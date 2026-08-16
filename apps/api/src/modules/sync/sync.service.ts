import { Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import {
  MAX_PULL_LIMIT,
  authorizeQueuedOperation,
  decideBootstrap,
  formatCursor,
  isValidCursor,
  parseCursor,
  resolveProductConflict,
  type ProductPatch,
} from '@dukaano/business-logic'
import type { Permission } from '@dukaano/types'
import { BusinessRuleError } from '../../common/errors/domain-error'
import { PrismaService } from '../../common/prisma/prisma.service'
import { currentContext, tenantClient } from '../../common/prisma/tenant-context'
import { serializeBigInts } from '../../common/interceptors/response-envelope.interceptor'
import { createSaleSchema, recordPaymentSchema } from '@dukaano/validation'
import type { PushOperation, SyncPushInput } from '@dukaano/validation'
import { ProductsService } from '../catalogue/products.service'
import { PaymentsService } from '../khata/payments.service'
import { SalesService } from '../sales/sales.service'

export type OpStatus = 'applied' | 'duplicate' | 'conflict' | 'rejected'

export interface OpResult {
  readonly opId: string
  readonly status: OpStatus
  readonly rowVersion?: number
  readonly serverEntity?: unknown
  readonly resolution?: 'server_wins' | 'client_wins' | 'partial'
  readonly code?: string
  readonly messageKey?: string
  readonly rejectedFields?: readonly { field: string; reason: string }[]
}

/**
 * The sync engine (blueprint §14).
 *
 * Three operations, each with a property that has to hold or a shopkeeper loses data:
 *
 *   **push** — every op is idempotent on `op_id`, so a retried batch cannot double a sale.
 *   **pull** — the cursor is an xmin watermark, so a change cannot be skipped past and lost.
 *   **bootstrap** — a device too far behind for a delta gets the whole dataset instead of a
 *   silently incomplete one.
 *
 * Phase 3 exercises this end-to-end on **products only**, per §28. The machinery — idempotency,
 * cursor, conflict policy, authorization — is entity-agnostic; Phase 4 registers sales and
 * payments against the same push loop rather than writing a second one.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly sales: SalesService,
    private readonly payments: PaymentsService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // PUSH
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Apply a batch of queued client operations.
   *
   * **The batch is not atomic; each op is** (§14.4). This is deliberate and is the opposite of
   * every other write path in Dukaano. A batch holds a fortnight of unrelated work — Tuesday's
   * sales, a price edit, a stock correction — and one bad op must not roll back the other 499.
   * The client would then retry the whole batch forever, making no progress, with a growing
   * outbox and no way to tell which op was poisonous.
   *
   * Consequently this method opens a transaction **per op** and must not run inside the request's
   * transaction. The route carries `@SkipTenant()` for that reason; see the controller.
   */
  async push(
    shopId: string,
    input: SyncPushInput,
    /**
     * The user's permissions **as of now**, resolved by the guard from the database on this
     * request. Never anything the client asserted about its own past authorization — a client
     * that can claim its own permissions can claim any of them (§14.2).
     */
    permissions: ReadonlySet<Permission>,
  ): Promise<{ results: OpResult[]; serverTime: Date }> {
    const userId = currentContext()?.userId ?? null
    const results: OpResult[] = []

    for (const op of input.ops) {
      results.push(
        await this.applyOneOperation({
          shopId,
          userId,
          deviceId: input.deviceId,
          op,
          permissions,
        }),
      )
    }

    await this.touchDevice(shopId, input.deviceId, input.clientTime, input.appVersion)

    return { results, serverTime: new Date() }
  }

  /**
   * One op, one transaction.
   *
   * The ordering inside is load-bearing and follows §14.4 exactly:
   *   1. claim the op_id — this is the entire duplicate-sale defence
   *   2. re-authorize against **current** permissions, not what the client claims it had
   *   3. apply through the normal domain service, never a parallel sync writer
   *   4. record the outcome so a replay returns the same answer
   */
  private async applyOneOperation(input: {
    shopId: string
    userId: string | null
    deviceId: string
    op: PushOperation
    permissions: ReadonlySet<Permission>
  }): Promise<OpResult> {
    const { shopId, op } = input

    /*
     * Step 1 — claim the op id, in its own committed transaction, BEFORE the work.
     *
     * Claiming inside the apply transaction would be neater but wrong in one direction that
     * matters: if the apply commits and the response is lost in the network, the client retries
     * and — because the claim committed with the apply — correctly sees a duplicate. Good. But if
     * the apply *fails*, the claim rolls back too, and the op can be retried. Also good.
     *
     * The case that forces a separate claim is a **rejection**: a deterministic refusal must be
     * remembered, or every retry re-evaluates it, and an op rejected for a permission the user
     * has since regained would suddenly apply — days after the shopkeeper was told it had failed.
     */
    const claim = await this.claimOperation(shopId, input.deviceId, input.userId, op)
    if (claim.alreadyProcessed) {
      // The stored original result, verbatim. §14.4 step 1.
      return { ...(claim.storedResult as OpResult), opId: op.opId, status: 'duplicate' }
    }

    // Step 2 — authorization against current server state (§14.2, E-31).
    const required = this.permissionFor(op)
    const authorization = authorizeQueuedOperation({
      entity: op.entity,
      opType: op.opType,
      holdsPermissionNow: input.permissions.has(required),
    })

    if (!authorization.allowed) {
      const result: OpResult = {
        opId: op.opId,
        status: 'rejected',
        code: 'PERMISSION_REVOKED',
        messageKey: 'errors.sync.permission',
      }
      await this.recordOutcome(shopId, op, result)
      return result
    }

    try {
      // Steps 3 and 4 — apply and record, in one transaction so an op is never recorded as
      // applied when its write rolled back.
      return await this.prisma.runAsTenant(
        {
          requestId: randomUUID(),
          shopId,
          userId: input.userId,
          deviceId: input.deviceId,
        },
        async () => {
          const result = await this.dispatch(shopId, op)
          await this.recordOutcomeInTransaction(shopId, op, result)
          return result
        },
      )
    } catch (error) {
      /*
       * A transient failure — deadlock, timeout, a dependency being down.
       *
       * Deliberately NOT recorded. The op stays unclaimed and the client retries it, which is
       * correct for a failure that may not recur. Recording it would turn a blip into permanent
       * data loss: the sale would be marked processed, never applied, and never retried.
       *
       * The claim from step 1 is released here for the same reason.
       */
      /*
       * Note the trade this makes. A deterministic bug on the server — a serialization error, a
       * broken migration — also lands here and is reported as retryable, so the client keeps
       * retrying an op that will never succeed. That is the deliberate direction to fail in:
       * marking real financial data as permanently failed to avoid a retry loop would discard a
       * sale that actually happened, and §54 puts financial correctness first. The retry is capped
       * at five minutes by the client's backoff, and this log line at error level is what surfaces
       * the bug.
       */
      await this.releaseClaim(shopId, op.opId)
      this.logger.error(
        `Sync op ${op.opId} (${op.entity}/${op.opType}) failed transiently and will be retried: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return {
        opId: op.opId,
        status: 'rejected',
        code: 'RETRYABLE',
        messageKey: 'errors.sync.retryable',
      }
    }
  }

  /**
   * Route an op to the domain service that owns it.
   *
   * Every branch goes through the **same service the online path uses** (§14.4 step 4). That is a
   * hard rule, not a convenience: a parallel sync writer drifts from online behaviour, and the
   * drift surfaces as data that is subtly different depending on whether the shop had signal.
   */
  private async dispatch(shopId: string, op: PushOperation): Promise<OpResult> {
    if (op.entity === 'product') {
      return op.opType === 'create'
        ? this.applyProductCreate(shopId, op)
        : this.applyProductUpdate(shopId, op)
    }

    // Financial facts are append-only and idempotent on their client-generated id, so a create is
    // the only op type they accept — §14.7. There is no "edit a sale"; a mistake is a cancellation
    // or a return, each of which is its own op.
    if (op.entity === 'sale' && op.opType === 'create') {
      /*
       * Parsed with `createSaleSchema` — **the same schema the online route uses** (§14.4 step 3).
       *
       * Not optional. Skipping it was the first version, and it broke immediately: `occurredAt`
       * arrives as a JSON string and the service expects a Date, so an offline sale crashed on a
       * date it had every right to send. Beyond the coercion, a queued op is untrusted input that
       * has been sitting on a device for a fortnight, and it must clear exactly the same bar as a
       * request arriving at the counter.
       */
      const parsed = createSaleSchema.parse({
        ...(op.payload as Record<string, unknown>),
        id: op.entityId,
        opId: op.opId,
      })
      const sale = await this.sales.create(shopId, parsed)
      return { opId: op.opId, status: 'applied', rowVersion: 1, serverEntity: sale }
    }

    if (op.entity === 'payment' && op.opType === 'create') {
      const parsed = recordPaymentSchema.parse({
        ...(op.payload as Record<string, unknown>),
        id: op.entityId,
        opId: op.opId,
      })
      const payment = await this.payments.record(shopId, parsed)
      return { opId: op.opId, status: 'applied', rowVersion: 1, serverEntity: payment }
    }

    // Unknown entities are rejected rather than ignored. A client one version ahead of the server
    // must be told its op did not apply, not left believing it did.
    return {
      opId: op.opId,
      status: 'rejected',
      code: 'UNSUPPORTED_ENTITY',
      messageKey: 'errors.sync.unsupportedEntity',
    }
  }

  /**
   * Create a product from a queued op.
   *
   * Goes through `ProductsService.create` — the same method the online path calls. §14.4 step 4
   * makes this a hard rule: a parallel "sync writer" drifts from online behaviour, and the drift
   * shows up as data that is subtly different depending on whether the shop had signal.
   */
  private async applyProductCreate(shopId: string, op: PushOperation): Promise<OpResult> {
    const payload = op.payload as Record<string, unknown>

    const existing = await tenantClient().product.findFirst({
      where: { id: op.entityId, shopId },
      select: { id: true, rowVersion: true },
    })

    // The id is client-generated (UUIDv7, §14.3), so a create whose response was lost arrives
    // again with the same id. Treat it as already done rather than as a duplicate-key error.
    if (existing) {
      return { opId: op.opId, status: 'applied', rowVersion: Number(existing.rowVersion) }
    }

    const created = await this.products.create(shopId, {
      id: op.entityId,
      nameEn: payload.nameEn as string | undefined,
      nameHi: payload.nameHi as string | undefined,
      sku: payload.sku as string | undefined,
      shortCode: payload.shortCode as string | undefined,
      categoryId: payload.categoryId as string | undefined,
      unitCode: payload.unitCode as never,
      sellingPricePaise: payload.sellingPricePaise as number,
      purchasePricePaise: payload.purchasePricePaise as number | undefined,
      mrpPaise: payload.mrpPaise as number | undefined,
      lowStockThresholdMilli: payload.lowStockThresholdMilli as number | undefined,
      openingStockMilli: payload.openingStockMilli as number | undefined,
      aliases: payload.aliases as string[] | undefined,
      clientUpdatedAt: op.clientUpdatedAt,
    })

    return {
      opId: op.opId,
      status: 'applied',
      rowVersion: Number(created.rowVersion),
      serverEntity: created,
    }
  }

  /**
   * Update a product, resolving field by field against the server's copy (§14.7).
   *
   * The interesting outcome is `conflict` with a *partial* resolution: the rename applies and the
   * stale price does not. All-or-nothing would either lose the rename or reprice the shelf from a
   * phone that has been in a drawer.
   */
  private async applyProductUpdate(shopId: string, op: PushOperation): Promise<OpResult> {
    const server = await tenantClient().product.findFirst({
      where: { id: op.entityId, shopId },
      select: { id: true, rowVersion: true, clientUpdatedAt: true, updatedAt: true },
    })

    if (!server) {
      return {
        opId: op.opId,
        status: 'rejected',
        code: 'NOT_FOUND',
        messageKey: 'errors.notFound',
      }
    }

    const resolution = resolveProductConflict(
      {
        patch: op.payload as ProductPatch,
        clientUpdatedAt: op.clientUpdatedAt,
        baseVersion: op.baseVersion,
      },
      {
        rowVersion: Number(server.rowVersion),
        effectiveUpdatedAt: server.clientUpdatedAt ?? server.updatedAt,
      },
    )

    if (resolution.hasConflict) {
      // "Nothing is ever discarded silently" (§14.9). Every refused field lands in the inbox.
      await this.recordConflict(shopId, op, resolution.rejected, server)
    }

    if (Object.keys(resolution.accepted).length === 0) {
      return {
        opId: op.opId,
        status: 'conflict',
        resolution: 'server_wins',
        rowVersion: Number(server.rowVersion),
        serverEntity: await this.products.findById(shopId, op.entityId),
        rejectedFields: resolution.rejected,
      }
    }

    const updated = await this.products.update(shopId, op.entityId, {
      ...resolution.accepted,
      clientUpdatedAt: op.clientUpdatedAt,
    })

    return {
      opId: op.opId,
      status: resolution.hasConflict ? 'conflict' : 'applied',
      resolution: resolution.hasConflict ? 'partial' : 'client_wins',
      rowVersion: Number(updated.rowVersion),
      serverEntity: updated,
      rejectedFields: resolution.hasConflict ? resolution.rejected : undefined,
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // PULL
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Delta pull, keyed on an xmin watermark (§14.5).
   *
   * The query below is the single most important piece of SQL in Dukaano, and the `txid <`
   * condition is the reason:
   *
   *   `change_log.id` is BIGSERIAL — allocated at INSERT, visible at COMMIT. A transaction that
   *   grabbed id 100 can commit *after* one that grabbed 105. A cursor on `id` would serve 105,
   *   advance past it, and permanently lose 100. The sale simply never appears on the device, no
   *   error is raised, and nothing is reproducible afterwards.
   *
   * `pg_snapshot_xmin(pg_current_snapshot())` is the id below which every transaction has
   * finished. Excluding everything at or above it means we never serve a row whose neighbours
   * might still be in flight. The watermark only advances past transactions that have all
   * committed, so nothing can commit into a range already handed out.
   *
   * Rows at exactly `cursor` may be re-served on the next pull. That is by design and costs
   * nothing: the client applies changes as an idempotent upsert keyed on
   * `(entity, id, row_version)`.
   */
  async pull(
    shopId: string,
    deviceId: string,
    cursor: string | null,
    limit: number,
  ): Promise<
    | { snapshotRequired: true; reason: string }
    | { snapshotRequired: false; changes: unknown[]; cursor: string; hasMore: boolean }
  > {
    const device = await tenantClient().device.findFirst({
      where: { id: deviceId, shopId },
      select: { id: true, lastSyncXmin: true, lastPulledAt: true, revokedAt: true },
    })

    if (!device) {
      throw new BusinessRuleError('DEVICE_NOT_REGISTERED', 'errors.sync.deviceUnknown')
    }
    if (device.revokedAt) {
      throw new BusinessRuleError('DEVICE_REVOKED', 'errors.sync.deviceRevoked')
    }

    const effectiveCursor = cursor ?? device.lastSyncXmin

    if (effectiveCursor !== null && !isValidCursor(effectiveCursor)) {
      throw new BusinessRuleError('INVALID_CURSOR', 'errors.sync.invalidCursor')
    }

    const decision = decideBootstrap({
      cursor: effectiveCursor,
      lastPulledAt: device.lastPulledAt,
      now: new Date(),
    })

    if (decision.required || effectiveCursor === null) {
      // The null check is redundant at runtime — decideBootstrap already requires a cursor — but
      // it is what tells the compiler the cursor below is a string, without an assertion.
      return { snapshotRequired: true, reason: decision.reason ?? 'NO_CURSOR' }
    }

    const cappedLimit = Math.min(Math.max(limit, 1), MAX_PULL_LIMIT)
    const position = parseCursor(effectiveCursor)
    if (!position) throw new BusinessRuleError('INVALID_CURSOR', 'errors.sync.invalidCursor')

    /*
     * A keyset on `(txid, id)`, matching the sort order exactly.
     *
     * The blueprint's query uses `txid >= cursor` alone, which is correct for an unpaginated pull
     * and breaks the moment a `LIMIT` truncates a page: the cursor either advances to the current
     * watermark and skips the remainder, or stays put and hands the client the same page forever.
     * The second is what an early version of this did, and a device with a backlog larger than one
     * page could never drain it.
     *
     * The composite fixes both. `changeId` is 0 for a fresh watermark, and every real
     * `change_log.id` is greater than 0, so the bare-watermark case stays inclusive exactly as
     * §14.5 requires — a transaction sitting at the watermark was in flight and its rows were
     * never served.
     *
     * `txid < pg_snapshot_xmin(...)` is unchanged and is the part that prevents lost changes:
     * every transaction below the watermark has finished, so no row can later commit into a range
     * already handed out.
     */
    const rows = await tenantClient().$queryRaw<
      {
        id: bigint
        txid: string
        entity: string
        entity_id: string
        op: string
        row_version: bigint
        changed_at: Date
      }[]
    >`
      SELECT id, txid::text AS txid, entity, entity_id, op, row_version, changed_at
      FROM change_log
      WHERE shop_id = ${shopId}::uuid
        AND txid <  pg_snapshot_xmin(pg_current_snapshot())
        AND (
          txid > ${position.txid.toString()}::xid8
          OR (txid = ${position.txid.toString()}::xid8 AND id > ${position.changeId})
        )
      ORDER BY txid, id
      LIMIT ${cappedLimit + 1}
    `

    const hasMore = rows.length > cappedLimit
    const page = hasMore ? rows.slice(0, cappedLimit) : rows

    // `hasMore` implies a full page, so `last` is always present — but read it rather than
    // asserting it, so a future change to the paging arithmetic cannot turn a wrong assumption
    // into a cursor built from `undefined`.
    const last = page[page.length - 1]

    let nextCursor: string
    if (hasMore && last) {
      // Mid-window: resume strictly after the last row delivered.
      nextCursor = formatCursor({ txid: BigInt(last.txid), changeId: last.id })
    } else {
      // Drained: jump to the current watermark, inclusively, so anything that was in flight is
      // picked up next time.
      const [watermark] = await tenantClient().$queryRaw<{ xmin: string }[]>`
        SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin
      `
      nextCursor = formatCursor({ txid: BigInt(watermark?.xmin ?? position.txid), changeId: 0n })
    }

    await tenantClient().device.update({
      where: { id: deviceId },
      // `lastPulledAt` moves on every page, not only the last. A device steadily working through
      // a large backlog is plainly not stale, and letting the timestamp go cold mid-drain would
      // eventually force it into a bootstrap it does not need.
      data: { lastSyncXmin: nextCursor, lastPulledAt: new Date() },
    })

    return {
      snapshotRequired: false,
      changes: page.map((row) => ({
        entity: row.entity,
        entityId: row.entity_id,
        op: row.op,
        rowVersion: Number(row.row_version),
        changedAt: row.changed_at,
      })),
      cursor: nextCursor,
      hasMore,
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // BOOTSTRAP
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  /**
   * The full dataset, for a first login, a new device, or a cursor past retention (§14.5).
   *
   * The cursor is read **before** the data, not after. Reading it after would open a window in
   * which a change committed between the snapshot and the cursor read, and the device would
   * advance past a change it never received — the same silent loss the xmin watermark exists to
   * prevent, reintroduced at the one moment the whole dataset is being replaced.
   *
   * Taking it first can only re-serve changes the bootstrap already included, which the client's
   * idempotent apply absorbs.
   */
  async bootstrap(shopId: string, deviceId: string) {
    const [watermark] = await tenantClient().$queryRaw<{ xmin: string }[]>`
      SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin
    `
    // Inclusive form: a transaction at exactly this watermark was still in flight when the
    // snapshot was taken, so its rows are not in the bootstrap and must arrive on the first delta.
    const cursor = formatCursor({ txid: BigInt(watermark?.xmin ?? '0'), changeId: 0n })

    const [products, balances, categories, settings, customers] = await Promise.all([
      tenantClient().product.findMany({
        where: { shopId, archivedAt: null },
        select: {
          id: true, nameEn: true, nameHi: true, sku: true, shortCode: true, categoryId: true,
          unitCode: true, sellingPricePaise: true, purchasePricePaise: true, mrpPaise: true,
          lowStockThresholdMilli: true, isActive: true, rowVersion: true, updatedAt: true,
        },
      }),
      tenantClient().inventoryBalance.findMany({
        where: { shopId },
        select: { productId: true, qtyMilli: true, avgCostPaise: true, version: true },
      }),
      tenantClient().category.findMany({
        where: { shopId, archivedAt: null },
        select: { id: true, nameEn: true, nameHi: true, sortOrder: true },
      }),
      tenantClient().shopSettings.findUnique({ where: { shopId } }),
      tenantClient().customer.findMany({
        where: { shopId, archivedAt: null },
        select: { id: true, name: true, phoneE164: true, rowVersion: true },
      }),
    ])

    const aliases = await tenantClient().productAlias.findMany({
      where: { shopId },
      select: { productId: true, alias: true },
    })

    await tenantClient().device.update({
      where: { id: deviceId },
      data: { lastSyncXmin: cursor, lastPulledAt: new Date() },
    })

    return {
      cursor,
      generatedAt: new Date(),
      products,
      // Derived state, pull-only — a client may never push these upward (§14.7).
      inventoryBalances: balances,
      productAliases: aliases,
      categories,
      customers,
      settings,
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // internals
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Claim an op id, or report that it was already processed.
   *
   * `ON CONFLICT DO NOTHING` makes this atomic against a concurrent duplicate: two devices — or
   * one device retrying while the first attempt is still running — race to insert the same key and
   * exactly one wins. This single statement is what makes a retried batch safe.
   */
  private async claimOperation(
    shopId: string,
    deviceId: string,
    userId: string | null,
    op: PushOperation,
  ): Promise<{ alreadyProcessed: boolean; storedResult?: unknown }> {
    return this.prisma.runAsTenant(
      { requestId: randomUUID(), shopId, userId, deviceId },
      async () => {
        const inserted = await tenantClient().$executeRaw`
          INSERT INTO processed_operation
            (op_id, shop_id, device_id, user_id, entity, entity_id, op_type, status)
          VALUES (
            ${op.opId}::uuid, ${shopId}::uuid, ${deviceId}::uuid,
            ${userId}::uuid, ${op.entity}, ${op.entityId}::uuid, ${op.opType}, 'in_progress'
          )
          ON CONFLICT (op_id) DO NOTHING
        `

        if (inserted === 1) return { alreadyProcessed: false }

        const existing = await tenantClient().processedOperation.findUnique({
          where: { opId: op.opId },
          select: { result: true, status: true },
        })

        /*
         * An `in_progress` row means a previous attempt died between claiming and recording —
         * the process was killed, or the pod was rescheduled mid-batch. Treating that as a
         * duplicate would lose the op permanently. The claim is taken over instead: the work is
         * re-done, which is safe because the apply itself is idempotent on the entity id.
         */
        if (existing?.status === 'in_progress') return { alreadyProcessed: false }

        return { alreadyProcessed: true, storedResult: existing?.result ?? { status: 'duplicate' } }
      },
    )
  }

  private async releaseClaim(shopId: string, opId: string): Promise<void> {
    await this.prisma.runAsTenant(
      { requestId: randomUUID(), shopId, userId: null, deviceId: null },
      async () => {
        await tenantClient().$executeRaw`
          DELETE FROM processed_operation
          WHERE op_id = ${opId}::uuid AND status = 'in_progress'
        `
      },
    )
  }

  /** Record a deterministic outcome in its own transaction (used for rejections). */
  private async recordOutcome(shopId: string, op: PushOperation, result: OpResult): Promise<void> {
    await this.prisma.runAsTenant(
      { requestId: randomUUID(), shopId, userId: null, deviceId: null },
      () => this.recordOutcomeInTransaction(shopId, op, result),
    )
  }

  private async recordOutcomeInTransaction(
    _shopId: string,
    op: PushOperation,
    result: OpResult,
  ): Promise<void> {
    await tenantClient().processedOperation.update({
      where: { opId: op.opId },
      data: {
        status: result.status,
        /*
         * Stored so a replay returns the identical answer rather than re-deriving one that may
         * have changed in the meantime.
         *
         * Through `serializeBigInts` — the same converter the HTTP response envelope uses —
         * because `result.serverEntity` is a Prisma row and every money and quantity column is
         * BIGINT, which `JSON.stringify` refuses outright. Reusing it also means a replayed result
         * is byte-identical to the response the first attempt returned.
         */
        result: serializeBigInts(result) as object,
      },
    })
  }

  private async recordConflict(
    shopId: string,
    op: PushOperation,
    rejected: readonly { field: string; reason: string }[],
    server: unknown,
  ): Promise<void> {
    await tenantClient().syncConflict.create({
      data: {
        id: randomUUID(),
        shopId,
        deviceId: currentContext()?.deviceId ?? null,
        entity: op.entity,
        entityId: op.entityId,
        clientPayload: serializeBigInts({ patch: op.payload, rejected }) as object,
        serverPayload: serializeBigInts(server) as object,
        resolution: 'server_wins',
      },
    })
  }

  /** The permission an op requires, evaluated against the user's *current* grants. */
  private permissionFor(op: PushOperation): Permission {
    if (op.entity === 'product') return 'product.write'
    if (op.entity === 'customer') return 'customer.write'
    if (op.entity === 'inventory_transaction') return 'inventory.adjust'
    if (op.entity === 'payment') return 'customer.payment.receive'
    return 'sale.create'
  }

  /**
   * Record that a device checked in, and flag a clock too far out to trust (E-26).
   *
   * The skew is stored rather than acted on here: `resolveBusinessTimestamp` in
   * @dukaano/business-logic decides per write whether to trust the client's clock for business
   * dating. Recording it makes "why is this sale dated yesterday?" answerable months later.
   */
  private async touchDevice(
    shopId: string,
    deviceId: string,
    clientTime: Date | undefined,
    appVersion: string | undefined,
  ): Promise<void> {
    const skewMs = clientTime ? Math.abs(Date.now() - clientTime.getTime()) : null

    await this.prisma.runAsTenant(
      { requestId: randomUUID(), shopId, userId: null, deviceId },
      async () => {
        await tenantClient().device.updateMany({
          where: { id: deviceId, shopId },
          data: {
            lastSeenAt: new Date(),
            ...(skewMs !== null ? { clockSkewMs: Math.min(skewMs, 2_147_483_647) } : {}),
            ...(appVersion ? { appVersion } : {}),
          },
        })
      },
    )
  }
}

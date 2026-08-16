import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../../common/prisma/prisma.service'
import { InventoryService } from './inventory.service'
import { env } from '../../config/env'
import { randomUUID } from 'node:crypto'

/**
 * The nightly reconciliation sweep (blueprint §17.4).
 *
 * Asserts, for every active shop, that `inventory_balance.qty_milli` equals the sum of that
 * product's `inventory_transaction.qty_delta_milli`. The invariant should be impossible to break
 * — `InventoryService` is the only writer of stock, and it appends the transaction and updates
 * the snapshot inside one locked transaction — which is exactly why this job matters. It is the
 * check that tells us the thing we believe is impossible has not happened.
 *
 * **It reports; it does not heal.** A mismatch means a bug in the write path. Correcting the
 * number would remove the evidence, leave the shopkeeper's history inconsistent with their
 * balance, and guarantee the bug ships again. The append-only design exists precisely so the
 * transaction log can be trusted over the snapshot; silently rewriting the snapshot to match
 * would throw that away.
 *
 * Runs at 02:30 in the shop's country, not UTC: it must not overlap the evening rush, and 02:30
 * IST is 21:00 UTC the previous day. Cron is quiet in the log unless something is wrong, so a
 * P1-worthy event is the only thing that produces output.
 */
@Injectable()
export class ReconciliationJob {
  private readonly logger = new Logger(ReconciliationJob.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  @Cron('30 2 * * *', { name: 'inventory-reconciliation', timeZone: 'Asia/Kolkata' })
  async run(): Promise<void> {
    if (!env.ENABLE_SCHEDULED_JOBS) return
    await this.reconcileAllShops()
  }

  /**
   * Sweep every active shop. Exposed separately from the `@Cron` wrapper so it is callable from a
   * test and from an ops one-off without waiting for 02:30.
   */
  async reconcileAllShops(): Promise<{ shopsChecked: number; shopsWithMismatch: number }> {
    const startedAt = Date.now()

    /*
     * `shop` is RLS-scoped like every other tenant table, so the application role cannot list
     * shops — it sees only the one the current request is scoped to. A plain `findMany` here
     * returns zero rows and the sweep silently checks nothing, which is precisely the failure
     * RLS-fails-closed is designed to produce and precisely what a maintenance job must not do.
     *
     * `platform_shop_directory()` is a SECURITY DEFINER function returning id, name and status
     * only — see its migration for what it can and cannot reach. Every actual data read below
     * still happens inside a normal tenant transaction with RLS applied.
     */
    const shops = await this.prisma.untenanted.$queryRaw<
      { id: string; name: string; status: string }[]
    >`SELECT id, name, status FROM platform_shop_directory()`

    let shopsWithMismatch = 0

    for (const shop of shops) {
      /*
       * One transaction per shop, not one for the whole sweep.
       *
       * A single transaction spanning every shop would hold a snapshot open for the duration of
       * the sweep, which blocks vacuum and grows with the tenant count. Per-shop also means one
       * shop's failure does not abort the others — the sweep must be able to report on shop 400
       * even if shop 12 threw.
       */
      try {
        const result = await this.prisma.runAsTenant(
          {
            requestId: randomUUID(),
            shopId: shop.id,
            userId: null,
            deviceId: null,
          },
          () => this.inventory.reconcile(shop.id),
        )

        if (result.mismatchCount > 0) {
          shopsWithMismatch++
          // Already logged at error level by the service, with the product ids. This line adds
          // the shop's name, which is what an on-call engineer needs to act on it.
          this.logger.error(
            `Reconciliation mismatch in "${shop.name}" (${shop.id}): ` +
              `${result.mismatchCount} products. This is a write-path bug — investigate, ` +
              `do not correct the balances by hand.`,
          )
        }
      } catch (error) {
        // Never swallowed, and never allowed to abort the sweep: a shop that fails to reconcile
        // is itself a finding, and the remaining shops still need checking.
        this.logger.error(
          `Reconciliation failed for shop ${shop.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        shopsWithMismatch++
      }
    }

    const elapsed = Date.now() - startedAt
    const summary = { shopsChecked: shops.length, shopsWithMismatch }

    if (shopsWithMismatch > 0) {
      this.logger.error(
        `Reconciliation sweep: ${shopsWithMismatch} of ${shops.length} shops have inventory ` +
          `that does not match their transaction history (${elapsed} ms).`,
      )
    } else {
      this.logger.log(`Reconciliation sweep: ${shops.length} shops clean (${elapsed} ms).`)
    }

    return summary
  }
}

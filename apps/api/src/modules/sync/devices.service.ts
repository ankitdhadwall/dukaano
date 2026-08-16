import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { NumberLeaseInput, RegisterDeviceInput } from '@dukaano/validation'
import { BusinessRuleError, NotFoundError } from '../../common/errors/domain-error'
import { currentContext, tenantClient } from '../../common/prisma/tenant-context'

/**
 * The device registry and invoice-number leases (blueprint §14.3, §14.6).
 *
 * A device is a first-class thing in Dukaano rather than an implementation detail of a session,
 * because three separate mechanisms need to name one: the sync cursor lives on it, invoice number
 * blocks are leased to it, and a lost phone has to be revocable without changing the owner's
 * password and logging out the whole shop.
 */
@Injectable()
export class DevicesService {
  /**
   * Register a device, or update the one already registered under this id.
   *
   * The id is client-generated so a device keeps its identity — and therefore its sync cursor —
   * across a reinstall that restores a backup. Re-registering an existing id is an update, not an
   * error: the alternative is a device that loses its cursor and re-bootstraps every time the app
   * is reinstalled, which on a 3G connection is a real cost for no benefit.
   */
  async register(shopId: string, input: RegisterDeviceInput) {
    const deviceId = input.deviceId ?? randomUUID()
    const userId = currentContext()?.userId ?? null

    const existing = await tenantClient().device.findFirst({
      where: { id: deviceId, shopId },
      select: { id: true, revokedAt: true },
    })

    if (existing?.revokedAt) {
      /*
       * A revoked device may not re-register itself.
       *
       * Revocation exists for a stolen or dismissed-employee phone. If that phone could clear the
       * flag by calling register again, revocation would mean nothing — and the device still holds
       * a valid refresh token until it expires. Clearing it requires an owner action on a
       * different device.
       */
      throw new BusinessRuleError(
        'DEVICE_REVOKED',
        'errors.sync.deviceRevoked',
        {},
        'This device was revoked; an owner must re-authorize it',
      )
    }

    if (existing) {
      return tenantClient().device.update({
        where: { id: deviceId },
        data: {
          userId,
          name: input.name ?? undefined,
          platform: input.platform,
          appVersion: input.appVersion ?? undefined,
          osVersion: input.osVersion ?? undefined,
          pushToken: input.pushToken ?? undefined,
          lastSeenAt: new Date(),
        },
      })
    }

    return tenantClient().device.create({
      data: {
        id: deviceId,
        shopId,
        userId,
        name: input.name ?? null,
        platform: input.platform,
        appVersion: input.appVersion ?? null,
        osVersion: input.osVersion ?? null,
        pushToken: input.pushToken ?? null,
        lastSeenAt: new Date(),
      },
    })
  }

  async list(shopId: string) {
    return tenantClient().device.findMany({
      where: { shopId },
      orderBy: [{ revokedAt: 'asc' }, { lastSeenAt: 'desc' }],
      select: {
        id: true, name: true, platform: true, appVersion: true, osVersion: true,
        lastSeenAt: true, lastPulledAt: true, clockSkewMs: true, revokedAt: true, createdAt: true,
      },
    })
  }

  /**
   * Revoke a device — the lost-phone path.
   *
   * Sessions are killed alongside the flag. Marking the device without ending its sessions would
   * leave a working access token in a stranger's pocket for up to fifteen minutes and a refresh
   * token for sixty days, which is exactly the window the owner is trying to close.
   *
   * The device's un-pushed outbox is lost with it, and that is the accepted trade: the sales on a
   * stolen phone are unrecoverable either way, and accepting writes from it is worse than losing
   * them.
   */
  async revoke(shopId: string, deviceId: string) {
    const device = await tenantClient().device.findFirst({
      where: { id: deviceId, shopId },
      select: { id: true, revokedAt: true },
    })
    if (!device) throw new NotFoundError('Device', deviceId)

    const revokedAt = device.revokedAt ?? new Date()

    // `session` has no shop_id — it hangs off the user, not the shop — so it is scoped by the
    // device id, which was already confirmed above to belong to this shop.
    await tenantClient().session.updateMany({
      where: { deviceId, revokedAt: null },
      data: { revokedAt, revokedReason: 'device_revoked' },
    })

    return tenantClient().device.update({
      where: { id: deviceId },
      data: { revokedAt },
      select: { id: true, revokedAt: true },
    })
  }

  /**
   * Issue a block of invoice numbers to a device (§14.6).
   *
   * A shop's numbers must be unique and a device's must be monotonic, but the sequence as a whole
   * **is expected to have gaps** — a device that leases 200 and sells 40 before the block is
   * replaced leaves 160 unused. That is the deliberate trade: the alternative is assigning numbers
   * at sync time, which means the receipt in the customer's hand and the record in the system
   * disagree, and no shopkeeper can defend that to a customer holding the paper.
   *
   * **The race that matters.** Two devices asking for a block at the same moment must not receive
   * overlapping ranges — two customers would hold receipts bearing the same invoice number, which
   * is worse than any gap. A transaction-scoped advisory lock on (shop, series) serializes
   * allocation; the UNIQUE (shop_id, series, range_from) index is the backstop that turns a bug
   * here into a failed request rather than a duplicated number.
   */
  async issueNumberLease(shopId: string, input: NumberLeaseInput) {
    const device = await tenantClient().device.findFirst({
      where: { id: input.deviceId, shopId, revokedAt: null },
      select: { id: true },
    })
    if (!device) throw new NotFoundError('Device', input.deviceId)

    /*
     * hashtextextended gives a stable 64-bit key from (shop, series). Advisory locks are
     * transaction-scoped with `_xact`, so the lock is released on commit or rollback and a crashed
     * request cannot wedge number allocation for the shop.
     */
    await tenantClient().$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${`${shopId}:${input.series}`}, 0))
    `

    const [highest] = await tenantClient().$queryRaw<{ max_to: number | null }[]>`
      SELECT max(range_to) AS max_to
      FROM number_lease
      WHERE shop_id = ${shopId}::uuid AND series = ${input.series}
    `

    const rangeFrom = (highest?.max_to ?? 0) + 1
    const rangeTo = rangeFrom + input.size - 1

    // Retire the device's previous block. A device holds one live lease per series; leaving the
    // old one open would let it keep drawing numbers it has already been told to stop using.
    await tenantClient().numberLease.updateMany({
      where: { shopId, deviceId: input.deviceId, series: input.series, exhaustedAt: null },
      data: { exhaustedAt: new Date() },
    })

    return tenantClient().numberLease.create({
      data: {
        id: randomUUID(),
        shopId,
        deviceId: input.deviceId,
        series: input.series,
        rangeFrom,
        rangeTo,
        nextValue: rangeFrom,
      },
      select: { id: true, series: true, rangeFrom: true, rangeTo: true, nextValue: true, issuedAt: true },
    })
  }

  /** A device's live lease, so a reinstalled app resumes where it left off instead of re-leasing. */
  async currentLease(shopId: string, deviceId: string, series = 'INV') {
    return tenantClient().numberLease.findFirst({
      where: { shopId, deviceId, series, exhaustedAt: null },
      orderBy: { issuedAt: 'desc' },
      select: { id: true, series: true, rangeFrom: true, rangeTo: true, nextValue: true, issuedAt: true },
    })
  }
}

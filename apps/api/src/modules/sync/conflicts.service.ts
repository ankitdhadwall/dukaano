import { Injectable } from '@nestjs/common'
import { NotFoundError } from '../../common/errors/domain-error'
import { tenantClient } from '../../common/prisma/tenant-context'

/**
 * The conflict inbox (blueprint §14.9).
 *
 * "Nothing is ever discarded silently." Every field the server refuses during a sync lands here,
 * with the client's value and the server's side by side, and stays until a human acknowledges it.
 *
 * The reason this exists rather than a log line: the shopkeeper edited a price on their phone and
 * it did not take. If nobody tells them, they find out when a customer is charged the old price,
 * and their conclusion is that the app loses their work — which is both reasonable and fatal to
 * trust. An inbox entry turns a silent loss into a visible, explainable decision.
 *
 * Acknowledgement is deliberately not resolution. Acknowledging says "I have seen this"; if the
 * shopkeeper still wants their value, they make the edit again on a device that is now up to date.
 * Offering a one-tap "apply mine" would re-introduce the stale-price overwrite the conflict rule
 * exists to prevent, just with an extra tap in front of it.
 */
@Injectable()
export class ConflictsService {
  async list(shopId: string, includeAcknowledged = false) {
    return tenantClient().syncConflict.findMany({
      where: { shopId, ...(includeAcknowledged ? {} : { acknowledgedAt: null }) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true, entity: true, entityId: true, deviceId: true,
        clientPayload: true, serverPayload: true, resolution: true,
        acknowledgedAt: true, createdAt: true,
      },
    })
  }

  /** How many need attention — drives the badge on the sync banner. */
  async unacknowledgedCount(shopId: string): Promise<number> {
    return tenantClient().syncConflict.count({ where: { shopId, acknowledgedAt: null } })
  }

  async acknowledge(shopId: string, id: string) {
    const conflict = await tenantClient().syncConflict.findFirst({
      where: { id, shopId },
      select: { id: true, acknowledgedAt: true },
    })
    if (!conflict) throw new NotFoundError('SyncConflict', id)

    // Idempotent: acknowledging twice keeps the first timestamp. The second tap is a double-tap
    // on a phone, not a second decision, and re-stamping would misreport when it was seen.
    if (conflict.acknowledgedAt) return conflict

    return tenantClient().syncConflict.update({
      where: { id },
      data: { acknowledgedAt: new Date() },
      select: { id: true, acknowledgedAt: true },
    })
  }

  /** Clear the inbox in one action, for a shop that has accumulated a backlog it has reviewed. */
  async acknowledgeAll(shopId: string): Promise<{ acknowledged: number }> {
    const result = await tenantClient().syncConflict.updateMany({
      where: { shopId, acknowledgedAt: null },
      data: { acknowledgedAt: new Date() },
    })
    return { acknowledged: result.count }
  }
}

import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import {
  CHANGE_LOG_RETENTION_DAYS,
  PROCESSED_OPERATION_RETENTION_DAYS,
} from '@dukaano/business-logic'
import { PrismaService } from '../../common/prisma/prisma.service'
import { env } from '../../config/env'

/**
 * Pruning the two sync tables that grow without bound (blueprint §14.4, §14.5).
 *
 * Both windows are chosen against a failure, not a disk-space target:
 *
 *   **`change_log` at 30 days** is what makes a delta pull possible. A device that has not synced
 *   inside the window may have missed rows that are now gone, which is why `decideBootstrap`
 *   forces it to re-download everything instead. Pruning and the bootstrap rule must always agree
 *   — shortening one without the other creates a device that is told a delta is fine and receives
 *   an incomplete one, which is the silent-loss failure the whole design exists to avoid.
 *
 *   **`processed_operation` at 90 days** is the duplicate-suppression window, deliberately longer.
 *   A device forced to bootstrap at 30 days may still hold un-pushed ops in its outbox; if their
 *   op ids had already expired, those queued sales would apply a second time at exactly the moment
 *   they are most likely to be retried.
 *
 * Runs at 03:15 IST, after the reconciliation sweep, so a night where both run does not put two
 * heavy jobs on the database at once.
 */
@Injectable()
export class SyncRetentionJob {
  private readonly logger = new Logger(SyncRetentionJob.name)

  constructor(private readonly prisma: PrismaService) {}

  @Cron('15 3 * * *', { name: 'sync-retention', timeZone: 'Asia/Kolkata' })
  async run(): Promise<void> {
    if (!env.ENABLE_SCHEDULED_JOBS) return
    await this.prune()
  }

  /** Exposed separately from the cron wrapper so it is testable without waiting for 03:15. */
  async prune(now: Date = new Date()): Promise<{ changeLogDeleted: number; operationsDeleted: number }> {
    const changeLogCutoff = daysBefore(now, CHANGE_LOG_RETENTION_DAYS)
    const operationCutoff = daysBefore(now, PROCESSED_OPERATION_RETENTION_DAYS)

    /*
     * Through a SECURITY DEFINER function, not a plain DELETE.
     *
     * `change_log` and `processed_operation` carry the standard tenant RLS policy, so a DELETE
     * issued by the application role with no `app.shop_id` set matches nothing and reports success
     * having removed zero rows. Retention would appear to run every night, forever, while both
     * tables grew without bound — the first symptom being a disk alert months later. The function
     * deletes by age only and holds no shop id, so it cannot be aimed at a tenant; see its
     * migration for the full argument.
     */
    const [pruned] = await this.prisma.untenanted.$queryRaw<
      { change_log_deleted: bigint; operations_deleted: bigint }[]
    >`SELECT * FROM platform_prune_sync_tables(${changeLogCutoff}, ${operationCutoff})`

    const changeLogDeleted = Number(pruned?.change_log_deleted ?? 0)
    const operationsDeleted = Number(pruned?.operations_deleted ?? 0)

    if (changeLogDeleted > 0 || operationsDeleted > 0) {
      this.logger.log(
        `Sync retention: pruned ${changeLogDeleted} change-log rows older than ` +
          `${CHANGE_LOG_RETENTION_DAYS}d and ${operationsDeleted} processed operations older than ` +
          `${PROCESSED_OPERATION_RETENTION_DAYS}d.`,
      )
    }

    return { changeLogDeleted, operationsDeleted }
  }
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

import { z } from 'zod'
import { MAX_PULL_LIMIT, MAX_PUSH_BATCH_OPS, isValidCursor } from '@dukaano/business-logic'

/**
 * The sync wire contract (blueprint §14.4, §14.5).
 *
 * Deliberately permissive about *payload* and strict about *envelope*. The envelope — op id,
 * entity, op type, versions, timestamps — is what the server reasons about, and a malformed one
 * makes an op unsafe to apply at all. The payload is validated afterwards by the same schema the
 * online path uses (§14.4 step 3), so there is exactly one definition of a valid product and no
 * chance of a sync-only dialect drifting away from it.
 */

/** UUIDv7 in practice; validated as a UUID because v7 is not a distinct format on the wire. */
const uuid = (key: string) => z.string().uuid(`errors.sync.${key}`)

/**
 * A timestamp from the device's clock.
 *
 * Kept even when it is obviously wrong. E-26: a skewed clock means the server decides the
 * *business date*, but the client's own time is still recorded, because "what did this device
 * think the time was?" is the only way to explain a mis-dated sale months later.
 */
const clientTimestamp = z.coerce.date()

export const pushOperationSchema = z.object({
  /** THE idempotency key. One op id applies at most once, ever (§14.4 step 1). */
  opId: uuid('invalidOpId'),
  /** Device-local monotonic ordering. Informational server-side; the client flushes in this order. */
  seq: z.number().int().min(0).optional(),
  entity: z.string().min(1).max(40),
  entityId: uuid('invalidEntityId'),
  opType: z.enum(['create', 'update', 'archive'], {
    errorMap: () => ({ message: 'errors.sync.invalidOpType' }),
  }),
  /**
   * The `rowVersion` this edit was made against.
   *
   * Absent on creates. On updates it is what separates a price edit from a *stale* price edit —
   * see the field-aware conflict rule in @dukaano/business-logic.
   */
  baseVersion: z.number().int().min(0).optional(),
  clientUpdatedAt: clientTimestamp,
  payload: z.record(z.unknown()),
})
export type PushOperation = z.infer<typeof pushOperationSchema>

export const syncPushSchema = z.object({
  deviceId: uuid('invalidDeviceId'),
  clientTime: clientTimestamp.optional(),
  appVersion: z.string().max(20).optional(),
  ops: z
    .array(pushOperationSchema)
    .min(1, 'errors.sync.emptyBatch')
    // Bounded so one device cannot monopolise a connection, and so a failure costs at most one
    // batch of progress rather than a fortnight of it.
    .max(MAX_PUSH_BATCH_OPS, 'errors.sync.batchTooLarge')
    /*
     * A repeated op id **within one batch** is rejected outright rather than deduplicated.
     *
     * Deduplicating would be friendlier and wrong: two ops sharing an id means the client's outbox
     * is generating colliding keys, and the whole duplicate-sale defence rests on those keys being
     * unique. Silently accepting one and dropping the other hides a client bug whose next symptom
     * is a sale that vanishes.
     */
    .refine((ops) => new Set(ops.map((op) => op.opId)).size === ops.length, {
      message: 'errors.sync.duplicateOpIdInBatch',
    }),
})
export type SyncPushInput = z.infer<typeof syncPushSchema>

export const syncPullSchema = z.object({
  deviceId: uuid('invalidDeviceId'),
  /**
   * The xmin watermark from the previous pull. Absent on a device's first delta after bootstrap,
   * in which case the server falls back to the cursor it stored for that device.
   */
  cursor: z
    .string()
    .refine(isValidCursor, { message: 'errors.sync.invalidCursor' })
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PULL_LIMIT).optional().default(200),
})
export type SyncPullInput = z.infer<typeof syncPullSchema>

export const registerDeviceSchema = z.object({
  /** Client-generated, so a device keeps its identity across a reinstall that restores a backup. */
  deviceId: uuid('invalidDeviceId').optional(),
  name: z.string().trim().max(60).optional(),
  platform: z.enum(['ANDROID', 'IOS', 'WEB'], {
    errorMap: () => ({ message: 'errors.sync.invalidPlatform' }),
  }),
  appVersion: z.string().max(20).optional(),
  osVersion: z.string().max(40).optional(),
  pushToken: z.string().max(255).optional(),
})
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>

/**
 * Request a block of invoice numbers (§14.6).
 *
 * `size` is capped: a device that leases ten thousand numbers and is then lost takes a ten-thousand
 * number gap with it. Gaps are acceptable, but they should be the size of a day's trading, not a
 * year's.
 */
export const numberLeaseSchema = z.object({
  deviceId: uuid('invalidDeviceId'),
  series: z.string().trim().min(1).max(10).default('INV'),
  size: z.number().int().min(10).max(1_000).optional().default(200),
})
export type NumberLeaseInput = z.infer<typeof numberLeaseSchema>

import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common'
import {
  Audit,
  CurrentShop,
  CurrentUser,
  LongTransaction,
  RequirePermission,
  SkipTenant,
} from '../../common/decorators'
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe'
import {
  numberLeaseSchema,
  registerDeviceSchema,
  syncPullSchema,
  syncPushSchema,
} from '@dukaano/validation'
import type {
  NumberLeaseInput,
  RegisterDeviceInput,
  SyncPullInput,
  SyncPushInput,
} from '@dukaano/validation'
import type { RequestPrincipal } from '../../common/guards/types'
import { ConflictsService } from './conflicts.service'
import { DevicesService } from './devices.service'
import { SyncService } from './sync.service'

/**
 * The sync API (blueprint §14).
 *
 * Every route requires only `@RequirePermission()` — any authenticated shop member may sync,
 * because a cashier who cannot sync cannot bill. Authorization happens **per operation** inside
 * the push, against current permissions, which is where the E-31 asymmetry lives: a queued sale
 * from a since-demoted cashier applies, a queued edit does not.
 */
@Controller('v1/sync')
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly devices: DevicesService,
    private readonly conflicts: ConflictsService,
  ) {}

  /**
   * Push queued operations.
   *
   * **`@SkipTenant` is load-bearing, not an optimisation.** Every other route runs inside one
   * request-scoped transaction, which is what gives them free atomicity. Push must not: the batch
   * is explicitly non-atomic and each op commits independently (§14.4), so that one poisonous op
   * cannot roll back the other 499 and leave the client retrying the same batch forever with a
   * growing outbox and no way to identify the culprit. `SyncService` therefore opens its own
   * transaction per op.
   *
   * `@LongTransaction` still applies to nothing here — there is no outer transaction — but 100 ops
   * each doing real work needs headroom against the request timeout.
   */
  @RequirePermission()
  @SkipTenant()
  @Audit('sync.pushed', 'sync')
  @LongTransaction(120_000)
  @Post('push')
  push(
    @CurrentShop() shopId: string,
    @CurrentUser() principal: RequestPrincipal,
    @Body(new ZodValidationPipe(syncPushSchema)) body: SyncPushInput,
  ) {
    // Permissions come from the guard's fresh database read, never from the request body.
    return this.sync.push(shopId, body, principal.permissions)
  }

  /**
   * Delta pull. Returns `{ snapshotRequired: true }` when the device is past retention.
   *
   * A GET with query parameters rather than a POST: it is a read, it is safely retryable, and a
   * client that loses the response can simply ask again with the same cursor.
   */
  @RequirePermission()
  @Get('pull')
  pull(
    @CurrentShop() shopId: string,
    @Query(new ZodValidationPipe(syncPullSchema)) query: SyncPullInput,
  ) {
    return this.sync.pull(shopId, query.deviceId, query.cursor ?? null, query.limit)
  }

  /** The full dataset, for a first login, a new device, or an expired cursor. */
  @RequirePermission()
  @LongTransaction(60_000)
  @Get('bootstrap')
  bootstrap(@CurrentShop() shopId: string, @Query('deviceId') deviceId: string) {
    return this.sync.bootstrap(shopId, deviceId)
  }

  // --- devices ---------------------------------------------------------------------------------

  @RequirePermission()
  @Audit('device.registered', 'device')
  @Post('devices')
  registerDevice(
    @CurrentShop() shopId: string,
    @Body(new ZodValidationPipe(registerDeviceSchema)) body: RegisterDeviceInput,
  ) {
    return this.devices.register(shopId, body)
  }

  /** Reading the device list exposes where a shop's staff are working — owner-level information. */
  @RequirePermission('device.revoke')
  @Get('devices')
  listDevices(@CurrentShop() shopId: string) {
    return this.devices.list(shopId)
  }

  /** The lost-phone path. Ends the device's sessions as well as flagging it. */
  @RequirePermission('device.revoke')
  @Audit('device.revoked', 'device')
  @Delete('devices/:id')
  revokeDevice(@CurrentShop() shopId: string, @Param('id') id: string) {
    return this.devices.revoke(shopId, id)
  }

  // --- invoice number leases -------------------------------------------------------------------

  /** Any member may lease numbers: a cashier who cannot get one cannot hand over a receipt. */
  @RequirePermission()
  @Post('number-lease')
  issueLease(
    @CurrentShop() shopId: string,
    @Body(new ZodValidationPipe(numberLeaseSchema)) body: NumberLeaseInput,
  ) {
    return this.devices.issueNumberLease(shopId, body)
  }

  @RequirePermission()
  @Get('number-lease')
  currentLease(
    @CurrentShop() shopId: string,
    @Query('deviceId') deviceId: string,
    @Query('series') series = 'INV',
  ) {
    return this.devices.currentLease(shopId, deviceId, series)
  }

  // --- conflict inbox --------------------------------------------------------------------------

  @RequirePermission()
  @Get('conflicts')
  listConflicts(
    @CurrentShop() shopId: string,
    @Query('includeAcknowledged') includeAcknowledged?: string,
  ) {
    return this.conflicts.list(shopId, includeAcknowledged === 'true')
  }

  @RequirePermission()
  @Post('conflicts/:id/acknowledge')
  acknowledgeConflict(@CurrentShop() shopId: string, @Param('id') id: string) {
    return this.conflicts.acknowledge(shopId, id)
  }

  @RequirePermission()
  @Post('conflicts/acknowledge-all')
  acknowledgeAll(@CurrentShop() shopId: string) {
    return this.conflicts.acknowledgeAll(shopId)
  }
}

import { Global, Module } from '@nestjs/common'
import { CatalogueModule } from '../catalogue/catalogue.module'
import { ChangeLogService } from './change-log.service'
import { ConflictsService } from './conflicts.service'
import { DevicesService } from './devices.service'
import { SyncController } from './sync.controller'
import { SyncRetentionJob } from './sync-retention.job'
import { SyncService } from './sync.service'

/**
 * `ChangeLogService` is exported globally because **every** domain service that writes tenant data
 * must append to the change log in the same transaction, and a module that forgets to import it
 * would compile fine and silently produce data no device ever receives. Making it ambient removes
 * that failure mode; `sync-coverage.spec.ts` catches the other half — forgetting to call it.
 */
@Global()
@Module({
  imports: [CatalogueModule],
  controllers: [SyncController],
  providers: [ChangeLogService, SyncService, DevicesService, ConflictsService, SyncRetentionJob],
  exports: [ChangeLogService, SyncRetentionJob],
})
export class SyncModule {}

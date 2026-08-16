import { Global, Module } from '@nestjs/common'
import { InventoryController } from './inventory.controller'
import { InventoryService } from './inventory.service'
import { ReconciliationJob } from './reconciliation.job'

// Global: the sales module (Phase 4) and purchases (Phase 7) both need InventoryService, and it
// must stay the single writer of stock rather than being re-implemented per module.
@Global()
@Module({
  controllers: [InventoryController],
  providers: [InventoryService, ReconciliationJob],
  exports: [InventoryService, ReconciliationJob],
})
export class InventoryModule {}

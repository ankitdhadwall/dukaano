import { Global, Module } from '@nestjs/common'
import { InventoryController } from './inventory.controller'
import { InventoryService } from './inventory.service'

// Global: the sales module (Phase 4) and purchases (Phase 7) both need InventoryService, and it
// must stay the single writer of stock rather than being re-implemented per module.
@Global()
@Module({
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}

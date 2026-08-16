import { Module } from '@nestjs/common'
import { ReturnsService } from './returns.service'
import { SalesController } from './sales.controller'
import { SalesService } from './sales.service'

// InventoryService, LedgerService and ChangeLogService all arrive from @Global() modules — each
// is the single writer of its own table, and this module uses them rather than re-implementing.
@Module({
  controllers: [SalesController],
  providers: [SalesService, ReturnsService],
  exports: [SalesService, ReturnsService],
})
export class SalesModule {}

import { Global, Module } from '@nestjs/common'
import { CustomersService } from './customers.service'
import { KhataController } from './khata.controller'
import { LedgerService } from './ledger.service'
import { PaymentsService } from './payments.service'

// Global for the same reason as InventoryService: LedgerService must stay the single writer of
// `customer_ledger_entry` and `customer_balance`, and sales, returns and payments all need it.
// A module that re-provided its own copy would break `balance == Σ entries` invisibly.
@Global()
@Module({
  controllers: [KhataController],
  providers: [LedgerService, CustomersService, PaymentsService],
  exports: [LedgerService, CustomersService, PaymentsService],
})
export class KhataModule {}

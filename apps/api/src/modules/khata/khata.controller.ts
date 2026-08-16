import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { Audit, CurrentShop, RequirePermission } from '../../common/decorators'
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe'
import {
  createCustomerSchema,
  ledgerAdjustmentSchema,
  recordPaymentSchema,
  reversePaymentSchema,
  updateCustomerSchema,
} from '@dukaano/validation'
import type {
  CreateCustomerInput,
  LedgerAdjustmentInput,
  RecordPaymentInput,
  ReversePaymentInput,
  UpdateCustomerInput,
} from '@dukaano/validation'
import { CustomersService } from './customers.service'
import { LedgerService } from './ledger.service'
import { PaymentsService } from './payments.service'

@Controller('v1')
export class KhataController {
  constructor(
    private readonly customers: CustomersService,
    private readonly payments: PaymentsService,
    private readonly ledger: LedgerService,
  ) {}

  // --- customers ---------------------------------------------------------------------------------

  /** A cashier searches customers constantly while billing on credit. */
  @RequirePermission()
  @Get('customers')
  search(
    @CurrentShop() shopId: string,
    @Query('q') q = '',
    @Query('limit') limit = '20',
  ) {
    return this.customers.search(shopId, q, Math.min(Number(limit) || 20, 50))
  }

  @RequirePermission()
  @Get('customers/:id')
  findOne(@CurrentShop() shopId: string, @Param('id') id: string) {
    return this.customers.findById(shopId, id)
  }

  /** Quick-create during billing uses this same endpoint — a cashier holds `customer.write`. */
  @RequirePermission('customer.write')
  @Audit('customer.created', 'customer')
  @Post('customers')
  create(
    @CurrentShop() shopId: string,
    @Body(new ZodValidationPipe(createCustomerSchema)) body: CreateCustomerInput,
  ) {
    return this.customers.create(shopId, body)
  }

  @RequirePermission('customer.write')
  @Audit('customer.updated', 'customer')
  @Patch('customers/:id')
  update(
    @CurrentShop() shopId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateCustomerSchema)) body: UpdateCustomerInput,
  ) {
    return this.customers.update(shopId, id, body)
  }

  /** Blocked while they owe money (§25 E-8) — a cashier can never do it at all. */
  @RequirePermission('customer.archive')
  @Audit('customer.archived', 'customer')
  @Delete('customers/:id')
  archive(@CurrentShop() shopId: string, @Param('id') id: string) {
    return this.customers.archive(shopId, id)
  }

  // --- khata -------------------------------------------------------------------------------------

  /** The statement a shopkeeper shows a customer who disputes their balance (§18.5). */
  @RequirePermission()
  @Get('customers/:id/statement')
  statement(
    @CurrentShop() shopId: string,
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.ledger.statement(shopId, id, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    })
  }

  /** Who owes what, worst first, bucketed by the age of their oldest unpaid bill. */
  @RequirePermission('sale.view.all')
  @Get('khata/ageing')
  ageing(@CurrentShop() shopId: string) {
    return this.customers.ageing(shopId)
  }

  @RequirePermission('inventory.adjust')
  @Get('khata/reconcile')
  reconcile(@CurrentShop() shopId: string) {
    return this.ledger.reconcile(shopId)
  }

  /**
   * A manual khata correction — Owner only, reason required, permanently visible.
   *
   * `customer.ledger.adjust` is on the Cashier ceiling and can never be granted to one: a cashier
   * who can adjust the ledger can erase their own theft, which is the specific abuse the ceiling
   * exists to prevent.
   */
  @RequirePermission('customer.ledger.adjust')
  @Audit('khata.adjusted', 'customer_ledger_entry')
  @Post('khata/adjustments')
  adjust(
    @CurrentShop() _shopId: string,
    @Body(new ZodValidationPipe(ledgerAdjustmentSchema)) body: LedgerAdjustmentInput,
  ) {
    return this.ledger.append({
      customerId: body.customerId,
      entryType: body.entryType,
      magnitudePaise: body.magnitudePaise,
      reason: body.reason,
      note: body.note,
    })
  }

  // --- payments ----------------------------------------------------------------------------------

  /** Receiving a khata collection is a cashier's job. */
  @RequirePermission('customer.payment.receive')
  @Audit('payment.received', 'payment')
  @Post('payments')
  recordPayment(
    @CurrentShop() shopId: string,
    @Body(new ZodValidationPipe(recordPaymentSchema)) body: RecordPaymentInput,
  ) {
    return this.payments.record(shopId, body)
  }

  @RequirePermission('sale.view.all')
  @Get('payments')
  listPayments(
    @CurrentShop() shopId: string,
    @Query('customerId') customerId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.payments.list(shopId, {
      customerId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: limit ? Number(limit) : undefined,
    })
  }

  /** How much cash should be in the drawer for a business date (§19.4). */
  @RequirePermission('report.sales')
  @Get('payments/day-totals')
  dayTotals(@CurrentShop() shopId: string, @Query('date') date?: string) {
    const businessDate = date ? new Date(date) : new Date()
    return this.payments.dayTotals(
      shopId,
      new Date(`${businessDate.toISOString().slice(0, 10)}T00:00:00.000Z`),
    )
  }

  /**
   * Reverse a payment — a new reversing row, never an edit (§19.3).
   *
   * Requires the ledger-adjust permission rather than `customer.payment.receive`: undoing money
   * that was recorded as received is the same class of act as adjusting the ledger by hand, and a
   * cashier must not be able to do either.
   */
  @RequirePermission('customer.ledger.adjust')
  @Audit('payment.reversed', 'payment')
  @Post('payments/:id/reverse')
  reversePayment(
    @CurrentShop() shopId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reversePaymentSchema)) body: ReversePaymentInput,
  ) {
    return this.payments.reverse(shopId, id, body)
  }
}

import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'
import { Audit, CurrentShop, RequirePermission } from '../../common/decorators'
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe'
import { cancelSaleSchema, createReturnSchema, createSaleSchema } from '@dukaano/validation'
import type { CancelSaleInput, CreateReturnInput, CreateSaleInput } from '@dukaano/validation'
import { ReturnsService } from './returns.service'
import { SalesService } from './sales.service'

@Controller('v1/sales')
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly returns: ReturnsService,
  ) {}

  /**
   * Create a sale — the nine-row-group transaction (§19.2).
   *
   * `sale.create` is the one permission a Cashier holds by default, because a cashier who cannot
   * bill is not a cashier. Everything the bill *implies* — extending credit, discounting — is
   * checked separately below.
   */
  @RequirePermission('sale.create')
  @Audit('sale.created', 'sale')
  @Post()
  create(
    @CurrentShop() shopId: string,
    @Body(new ZodValidationPipe(createSaleSchema)) body: CreateSaleInput,
  ) {
    return this.sales.create(shopId, body)
  }

  @RequirePermission('sale.view.all')
  @Get()
  list(
    @CurrentShop() shopId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('customerId') customerId?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.sales.list(shopId, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      customerId,
      status,
      limit: limit ? Number(limit) : undefined,
    })
  }

  /** Any member may read a bill they are looking at — a cashier reprints receipts. */
  @RequirePermission()
  @Get(':id')
  findOne(@CurrentShop() shopId: string, @Param('id') id: string) {
    return this.sales.findById(shopId, id)
  }

  /**
   * Cancel a sale. Never a delete — compensating rows, original left visible (§25 E-12).
   *
   * Separate permission from creating one: reversing a completed transaction is how a dishonest
   * cashier would cover a theft, and it is the classic reason this permission is split.
   */
  @RequirePermission('sale.cancel')
  @Audit('sale.cancelled', 'sale')
  @Post(':id/cancel')
  cancel(
    @CurrentShop() shopId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(cancelSaleSchema)) body: CancelSaleInput,
  ) {
    return this.sales.cancel(shopId, id, body)
  }

  /** A partial or full return against a bill (§25 E-11, E-39). */
  @RequirePermission('sale.return')
  @Audit('sale.returned', 'sale_return')
  @Post(':id/returns')
  createReturn(
    @CurrentShop() shopId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createReturnSchema)) body: CreateReturnInput,
  ) {
    return this.returns.create(shopId, id, body)
  }

  @RequirePermission()
  @Get(':id/returns')
  listReturns(@CurrentShop() shopId: string, @Param('id') id: string) {
    return this.returns.listForSale(shopId, id)
  }
}

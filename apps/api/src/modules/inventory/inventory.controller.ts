import { Body, Controller, Get, Param, Post } from '@nestjs/common'
import { Audit, CurrentShop, RequirePermission } from '../../common/decorators'
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe'
import { stockAdjustmentSchema } from '@dukaano/validation'
import type { StockAdjustmentInput } from '@dukaano/validation'
import { InventoryService } from './inventory.service'

@Controller('v1/inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @RequirePermission()
  @Get('low-stock')
  lowStock(@CurrentShop() shopId: string) {
    return this.inventory.getLowStock(shopId)
  }

  /** Valuation exposes cost, so it requires the cost permission a Cashier can never hold. */
  @RequirePermission('product.view.cost')
  @Get('valuation')
  valuation(@CurrentShop() shopId: string) {
    return this.inventory.getValuation(shopId)
  }

  /**
   * Reconciliation: balance == Σ transactions (§17.4).
   *
   * Exposed as an endpoint as well as a scheduled job so support can answer "are this shop's
   * numbers trustworthy?" immediately rather than waiting for the nightly run.
   */
  @RequirePermission('inventory.adjust')
  @Get('reconcile')
  reconcile(@CurrentShop() shopId: string) {
    return this.inventory.reconcile(shopId)
  }

  @RequirePermission()
  @Get('products/:productId')
  productStock(@CurrentShop() shopId: string, @Param('productId') productId: string) {
    return this.inventory.getProductStock(shopId, productId)
  }

  /** Manual adjustment. Reason is mandatory — stock never changes without a trace (§17.1). */
  @RequirePermission('inventory.adjust')
  @Audit('inventory.adjusted', 'inventory_transaction')
  @Post('adjustments')
  adjust(
    @CurrentShop() _shopId: string,
    @Body(new ZodValidationPipe(stockAdjustmentSchema)) body: StockAdjustmentInput,
  ) {
    return this.inventory.applyMovement({
      productId: body.productId,
      type: body.type,
      qtyDeltaMilli: body.qtyDeltaMilli,
      reason: body.reason,
      note: body.note,
      unitCostPaise: body.unitCostPaise,
    })
  }
}

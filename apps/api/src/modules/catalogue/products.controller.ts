import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { Audit, CurrentShop, RequirePermission } from '../../common/decorators'
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe'
import { createProductSchema, updateProductSchema } from '@dukaano/validation'
import type { CreateProductInput, UpdateProductInput } from '@dukaano/validation'
import { ProductsService } from './products.service'

@Controller('v1/products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  /**
   * The billing search endpoint. Any authenticated member may call it — a cashier cannot bill
   * without it. Purchase cost is NOT in the response shape; that needs `product.view.cost`,
   * which a Cashier can never hold.
   */
  @RequirePermission()
  @Get('search')
  search(
    @CurrentShop() shopId: string,
    @Query('q') q = '',
    @Query('limit') limit = '20',
  ) {
    return this.products.search(shopId, q, Math.min(Number(limit) || 20, 50))
  }

  @RequirePermission()
  @Get(':id')
  findOne(@CurrentShop() shopId: string, @Param('id') id: string) {
    return this.products.findById(shopId, id)
  }

  /** Quick-create during billing uses this same endpoint (journey J6). */
  @RequirePermission('product.write')
  @Audit('product.created', 'product')
  @Post()
  create(
    @CurrentShop() shopId: string,
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductInput,
  ) {
    return this.products.create(shopId, body)
  }

  @RequirePermission('product.write')
  @Audit('product.updated', 'product')
  @Patch(':id')
  update(
    @CurrentShop() shopId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductInput,
  ) {
    return this.products.update(shopId, id, body)
  }

  @RequirePermission('product.archive')
  @Audit('product.archived', 'product')
  @Delete(':id')
  archive(@CurrentShop() shopId: string, @Param('id') id: string) {
    return this.products.archive(shopId, id)
  }
}

import { Body, Controller, Get, Post, Query } from '@nestjs/common'
import { Audit, CurrentShop, RequirePermission } from '../../common/decorators'
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe'
import { adoptMasterProductsSchema } from '@dukaano/validation'
import type { AdoptMasterProductsInput } from '@dukaano/validation'
import { MasterCatalogueService } from './master-catalogue.service'

@Controller('v1/master-catalogue')
export class MasterCatalogueController {
  constructor(private readonly master: MasterCatalogueService) {}

  /**
   * Browse the platform catalogue, with `alreadyAdded` per item.
   *
   * `commonOnly=true` is what the onboarding screen calls: the ~40 items nearly every Kirana shop
   * stocks, which is the one-tap path out of the cold-start problem (risk R-1).
   */
  @RequirePermission()
  @Get()
  browse(
    @CurrentShop() shopId: string,
    @Query('categoryId') categoryId?: string,
    @Query('commonOnly') commonOnly?: string,
  ) {
    return this.master.browse(shopId, { categoryId, commonOnly: commonOnly === 'true' })
  }

  /**
   * Adopt master products into this shop. Prices are supplied per item, never copied.
   *
   * Requires `product.write` — the same permission as creating a product by hand, because that is
   * exactly what this is.
   */
  @RequirePermission('product.write')
  @Audit('product.adoptedFromMaster', 'product')
  @Post('adopt')
  adopt(
    @CurrentShop() shopId: string,
    @Body(new ZodValidationPipe(adoptMasterProductsSchema)) body: AdoptMasterProductsInput,
  ) {
    return this.master.adopt(shopId, body)
  }
}

import { Body, Controller, Get, Param, Patch } from '@nestjs/common'
import { shopProfileSchema, shopSettingsSchema } from '@dukaano/validation'
import type { ShopProfileInput, ShopSettingsInput } from '@dukaano/validation'
import { Audit, CurrentShop, RequirePermission } from '../../common/decorators'
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe'
import { ShopsService } from './shops.service'

@Controller('v1/shops')
export class ShopsController {
  constructor(private readonly shops: ShopsService) {}

  /** Any authenticated member may read their own shop. */
  @RequirePermission()
  @Get('current')
  current(@CurrentShop() shopId: string) {
    return this.shops.findCurrent(shopId)
  }

  @RequirePermission('settings.manage')
  @Audit('shop.profile.updated', 'shop')
  @Patch('current')
  updateProfile(
    @CurrentShop() shopId: string,
    @Body(new ZodValidationPipe(shopProfileSchema)) body: ShopProfileInput,
  ) {
    return this.shops.updateProfile(shopId, body)
  }

  @RequirePermission()
  @Get('current/settings')
  settings(@CurrentShop() shopId: string) {
    return this.shops.findSettings(shopId)
  }

  @RequirePermission('settings.manage')
  @Audit('shop.settings.updated', 'shop_settings')
  @Patch('current/settings')
  updateSettings(
    @CurrentShop() shopId: string,
    @Body(new ZodValidationPipe(shopSettingsSchema)) body: ShopSettingsInput,
  ) {
    return this.shops.updateSettings(shopId, body)
  }

  /**
   * Fetch a shop by id.
   *
   * This route exists specifically to be attacked. Passing another shop's id must return 404 —
   * never 403, which would confirm the shop exists (§23.3). The generated tenant-isolation
   * suite calls this with a foreign id and asserts the status code.
   */
  @RequirePermission()
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.shops.findById(id)
  }
}

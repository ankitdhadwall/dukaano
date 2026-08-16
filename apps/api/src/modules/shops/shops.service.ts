import { Injectable } from '@nestjs/common'
import type { ShopProfileInput, ShopSettingsInput } from '@dukaano/validation'
import { NotFoundError } from '../../common/errors/domain-error'
import { tenantClient } from '../../common/prisma/tenant-context'

/**
 * Shop profile and settings.
 *
 * Every read goes through `tenantClient()`, which is the transaction the interceptor opened with
 * `app.shop_id` set. No method here filters by shop_id in its WHERE clause — it does not need to,
 * because RLS does it, and relying on the database rather than on the developer remembering is
 * the entire point of §13.
 */
@Injectable()
export class ShopsService {
  async findCurrent(shopId: string) {
    return this.findById(shopId)
  }

  /**
   * Look up a shop by id.
   *
   * Note there is no `AND shop_id = :current` here. Under RLS a foreign id simply matches no row,
   * so the NotFoundError below is what an attacker receives — indistinguishable from an id that
   * never existed (§23.3).
   */
  async findById(id: string) {
    const shop = await tenantClient().shop.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        shopType: true,
        phone: true,
        addressLine: true,
        city: true,
        stateCode: true,
        pincode: true,
        timezone: true,
        defaultLocale: true,
        currency: true,
        status: true,
        createdAt: true,
      },
    })
    if (!shop) throw new NotFoundError('Shop', id)
    return shop
  }

  async updateProfile(shopId: string, input: ShopProfileInput) {
    // A WHERE that matches no row under RLS throws P2025, which the filter maps to 404.
    return tenantClient().shop.update({
      where: { id: shopId },
      data: {
        name: input.name,
        shopType: input.shopType ?? undefined,
        phone: input.phone ?? undefined,
        addressLine: input.addressLine ?? undefined,
        city: input.city ?? undefined,
        stateCode: input.stateCode ?? undefined,
        pincode: input.pincode ?? undefined,
        timezone: input.timezone ?? undefined,
        defaultLocale: input.defaultLocale ?? undefined,
      },
      select: { id: true, name: true, timezone: true, defaultLocale: true },
    })
  }

  async findSettings(shopId: string) {
    const settings = await tenantClient().shopSettings.findUnique({ where: { shopId } })
    if (!settings) throw new NotFoundError('ShopSettings', shopId)
    return settings
  }

  async updateSettings(shopId: string, input: ShopSettingsInput) {
    return tenantClient().shopSettings.update({
      where: { shopId },
      data: {
        negativeStockPolicy: input.negativeStockPolicy ?? undefined,
        roundingPolicy: input.roundingPolicy ?? undefined,
        businessDayStartHour: input.businessDayStartHour ?? undefined,
        messagingChannel: input.messagingChannel ?? undefined,
        receiptFooter: input.receiptFooter ?? undefined,
        sendReceiptByDefault: input.sendReceiptByDefault ?? undefined,
        reminderCooldownDays: input.reminderCooldownDays ?? undefined,
        defaultLowStockThresholdMilli: input.defaultLowStockThresholdMilli ?? undefined,
        maxCashierDiscountBp: input.maxCashierDiscountBp ?? undefined,
      },
    })
  }
}

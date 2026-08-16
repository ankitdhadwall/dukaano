import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { AdoptMasterProductsInput } from '@dukaano/validation'
import { UNIT_DEFINITIONS, type UnitCode } from '@dukaano/types'
import { BusinessRuleError } from '../../common/errors/domain-error'
import { PrismaService } from '../../common/prisma/prisma.service'
import { currentContext, tenantClient } from '../../common/prisma/tenant-context'
import { ChangeLogService } from '../sync/change-log.service'
import { InventoryService } from '../inventory/inventory.service'

/**
 * The platform master catalogue, and one-tap adoption from it (blueprint §7).
 *
 * This is the primary mitigation for risk R-1 — a shopkeeper must enter hundreds of products
 * before the app repays the effort, and the honest expectation is that most abandon before they
 * get there. Adopting forty common items in one tap turns the first session from data entry into
 * a working shop.
 *
 * **Prices are never copied.** `hintPricePaise` on a master row exists so the UI can pre-fill a
 * plausible number, but adoption requires an explicit price per item on the wire. Sugar costs
 * differently in Shimla and Solan, and a shelf price the shopkeeper never agreed to is worse than
 * no price at all — they would find out when a customer disputed a bill.
 */
@Injectable()
export class MasterCatalogueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly changeLog: ChangeLogService,
  ) {}

  /**
   * Browse the master catalogue, flagging what this shop already has.
   *
   * Read through the untenanted client: `master_category` and `master_product` are platform
   * tables with no `shop_id` and no RLS policy, and reading them through the tenant client would
   * work only by accident. Being explicit here documents that this data is deliberately shared,
   * unlike everything else the request touches.
   */
  async browse(shopId: string, options: { categoryId?: string; commonOnly?: boolean } = {}) {
    const categories = await this.prisma.untenanted.masterCategory.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, nameEn: true, nameHi: true, icon: true, sortOrder: true },
    })

    const products = await this.prisma.untenanted.masterProduct.findMany({
      where: {
        isActive: true,
        ...(options.categoryId ? { categoryId: options.categoryId } : {}),
        ...(options.commonOnly ? { isCommon: true } : {}),
      },
      orderBy: [{ categoryId: 'asc' }, { sortOrder: 'asc' }],
      select: {
        id: true,
        categoryId: true,
        nameEn: true,
        nameHi: true,
        aliases: true,
        unitCode: true,
        hintPricePaise: true,
        isCommon: true,
      },
    })

    // Which of these has the shop already taken? Read through the tenant client so RLS applies —
    // this half of the query IS tenant data.
    const adopted = await tenantClient().product.findMany({
      where: { shopId, masterProductId: { not: null }, archivedAt: null },
      select: { masterProductId: true },
    })
    const adoptedIds = new Set(adopted.map((row) => row.masterProductId))

    return {
      categories,
      products: products.map((product) => ({ ...product, alreadyAdded: adoptedIds.has(product.id) })),
    }
  }

  /**
   * Create shop products from master rows.
   *
   * Runs inside the request's tenant transaction, so the whole batch commits or none of it does.
   * A half-applied "add 40 common items" would leave the shopkeeper with a partial catalogue and
   * no indication of where it stopped.
   */
  async adopt(shopId: string, input: AdoptMasterProductsInput) {
    const requestedIds = input.items.map((item) => item.masterProductId)
    const uniqueIds = new Set(requestedIds)
    if (uniqueIds.size !== requestedIds.length) {
      throw new BusinessRuleError(
        'DUPLICATE_MASTER_PRODUCT',
        'errors.import.duplicateInRequest',
        {},
        'The same master product appears more than once in this request',
      )
    }

    const masters = await this.prisma.untenanted.masterProduct.findMany({
      where: { id: { in: [...uniqueIds] }, isActive: true },
      select: { id: true, nameEn: true, nameHi: true, aliases: true, unitCode: true, categoryId: true },
    })
    const mastersById = new Map(masters.map((master) => [master.id, master]))

    // Pair each request item with its master row once, here, so nothing downstream has to look it
    // up again and assert the result is present.
    type MasterRow = (typeof masters)[number]
    const resolved: { item: (typeof input.items)[number]; master: MasterRow }[] = []
    const missing: string[] = []
    for (const item of input.items) {
      const master = mastersById.get(item.masterProductId)
      if (master) resolved.push({ item, master })
      else missing.push(item.masterProductId)
    }

    if (missing.length > 0) {
      throw new BusinessRuleError(
        'MASTER_PRODUCT_NOT_FOUND',
        'errors.import.masterProductNotFound',
        { count: missing.length },
        `Unknown or inactive master products: ${missing.join(', ')}`,
      )
    }

    // Already-adopted items are skipped rather than duplicated. A shopkeeper who taps "add common
    // items" twice should end up with one Sugar, not two — and should not get an error either,
    // because from their side nothing went wrong.
    const existing = await tenantClient().product.findMany({
      where: { shopId, masterProductId: { in: [...uniqueIds] }, archivedAt: null },
      select: { masterProductId: true },
    })
    const alreadyAdopted = new Set(existing.map((row) => row.masterProductId))

    const categoryIdByMaster = await this.mapMasterCategoriesToShop(shopId, masters)

    const userId = currentContext()?.userId ?? null
    const created: { id: string; item: (typeof input.items)[number]; master: MasterRow }[] = []
    const openingStock: { productId: string; qtyMilli: number; unitCostPaise?: number }[] = []
    const aliasRows: { id: string; shopId: string; productId: string; alias: string }[] = []

    for (const { item, master } of resolved) {
      if (alreadyAdopted.has(item.masterProductId)) continue

      const unitCode = master.unitCode as UnitCode
      const decimals = UNIT_DEFINITIONS[unitCode]?.decimals ?? 3
      if (decimals === 0 && item.openingStockMilli && item.openingStockMilli % 1000 !== 0) {
        throw new BusinessRuleError(
          'FRACTIONAL_QUANTITY',
          'errors.quantity.tooManyDecimals',
          { max: 0, product: master.nameEn },
          `Unit ${unitCode} does not allow fractional quantities`,
        )
      }

      const productId = randomUUID()
      created.push({ id: productId, item, master })

      for (const alias of new Set(master.aliases.map((a) => a.trim().toLowerCase()).filter(Boolean))) {
        aliasRows.push({ id: randomUUID(), shopId, productId, alias })
      }

      if (item.openingStockMilli && item.openingStockMilli > 0) {
        openingStock.push({
          productId,
          qtyMilli: item.openingStockMilli,
          unitCostPaise: item.purchasePricePaise,
        })
      }
    }

    if (created.length === 0) {
      return { createdCount: 0, skippedCount: input.items.length, products: [] }
    }

    const tx = tenantClient()

    await tx.product.createMany({
      data: created.map(({ id, item, master }) => ({
        id,
        shopId,
        masterProductId: master.id,
        categoryId: categoryIdByMaster.get(master.categoryId) ?? null,
        nameEn: master.nameEn,
        nameHi: master.nameHi,
        unitCode: master.unitCode,
        sellingPricePaise: BigInt(item.sellingPricePaise),
        purchasePricePaise:
          item.purchasePricePaise !== undefined ? BigInt(item.purchasePricePaise) : null,
        mrpPaise: item.mrpPaise !== undefined ? BigInt(item.mrpPaise) : null,
        lowStockThresholdMilli: BigInt(item.lowStockThresholdMilli ?? 0),
        createdByUserId: userId,
        updatedByUserId: userId,
      })),
    })

    if (aliasRows.length > 0) {
      await tx.productAlias.createMany({ data: aliasRows, skipDuplicates: true })
    }

    // Adoption creates products in bulk, bypassing ProductsService, so it logs its own changes
    // — an adopted catalogue that never reaches the phone is worse than one never adopted.
    await this.changeLog.recordMany(
      created.map(({ id }) => ({ entity: 'product' as const, entityId: id, op: 'upsert' as const, rowVersion: 1 })),
    )

    // Opening stock as OPENING_STOCK transactions, never a bare balance write (§17.2). Safe to
    // batch: every product id here was created two statements ago in this same transaction.
    await this.inventory.applyOpeningStockBatch(openingStock)

    return {
      createdCount: created.length,
      skippedCount: input.items.length - created.length,
      products: created.map(({ id, master }) => ({ id, nameEn: master.nameEn })),
    }
  }

  /**
   * Ensure the shop has a category mirroring each master category the adopted products belong to.
   *
   * Adopted products land in a category named the same as the platform's, created on demand and
   * linked by `master_category_id` so a second adoption reuses it rather than making a twin.
   */
  private async mapMasterCategoriesToShop(
    shopId: string,
    masters: readonly { categoryId: string }[],
  ): Promise<Map<string, string>> {
    const masterCategoryIds = [...new Set(masters.map((master) => master.categoryId))]
    if (masterCategoryIds.length === 0) return new Map()

    const existing = await tenantClient().category.findMany({
      where: { shopId, masterCategoryId: { in: masterCategoryIds }, archivedAt: null },
      select: { id: true, masterCategoryId: true },
    })
    const mapped = new Map(
      existing.map((row) => [row.masterCategoryId as string, row.id] as const),
    )

    const missing = masterCategoryIds.filter((id) => !mapped.has(id))
    if (missing.length === 0) return mapped

    const masterCategories = await this.prisma.untenanted.masterCategory.findMany({
      where: { id: { in: missing } },
      select: { id: true, nameEn: true, nameHi: true, sortOrder: true },
    })

    const toCreate = masterCategories.map((category) => ({
      id: randomUUID(),
      shopId,
      masterCategoryId: category.id,
      nameEn: category.nameEn,
      nameHi: category.nameHi,
      sortOrder: category.sortOrder,
    }))

    if (toCreate.length > 0) {
      await tenantClient().category.createMany({ data: toCreate })
      for (const category of toCreate) mapped.set(category.masterCategoryId, category.id)
    }

    return mapped
  }
}

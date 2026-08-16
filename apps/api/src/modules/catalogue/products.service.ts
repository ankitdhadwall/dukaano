import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { UNIT_DEFINITIONS, type UnitCode } from '@dukaano/types'
import { ConflictError, NotFoundError, BusinessRuleError } from '../../common/errors/domain-error'
import { currentContext, tenantClient } from '../../common/prisma/tenant-context'
import { InventoryService } from '../inventory/inventory.service'

export interface CreateProductInput {
  nameEn?: string
  nameHi?: string
  sku?: string
  shortCode?: string
  categoryId?: string
  unitCode: UnitCode
  sellingPricePaise: number
  purchasePricePaise?: number
  mrpPaise?: number
  lowStockThresholdMilli?: number
  openingStockMilli?: number
  aliases?: string[]
}

export interface ProductSearchResult {
  id: string
  nameEn: string | null
  nameHi: string | null
  sku: string | null
  shortCode: string | null
  unitCode: string
  sellingPricePaise: bigint
  qtyMilli: bigint
  lowStockThresholdMilli: bigint
}

@Injectable()
export class ProductsService {
  constructor(private readonly inventory: InventoryService) {}

  /**
   * Billing search — the single most performance-sensitive query in Dukaano.
   *
   * Blueprint §5: typing "sug" must show Sugar Loose, Sugar 1kg and Sugar 500g before the
   * shopkeeper's finger leaves the key. The acceptance bar is under 100 ms at 5,000 products.
   *
   * Ranking, in the order a shopkeeper expects:
   *   1. exact short-code match  — they typed a code, they want that product, nothing else
   *   2. exact SKU match
   *   3. prefix match on name or alias — "sug" → "Sugar …"
   *   4. anything else containing the term
   *
   * Aliases carry equal weight to names, which is what makes the Hindi story work: typing
   * "chini" finds चीनी even though the term appears in neither the English nor the Hindi name.
   * Without that, search silently fails for the users the product was built for.
   *
   * Raw SQL rather than Prisma here, deliberately: the ranking is a CASE expression over a
   * UNION of name and alias matches, which Prisma's query builder cannot express, and this query
   * runs on every keystroke.
   */
  async search(shopId: string, term: string, limit = 20): Promise<ProductSearchResult[]> {
    const trimmed = term.trim().toLowerCase()
    if (trimmed.length === 0) return this.recent(shopId, limit)

    const prefix = `${trimmed}%`
    const contains = `%${trimmed}%`

    return tenantClient().$queryRaw<ProductSearchResult[]>`
      SELECT p.id, p.name_en AS "nameEn", p.name_hi AS "nameHi", p.sku, p.short_code AS "shortCode",
             p.unit_code AS "unitCode", p.selling_price_paise AS "sellingPricePaise",
             coalesce(b.qty_milli, 0) AS "qtyMilli",
             p.low_stock_threshold_milli AS "lowStockThresholdMilli"
      FROM product p
      LEFT JOIN inventory_balance b ON b.shop_id = p.shop_id AND b.product_id = p.id
      WHERE p.shop_id = ${shopId}::uuid
        AND p.archived_at IS NULL
        AND p.is_active = true
        AND (
          p.search_text LIKE ${contains}
          OR EXISTS (
            SELECT 1 FROM product_alias a
            WHERE a.shop_id = p.shop_id AND a.product_id = p.id AND lower(a.alias) LIKE ${contains}
          )
        )
      ORDER BY
        CASE
          WHEN lower(p.short_code) = ${trimmed} THEN 0
          WHEN lower(p.sku) = ${trimmed}        THEN 1
          WHEN lower(coalesce(p.name_en, '')) LIKE ${prefix} THEN 2
          WHEN lower(coalesce(p.name_hi, '')) LIKE ${prefix} THEN 2
          WHEN EXISTS (
            SELECT 1 FROM product_alias a
            WHERE a.shop_id = p.shop_id AND a.product_id = p.id AND lower(a.alias) LIKE ${prefix}
          ) THEN 3
          ELSE 4
        END,
        p.name_en NULLS LAST
      LIMIT ${limit}
    `
  }

  /** Most recently created products, shown when the search box is empty. */
  async recent(shopId: string, limit = 20): Promise<ProductSearchResult[]> {
    return tenantClient().$queryRaw<ProductSearchResult[]>`
      SELECT p.id, p.name_en AS "nameEn", p.name_hi AS "nameHi", p.sku, p.short_code AS "shortCode",
             p.unit_code AS "unitCode", p.selling_price_paise AS "sellingPricePaise",
             coalesce(b.qty_milli, 0) AS "qtyMilli",
             p.low_stock_threshold_milli AS "lowStockThresholdMilli"
      FROM product p
      LEFT JOIN inventory_balance b ON b.shop_id = p.shop_id AND b.product_id = p.id
      WHERE p.shop_id = ${shopId}::uuid AND p.archived_at IS NULL AND p.is_active = true
      ORDER BY p.created_at DESC
      LIMIT ${limit}
    `
  }

  async findById(shopId: string, id: string) {
    const product = await tenantClient().product.findFirst({
      where: { id, shopId },
      include: {
        aliases: { select: { id: true, alias: true } },
        balance: { select: { qtyMilli: true, avgCostPaise: true } },
        category: { select: { id: true, nameEn: true, nameHi: true } },
      },
    })
    if (!product) throw new NotFoundError('Product', id)
    return product
  }

  /**
   * Create a product, optionally with opening stock.
   *
   * Opening stock is written as an `OPENING_STOCK` inventory transaction, never as a bare
   * balance (§17.2, journey J2). Writing the balance directly would be one line shorter and
   * would immediately break the invariant the reconciliation job checks.
   */
  async create(shopId: string, input: CreateProductInput) {
    if (!input.nameEn?.trim() && !input.nameHi?.trim()) {
      throw new BusinessRuleError('NAME_REQUIRED', 'errors.product.nameRequired')
    }

    const unit = UNIT_DEFINITIONS[input.unitCode]
    if (!unit) {
      throw new BusinessRuleError('INVALID_UNIT', 'errors.product.invalidUnit', { unit: input.unitCode })
    }

    // A whole-number unit must not be given fractional opening stock — "1.5 pieces" is rejected
    // at the source rather than silently truncated (§25 E-22).
    if (unit.decimals === 0 && input.openingStockMilli && input.openingStockMilli % 1000 !== 0) {
      throw new BusinessRuleError(
        'FRACTIONAL_QUANTITY',
        'errors.quantity.tooManyDecimals',
        { max: 0 },
        `Unit ${input.unitCode} does not allow fractional quantities`,
      )
    }

    await this.assertCodesAreFree(shopId, input.sku, input.shortCode)

    const tx = tenantClient()
    const productId = randomUUID()
    const userId = currentContext()?.userId ?? null

    await tx.product.create({
      data: {
        id: productId,
        shopId,
        nameEn: input.nameEn?.trim() || null,
        nameHi: input.nameHi?.trim() || null,
        sku: input.sku?.trim() || null,
        shortCode: input.shortCode?.trim() || null,
        categoryId: input.categoryId ?? null,
        unitCode: input.unitCode,
        sellingPricePaise: BigInt(input.sellingPricePaise),
        purchasePricePaise:
          input.purchasePricePaise !== undefined ? BigInt(input.purchasePricePaise) : null,
        mrpPaise: input.mrpPaise !== undefined ? BigInt(input.mrpPaise) : null,
        lowStockThresholdMilli: BigInt(input.lowStockThresholdMilli ?? 0),
        createdByUserId: userId,
        updatedByUserId: userId,
      },
    })

    const aliases = (input.aliases ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean)
    if (aliases.length > 0) {
      await tx.productAlias.createMany({
        data: [...new Set(aliases)].map((alias) => ({ id: randomUUID(), shopId, productId, alias })),
        skipDuplicates: true,
      })
    }

    if (input.openingStockMilli && input.openingStockMilli !== 0) {
      await this.inventory.applyMovement({
        productId,
        type: 'OPENING_STOCK',
        qtyDeltaMilli: input.openingStockMilli,
        unitCostPaise: input.purchasePricePaise,
      })
    }

    return this.findById(shopId, productId)
  }

  /**
   * Update a product.
   *
   * A price change here never touches historical sales: `sale_item` holds a snapshot of the
   * price the customer was quoted (§25 E-4, E-10). Editing a price is a forward-looking act.
   */
  async update(shopId: string, id: string, input: Partial<CreateProductInput>) {
    const existing = await tenantClient().product.findFirst({
      where: { id, shopId },
      select: { id: true, sku: true, shortCode: true, unitCode: true },
    })
    if (!existing) throw new NotFoundError('Product', id)

    await this.assertCodesAreFree(shopId, input.sku, input.shortCode, id)

    /*
     * Changing the unit while stock is non-zero is BLOCKED (§25 E-37).
     *
     * A product holding 45,000 milli means 45 kg under KG and 45 pieces under PIECE. Silently
     * reinterpreting it would corrupt both the stock number and every valuation that reads it,
     * with no trace of what happened. The shopkeeper must zero the stock via an adjustment
     * first, which leaves an auditable record of the decision.
     */
    if (input.unitCode && input.unitCode !== existing.unitCode) {
      const balance = await tenantClient().inventoryBalance.findUnique({
        where: { shopId_productId: { shopId, productId: id } },
        select: { qtyMilli: true },
      })
      if (balance && balance.qtyMilli !== 0n) {
        throw new BusinessRuleError(
          'UNIT_CHANGE_BLOCKED',
          'errors.product.unitChangeBlocked',
          { from: existing.unitCode, to: input.unitCode },
          'Zero the stock with an adjustment before changing the unit',
        )
      }
    }

    await tenantClient().product.update({
      where: { id },
      data: {
        nameEn: input.nameEn !== undefined ? input.nameEn.trim() || null : undefined,
        nameHi: input.nameHi !== undefined ? input.nameHi.trim() || null : undefined,
        sku: input.sku !== undefined ? input.sku.trim() || null : undefined,
        shortCode: input.shortCode !== undefined ? input.shortCode.trim() || null : undefined,
        categoryId: input.categoryId ?? undefined,
        unitCode: input.unitCode ?? undefined,
        sellingPricePaise:
          input.sellingPricePaise !== undefined ? BigInt(input.sellingPricePaise) : undefined,
        purchasePricePaise:
          input.purchasePricePaise !== undefined ? BigInt(input.purchasePricePaise) : undefined,
        lowStockThresholdMilli:
          input.lowStockThresholdMilli !== undefined
            ? BigInt(input.lowStockThresholdMilli)
            : undefined,
        updatedByUserId: currentContext()?.userId ?? null,
        rowVersion: { increment: 1n },
      },
    })

    return this.findById(shopId, id)
  }

  /**
   * Archive a product.
   *
   * Soft only. Historical sale lines hold name/unit/price snapshots, so old bills still render
   * correctly years later (§25 E-9). Stock is deliberately NOT zeroed — the goods may physically
   * still be on the shelf, and silently discarding a stock position would corrupt the valuation.
   */
  async archive(shopId: string, id: string) {
    const product = await tenantClient().product.findFirst({
      where: { id, shopId, archivedAt: null },
      select: { id: true },
    })
    if (!product) throw new NotFoundError('Product', id)

    return tenantClient().product.update({
      where: { id },
      data: { archivedAt: new Date(), isActive: false, rowVersion: { increment: 1n } },
      select: { id: true, archivedAt: true },
    })
  }

  /**
   * SKU and short code are unique per shop, excluding archived products (§25 E-14, E-15).
   *
   * Checked in application code as well as by the partial unique index so the shopkeeper gets a
   * message naming the conflicting product rather than a database constraint error.
   */
  private async assertCodesAreFree(
    shopId: string,
    sku?: string,
    shortCode?: string,
    excludeId?: string,
  ): Promise<void> {
    const checks: { field: 'sku' | 'shortCode'; value: string }[] = []
    if (sku?.trim()) checks.push({ field: 'sku', value: sku.trim() })
    if (shortCode?.trim()) checks.push({ field: 'shortCode', value: shortCode.trim() })

    for (const check of checks) {
      const clash = await tenantClient().product.findFirst({
        where: {
          shopId,
          archivedAt: null,
          ...(excludeId ? { NOT: { id: excludeId } } : {}),
          [check.field]: { equals: check.value, mode: 'insensitive' },
        },
        select: { id: true, nameEn: true, nameHi: true },
      })

      if (clash) {
        throw new ConflictError('DUPLICATE_CODE', 'errors.product.duplicateSku', {
          sku: check.value,
          existing: clash.nameEn ?? clash.nameHi ?? clash.id,
        })
      }
    }
  }
}

import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { CreateCategoryInput, UpdateCategoryInput } from '@dukaano/validation'
import { BusinessRuleError, NotFoundError } from '../../common/errors/domain-error'
import { tenantClient } from '../../common/prisma/tenant-context'

/**
 * Categories — organisational only.
 *
 * Nothing financial hangs off a category: no pricing rule, no tax rate, no report that would
 * change its answer if a product moved between them. That is what makes renaming free and
 * archiving cheap, and it is worth stating because the obvious next feature request
 * ("category-wise GST") would change it and must be treated as a schema decision, not a tweak.
 */
@Injectable()
export class CategoriesService {
  /** Categories with a live product count, so the UI can warn before archiving a populated one. */
  async list(shopId: string, includeArchived = false) {
    return tenantClient().$queryRaw<
      {
        id: string
        nameEn: string | null
        nameHi: string | null
        sortOrder: number
        archivedAt: Date | null
        productCount: bigint
      }[]
    >`
      SELECT c.id, c.name_en AS "nameEn", c.name_hi AS "nameHi",
             c.sort_order AS "sortOrder", c.archived_at AS "archivedAt",
             count(p.id) FILTER (WHERE p.archived_at IS NULL) AS "productCount"
      FROM category c
      LEFT JOIN product p ON p.shop_id = c.shop_id AND p.category_id = c.id
      WHERE c.shop_id = ${shopId}::uuid
        AND (${includeArchived}::boolean OR c.archived_at IS NULL)
      GROUP BY c.id
      ORDER BY c.sort_order, c.name_en NULLS LAST
    `
  }

  async findById(shopId: string, id: string) {
    const category = await tenantClient().category.findFirst({ where: { id, shopId } })
    if (!category) throw new NotFoundError('Category', id)
    return category
  }

  async create(shopId: string, input: CreateCategoryInput) {
    await this.assertNameIsFree(shopId, input.nameEn, input.nameHi)

    return tenantClient().category.create({
      data: {
        id: randomUUID(),
        shopId,
        nameEn: input.nameEn?.trim() || null,
        nameHi: input.nameHi?.trim() || null,
        sortOrder: input.sortOrder ?? 0,
      },
    })
  }

  async update(shopId: string, id: string, input: UpdateCategoryInput) {
    await this.findById(shopId, id)
    await this.assertNameIsFree(shopId, input.nameEn, input.nameHi, id)

    return tenantClient().category.update({
      where: { id },
      data: {
        nameEn: input.nameEn !== undefined ? input.nameEn.trim() || null : undefined,
        nameHi: input.nameHi !== undefined ? input.nameHi.trim() || null : undefined,
        sortOrder: input.sortOrder ?? undefined,
      },
    })
  }

  /**
   * Archive a category.
   *
   * Products keep their `category_id` and stay fully sellable. Nulling it would be tidier in the
   * schema and worse for the shopkeeper: they archived a *label*, and finding that forty products
   * had quietly become uncategorised is a bigger problem than the one they were solving. An
   * archived category simply stops appearing in pickers.
   */
  async archive(shopId: string, id: string) {
    const category = await tenantClient().category.findFirst({
      where: { id, shopId, archivedAt: null },
      select: { id: true },
    })
    if (!category) throw new NotFoundError('Category', id)

    return tenantClient().category.update({
      where: { id },
      data: { archivedAt: new Date() },
      select: { id: true, archivedAt: true },
    })
  }

  /**
   * Find a category by either name, creating it if absent. Used by the bulk import.
   *
   * Matching is case-insensitive and checks both languages, because a shopkeeper importing a file
   * labelled "staples" should land in the existing "Staples", not create a near-duplicate they
   * then have to merge by hand. Archived categories are excluded from the match: reviving one
   * silently would undo a deliberate decision.
   */
  async findOrCreateByName(shopId: string, name: string, isHindi: boolean): Promise<string> {
    const trimmed = name.trim().slice(0, 80)

    const existing = await tenantClient().category.findFirst({
      where: {
        shopId,
        archivedAt: null,
        OR: [
          { nameEn: { equals: trimmed, mode: 'insensitive' } },
          { nameHi: { equals: trimmed, mode: 'insensitive' } },
        ],
      },
      select: { id: true },
    })
    if (existing) return existing.id

    const created = await tenantClient().category.create({
      data: {
        id: randomUUID(),
        shopId,
        nameEn: isHindi ? null : trimmed,
        nameHi: isHindi ? trimmed : null,
      },
      select: { id: true },
    })
    return created.id
  }

  /** Two categories with the same name are a UI trap — the shopkeeper cannot tell them apart. */
  private async assertNameIsFree(
    shopId: string,
    nameEn?: string,
    nameHi?: string,
    excludeId?: string,
  ): Promise<void> {
    const names = [nameEn?.trim(), nameHi?.trim()].filter((n): n is string => Boolean(n))
    if (names.length === 0) return

    const clash = await tenantClient().category.findFirst({
      where: {
        shopId,
        archivedAt: null,
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
        OR: names.flatMap((name) => [
          { nameEn: { equals: name, mode: 'insensitive' as const } },
          { nameHi: { equals: name, mode: 'insensitive' as const } },
        ]),
      },
      select: { id: true, nameEn: true, nameHi: true },
    })

    if (clash) {
      throw new BusinessRuleError('DUPLICATE_CATEGORY', 'errors.category.duplicate', {
        name: clash.nameEn ?? clash.nameHi ?? '',
      })
    }
  }
}

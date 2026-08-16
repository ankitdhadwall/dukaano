import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { Audit, CurrentShop, RequirePermission } from '../../common/decorators'
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe'
import { createCategorySchema, updateCategorySchema } from '@dukaano/validation'
import type { CreateCategoryInput, UpdateCategoryInput } from '@dukaano/validation'
import { CategoriesService } from './categories.service'

@Controller('v1/categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  /** Any member may read categories — a cashier needs them to browse while billing. */
  @RequirePermission()
  @Get()
  list(@CurrentShop() shopId: string, @Query('includeArchived') includeArchived?: string) {
    return this.categories.list(shopId, includeArchived === 'true')
  }

  @RequirePermission()
  @Get(':id')
  findOne(@CurrentShop() shopId: string, @Param('id') id: string) {
    return this.categories.findById(shopId, id)
  }

  @RequirePermission('product.write')
  @Audit('category.created', 'category')
  @Post()
  create(
    @CurrentShop() shopId: string,
    @Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategoryInput,
  ) {
    return this.categories.create(shopId, body)
  }

  @RequirePermission('product.write')
  @Audit('category.updated', 'category')
  @Patch(':id')
  update(
    @CurrentShop() shopId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateCategorySchema)) body: UpdateCategoryInput,
  ) {
    return this.categories.update(shopId, id, body)
  }

  /** Soft archive. Products keep their category and stay sellable — see the service comment. */
  @RequirePermission('product.archive')
  @Audit('category.archived', 'category')
  @Delete(':id')
  archive(@CurrentShop() shopId: string, @Param('id') id: string) {
    return this.categories.archive(shopId, id)
  }
}

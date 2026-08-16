import { Module } from '@nestjs/common'
import { CategoriesController } from './categories.controller'
import { CategoriesService } from './categories.service'
import { ImportController } from './import.controller'
import { ImportService } from './import.service'
import { MasterCatalogueController } from './master-catalogue.controller'
import { MasterCatalogueService } from './master-catalogue.service'
import { ProductsController } from './products.controller'
import { ProductsService } from './products.service'
import { UnitsController } from './units.controller'

// InventoryService arrives via the @Global() InventoryModule — it must stay the single writer of
// stock, so it is never re-provided here.
@Module({
  controllers: [
    // Declared before ProductsController so `/v1/products/import/template` is matched by the
    // import controller rather than swallowed by `/v1/products/:id`. Express matches in
    // registration order, and `:id` would otherwise capture the literal segment "import".
    ImportController,
    ProductsController,
    CategoriesController,
    UnitsController,
    MasterCatalogueController,
  ],
  providers: [ProductsService, CategoriesService, ImportService, MasterCatalogueService],
  // SyncService applies queued product ops through ProductsService — the same method the online
  // path uses. §14.4 makes that a hard rule: a parallel sync writer drifts from online behaviour.
  exports: [ProductsService],
})
export class CatalogueModule {}

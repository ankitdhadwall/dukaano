import { PrismaClient } from '@prisma/client'
import * as argon2 from 'argon2'
import { randomUUID } from 'node:crypto'
import { MASTER_CATEGORIES, MASTER_PRODUCTS } from './seed-data/master-catalogue'

/**
 * Database seed.
 *
 * Two distinct things are seeded, and the difference matters:
 *
 *   1. **Platform data** — plans and the master Kirana catalogue. This exists in every
 *      environment including production; it is product content, not test data.
 *   2. **A demo shop** — Dhadwal Confectionery & General Store, with a real general-store
 *      inventory. Development and staging only, and guarded so it can never run in production.
 *
 * The demo shop is modelled on a real Himachal general store rather than invented data, because
 * the shape of a real catalogue is what surfaces design problems: loose goods priced per kg
 * alongside packeted goods priced per packet, ₹1 toffees alongside ₹330 ghee, and Hindi product
 * names that are longer than their English equivalents.
 *
 * Run with:  pnpm db:seed
 */

const prisma = new PrismaClient()

/** Opening stock is written as an inventory transaction, never as a bare balance (§17.2). */
interface StockedProduct {
  masterKey: string
  sku: string
  shortCode?: string
  sellingPricePaise: number
  purchasePricePaise: number
  openingStockMilli: number
  lowStockThresholdMilli: number
}

/**
 * What Dhadwal Confectionery & General Store actually stocks.
 *
 * Margins here are realistic for the category rather than uniform: confectionery and cold drinks
 * run thin (₹1–3 on a ₹10–45 item), staples run thinner still on loose goods, and household
 * chemicals carry the best margin. A seed with a flat 20% markup everywhere would make the
 * Phase-8 profit report look plausible and be completely wrong.
 */
const SHOP_INVENTORY: StockedProduct[] = [
  // Confectionery — the store's namesake. Fast-moving, thin margin, high count.
  { masterKey: 'Cadbury Dairy Milk 13g', sku: 'CONF-DM13', shortCode: 'DM13', sellingPricePaise: 1000, purchasePricePaise: 850, openingStockMilli: 48_000, lowStockThresholdMilli: 12_000 },
  { masterKey: 'Cadbury Dairy Milk 55g', sku: 'CONF-DM55', shortCode: 'DM55', sellingPricePaise: 5000, purchasePricePaise: 4300, openingStockMilli: 15_000, lowStockThresholdMilli: 5_000 },
  { masterKey: 'Cadbury 5 Star', sku: 'CONF-5STAR', shortCode: '5ST', sellingPricePaise: 1000, purchasePricePaise: 850, openingStockMilli: 40_000, lowStockThresholdMilli: 10_000 },
  { masterKey: 'Kit Kat', sku: 'CONF-KITKAT', shortCode: 'KK', sellingPricePaise: 2000, purchasePricePaise: 1700, openingStockMilli: 24_000, lowStockThresholdMilli: 8_000 },
  { masterKey: 'Cadbury Eclairs', sku: 'CONF-ECL', shortCode: 'ECL', sellingPricePaise: 200, purchasePricePaise: 150, openingStockMilli: 200_000, lowStockThresholdMilli: 50_000 },
  { masterKey: 'Alpenliebe', sku: 'CONF-ALP', shortCode: 'ALP', sellingPricePaise: 100, purchasePricePaise: 75, openingStockMilli: 250_000, lowStockThresholdMilli: 50_000 },
  { masterKey: 'Melody Toffee', sku: 'CONF-MEL', shortCode: 'MEL', sellingPricePaise: 100, purchasePricePaise: 75, openingStockMilli: 180_000, lowStockThresholdMilli: 50_000 },
  { masterKey: 'Center Fresh', sku: 'CONF-CF', shortCode: 'CF', sellingPricePaise: 200, purchasePricePaise: 160, openingStockMilli: 120_000, lowStockThresholdMilli: 30_000 },
  { masterKey: 'Pulse Candy', sku: 'CONF-PULSE', shortCode: 'PLS', sellingPricePaise: 100, purchasePricePaise: 75, openingStockMilli: 150_000, lowStockThresholdMilli: 40_000 },

  // Biscuits — the highest-turnover category in most general stores.
  { masterKey: 'Parle-G', sku: 'BISC-PG', shortCode: 'PG', sellingPricePaise: 1000, purchasePricePaise: 880, openingStockMilli: 60_000, lowStockThresholdMilli: 15_000 },
  { masterKey: 'Britannia Good Day', sku: 'BISC-GD', shortCode: 'GD', sellingPricePaise: 3000, purchasePricePaise: 2600, openingStockMilli: 30_000, lowStockThresholdMilli: 8_000 },
  { masterKey: 'Britannia Marie Gold', sku: 'BISC-MG', shortCode: 'MG', sellingPricePaise: 3000, purchasePricePaise: 2600, openingStockMilli: 24_000, lowStockThresholdMilli: 6_000 },
  { masterKey: 'Parle Monaco', sku: 'BISC-MON', shortCode: 'MON', sellingPricePaise: 2000, purchasePricePaise: 1750, openingStockMilli: 24_000, lowStockThresholdMilli: 6_000 },
  { masterKey: 'Sunfeast Bourbon', sku: 'BISC-BRB', shortCode: 'BRB', sellingPricePaise: 3000, purchasePricePaise: 2600, openingStockMilli: 18_000, lowStockThresholdMilli: 6_000 },
  { masterKey: 'Britannia Rusk', sku: 'BISC-RUSK', shortCode: 'RSK', sellingPricePaise: 4000, purchasePricePaise: 3500, openingStockMilli: 12_000, lowStockThresholdMilli: 4_000 },

  // Namkeen & snacks
  { masterKey: 'Kurkure Masala Munch', sku: 'SNK-KUR', shortCode: 'KUR', sellingPricePaise: 2000, purchasePricePaise: 1740, openingStockMilli: 36_000, lowStockThresholdMilli: 10_000 },
  { masterKey: 'Lays Classic Salted', sku: 'SNK-LAYS', shortCode: 'LAY', sellingPricePaise: 2000, purchasePricePaise: 1740, openingStockMilli: 30_000, lowStockThresholdMilli: 10_000 },
  { masterKey: 'Haldiram Bhujia', sku: 'SNK-BHUJ', shortCode: 'BHJ', sellingPricePaise: 5000, purchasePricePaise: 4400, openingStockMilli: 15_000, lowStockThresholdMilli: 5_000 },
  { masterKey: 'Roasted Peanuts', sku: 'SNK-PNUT', shortCode: 'MGF', sellingPricePaise: 16_000, purchasePricePaise: 12_500, openingStockMilli: 8_000, lowStockThresholdMilli: 2_000 },

  // Cold drinks
  { masterKey: 'Thums Up 750ml', sku: 'BEV-TU750', shortCode: 'TU', sellingPricePaise: 4500, purchasePricePaise: 3900, openingStockMilli: 24_000, lowStockThresholdMilli: 6_000 },
  { masterKey: 'Coca Cola 750ml', sku: 'BEV-CC750', shortCode: 'CC', sellingPricePaise: 4500, purchasePricePaise: 3900, openingStockMilli: 18_000, lowStockThresholdMilli: 6_000 },
  { masterKey: 'Sprite 750ml', sku: 'BEV-SPR750', shortCode: 'SPR', sellingPricePaise: 4500, purchasePricePaise: 3900, openingStockMilli: 12_000, lowStockThresholdMilli: 6_000 },
  { masterKey: 'Maaza 600ml', sku: 'BEV-MAZ600', shortCode: 'MAZ', sellingPricePaise: 4000, purchasePricePaise: 3450, openingStockMilli: 18_000, lowStockThresholdMilli: 6_000 },
  { masterKey: 'Frooti 200ml', sku: 'BEV-FRO200', shortCode: 'FRO', sellingPricePaise: 1000, purchasePricePaise: 860, openingStockMilli: 48_000, lowStockThresholdMilli: 12_000 },
  { masterKey: 'Bisleri Water 1L', sku: 'BEV-BIS1L', shortCode: 'BIS', sellingPricePaise: 2000, purchasePricePaise: 1400, openingStockMilli: 36_000, lowStockThresholdMilli: 12_000 },

  // Tea & coffee
  { masterKey: 'Tata Tea Gold 250g', sku: 'TEA-TTG250', shortCode: 'TTG', sellingPricePaise: 15_000, purchasePricePaise: 13_200, openingStockMilli: 10_000, lowStockThresholdMilli: 3_000 },
  { masterKey: 'Red Label Tea 250g', sku: 'TEA-RL250', shortCode: 'RL', sellingPricePaise: 14_000, purchasePricePaise: 12_300, openingStockMilli: 8_000, lowStockThresholdMilli: 3_000 },
  { masterKey: 'Nescafe Classic 50g', sku: 'TEA-NES50', shortCode: 'NES', sellingPricePaise: 17_000, purchasePricePaise: 15_000, openingStockMilli: 6_000, lowStockThresholdMilli: 2_000 },

  // Staples — loose goods sold by weight, the case that makes decimal quantities essential.
  { masterKey: 'Sugar (Loose)', sku: 'STPL-SUG', shortCode: 'SUG01', sellingPricePaise: 5000, purchasePricePaise: 4400, openingStockMilli: 45_000, lowStockThresholdMilli: 5_000 },
  { masterKey: 'Wheat Flour (Loose)', sku: 'STPL-ATTA', shortCode: 'ATA', sellingPricePaise: 4500, purchasePricePaise: 3900, openingStockMilli: 60_000, lowStockThresholdMilli: 10_000 },
  { masterKey: 'Rice (Loose)', sku: 'STPL-RICE', shortCode: 'CHW', sellingPricePaise: 5500, purchasePricePaise: 4800, openingStockMilli: 75_000, lowStockThresholdMilli: 10_000 },
  { masterKey: 'Basmati Rice (Loose)', sku: 'STPL-BASM', shortCode: 'BAS', sellingPricePaise: 12_000, purchasePricePaise: 10_500, openingStockMilli: 25_000, lowStockThresholdMilli: 5_000 },
  { masterKey: 'Aashirvaad Atta 5kg', sku: 'STPL-AAT5', shortCode: 'AAT5', sellingPricePaise: 28_000, purchasePricePaise: 26_000, openingStockMilli: 12_000, lowStockThresholdMilli: 3_000 },
  { masterKey: 'Tata Salt 1kg', sku: 'STPL-SALT', shortCode: 'NMK', sellingPricePaise: 3000, purchasePricePaise: 2600, openingStockMilli: 24_000, lowStockThresholdMilli: 6_000 },
  { masterKey: 'Toor Dal (Arhar)', sku: 'STPL-TOOR', shortCode: 'TOR', sellingPricePaise: 18_000, purchasePricePaise: 16_000, openingStockMilli: 20_000, lowStockThresholdMilli: 4_000 },
  { masterKey: 'Moong Dal', sku: 'STPL-MOONG', shortCode: 'MNG', sellingPricePaise: 14_000, purchasePricePaise: 12_400, openingStockMilli: 15_000, lowStockThresholdMilli: 3_000 },
  { masterKey: 'Chana Dal', sku: 'STPL-CHANA', shortCode: 'CHN', sellingPricePaise: 10_000, purchasePricePaise: 8_800, openingStockMilli: 18_000, lowStockThresholdMilli: 4_000 },
  { masterKey: 'Rajma', sku: 'STPL-RAJMA', shortCode: 'RJM', sellingPricePaise: 16_000, purchasePricePaise: 14_000, openingStockMilli: 10_000, lowStockThresholdMilli: 3_000 },
  { masterKey: 'Besan', sku: 'STPL-BESAN', shortCode: 'BSN', sellingPricePaise: 11_000, purchasePricePaise: 9_600, openingStockMilli: 12_000, lowStockThresholdMilli: 3_000 },
  { masterKey: 'Maida', sku: 'STPL-MAIDA', shortCode: 'MDA', sellingPricePaise: 5000, purchasePricePaise: 4300, openingStockMilli: 15_000, lowStockThresholdMilli: 3_000 },

  // Oil, ghee & masala
  { masterKey: 'Fortune Sunflower Oil 1L', sku: 'OIL-FRT1L', shortCode: 'FRT', sellingPricePaise: 15_000, purchasePricePaise: 13_600, openingStockMilli: 18_000, lowStockThresholdMilli: 5_000 },
  { masterKey: 'Mustard Oil 1L', sku: 'OIL-SAR1L', shortCode: 'SAR', sellingPricePaise: 17_000, purchasePricePaise: 15_400, openingStockMilli: 15_000, lowStockThresholdMilli: 4_000 },
  { masterKey: 'Amul Ghee 500ml', sku: 'OIL-GHEE5', shortCode: 'GHE', sellingPricePaise: 33_000, purchasePricePaise: 30_500, openingStockMilli: 8_000, lowStockThresholdMilli: 2_000 },
  { masterKey: 'Turmeric Powder (Haldi)', sku: 'MSL-HALDI', shortCode: 'HLD', sellingPricePaise: 3000, purchasePricePaise: 2500, openingStockMilli: 20_000, lowStockThresholdMilli: 5_000 },
  { masterKey: 'Red Chilli Powder', sku: 'MSL-MIRCH', shortCode: 'MRC', sellingPricePaise: 4000, purchasePricePaise: 3400, openingStockMilli: 18_000, lowStockThresholdMilli: 5_000 },
  { masterKey: 'Garam Masala', sku: 'MSL-GARAM', shortCode: 'GRM', sellingPricePaise: 5000, purchasePricePaise: 4200, openingStockMilli: 12_000, lowStockThresholdMilli: 3_000 },

  // Dairy & bakery — daily items, and the reason low-stock alerts matter.
  { masterKey: 'Amul Taaza Milk 500ml', sku: 'DRY-AMTZ5', shortCode: 'DUD', sellingPricePaise: 3000, purchasePricePaise: 2800, openingStockMilli: 40_000, lowStockThresholdMilli: 15_000 },
  { masterKey: 'Amul Gold Milk 500ml', sku: 'DRY-AMGD5', shortCode: 'GLD', sellingPricePaise: 3400, purchasePricePaise: 3200, openingStockMilli: 25_000, lowStockThresholdMilli: 10_000 },
  { masterKey: 'Amul Butter 100g', sku: 'DRY-BTR100', shortCode: 'BTR', sellingPricePaise: 6200, purchasePricePaise: 5800, openingStockMilli: 12_000, lowStockThresholdMilli: 4_000 },
  { masterKey: 'Curd (Dahi) 400g', sku: 'DRY-DAHI4', shortCode: 'DHI', sellingPricePaise: 4000, purchasePricePaise: 3600, openingStockMilli: 15_000, lowStockThresholdMilli: 5_000 },
  { masterKey: 'Bread', sku: 'BKY-BREAD', shortCode: 'BRD', sellingPricePaise: 4500, purchasePricePaise: 4000, openingStockMilli: 18_000, lowStockThresholdMilli: 6_000 },
  { masterKey: 'Eggs', sku: 'DRY-EGG', shortCode: 'AND', sellingPricePaise: 800, purchasePricePaise: 700, openingStockMilli: 180_000, lowStockThresholdMilli: 30_000 },

  // Instant food
  { masterKey: 'Maggi Noodles 70g', sku: 'INS-MAG70', shortCode: 'MAG', sellingPricePaise: 1400, purchasePricePaise: 1230, openingStockMilli: 72_000, lowStockThresholdMilli: 18_000 },
  { masterKey: 'Maggi Noodles 4-Pack', sku: 'INS-MAG4P', shortCode: 'MG4', sellingPricePaise: 5600, purchasePricePaise: 4950, openingStockMilli: 18_000, lowStockThresholdMilli: 5_000 },
  { masterKey: 'Tomato Ketchup 200g', sku: 'INS-KETCH', shortCode: 'KTC', sellingPricePaise: 5000, purchasePricePaise: 4300, openingStockMilli: 10_000, lowStockThresholdMilli: 3_000 },

  // Personal care
  { masterKey: 'Lifebuoy Soap', sku: 'PC-LIFE', shortCode: 'LIF', sellingPricePaise: 3500, purchasePricePaise: 2950, openingStockMilli: 30_000, lowStockThresholdMilli: 8_000 },
  { masterKey: 'Lux Soap', sku: 'PC-LUX', shortCode: 'LUX', sellingPricePaise: 4000, purchasePricePaise: 3400, openingStockMilli: 24_000, lowStockThresholdMilli: 8_000 },
  { masterKey: 'Santoor Soap', sku: 'PC-SANT', shortCode: 'SNT', sellingPricePaise: 4000, purchasePricePaise: 3400, openingStockMilli: 24_000, lowStockThresholdMilli: 8_000 },
  { masterKey: 'Colgate Toothpaste 100g', sku: 'PC-COLG100', shortCode: 'CLG', sellingPricePaise: 6000, purchasePricePaise: 5200, openingStockMilli: 15_000, lowStockThresholdMilli: 4_000 },
  { masterKey: 'Clinic Plus Shampoo Sachet', sku: 'PC-CPSACH', shortCode: 'CPS', sellingPricePaise: 300, purchasePricePaise: 240, openingStockMilli: 200_000, lowStockThresholdMilli: 50_000 },
  { masterKey: 'Parachute Coconut Oil 100ml', sku: 'PC-PARA100', shortCode: 'PAR', sellingPricePaise: 4500, purchasePricePaise: 3900, openingStockMilli: 12_000, lowStockThresholdMilli: 4_000 },

  // Cleaning & household — the best margins in the shop.
  { masterKey: 'Surf Excel Easy Wash 1kg', sku: 'HH-SURF1K', shortCode: 'SRF', sellingPricePaise: 13_500, purchasePricePaise: 11_800, openingStockMilli: 12_000, lowStockThresholdMilli: 3_000 },
  { masterKey: 'Rin Detergent Bar', sku: 'HH-RIN', shortCode: 'RIN', sellingPricePaise: 1200, purchasePricePaise: 1000, openingStockMilli: 48_000, lowStockThresholdMilli: 12_000 },
  { masterKey: 'Vim Dishwash Bar', sku: 'HH-VIM', shortCode: 'VIM', sellingPricePaise: 2000, purchasePricePaise: 1650, openingStockMilli: 36_000, lowStockThresholdMilli: 10_000 },
  { masterKey: 'Harpic 500ml', sku: 'HH-HARP5', shortCode: 'HRP', sellingPricePaise: 9500, purchasePricePaise: 8100, openingStockMilli: 8_000, lowStockThresholdMilli: 2_000 },
  { masterKey: 'Agarbatti Packet', sku: 'HH-AGAR', shortCode: 'AGR', sellingPricePaise: 2000, purchasePricePaise: 1500, openingStockMilli: 24_000, lowStockThresholdMilli: 6_000 },
  { masterKey: 'Match Box', sku: 'HH-MATCH', shortCode: 'MCH', sellingPricePaise: 200, purchasePricePaise: 140, openingStockMilli: 100_000, lowStockThresholdMilli: 20_000 },
  { masterKey: 'Candle', sku: 'HH-CANDLE', shortCode: 'MOM', sellingPricePaise: 1000, purchasePricePaise: 700, openingStockMilli: 30_000, lowStockThresholdMilli: 10_000 },

  // Stationery
  { masterKey: 'Ball Pen (Blue)', sku: 'STN-PEN', shortCode: 'PEN', sellingPricePaise: 1000, purchasePricePaise: 700, openingStockMilli: 60_000, lowStockThresholdMilli: 15_000 },
  { masterKey: 'Notebook 100 pages', sku: 'STN-NB100', shortCode: 'CPY', sellingPricePaise: 3000, purchasePricePaise: 2300, openingStockMilli: 30_000, lowStockThresholdMilli: 8_000 },
  { masterKey: 'Pencil', sku: 'STN-PENCIL', shortCode: 'PNC', sellingPricePaise: 500, purchasePricePaise: 350, openingStockMilli: 60_000, lowStockThresholdMilli: 15_000 },
]

/** Regular khata customers. Names are ordinary Himachali names; numbers are in the reserved
 *  555-style test range so a stray reminder can never reach a real person. */
const DEMO_CUSTOMERS = [
  { name: 'Ramesh Sharma', phone: '+919555500001', openingBalancePaise: 84_000 },
  { name: 'Sunita Devi', phone: '+919555500002', openingBalancePaise: 32_500 },
  { name: 'Vikram Thakur', phone: '+919555500003', openingBalancePaise: 156_000 },
  { name: 'Anil Kumar', phone: '+919555500004', openingBalancePaise: 0 },
  { name: 'Meena Chauhan', phone: '+919555500005', openingBalancePaise: 47_500 },
  { name: 'Rakesh Verma', phone: '+919555500006', openingBalancePaise: 21_000 },
]

async function seedPlans(): Promise<string> {
  const plans = [
    {
      code: 'FREE',
      nameEn: 'Free',
      nameHi: 'मुफ़्त',
      pricePaise: 0,
      trialDays: 0,
      entitlements: ['bulk_import'],
      limits: { maxUsers: 1, maxDevices: 1, maxProducts: 200, monthlySales: 50, monthlyMessages: 0 },
      sortOrder: 10,
    },
    {
      code: 'BASIC',
      nameEn: 'Basic',
      nameHi: 'बेसिक',
      pricePaise: 29_900,
      trialDays: 14,
      entitlements: ['unlimited_sales', 'staff_accounts', 'bulk_import', 'data_export'],
      limits: { maxUsers: 3, maxDevices: 2, maxProducts: null, monthlySales: null, monthlyMessages: 500 },
      sortOrder: 20,
    },
    {
      code: 'PRO',
      nameEn: 'Pro',
      nameHi: 'प्रो',
      pricePaise: 59_900,
      trialDays: 14,
      entitlements: [
        'unlimited_sales',
        'advanced_reports',
        'multi_device',
        'staff_accounts',
        'bulk_import',
        'data_export',
        'priority_support',
      ],
      limits: { maxUsers: null, maxDevices: null, maxProducts: null, monthlySales: null, monthlyMessages: 2000 },
      sortOrder: 30,
    },
  ]

  let basicId = ''
  for (const plan of plans) {
    const existing = await prisma.plan.findUnique({ where: { code: plan.code } })
    const id = existing?.id ?? randomUUID()
    await prisma.plan.upsert({
      where: { code: plan.code },
      create: { id, billingPeriod: 'MONTHLY', isPublic: true, ...plan },
      update: { ...plan },
    })
    if (plan.code === 'BASIC') basicId = id
  }

  console.warn(`  ✓ ${plans.length} plans`)
  return basicId
}

async function seedMasterCatalogue(): Promise<Map<string, string>> {
  const categoryIds = new Map<string, string>()

  for (const category of MASTER_CATEGORIES) {
    const existing = await prisma.masterCategory.findFirst({ where: { nameEn: category.nameEn } })
    const id = existing?.id ?? randomUUID()
    await prisma.masterCategory.upsert({
      where: { id },
      create: {
        id,
        nameEn: category.nameEn,
        nameHi: category.nameHi,
        icon: category.icon,
        sortOrder: category.sortOrder,
      },
      update: { nameHi: category.nameHi, icon: category.icon, sortOrder: category.sortOrder },
    })
    categoryIds.set(category.key, id)
  }

  const productIds = new Map<string, string>()
  let index = 0
  for (const product of MASTER_PRODUCTS) {
    const categoryId = categoryIds.get(product.categoryKey)
    if (!categoryId) throw new Error(`Unknown master category key: ${product.categoryKey}`)

    const existing = await prisma.masterProduct.findFirst({ where: { nameEn: product.nameEn } })
    const id = existing?.id ?? randomUUID()
    await prisma.masterProduct.upsert({
      where: { id },
      create: {
        id,
        categoryId,
        nameEn: product.nameEn,
        nameHi: product.nameHi,
        aliases: [...product.aliases],
        unitCode: product.unitCode,
        hintPricePaise: BigInt(product.hintPricePaise),
        isCommon: product.isCommon,
        sortOrder: (index += 10),
      },
      update: {
        categoryId,
        nameHi: product.nameHi,
        aliases: [...product.aliases],
        unitCode: product.unitCode,
        hintPricePaise: BigInt(product.hintPricePaise),
        isCommon: product.isCommon,
      },
    })
    productIds.set(product.nameEn, id)
  }

  console.warn(
    `  ✓ ${MASTER_CATEGORIES.length} master categories, ${MASTER_PRODUCTS.length} master products`,
  )
  return productIds
}

async function seedDemoShop(planId: string, masterProductIds: Map<string, string>): Promise<void> {
  const OWNER_PHONE = '+919816000001'
  const shopName = 'Dhadwal Confectionery & General Store'

  const existingUser = await prisma.user.findUnique({ where: { phoneE164: OWNER_PHONE } })
  if (existingUser) {
    console.warn(`  · demo shop already seeded (owner ${OWNER_PHONE}) — skipping`)
    return
  }

  const shopId = randomUUID()
  const ownerId = randomUUID()
  const cashierId = randomUUID()
  const now = new Date()

  await prisma.$transaction(async (tx) => {
    // Every write below supplies shop_id, but RLS's WITH CHECK compares it against
    // current_setting('app.shop_id'), so the context must be set even as the owner role.
    await tx.$executeRaw`SELECT set_config('app.shop_id', ${shopId}::text, true)`

    const passwordHash = await argon2.hash('dukaano123', {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 4,
    })

    await tx.user.createMany({
      data: [
        { id: ownerId, phoneE164: OWNER_PHONE, passwordHash, fullName: 'Ankit Dhadwal', locale: 'hi', status: 'ACTIVE' },
        { id: cashierId, phoneE164: '+919816000002', passwordHash, fullName: 'Suresh', locale: 'hi', status: 'ACTIVE' },
      ],
    })

    await tx.shop.create({
      data: {
        id: shopId,
        name: shopName,
        shopType: 'GENERAL_STORE',
        phone: OWNER_PHONE,
        city: 'Shimla',
        stateCode: 'HP',
        timezone: 'Asia/Kolkata',
        defaultLocale: 'hi',
        currency: 'INR',
        status: 'TRIAL',
        settings: {
          create: {
            // A confectionery counter deals in ₹1 and ₹2 items all day, so rounding the bill to
            // the nearest rupee is the norm rather than an option.
            roundingPolicy: 'NEAREST_RUPEE',
            negativeStockPolicy: 'ALLOW',
            messagingChannel: 'WA_DEEPLINK',
            receiptFooter: 'धन्यवाद 🙏 फिर आइएगा',
          },
        },
      },
    })

    await tx.shopMembership.createMany({
      data: [
        { id: randomUUID(), shopId, userId: ownerId, role: 'OWNER', permissionOverrides: {}, status: 'ACTIVE', joinedAt: now },
        {
          id: randomUUID(),
          shopId,
          userId: cashierId,
          role: 'CASHIER',
          // The common real arrangement: the counter boy may take khata payments and sell on
          // credit, but can never see purchase cost or touch the ledger (the role ceiling).
          permissionOverrides: { grant: ['customer.payment.receive', 'customer.credit.sell'] },
          status: 'ACTIVE',
          joinedAt: now,
        },
      ],
    })

    await tx.subscription.create({
      data: {
        id: randomUUID(),
        shopId,
        planId,
        status: 'TRIALING',
        trialEndsAt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      },
    })

    // Categories, mirrored from the master catalogue the shop actually uses.
    const usedCategoryKeys = new Set(
      SHOP_INVENTORY.map((item) => {
        const master = MASTER_PRODUCTS.find((p) => p.nameEn === item.masterKey)
        if (!master) throw new Error(`SHOP_INVENTORY references unknown master product: ${item.masterKey}`)
        return master.categoryKey
      }),
    )

    const shopCategoryIds = new Map<string, string>()
    for (const category of MASTER_CATEGORIES.filter((c) => usedCategoryKeys.has(c.key))) {
      const id = randomUUID()
      await tx.category.create({
        data: { id, shopId, nameEn: category.nameEn, nameHi: category.nameHi, sortOrder: category.sortOrder },
      })
      shopCategoryIds.set(category.key, id)
    }

    // Products, their aliases, and opening stock.
    for (const item of SHOP_INVENTORY) {
      const master = MASTER_PRODUCTS.find((p) => p.nameEn === item.masterKey)
      if (!master) continue

      const productId = randomUUID()
      await tx.product.create({
        data: {
          id: productId,
          shopId,
          masterProductId: masterProductIds.get(master.nameEn) ?? null,
          categoryId: shopCategoryIds.get(master.categoryKey) ?? null,
          nameEn: master.nameEn,
          nameHi: master.nameHi,
          sku: item.sku,
          shortCode: item.shortCode ?? null,
          unitCode: master.unitCode,
          sellingPricePaise: BigInt(item.sellingPricePaise),
          purchasePricePaise: BigInt(item.purchasePricePaise),
          lowStockThresholdMilli: BigInt(item.lowStockThresholdMilli),
          isActive: true,
          createdByUserId: ownerId,
        },
      })

      if (master.aliases.length > 0) {
        await tx.productAlias.createMany({
          data: master.aliases.map((alias) => ({ id: randomUUID(), shopId, productId, alias })),
        })
      }

      /*
       * Opening stock is an OPENING_STOCK inventory transaction, and the balance row is derived
       * from it — never a bare balance write (blueprint §17.2, journey J2).
       *
       * Seeding a balance directly would be faster and would immediately break the invariant the
       * reconciliation job checks (balance == Σ transactions), which is exactly the class of bug
       * that makes a shopkeeper stop trusting the numbers.
       */
      await tx.inventoryTransaction.create({
        data: {
          id: randomUUID(),
          shopId,
          productId,
          type: 'OPENING_STOCK',
          qtyDeltaMilli: BigInt(item.openingStockMilli),
          balanceAfterMilli: BigInt(item.openingStockMilli),
          unitCostPaise: BigInt(item.purchasePricePaise),
          actorUserId: ownerId,
          occurredAt: now,
        },
      })

      await tx.inventoryBalance.create({
        data: {
          shopId,
          productId,
          qtyMilli: BigInt(item.openingStockMilli),
          avgCostPaise: BigInt(item.purchasePricePaise),
          version: 1n,
        },
      })
    }

    // Khata customers, with opening balances written as ledger entries.
    for (const customer of DEMO_CUSTOMERS) {
      const customerId = randomUUID()
      await tx.customer.create({
        data: {
          id: customerId,
          shopId,
          name: customer.name,
          phoneE164: customer.phone,
          creditLimitPaise: 200_000n,
          createdByUserId: ownerId,
        },
      })

      await tx.customerBalance.create({
        data: { shopId, customerId, outstandingPaise: BigInt(customer.openingBalancePaise), version: 0n },
      })

      if (customer.openingBalancePaise > 0) {
        // Same rule as inventory: the balance is derived from an append-only entry (§18.1).
        const entryId = randomUUID()
        await tx.customerLedgerEntry.create({
          data: {
            id: entryId,
            shopId,
            customerId,
            entryType: 'OPENING_BALANCE',
            amountPaise: BigInt(customer.openingBalancePaise),
            balanceAfterPaise: BigInt(customer.openingBalancePaise),
            note: 'पुरानी बही से / carried over from the paper khata',
            actorUserId: ownerId,
            occurredAt: now,
          },
        })
        await tx.customerBalance.update({
          where: { shopId_customerId: { shopId, customerId } },
          data: { lastEntryId: entryId, lastActivityAt: now, version: 1n },
        })
      }
    }

    await tx.supplier.createMany({
      data: [
        { id: randomUUID(), shopId, name: 'Gupta Distributors', phoneE164: '+919555510001', address: 'Lower Bazaar, Shimla' },
        { id: randomUUID(), shopId, name: 'Sharma Agencies', phoneE164: '+919555510002', address: 'Sanjauli, Shimla' },
        { id: randomUUID(), shopId, name: 'Himachal Beverages', phoneE164: '+919555510003', address: 'Dhalli, Shimla' },
      ],
    })
  })

  const totalStockValue = SHOP_INVENTORY.reduce(
    (sum, item) => sum + (item.purchasePricePaise * item.openingStockMilli) / 1000,
    0,
  )
  const totalOutstanding = DEMO_CUSTOMERS.reduce((sum, c) => sum + c.openingBalancePaise, 0)

  console.warn(`  ✓ ${shopName}`)
  const categoryCount = new Set(
    SHOP_INVENTORY.map((i) => MASTER_PRODUCTS.find((p) => p.nameEn === i.masterKey)?.categoryKey),
  ).size
  console.warn(`      ${SHOP_INVENTORY.length} products across ${categoryCount} categories`)
  console.warn(`      stock at cost  ₹${(totalStockValue / 100).toLocaleString('en-IN')}`)
  console.warn(`      ${DEMO_CUSTOMERS.length} khata customers, ₹${(totalOutstanding / 100).toLocaleString('en-IN')} outstanding`)
  console.warn(`      owner   ${OWNER_PHONE} / dukaano123`)
  console.warn(`      cashier +919816000002 / dukaano123`)
}

async function main(): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production'

  console.warn('\nSeeding Dukaano\n')

  console.warn('Platform data (all environments):')
  const basicPlanId = await seedPlans()
  const masterProductIds = await seedMasterCatalogue()

  if (isProduction) {
    // The demo shop contains a known password. Creating it in production would be a live
    // credential, so the guard is a hard stop rather than a warning.
    console.warn('\nNODE_ENV=production — skipping the demo shop.\n')
    return
  }

  console.warn('\nDemo shop (development and staging only):')
  await seedDemoShop(basicPlanId, masterProductIds)
  console.warn('')
}

main()
  .catch((error: unknown) => {
    console.error('\nSeed failed:', error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })

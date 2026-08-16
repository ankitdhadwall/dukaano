/**
 * The Dukaano master Kirana catalogue (blueprint §7).
 *
 * This is the single highest-leverage fix for risk R-1 — the cold-start problem. A shopkeeper who
 * must type 400 products before the app is useful abandons it in week one. Seeding from here lets
 * them tap "add all" and have a working catalogue in about ninety seconds.
 *
 * Content rules, learned from how these shops actually work:
 *
 *   • **Romanized aliases are mandatory, not decorative.** A shopkeeper types "chini", not "चीनी"
 *     and not "Sugar". Without `chini` in the alias list, Hindi-first users cannot find their own
 *     stock, and the search feature silently fails for exactly the audience it was built for.
 *   • **Brand names in Devanagari too.** "Parle-G" is written पारले-जी on half the shelf labels in
 *     Himachal. Both spellings must match.
 *   • **hintPrice is indicative only.** Every shop sets its own prices (§7) — this is a starting
 *     point the shopkeeper edits, never a price we impose. Prices reflect typical MRP at the time
 *     of writing and WILL drift; they are seed defaults, not a price list.
 *   • **Units match how the item is sold**, not how it is packaged. Loose sugar is KG; a 1 kg
 *     packet of Aashirvaad atta is PACKET, because the shopkeeper sells "one packet", not "one
 *     kilogram" (blueprint A-7 — no unit conversion in MVP).
 */

export interface MasterCategorySeed {
  readonly key: string
  readonly nameEn: string
  readonly nameHi: string
  readonly icon: string
  readonly sortOrder: number
}

export interface MasterProductSeed {
  readonly categoryKey: string
  readonly nameEn: string
  readonly nameHi: string
  /** Romanized and colloquial search keys. Lowercase. */
  readonly aliases: readonly string[]
  readonly unitCode: string
  /** Indicative MRP in paise. The shop edits this. */
  readonly hintPricePaise: number
  /** Shown pre-checked in onboarding — the items almost every general store carries. */
  readonly isCommon: boolean
}

export const MASTER_CATEGORIES: readonly MasterCategorySeed[] = [
  { key: 'confectionery', nameEn: 'Confectionery', nameHi: 'टॉफ़ी-चॉकलेट', icon: '🍬', sortOrder: 10 },
  { key: 'biscuits', nameEn: 'Biscuits & Cakes', nameHi: 'बिस्कुट-केक', icon: '🍪', sortOrder: 20 },
  { key: 'snacks', nameEn: 'Namkeen & Snacks', nameHi: 'नमकीन-स्नैक्स', icon: '🥨', sortOrder: 30 },
  { key: 'beverages', nameEn: 'Cold Drinks & Juices', nameHi: 'कोल्ड ड्रिंक-जूस', icon: '🥤', sortOrder: 40 },
  { key: 'tea_coffee', nameEn: 'Tea & Coffee', nameHi: 'चाय-कॉफ़ी', icon: '☕', sortOrder: 50 },
  { key: 'staples', nameEn: 'Atta, Rice & Dal', nameHi: 'आटा-चावल-दाल', icon: '🌾', sortOrder: 60 },
  { key: 'oil_masala', nameEn: 'Oil, Ghee & Masala', nameHi: 'तेल-घी-मसाला', icon: '🫙', sortOrder: 70 },
  { key: 'dairy', nameEn: 'Dairy & Bakery', nameHi: 'डेयरी-बेकरी', icon: '🥛', sortOrder: 80 },
  { key: 'instant', nameEn: 'Instant Food', nameHi: 'इंस्टेंट फ़ूड', icon: '🍜', sortOrder: 90 },
  { key: 'personal_care', nameEn: 'Personal Care', nameHi: 'साबुन-शैम्पू', icon: '🧴', sortOrder: 100 },
  { key: 'household', nameEn: 'Cleaning & Household', nameHi: 'सफ़ाई-घरेलू', icon: '🧹', sortOrder: 110 },
  { key: 'stationery', nameEn: 'Stationery', nameHi: 'स्टेशनरी', icon: '✏️', sortOrder: 120 },
]

export const MASTER_PRODUCTS: readonly MasterProductSeed[] = [
  // ── Confectionery ──────────────────────────────────────────────────────────────────────
  { categoryKey: 'confectionery', nameEn: 'Cadbury Dairy Milk 13g', nameHi: 'डेयरी मिल्क 13g', aliases: ['dairy milk', 'cadbury', 'chocolate', 'chaklet'], unitCode: 'PIECE', hintPricePaise: 1000, isCommon: true },
  { categoryKey: 'confectionery', nameEn: 'Cadbury Dairy Milk 55g', nameHi: 'डेयरी मिल्क 55g', aliases: ['dairy milk big', 'cadbury bada'], unitCode: 'PIECE', hintPricePaise: 5000, isCommon: true },
  { categoryKey: 'confectionery', nameEn: 'Cadbury 5 Star', nameHi: 'फ़ाइव स्टार', aliases: ['5 star', 'five star', 'fivestar'], unitCode: 'PIECE', hintPricePaise: 1000, isCommon: true },
  { categoryKey: 'confectionery', nameEn: 'Kit Kat', nameHi: 'किट कैट', aliases: ['kitkat', 'kit kat'], unitCode: 'PIECE', hintPricePaise: 2000, isCommon: true },
  { categoryKey: 'confectionery', nameEn: 'Cadbury Eclairs', nameHi: 'एक्लेयर्स', aliases: ['eclairs', 'eclair', 'toffee'], unitCode: 'PIECE', hintPricePaise: 200, isCommon: true },
  { categoryKey: 'confectionery', nameEn: 'Alpenliebe', nameHi: 'अल्पेनलिबे', aliases: ['alpenliebe', 'alpen', 'toffee'], unitCode: 'PIECE', hintPricePaise: 100, isCommon: true },
  { categoryKey: 'confectionery', nameEn: 'Melody Toffee', nameHi: 'मेलोडी', aliases: ['melody', 'toffee'], unitCode: 'PIECE', hintPricePaise: 100, isCommon: true },
  { categoryKey: 'confectionery', nameEn: 'Center Fresh', nameHi: 'सेंटर फ्रेश', aliases: ['center fresh', 'chewing gum', 'gum'], unitCode: 'PIECE', hintPricePaise: 200, isCommon: true },
  { categoryKey: 'confectionery', nameEn: 'Pulse Candy', nameHi: 'पल्स कैंडी', aliases: ['pulse', 'candy'], unitCode: 'PIECE', hintPricePaise: 100, isCommon: true },
  { categoryKey: 'confectionery', nameEn: 'Parle Kismi Toffee', nameHi: 'किस्मी टॉफ़ी', aliases: ['kismi', 'toffee'], unitCode: 'PIECE', hintPricePaise: 100, isCommon: false },
  { categoryKey: 'confectionery', nameEn: 'Perk', nameHi: 'पर्क', aliases: ['perk'], unitCode: 'PIECE', hintPricePaise: 1000, isCommon: false },
  { categoryKey: 'confectionery', nameEn: 'Munch', nameHi: 'मंच', aliases: ['munch'], unitCode: 'PIECE', hintPricePaise: 1000, isCommon: false },
  { categoryKey: 'confectionery', nameEn: 'Loose Sweets (Mithai)', nameHi: 'मिठाई (खुली)', aliases: ['mithai', 'sweets', 'barfi', 'ladoo'], unitCode: 'KG', hintPricePaise: 40000, isCommon: false },

  // ── Biscuits & Cakes ───────────────────────────────────────────────────────────────────
  { categoryKey: 'biscuits', nameEn: 'Parle-G', nameHi: 'पारले-जी', aliases: ['parle g', 'parleg', 'parle', 'glucose biscuit'], unitCode: 'PACKET', hintPricePaise: 1000, isCommon: true },
  { categoryKey: 'biscuits', nameEn: 'Britannia Good Day', nameHi: 'गुड डे', aliases: ['good day', 'goodday', 'britannia'], unitCode: 'PACKET', hintPricePaise: 3000, isCommon: true },
  { categoryKey: 'biscuits', nameEn: 'Britannia Marie Gold', nameHi: 'मैरी गोल्ड', aliases: ['marie', 'mari gold', 'marie gold'], unitCode: 'PACKET', hintPricePaise: 3000, isCommon: true },
  { categoryKey: 'biscuits', nameEn: 'Parle Monaco', nameHi: 'मोनैको', aliases: ['monaco', 'salted biscuit'], unitCode: 'PACKET', hintPricePaise: 2000, isCommon: true },
  { categoryKey: 'biscuits', nameEn: 'Sunfeast Bourbon', nameHi: 'बोरबॉन', aliases: ['bourbon', 'cream biscuit'], unitCode: 'PACKET', hintPricePaise: 3000, isCommon: true },
  { categoryKey: 'biscuits', nameEn: 'Hide & Seek', nameHi: 'हाइड एंड सीक', aliases: ['hide and seek', 'hide seek'], unitCode: 'PACKET', hintPricePaise: 3000, isCommon: false },
  { categoryKey: 'biscuits', nameEn: 'Oreo', nameHi: 'ओरियो', aliases: ['oreo'], unitCode: 'PACKET', hintPricePaise: 3000, isCommon: false },
  { categoryKey: 'biscuits', nameEn: 'Britannia Rusk', nameHi: 'टोस्ट-रस्क', aliases: ['rusk', 'toast'], unitCode: 'PACKET', hintPricePaise: 4000, isCommon: true },
  { categoryKey: 'biscuits', nameEn: 'Britannia Cake Slice', nameHi: 'केक स्लाइस', aliases: ['cake', 'slice cake'], unitCode: 'PIECE', hintPricePaise: 1000, isCommon: true },

  // ── Namkeen & Snacks ───────────────────────────────────────────────────────────────────
  { categoryKey: 'snacks', nameEn: 'Kurkure Masala Munch', nameHi: 'कुरकुरे', aliases: ['kurkure', 'kurkure masala'], unitCode: 'PACKET', hintPricePaise: 2000, isCommon: true },
  { categoryKey: 'snacks', nameEn: 'Lays Classic Salted', nameHi: 'लेज़', aliases: ['lays', 'chips', 'lays chips'], unitCode: 'PACKET', hintPricePaise: 2000, isCommon: true },
  { categoryKey: 'snacks', nameEn: 'Bingo Mad Angles', nameHi: 'बिंगो', aliases: ['bingo', 'mad angles'], unitCode: 'PACKET', hintPricePaise: 2000, isCommon: false },
  { categoryKey: 'snacks', nameEn: 'Haldiram Bhujia', nameHi: 'हल्दीराम भुजिया', aliases: ['bhujia', 'haldiram', 'namkeen'], unitCode: 'PACKET', hintPricePaise: 5000, isCommon: true },
  { categoryKey: 'snacks', nameEn: 'Aloo Bhujia (Loose)', nameHi: 'आलू भुजिया (खुली)', aliases: ['aloo bhujia', 'namkeen khula'], unitCode: 'KG', hintPricePaise: 28000, isCommon: false },
  { categoryKey: 'snacks', nameEn: 'Roasted Peanuts', nameHi: 'मूंगफली', aliases: ['moongfali', 'mungfali', 'peanut', 'groundnut'], unitCode: 'KG', hintPricePaise: 16000, isCommon: true },
  { categoryKey: 'snacks', nameEn: 'Popcorn Packet', nameHi: 'पॉपकॉर्न', aliases: ['popcorn'], unitCode: 'PACKET', hintPricePaise: 2000, isCommon: false },

  // ── Cold Drinks & Juices ───────────────────────────────────────────────────────────────
  { categoryKey: 'beverages', nameEn: 'Thums Up 750ml', nameHi: 'थम्स अप 750ml', aliases: ['thums up', 'thumsup', 'cold drink'], unitCode: 'BOTTLE', hintPricePaise: 4500, isCommon: true },
  { categoryKey: 'beverages', nameEn: 'Coca Cola 750ml', nameHi: 'कोका कोला 750ml', aliases: ['coca cola', 'coke', 'cold drink'], unitCode: 'BOTTLE', hintPricePaise: 4500, isCommon: true },
  { categoryKey: 'beverages', nameEn: 'Sprite 750ml', nameHi: 'स्प्राइट 750ml', aliases: ['sprite'], unitCode: 'BOTTLE', hintPricePaise: 4500, isCommon: true },
  { categoryKey: 'beverages', nameEn: 'Maaza 600ml', nameHi: 'माज़ा 600ml', aliases: ['maaza', 'maza', 'mango juice'], unitCode: 'BOTTLE', hintPricePaise: 4000, isCommon: true },
  { categoryKey: 'beverages', nameEn: 'Frooti 200ml', nameHi: 'फ्रूटी 200ml', aliases: ['frooti', 'fruity'], unitCode: 'PIECE', hintPricePaise: 1000, isCommon: true },
  { categoryKey: 'beverages', nameEn: 'Real Mixed Fruit Juice 1L', nameHi: 'रियल जूस 1L', aliases: ['real juice', 'juice'], unitCode: 'PIECE', hintPricePaise: 12000, isCommon: false },
  { categoryKey: 'beverages', nameEn: 'Bisleri Water 1L', nameHi: 'बिसलेरी पानी 1L', aliases: ['bisleri', 'pani', 'water', 'paani'], unitCode: 'BOTTLE', hintPricePaise: 2000, isCommon: true },

  // ── Tea & Coffee ───────────────────────────────────────────────────────────────────────
  { categoryKey: 'tea_coffee', nameEn: 'Tata Tea Gold 250g', nameHi: 'टाटा टी गोल्ड 250g', aliases: ['tata tea', 'chai', 'chai patti', 'tea'], unitCode: 'PACKET', hintPricePaise: 15000, isCommon: true },
  { categoryKey: 'tea_coffee', nameEn: 'Red Label Tea 250g', nameHi: 'रेड लेबल चाय 250g', aliases: ['red label', 'chai patti', 'chai'], unitCode: 'PACKET', hintPricePaise: 14000, isCommon: true },
  { categoryKey: 'tea_coffee', nameEn: 'Nescafe Classic 50g', nameHi: 'नेस्कैफ़े 50g', aliases: ['nescafe', 'coffee', 'kaafi'], unitCode: 'PIECE', hintPricePaise: 17000, isCommon: true },
  { categoryKey: 'tea_coffee', nameEn: 'Bru Instant Coffee 50g', nameHi: 'ब्रू कॉफ़ी 50g', aliases: ['bru', 'coffee'], unitCode: 'PIECE', hintPricePaise: 15000, isCommon: false },

  // ── Atta, Rice & Dal ───────────────────────────────────────────────────────────────────
  { categoryKey: 'staples', nameEn: 'Aashirvaad Atta 5kg', nameHi: 'आशीर्वाद आटा 5kg', aliases: ['aashirvaad', 'ashirvad', 'atta', 'aata', 'flour'], unitCode: 'PACKET', hintPricePaise: 28000, isCommon: true },
  { categoryKey: 'staples', nameEn: 'Wheat Flour (Loose)', nameHi: 'आटा (खुला)', aliases: ['atta', 'aata', 'gehu atta'], unitCode: 'KG', hintPricePaise: 4500, isCommon: true },
  { categoryKey: 'staples', nameEn: 'Basmati Rice (Loose)', nameHi: 'बासमती चावल', aliases: ['basmati', 'chawal', 'chaval', 'rice'], unitCode: 'KG', hintPricePaise: 12000, isCommon: true },
  { categoryKey: 'staples', nameEn: 'Rice (Loose)', nameHi: 'चावल (खुला)', aliases: ['chawal', 'chaval', 'rice'], unitCode: 'KG', hintPricePaise: 5500, isCommon: true },
  { categoryKey: 'staples', nameEn: 'Sugar (Loose)', nameHi: 'चीनी (खुली)', aliases: ['chini', 'cheeni', 'shakkar', 'sugar'], unitCode: 'KG', hintPricePaise: 5000, isCommon: true },
  { categoryKey: 'staples', nameEn: 'Tata Salt 1kg', nameHi: 'टाटा नमक 1kg', aliases: ['tata salt', 'namak', 'salt'], unitCode: 'PACKET', hintPricePaise: 3000, isCommon: true },
  { categoryKey: 'staples', nameEn: 'Toor Dal (Arhar)', nameHi: 'तूर दाल (अरहर)', aliases: ['toor dal', 'arhar', 'arhar dal', 'dal'], unitCode: 'KG', hintPricePaise: 18000, isCommon: true },
  { categoryKey: 'staples', nameEn: 'Moong Dal', nameHi: 'मूंग दाल', aliases: ['moong', 'mung dal', 'dal'], unitCode: 'KG', hintPricePaise: 14000, isCommon: true },
  { categoryKey: 'staples', nameEn: 'Chana Dal', nameHi: 'चना दाल', aliases: ['chana dal', 'chana', 'dal'], unitCode: 'KG', hintPricePaise: 10000, isCommon: true },
  { categoryKey: 'staples', nameEn: 'Rajma', nameHi: 'राजमा', aliases: ['rajma', 'kidney beans'], unitCode: 'KG', hintPricePaise: 16000, isCommon: true },
  { categoryKey: 'staples', nameEn: 'Kabuli Chana', nameHi: 'काबुली चना', aliases: ['kabuli chana', 'chole', 'chana'], unitCode: 'KG', hintPricePaise: 13000, isCommon: true },
  { categoryKey: 'staples', nameEn: 'Besan', nameHi: 'बेसन', aliases: ['besan', 'gram flour'], unitCode: 'KG', hintPricePaise: 11000, isCommon: true },
  { categoryKey: 'staples', nameEn: 'Maida', nameHi: 'मैदा', aliases: ['maida'], unitCode: 'KG', hintPricePaise: 5000, isCommon: true },
  { categoryKey: 'staples', nameEn: 'Sooji / Rava', nameHi: 'सूजी', aliases: ['sooji', 'suji', 'rava'], unitCode: 'KG', hintPricePaise: 5500, isCommon: false },
  { categoryKey: 'staples', nameEn: 'Poha', nameHi: 'पोहा', aliases: ['poha', 'chiwda'], unitCode: 'KG', hintPricePaise: 6000, isCommon: false },

  // ── Oil, Ghee & Masala ─────────────────────────────────────────────────────────────────
  { categoryKey: 'oil_masala', nameEn: 'Fortune Sunflower Oil 1L', nameHi: 'फॉर्च्यून तेल 1L', aliases: ['fortune', 'refined', 'sunflower oil', 'tel'], unitCode: 'PIECE', hintPricePaise: 15000, isCommon: true },
  { categoryKey: 'oil_masala', nameEn: 'Mustard Oil 1L', nameHi: 'सरसों का तेल 1L', aliases: ['sarson tel', 'sarson ka tel', 'mustard oil', 'kachi ghani'], unitCode: 'PIECE', hintPricePaise: 17000, isCommon: true },
  { categoryKey: 'oil_masala', nameEn: 'Amul Ghee 500ml', nameHi: 'अमूल घी 500ml', aliases: ['ghee', 'amul ghee', 'ghi'], unitCode: 'PIECE', hintPricePaise: 33000, isCommon: true },
  { categoryKey: 'oil_masala', nameEn: 'Turmeric Powder (Haldi)', nameHi: 'हल्दी पाउडर', aliases: ['haldi', 'turmeric'], unitCode: 'PACKET', hintPricePaise: 3000, isCommon: true },
  { categoryKey: 'oil_masala', nameEn: 'Red Chilli Powder', nameHi: 'लाल मिर्च पाउडर', aliases: ['mirch', 'lal mirch', 'chilli powder'], unitCode: 'PACKET', hintPricePaise: 4000, isCommon: true },
  { categoryKey: 'oil_masala', nameEn: 'Coriander Powder (Dhaniya)', nameHi: 'धनिया पाउडर', aliases: ['dhaniya', 'dhania', 'coriander'], unitCode: 'PACKET', hintPricePaise: 3500, isCommon: true },
  { categoryKey: 'oil_masala', nameEn: 'Garam Masala', nameHi: 'गरम मसाला', aliases: ['garam masala', 'masala'], unitCode: 'PACKET', hintPricePaise: 5000, isCommon: true },
  { categoryKey: 'oil_masala', nameEn: 'Cumin Seeds (Jeera)', nameHi: 'जीरा', aliases: ['jeera', 'cumin'], unitCode: 'PACKET', hintPricePaise: 6000, isCommon: true },

  // ── Dairy & Bakery ─────────────────────────────────────────────────────────────────────
  { categoryKey: 'dairy', nameEn: 'Amul Taaza Milk 500ml', nameHi: 'अमूल ताज़ा दूध 500ml', aliases: ['amul', 'doodh', 'dudh', 'milk', 'taaza'], unitCode: 'PACKET', hintPricePaise: 3000, isCommon: true },
  { categoryKey: 'dairy', nameEn: 'Amul Gold Milk 500ml', nameHi: 'अमूल गोल्ड दूध 500ml', aliases: ['amul gold', 'doodh', 'milk'], unitCode: 'PACKET', hintPricePaise: 3400, isCommon: true },
  { categoryKey: 'dairy', nameEn: 'Amul Butter 100g', nameHi: 'अमूल बटर 100g', aliases: ['butter', 'makhan', 'amul butter'], unitCode: 'PIECE', hintPricePaise: 6200, isCommon: true },
  { categoryKey: 'dairy', nameEn: 'Curd (Dahi) 400g', nameHi: 'दही 400g', aliases: ['dahi', 'curd', 'yogurt'], unitCode: 'PIECE', hintPricePaise: 4000, isCommon: true },
  { categoryKey: 'dairy', nameEn: 'Paneer 200g', nameHi: 'पनीर 200g', aliases: ['paneer', 'cheese'], unitCode: 'PIECE', hintPricePaise: 9500, isCommon: false },
  { categoryKey: 'dairy', nameEn: 'Bread', nameHi: 'ब्रेड', aliases: ['bread', 'double roti', 'pav'], unitCode: 'PIECE', hintPricePaise: 4500, isCommon: true },
  { categoryKey: 'dairy', nameEn: 'Eggs', nameHi: 'अंडे', aliases: ['anda', 'ande', 'egg'], unitCode: 'PIECE', hintPricePaise: 800, isCommon: true },

  // ── Instant Food ───────────────────────────────────────────────────────────────────────
  { categoryKey: 'instant', nameEn: 'Maggi Noodles 70g', nameHi: 'मैगी 70g', aliases: ['maggi', 'noodles', 'maggie'], unitCode: 'PACKET', hintPricePaise: 1400, isCommon: true },
  { categoryKey: 'instant', nameEn: 'Maggi Noodles 4-Pack', nameHi: 'मैगी 4 पैक', aliases: ['maggi pack', 'maggi family'], unitCode: 'PACKET', hintPricePaise: 5600, isCommon: true },
  { categoryKey: 'instant', nameEn: 'Yippee Noodles', nameHi: 'यिप्पी नूडल्स', aliases: ['yippee', 'noodles'], unitCode: 'PACKET', hintPricePaise: 1400, isCommon: false },
  { categoryKey: 'instant', nameEn: 'Top Ramen', nameHi: 'टॉप रामेन', aliases: ['top ramen', 'ramen', 'noodles'], unitCode: 'PACKET', hintPricePaise: 1400, isCommon: false },
  { categoryKey: 'instant', nameEn: 'Kissan Mixed Fruit Jam 200g', nameHi: 'किसान जैम 200g', aliases: ['jam', 'kissan'], unitCode: 'PIECE', hintPricePaise: 8000, isCommon: false },
  { categoryKey: 'instant', nameEn: 'Tomato Ketchup 200g', nameHi: 'टोमैटो सॉस 200g', aliases: ['ketchup', 'sauce', 'tomato sauce'], unitCode: 'PIECE', hintPricePaise: 5000, isCommon: true },

  // ── Personal Care ──────────────────────────────────────────────────────────────────────
  { categoryKey: 'personal_care', nameEn: 'Lifebuoy Soap', nameHi: 'लाइफ़बॉय साबुन', aliases: ['lifebuoy', 'sabun', 'saabun', 'soap'], unitCode: 'PIECE', hintPricePaise: 3500, isCommon: true },
  { categoryKey: 'personal_care', nameEn: 'Lux Soap', nameHi: 'लक्स साबुन', aliases: ['lux', 'sabun', 'soap'], unitCode: 'PIECE', hintPricePaise: 4000, isCommon: true },
  { categoryKey: 'personal_care', nameEn: 'Santoor Soap', nameHi: 'संतूर साबुन', aliases: ['santoor', 'sabun', 'soap'], unitCode: 'PIECE', hintPricePaise: 4000, isCommon: true },
  { categoryKey: 'personal_care', nameEn: 'Colgate Toothpaste 100g', nameHi: 'कोलगेट 100g', aliases: ['colgate', 'toothpaste', 'manjan', 'paste'], unitCode: 'PIECE', hintPricePaise: 6000, isCommon: true },
  { categoryKey: 'personal_care', nameEn: 'Clinic Plus Shampoo Sachet', nameHi: 'क्लिनिक प्लस पाउच', aliases: ['clinic plus', 'shampoo', 'sachet', 'pouch'], unitCode: 'PIECE', hintPricePaise: 300, isCommon: true },
  { categoryKey: 'personal_care', nameEn: 'Head & Shoulders 180ml', nameHi: 'हेड एंड शोल्डर्स', aliases: ['head shoulders', 'shampoo'], unitCode: 'PIECE', hintPricePaise: 19000, isCommon: false },
  { categoryKey: 'personal_care', nameEn: 'Parachute Coconut Oil 100ml', nameHi: 'पैराशूट तेल 100ml', aliases: ['parachute', 'nariyal tel', 'hair oil', 'coconut oil'], unitCode: 'PIECE', hintPricePaise: 4500, isCommon: true },
  { categoryKey: 'personal_care', nameEn: 'Dettol Antiseptic 100ml', nameHi: 'डेटॉल 100ml', aliases: ['dettol', 'antiseptic'], unitCode: 'PIECE', hintPricePaise: 6500, isCommon: false },

  // ── Cleaning & Household ───────────────────────────────────────────────────────────────
  { categoryKey: 'household', nameEn: 'Surf Excel Easy Wash 1kg', nameHi: 'सर्फ़ एक्सेल 1kg', aliases: ['surf', 'surf excel', 'detergent', 'washing powder'], unitCode: 'PACKET', hintPricePaise: 13500, isCommon: true },
  { categoryKey: 'household', nameEn: 'Rin Detergent Bar', nameHi: 'रिन साबुन', aliases: ['rin', 'detergent bar', 'kapde ka sabun'], unitCode: 'PIECE', hintPricePaise: 1200, isCommon: true },
  { categoryKey: 'household', nameEn: 'Vim Dishwash Bar', nameHi: 'विम बार', aliases: ['vim', 'dishwash', 'bartan sabun'], unitCode: 'PIECE', hintPricePaise: 2000, isCommon: true },
  { categoryKey: 'household', nameEn: 'Vim Dishwash Liquid 500ml', nameHi: 'विम लिक्विड 500ml', aliases: ['vim liquid', 'dishwash liquid'], unitCode: 'PIECE', hintPricePaise: 11000, isCommon: false },
  { categoryKey: 'household', nameEn: 'Harpic 500ml', nameHi: 'हार्पिक 500ml', aliases: ['harpic', 'toilet cleaner'], unitCode: 'PIECE', hintPricePaise: 9500, isCommon: true },
  { categoryKey: 'household', nameEn: 'Lizol Floor Cleaner 500ml', nameHi: 'लाइज़ॉल 500ml', aliases: ['lizol', 'phenyl', 'floor cleaner'], unitCode: 'PIECE', hintPricePaise: 10000, isCommon: false },
  { categoryKey: 'household', nameEn: 'Agarbatti Packet', nameHi: 'अगरबत्ती', aliases: ['agarbatti', 'incense', 'dhoop'], unitCode: 'PACKET', hintPricePaise: 2000, isCommon: true },
  { categoryKey: 'household', nameEn: 'Candle', nameHi: 'मोमबत्ती', aliases: ['candle', 'mombatti'], unitCode: 'PIECE', hintPricePaise: 1000, isCommon: true },
  { categoryKey: 'household', nameEn: 'Match Box', nameHi: 'माचिस', aliases: ['machis', 'matchbox', 'match'], unitCode: 'PIECE', hintPricePaise: 200, isCommon: true },

  // ── Stationery ─────────────────────────────────────────────────────────────────────────
  { categoryKey: 'stationery', nameEn: 'Ball Pen (Blue)', nameHi: 'पेन (नीला)', aliases: ['pen', 'ball pen', 'kalam'], unitCode: 'PIECE', hintPricePaise: 1000, isCommon: true },
  { categoryKey: 'stationery', nameEn: 'Notebook 100 pages', nameHi: 'कॉपी 100 पेज', aliases: ['copy', 'notebook', 'register'], unitCode: 'PIECE', hintPricePaise: 3000, isCommon: true },
  { categoryKey: 'stationery', nameEn: 'Pencil', nameHi: 'पेंसिल', aliases: ['pencil'], unitCode: 'PIECE', hintPricePaise: 500, isCommon: true },
  { categoryKey: 'stationery', nameEn: 'Eraser', nameHi: 'रबड़', aliases: ['eraser', 'rubber', 'rabar'], unitCode: 'PIECE', hintPricePaise: 500, isCommon: false },
]

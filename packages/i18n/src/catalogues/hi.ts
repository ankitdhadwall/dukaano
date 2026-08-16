/**
 * Hindi catalogue — हिंदी.
 *
 * Not a translation of the English file: this is the language most Dukaano users will actually
 * read, and it is written as primary copy. Two rules that a machine translation would get wrong
 * and that reviewers should hold this file to:
 *
 *   1. **Everyday shop Hindi, not formal/Sanskritised Hindi.** A shopkeeper says "स्टॉक",
 *      "बिल", "पेमेंट" and "मोबाइल नंबर" — commonly used English loanwords written in
 *      Devanagari. Writing "सूची" for stock or "दूरभाष संख्या" for phone number is technically
 *      correct and completely alien to the reader.
 *   2. **No accounting jargon** (blueprint §29). "बकाया" (outstanding), not "देयता".
 *
 * Numerals stay Latin (₹1,250, not ₹१,२५०) — see formatters.ts for why.
 */
export const hi = {
  // --- common ------------------------------------------------------------------------------
  'common.appName': 'दुकानो',
  'common.tagline': 'बिलिंग, स्टॉक और खाता — सब एक जगह',
  'common.save': 'सेव करें',
  'common.cancel': 'रद्द करें',
  'common.delete': 'हटाएं',
  'common.edit': 'बदलें',
  'common.done': 'हो गया',
  'common.next': 'आगे बढ़ें',
  'common.back': 'पीछे',
  'common.search': 'खोजें',
  'common.retry': 'दोबारा कोशिश करें',
  'common.loading': 'लोड हो रहा है…',
  'common.yes': 'हाँ',
  'common.no': 'नहीं',
  'common.total': 'कुल',
  'common.paid': 'जमा',
  'common.pending': 'बाकी',
  'common.today': 'आज',

  // --- navigation --------------------------------------------------------------------------
  'nav.home': 'होम',
  'nav.sale': 'बिक्री',
  'nav.newSale': 'नई बिक्री',
  'nav.stock': 'स्टॉक',
  'nav.khata': 'खाता',
  'nav.customers': 'ग्राहक',
  'nav.reports': 'रिपोर्ट',
  'nav.settings': 'सेटिंग',
  'nav.more': 'और',

  // --- auth --------------------------------------------------------------------------------
  'auth.login': 'लॉगिन करें',
  'auth.logout': 'लॉगआउट',
  'auth.phone': 'मोबाइल नंबर',
  'auth.password': 'पासवर्ड',
  'auth.register': 'नया अकाउंट बनाएं',
  'auth.shopName': 'दुकान का नाम',
  'auth.welcome': 'नमस्ते, {{name}}',

  // --- shop --------------------------------------------------------------------------------
  'shop.created': 'दुकान बन गई',
  'shop.settings': 'दुकान की सेटिंग',
  'shop.language': 'भाषा',
  'shop.timezone': 'समय क्षेत्र',

  // --- roles -------------------------------------------------------------------------------
  'role.OWNER': 'मालिक',
  'role.MANAGER': 'मैनेजर',
  'role.CASHIER': 'कैशियर',

  // --- units -------------------------------------------------------------------------------
  'unit.PIECE': 'नग',
  'unit.PACKET': 'पैकेट',
  'unit.BOX': 'डिब्बा',
  'unit.DOZEN': 'दर्जन',
  'unit.BOTTLE': 'बोतल',
  'unit.BAG': 'बोरी',
  'unit.KG': 'किलो',
  'unit.GRAM': 'ग्राम',
  'unit.LITRE': 'लीटर',
  'unit.ML': 'मिली',
  'unit.METRE': 'मीटर',

  // --- counts ------------------------------------------------------------------------------
  // Hindi CLDR has `one` and `other`, and treats 0 as `one` — which is why plural selection goes
  // through Intl.PluralRules rather than a `count === 1` check.
  'count.items_one': '{{count}} चीज़',
  'count.items_other': '{{count}} चीज़ें',
  'count.customers_one': '{{count}} ग्राहक',
  'count.customers_other': '{{count}} ग्राहक',
  'count.pendingSync_one': '{{count}} बाकी',
  'count.pendingSync_other': '{{count}} बाकी',

  // --- errors: generic ----------------------------------------------------------------------
  'errors.unknown': 'कुछ गड़बड़ हो गई। दोबारा कोशिश करें।',
  'errors.network': 'इंटरनेट नहीं है। आपका काम इसी फ़ोन में सेव है और अपने आप सिंक हो जाएगा।',
  'errors.validation': 'लाल दिख रहे खानों को ठीक करें।',
  'errors.notFound': 'नहीं मिला।',
  'errors.rateLimited': 'बहुत बार कोशिश की गई। {{seconds}} सेकंड बाद दोबारा कोशिश करें।',

  // --- errors: auth & permissions -----------------------------------------------------------
  'errors.auth.invalidCredentials': 'मोबाइल नंबर या पासवर्ड सही नहीं है।',
  'errors.auth.accountSuspended': 'यह अकाउंट बंद कर दिया गया है। दुकान के मालिक से बात करें।',
  'errors.auth.sessionExpired': 'आपका सेशन खत्म हो गया। दोबारा लॉगिन करें।',
  'errors.auth.tokenReused': 'सुरक्षा के लिए आपको सभी डिवाइस से लॉगआउट कर दिया गया है। दोबारा लॉगिन करें।',
  'errors.auth.phoneTaken': 'इस मोबाइल नंबर से पहले से अकाउंट बना हुआ है।',
  'errors.permission.denied': 'आपको {{action}} की अनुमति नहीं है। दुकान के मालिक से चालू करवाएं।',
  'errors.entitlement.denied': 'यह सुविधा आपके {{plan}} प्लान में नहीं है।',
  'errors.tenant.noShop': 'आप किसी दुकान से जुड़े हुए नहीं हैं।',

  // --- errors: money & quantity ---------------------------------------------------------------
  'errors.money.invalidValue': 'सही रकम डालें।',
  'errors.money.overflow': 'यह रकम बहुत बड़ी है।',
  'errors.money.invalidDivisor': 'गणना में गड़बड़ी।',
  'errors.money.invalidAllocation': 'बंटवारा सही नहीं है।',
  'errors.money.required': 'रकम डालें।',
  'errors.money.invalid': 'सही रकम डालें, जैसे 44.50',
  'errors.money.tooManyDecimals': 'रकम में ज़्यादा से ज़्यादा {{max}} दशमलव हो सकते हैं।',
  'errors.money.tooLarge': 'यह रकम बहुत बड़ी है।',
  'errors.quantity.required': 'मात्रा डालें।',
  'errors.quantity.invalid': 'सही मात्रा डालें, जैसे 1.5',
  'errors.quantity.tooManyDecimals': 'इस यूनिट में ज़्यादा से ज़्यादा {{max}} दशमलव हो सकते हैं।',
  'errors.quantity.tooLarge': 'यह मात्रा बहुत ज़्यादा है।',
  'errors.quantity.invalidUnitPrecision': 'यूनिट की दशमलव सेटिंग सही नहीं है।',

  // --- errors: domain rules ------------------------------------------------------------------
  'errors.product.nameRequired': 'प्रोडक्ट का नाम डालें।',
  'errors.product.duplicateSku': '{{sku}} कोड वाला प्रोडक्ट पहले से मौजूद है।',
  'errors.customer.duplicatePhone': 'यह ग्राहक पहले से है: {{name}}',
  'errors.customer.hasOutstanding': '{{name}} का {{amount}} बकाया है। पहले हिसाब करें या माफ़ करें।',
  'errors.sale.customerRequiredForCredit': 'उधार लिखने के लिए ग्राहक चुनें।',
  'errors.inventory.insufficient': 'स्टॉक में सिर्फ़ {{available}} बचा है।',
  'errors.sync.permission': 'आप ऑफलाइन थे तब आपकी अनुमति बदल गई थी, इसलिए यह बदलाव सेव नहीं हुआ।',

  // --- notifications -------------------------------------------------------------------------
  'notification.lowStock.title': 'स्टॉक कम है',
  'notification.lowStock.body': '{{count}} चीज़ें खत्म होने वाली हैं।',
  'notification.stockMismatch.title': 'स्टॉक में गड़बड़',
  'notification.stockMismatch.body': 'सिंक के बाद {{product}} का स्टॉक शून्य से नीचे चला गया। ठीक करने के लिए दबाएं।',
  'notification.syncFailed.title': 'सिंक रुक गया',
  'notification.syncFailed.body': '{{count}} बदलाव सेव नहीं हो पाए। देखने के लिए दबाएं।',
} as const

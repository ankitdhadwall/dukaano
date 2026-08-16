/**
 * English catalogue.
 *
 * Keys are namespaced by domain. Every key here MUST have a Hindi counterpart — the parity test
 * in catalogues.test.ts fails CI otherwise (blueprint §22.1), so a feature cannot ship
 * English-only and get "translated later".
 *
 * Copy rules (blueprint §29): name things the way a shopkeeper would, not the way the system is
 * built. Errors say what went wrong and what to do about it. No accounting jargon.
 */
export const en = {
  // --- common ------------------------------------------------------------------------------
  'common.appName': 'Dukaano',
  'common.tagline': 'Billing, Stock and Khata — all in one place',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.done': 'Done',
  'common.next': 'Next',
  'common.back': 'Back',
  'common.search': 'Search',
  'common.retry': 'Try again',
  'common.loading': 'Loading…',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.total': 'Total',
  'common.paid': 'Paid',
  'common.pending': 'Pending',
  'common.today': 'Today',

  // --- navigation --------------------------------------------------------------------------
  'nav.home': 'Home',
  'nav.sale': 'Sale',
  'nav.newSale': 'New Sale',
  'nav.stock': 'Stock',
  'nav.khata': 'Khata',
  'nav.customers': 'Customers',
  'nav.reports': 'Reports',
  'nav.settings': 'Settings',
  'nav.more': 'More',

  // --- auth --------------------------------------------------------------------------------
  'auth.login': 'Log in',
  'auth.logout': 'Log out',
  'auth.phone': 'Mobile number',
  'auth.password': 'Password',
  'auth.register': 'Create account',
  'auth.shopName': 'Shop name',
  'auth.welcome': 'Welcome, {{name}}',

  // --- shop --------------------------------------------------------------------------------
  'shop.created': 'Shop created',
  'shop.settings': 'Shop settings',
  'shop.language': 'Language',
  'shop.timezone': 'Time zone',

  // --- roles -------------------------------------------------------------------------------
  'role.OWNER': 'Owner',
  'role.MANAGER': 'Manager',
  'role.CASHIER': 'Cashier',

  // --- units -------------------------------------------------------------------------------
  'unit.PIECE': 'Piece',
  'unit.PACKET': 'Packet',
  'unit.BOX': 'Box',
  'unit.DOZEN': 'Dozen',
  'unit.BOTTLE': 'Bottle',
  'unit.BAG': 'Bag',
  'unit.KG': 'kg',
  'unit.GRAM': 'g',
  'unit.LITRE': 'L',
  'unit.ML': 'ml',
  'unit.METRE': 'm',

  // --- counts (ICU plural categories) -------------------------------------------------------
  'count.items_one': '{{count}} item',
  'count.items_other': '{{count}} items',
  'count.customers_one': '{{count}} customer',
  'count.customers_other': '{{count}} customers',
  'count.pendingSync_one': '{{count}} pending',
  'count.pendingSync_other': '{{count}} pending',

  // --- errors: generic ----------------------------------------------------------------------
  'errors.unknown': 'Something went wrong. Please try again.',
  'errors.network': 'No internet connection. Your work is saved on this device and will sync automatically.',
  'errors.validation': 'Please check the highlighted fields.',
  'errors.notFound': 'Not found.',
  'errors.rateLimited': 'Too many attempts. Please wait {{seconds}} seconds and try again.',

  // --- errors: auth & permissions -----------------------------------------------------------
  'errors.auth.invalidCredentials': 'That mobile number or password is not correct.',
  'errors.auth.accountSuspended': 'This account has been suspended. Contact your shop owner.',
  'errors.auth.sessionExpired': 'Your session has ended. Please log in again.',
  'errors.auth.tokenReused': 'For your security you have been logged out of all devices. Please log in again.',
  'errors.auth.phoneTaken': 'An account already exists with this mobile number.',
  // Names the missing permission and who can grant it — "Forbidden" alone is useless to the user.
  'errors.permission.denied': 'You do not have permission to {{action}}. Ask the shop owner to enable it.',
  'errors.entitlement.denied': 'This feature is not included in your {{plan}} plan.',
  'errors.tenant.noShop': 'You are not a member of any shop.',

  // --- errors: money & quantity (raised by @dukaano/money) -----------------------------------
  'errors.money.invalidValue': 'Enter a valid amount.',
  'errors.money.overflow': 'That amount is too large.',
  'errors.money.invalidDivisor': 'Invalid calculation.',
  'errors.money.invalidAllocation': 'Invalid split.',
  'errors.money.required': 'Enter an amount.',
  'errors.money.invalid': 'Enter a valid amount, for example 44.50',
  'errors.money.tooManyDecimals': 'Amounts can have at most {{max}} decimal places.',
  'errors.money.tooLarge': 'That amount is too large.',
  'errors.quantity.required': 'Enter a quantity.',
  'errors.quantity.invalid': 'Enter a valid quantity, for example 1.5',
  'errors.quantity.tooManyDecimals': 'This unit allows at most {{max}} decimal places.',
  'errors.quantity.tooLarge': 'That quantity is too large.',
  'errors.quantity.invalidUnitPrecision': 'Invalid unit precision.',

  // --- errors: domain rules ------------------------------------------------------------------
  'errors.product.nameRequired': 'Enter the product name.',
  'errors.product.duplicateSku': 'A product with the code {{sku}} already exists.',
  'errors.customer.duplicatePhone': 'This customer already exists: {{name}}',
  'errors.customer.hasOutstanding': '{{name}} still owes {{amount}}. Settle or write off the balance before archiving.',
  'errors.sale.customerRequiredForCredit': 'Choose a customer to record udhaar.',
  'errors.inventory.insufficient': 'Only {{available}} left in stock.',
  'errors.sync.permission': 'Your permissions changed while you were offline, so this change was not saved.',

  // --- notifications -------------------------------------------------------------------------
  'notification.lowStock.title': 'Running low',
  'notification.lowStock.body': '{{count}} products are running low.',
  'notification.stockMismatch.title': 'Stock mismatch',
  'notification.stockMismatch.body': '{{product}} went below zero after syncing. Tap to correct it.',
  'notification.syncFailed.title': 'Sync stopped',
  'notification.syncFailed.body': '{{count}} changes could not be saved. Tap to review.',
} as const

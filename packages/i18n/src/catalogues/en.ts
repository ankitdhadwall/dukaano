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

  'errors.category.nameRequired': 'Enter the category name.',
  'errors.category.nameTooLong': 'That category name is too long.',
  'errors.category.duplicate': 'A category called {{name}} already exists.',

  // --- errors: bulk import -------------------------------------------------------------------
  'errors.import.fileRequired': 'Choose a file to import.',
  'errors.import.fileEmpty': 'That file has no rows in it.',
  'errors.import.fileTooLarge': 'That file is too large. Split it and import in parts.',
  'errors.import.parseFailed': 'The file could not be read at line {{line}}. Check for a missing quotation mark.',
  'errors.import.tooManyRows': 'That file has {{received}} rows. Import at most {{max}} at a time.',
  'errors.import.noRows': 'There is nothing to import.',
  'errors.import.nameColumnRequired': 'Choose which column holds the product name.',
  'errors.import.priceColumnRequired': 'Choose which column holds the selling price.',
  'errors.import.priceRequired': 'This row has no selling price.',
  'errors.import.unitRequired': 'This row has no unit. Choose a unit for the whole file, or add a unit column.',
  'errors.import.duplicateInFile': 'This code is used twice in the same file. Keep one row and remove the other.',
  'errors.import.duplicateInRequest': 'The same item appears more than once.',
  'errors.import.masterProductNotFound': '{{count}} of these items are no longer available.',

  // Amber, not red: the row will import exactly as written, but it looks like a slip.
  'warnings.import.sellingBelowCost': 'The selling price is below the purchase price.',
  'warnings.import.sellingAboveMrp': 'The selling price is above the MRP.',
  'warnings.import.stockWithoutCost': 'Stock with no purchase price will show a value of zero until you record a purchase.',

  // --- errors: sync ---------------------------------------------------------------------------
  'errors.sync.retryable': 'That change could not be saved just now. It will be retried automatically.',
  'errors.sync.unsupportedEntity': 'This app version sent something the server does not understand. Please update the app.',
  'errors.sync.deviceUnknown': 'This device is not registered with the shop.',
  'errors.sync.deviceRevoked': 'This device was removed from the shop. Ask the owner to add it again.',
  'errors.sync.invalidCursor': 'The sync position was not valid, so everything will be downloaded again.',
  'errors.sync.invalidOpId': 'Invalid operation id.',
  'errors.sync.invalidEntityId': 'Invalid record id.',
  'errors.sync.invalidDeviceId': 'Invalid device id.',
  'errors.sync.invalidOpType': 'Invalid operation type.',
  'errors.sync.invalidPlatform': 'Invalid device platform.',
  'errors.sync.emptyBatch': 'There is nothing to sync.',
  'errors.sync.batchTooLarge': 'Too many changes in one go. They will be sent in smaller batches.',
  'errors.sync.duplicateOpIdInBatch': 'The same change was sent twice in one batch.',

  // --- sync status (never a toast — a persistent banner, §14.9) --------------------------------
  'sync.status.synced': 'All saved',
  'sync.status.pending': '{{count}} changes waiting to be saved',
  'sync.status.syncing': 'Saving…',
  'sync.status.offline': 'No internet. Your work is saved on this phone.',
  'sync.status.failed': 'Some changes could not be saved. Tap to see.',
  'sync.conflict.title': 'Some changes were not applied',
  'sync.conflict.priceStale': 'The price on this phone was older than the shop price, so the shop price was kept.',
  'sync.conflict.stale': 'This was changed somewhere else more recently, so that change was kept.',
  'sync.conflict.acknowledge': 'Got it',
  'sync.numbers.gapsAreNormal': 'Some bill numbers may be skipped. This is normal.',

  // --- errors: billing & khata -----------------------------------------------------------------
  'errors.sale.emptyCart': 'Add at least one item to the bill.',
  'errors.sale.quantityRequired': 'Enter a quantity.',
  'errors.sale.overpaid': 'The payment is more than the bill total. Give the change from the drawer, or record the extra as an advance.',
  'errors.sale.creditLimitExceeded': 'This will take {{name}} over their udhaar limit. Continue anyway?',
  'errors.sale.cancelReasonRequired': 'Say why this bill is being cancelled.',
  'errors.sale.alreadyCancelled': 'This bill was already cancelled.',
  'errors.sale.hasReturns': 'This bill already has returns against it. Handle those first.',
  'errors.sale.emptyReturn': 'Choose at least one item to return.',
  'errors.sale.invalidItemId': 'That item is not on this bill.',
  'errors.sale.returnExceedsSold': 'Only {{returnable}} of this item can still be returned.',
  'errors.sale.refundExceedsPaid': 'You can return at most {{max}} in cash — the rest was on udhaar and will come off their khata.',
  'errors.payment.invalidMethod': 'Choose how the money was received.',
  'errors.payment.amountRequired': 'Enter an amount.',
  'errors.payment.alreadyReversed': 'This payment was already reversed.',
  'errors.payment.notReversible': 'Only money received can be reversed.',
  'errors.payment.reversalReasonRequired': 'Say why this payment is being reversed.',
  'errors.payment.overAllocated': 'The bills selected add up to more than the payment.',
  'errors.customer.nameRequired': "Enter the customer's name.",
  'errors.customer.invalidId': 'That customer was not found.',
  'errors.khata.reasonRequired': 'A correction needs a reason. It stays on the khata permanently.',
  'errors.khata.invalidAdjustment': 'Choose a valid correction type.',

  // --- billing ---------------------------------------------------------------------------------
  'sale.udhaar': 'Udhaar',
  'sale.cash': 'Cash',
  'sale.split': 'Split',
  'sale.change': 'Change {{amount}}',
  'sale.saved': 'Bill saved',
  'sale.cancelled': 'Bill cancelled',
  'sale.stockWentNegative': 'Stock for {{product}} is now below zero. Tap to correct the count.',
  'khata.outstanding': 'Outstanding {{amount}}',
  'khata.advance': '{{amount}} advance',
  'khata.settled': 'All settled',
  'khata.paymentReceived': 'Received {{amount}}',
  'khata.statement': 'Khata statement',
  'khata.ageing.current': 'This week',
  'khata.ageing.week2': 'Up to 15 days',
  'khata.ageing.month1': 'Up to a month',
  'khata.ageing.older': 'Over a month',

  // --- notifications -------------------------------------------------------------------------
  'notification.lowStock.title': 'Running low',
  'notification.lowStock.body': '{{count}} products are running low.',
  'notification.stockMismatch.title': 'Stock mismatch',
  'notification.stockMismatch.body': '{{product}} went below zero after syncing. Tap to correct it.',
  'notification.syncFailed.title': 'Sync stopped',
  'notification.syncFailed.body': '{{count}} changes could not be saved. Tap to review.',
} as const

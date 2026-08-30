/**
 * bookpod-order.cjs
 * The one call in this codebase that spends money.
 *
 * ============================================================
 * !! OWNER APPROVAL REQUIRED !!
 * createOrder consumes pre-paid credits and triggers physical
 * printing + shipping. It is kept in its own file, apart from
 * the book-creation client, so that it is impossible to reach
 * by accident, and it refuses to run unless the owner has
 * switched BOOKPOD_ORDERS_ENABLED on in Railway.
 * ============================================================
 *
 * Env vars:
 *   BOOKPOD_ORDERS_ENABLED — must be exactly "true" for a real order to be sent.
 *                            Unset or anything else → this module throws before
 *                            reaching Bookpod. Turn it on only once the book
 *                            step has been verified end-to-end.
 *
 * ---------------------------------------------------------------------------
 * Payload shape verified against Bookpod's own WordPress plugin
 * ("BookPod Author Tools" v2.2.2, bpat-order.php:44-50 and :249-380).
 *
 * The previous implementation of this call was written from the January-2025
 * PDFs and was wrong in every part: it sent `book_id` at the top level, a
 * `shipping` object with snake_case keys, and no items array. It had never run.
 * The real payload is three parts — shippingDetails, items, totals.
 * ---------------------------------------------------------------------------
 */

'use strict';

// Bookpod's shipping method codes (bpat-order.php:301, :274).
const SHIPPING_METHOD_PICKUP_POINT = 1;
const SHIPPING_METHOD_HOME         = 2;
const SHIPPING_METHOD_SELF_PICKUP  = 3;
const SHIPPING_COMPANY_KEXPRESS    = 7;

/**
 * Attempt to extract a house number from a Hebrew (or Latin) address string.
 *
 *   "רחוב הרצל 12"  → { street: "רחוב הרצל", house: "12" }
 *   "הרצל 12א"       → { street: "הרצל", house: "12א" }
 *   "12 Main St"     → { street: "Main St", house: "12" }
 *   "Main St"        → { street: "Main St", house: "" }
 */
function splitStreetAddress(fullAddress) {
  if (!fullAddress || typeof fullAddress !== 'string') {
    return { street: '', house: '' };
  }
  const addr = fullAddress.trim();

  const trailingNum = addr.match(/^(.+?)\s+(\d+[\u05D0-\u05EAa-zA-Z]?)$/u);
  if (trailingNum) return { street: trailingNum[1].trim(), house: trailingNum[2].trim() };

  const leadingNum = addr.match(/^(\d+[\u05D0-\u05EAa-zA-Z]?)\s+(.+)$/u);
  if (leadingNum) return { street: leadingNum[2].trim(), house: leadingNum[1].trim() };

  return { street: addr, house: '' };
}

/**
 * !! OWNER APPROVAL REQUIRED — reads pre-paid credits and prints a physical book !!
 *
 * Create a print order for a book that already exists on Bookpod.
 *
 * shippingDetails shape (as produced by printShippingToBookpod in server.js):
 *   { firstName, lastName, email, phone, address, city, postalCode, country,
 *     house? }   // house overrides the auto-split when supplied
 *
 * POST /api/v1/orders
 *
 * @param {string} bookpodBookId    Bookpod internal book ID
 * @param {object} shippingDetails
 * @param {string} referenceBookId  Internal Lifebook bookId, for traceability
 * @param {object} [options]        { quantity, totalPrice }
 * @returns {Promise<{ orderId: string, referenceNum: string, status: string }>}
 */
async function createOrder(bookpodBookId, shippingDetails, referenceBookId, options = {}) {
  if (process.env.BOOKPOD_ORDERS_ENABLED !== 'true') {
    throw new Error(
      '[bookpod] createOrder is disabled. This call spends credits and prints a ' +
      'physical book. Set BOOKPOD_ORDERS_ENABLED=true in Railway to enable it, ' +
      'once the book-creation step has been verified.'
    );
  }

  console.log(`[bookpod] createOrder: bookpodBookId=${bookpodBookId} referenceBookId=${referenceBookId}`);
  console.log('[bookpod] createOrder: !! This call consumes pre-paid credits and triggers physical printing !!');

  const referenceNum = `${referenceBookId}-${Date.now()}`;

  let street = shippingDetails.address || '';
  let house = shippingDetails.house || '';
  if (!house && street) {
    const split = splitStreetAddress(street);
    street = split.street;
    house = split.house;
  }

  const name = [shippingDetails.firstName, shippingDetails.lastName]
    .filter(Boolean).join(' ').trim();

  const payload = {
    shippingDetails: {
      shippingMethod:    SHIPPING_METHOD_HOME,
      shippingCompanyId: SHIPPING_COMPANY_KEXPRESS,
      name,
      phoneNumber:       shippingDetails.phone || '',
      email:             shippingDetails.email || '',
      reference_num1:    referenceNum,
      acceptAds:         false,
      acceptTerms:       true,
      city:              shippingDetails.city || '',
      zipCode:           shippingDetails.postalCode || '',
      street,
      house,
      apartment:         shippingDetails.apartment || '',
      floor:             shippingDetails.floor || '',
      notes:             '',
      shipment_remarks:  '',
    },
    items: [
      { type: 'book', bookid: String(bookpodBookId), quantity: options.quantity ?? 1 },
    ],
    totalprice: options.totalPrice ?? 0,
    logComment: `Lifebook order for bookId ${referenceBookId}`,
  };

  const { apiRequest } = require('./bookpod-client.cjs');
  const response = await apiRequest('POST', '/api/v1/orders', payload);

  // Bookpod answer 200 with success:false on a rejected order, so the status code
  // alone is not enough to tell whether anything was actually placed.
  if (!response.success) {
    throw new Error(`[bookpod] createOrder rejected: ${JSON.stringify(response)}`);
  }

  const orderId = response.order_no;
  if (!orderId) {
    throw new Error(`[bookpod] createOrder: response missing order_no. Full response: ${JSON.stringify(response)}`);
  }

  const result = { orderId: String(orderId), referenceNum, status: 'created' };
  console.log(`[bookpod] createOrder: done — orderId=${result.orderId} reference=${referenceNum}`);
  return result;
}

module.exports = {
  createOrder,
  __test: { splitStreetAddress },
};

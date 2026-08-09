/**
 * bookpod-client.cjs
 * Standalone Bookpod API client for Lifebook AI print-PDF track.
 *
 * ============================================================
 * !! OWNER APPROVAL REQUIRED before calling createOrder !!
 * in production. Every real order consumes pre-paid credits
 * and triggers physical printing + shipping. Never call
 * createOrder automatically — always gate behind explicit
 * owner confirmation.
 * ============================================================
 *
 * Env vars required:
 *   BOOKPOD_API_TOKEN    — API auth token (never hard-code)
 *   BOOKPOD_API_BASE_URL — optional override (default: https://api.bookpod.co.il)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = process.env.BOOKPOD_API_BASE_URL || 'https://api.bookpod.co.il';
const API_TOKEN = process.env.BOOKPOD_API_TOKEN; // never fall back to a literal

// ---------------------------------------------------------------------------
// Internal HTTP helper
// ---------------------------------------------------------------------------

/**
 * Make an HTTP/HTTPS request to the Bookpod API.
 * @param {'GET'|'POST'|'PUT'|'DELETE'} method
 * @param {string} endpoint  e.g. '/api/v1/books'
 * @param {object|null} body JSON body (for POST/PUT)
 * @param {object} [extraHeaders]
 * @returns {Promise<object>} parsed JSON response
 */
function apiRequest(method, endpoint, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    if (!API_TOKEN) {
      return reject(new Error('[bookpod] BOOKPOD_API_TOKEN env var is not set'));
    }

    const url = new URL(endpoint, BASE_URL);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Accept': 'application/json',
        ...extraHeaders,
        ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          return reject(new Error(`[bookpod] Non-JSON response (HTTP ${res.statusCode}): ${data.slice(0, 200)}`));
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          reject(new Error(`[bookpod] API error HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`[bookpod] Network error: ${err.message}`)));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Multipart file upload helper for PDF files.
 * Uses Node's built-in modules only — no form-data package required.
 * @param {string} endpoint
 * @param {object} fields  plain text fields
 * @param {Array<{name:string, filePath:string, mimeType:string}>} files
 * @returns {Promise<object>}
 */
function apiUpload(endpoint, fields, files) {
  return new Promise((resolve, reject) => {
    if (!API_TOKEN) {
      return reject(new Error('[bookpod] BOOKPOD_API_TOKEN env var is not set'));
    }

    const boundary = `----BookpodBoundary${Date.now()}`;
    const url = new URL(endpoint, BASE_URL);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    // Build multipart body
    const parts = [];

    for (const [key, value] of Object.entries(fields)) {
      parts.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`)
      );
    }

    for (const { name, filePath, mimeType } of files) {
      const filename = path.basename(filePath);
      const fileData = fs.readFileSync(filePath);
      parts.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
        fileData,
        Buffer.from('\r\n')
      );
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(parts);

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuf.length,
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          return reject(new Error(`[bookpod] Non-JSON response (HTTP ${res.statusCode}): ${data.slice(0, 200)}`));
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          reject(new Error(`[bookpod] Upload error HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`[bookpod] Network error during upload: ${err.message}`)));
    req.write(bodyBuf);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Helper: splitStreetAddress
// ---------------------------------------------------------------------------

/**
 * Attempt to extract a house number from a Hebrew (or Latin) address string.
 *
 * Common Hebrew patterns:
 *   "רחוב הרצל 12"        → { street: "רחוב הרצל", houseNumber: "12" }
 *   "הרצל 12א"            → { street: "הרצל", houseNumber: "12א" }
 *   "12 Main St"          → { street: "Main St", houseNumber: "12" }
 *   "Main St 12"          → { street: "Main St", houseNumber: "12" }
 *   "Main St"             → { street: "Main St", houseNumber: "" }
 *
 * Returns { street: string, houseNumber: string }.
 * If extraction fails, street = fullAddress, houseNumber = "".
 *
 * @param {string} fullAddress
 * @returns {{ street: string, houseNumber: string }}
 */
function splitStreetAddress(fullAddress) {
  if (!fullAddress || typeof fullAddress !== 'string') {
    return { street: '', houseNumber: '' };
  }

  const addr = fullAddress.trim();

  // Pattern 1: number (optionally followed by Hebrew letter/letter) at END of string
  // e.g. "הרצל 12" or "הרצל 12א" or "Main St 12B"
  const trailingNum = addr.match(/^(.+?)\s+(\d+[\u05D0-\u05EAa-zA-Z]?)$/u);
  if (trailingNum) {
    return { street: trailingNum[1].trim(), houseNumber: trailingNum[2].trim() };
  }

  // Pattern 2: number at START of string (Western format)
  // e.g. "12 Main St"
  const leadingNum = addr.match(/^(\d+[\u05D0-\u05EAa-zA-Z]?)\s+(.+)$/u);
  if (leadingNum) {
    return { street: leadingNum[2].trim(), houseNumber: leadingNum[1].trim() };
  }

  // No number found
  return { street: addr, houseNumber: '' };
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

/**
 * Check the account balance / remaining print credits.
 *
 * // GET /api/v1/balance
 *
 * @returns {Promise<{ balance: number, currency: string }>}
 */
async function checkBalance() {
  console.log('[bookpod] checkBalance: requesting account balance');

  const response = await apiRequest('GET', '/api/v1/balance');

  const result = {
    balance: response.balance ?? response.credits ?? response.amount ?? null,
    currency: response.currency ?? 'ILS',
  };

  console.log(`[bookpod] checkBalance: done — balance=${result.balance} ${result.currency}`);
  return result;
}

/**
 * Check balance and throw if below the minimum required amount.
 *
 * @param {number} [minimumRequired=1]  minimum acceptable balance
 * @returns {Promise<{ balance: number, currency: string }>}
 */
async function checkBalanceOrThrow(minimumRequired = 1) {
  const info = await checkBalance();
  if (info.balance === null || info.balance < minimumRequired) {
    throw new Error(
      `[bookpod] Insufficient credits: balance=${info.balance} ${info.currency}, required=${minimumRequired}`
    );
  }
  return info;
}

/**
 * Create a book draft on Bookpod.
 *
 * status is always set to false (draft) — owner must manually activate
 * or a separate publish step must be called after owner confirmation.
 *
 * // POST /api/v1/books
 *
 * @param {string} bookId         Internal Lifebook bookId (used as external reference)
 * @param {string} contentPdfPath Absolute path to the interior content PDF (28 pages, 22.64×22.64 cm, 300DPI)
 * @param {string} coverPdfPath   Absolute path to the cover PDF (flat: back+spine+front)
 * @returns {Promise<string>}     Bookpod book ID
 */
async function createBook(bookId, contentPdfPath, coverPdfPath) {
  console.log(`[bookpod] createBook: bookId=${bookId} content=${contentPdfPath} cover=${coverPdfPath}`);

  if (!fs.existsSync(contentPdfPath)) {
    throw new Error(`[bookpod] createBook: content PDF not found at ${contentPdfPath}`);
  }
  if (!fs.existsSync(coverPdfPath)) {
    throw new Error(`[bookpod] createBook: cover PDF not found at ${coverPdfPath}`);
  }

  // status=false → draft (NOT live) until owner confirms
  const fields = {
    external_id: bookId,
    status: 'false', // DRAFT — do not publish automatically
  };

  const files = [
    { name: 'content_file', filePath: contentPdfPath, mimeType: 'application/pdf' },
    { name: 'cover_file',   filePath: coverPdfPath,   mimeType: 'application/pdf' },
  ];

  const response = await apiUpload('/api/v1/books', fields, files);

  const bookpodBookId = response.id ?? response.book_id ?? response.bookId;
  if (!bookpodBookId) {
    throw new Error(`[bookpod] createBook: response missing book ID. Full response: ${JSON.stringify(response)}`);
  }

  console.log(`[bookpod] createBook: done — bookpodBookId=${bookpodBookId} (status=draft)`);
  return String(bookpodBookId);
}

/**
 * Calculate production + shipping cost estimate for a book.
 *
 * // GET /api/v1/books/:bookpodBookId/price?country=IL
 *
 * @param {string} bookpodBookId    Bookpod internal book ID (returned by createBook)
 * @param {string} [shippingCountry='IL']  ISO 3166-1 alpha-2 country code
 * @returns {Promise<{ productionCost: number, shippingCost: number, totalCost: number, currency: string }>}
 */
async function calculateCost(bookpodBookId, shippingCountry = 'IL') {
  console.log(`[bookpod] calculateCost: bookpodBookId=${bookpodBookId} country=${shippingCountry}`);

  const response = await apiRequest(
    'GET',
    `/api/v1/books/${encodeURIComponent(bookpodBookId)}/price?country=${encodeURIComponent(shippingCountry)}`
  );

  const result = {
    productionCost: response.production_cost ?? response.productionCost ?? null,
    shippingCost:   response.shipping_cost   ?? response.shippingCost   ?? null,
    totalCost:      response.total_cost       ?? response.totalCost      ?? response.total ?? null,
    currency:       response.currency ?? 'ILS',
  };

  console.log(`[bookpod] calculateCost: done — total=${result.totalCost} ${result.currency}`);
  return result;
}

/**
 * !! OWNER APPROVAL REQUIRED — reads pre-paid credits and triggers physical production !!
 *
 * Create a print order for an approved book draft.
 *
 * Generates a unique reference_num1 = `${referenceBookId}-${Date.now()}` so
 * every order is traceable back to the Lifebook bookId in Bookpod's system.
 *
 * shippingDetails shape:
 * {
 *   firstName:   string,
 *   lastName:    string,
 *   email:       string,
 *   phone:       string,
 *   address:     string,   // full street address (house number may be embedded)
 *   city:        string,
 *   postalCode:  string,
 *   country:     string,   // ISO 3166-1 alpha-2, default 'IL'
 *   // Optional — if provided, overrides auto-split:
 *   houseNumber: string,
 * }
 *
 * // POST /api/v1/orders
 *
 * @param {string} bookpodBookId      Bookpod internal book ID
 * @param {object} shippingDetails
 * @param {string} referenceBookId    Internal Lifebook bookId for the reference field
 * @returns {Promise<{ orderId: string, trackingNumber: string|null, status: string }>}
 */
async function createOrder(bookpodBookId, shippingDetails, referenceBookId) {
  // ============================================================
  // !! OWNER APPROVAL REQUIRED — do not call in automated flows !!
  // ============================================================
  console.log(`[bookpod] createOrder: bookpodBookId=${bookpodBookId} referenceBookId=${referenceBookId}`);
  console.log('[bookpod] createOrder: !! This call consumes pre-paid credits and triggers physical printing !!');

  const referenceNum = `${referenceBookId}-${Date.now()}`;

  // Split house number if not explicitly provided
  let street = shippingDetails.address || '';
  let houseNumber = shippingDetails.houseNumber || '';

  if (!houseNumber && street) {
    const split = splitStreetAddress(street);
    street = split.street;
    houseNumber = split.houseNumber;
  }

  const payload = {
    book_id:       bookpodBookId,
    reference_num1: referenceNum,
    shipping: {
      first_name:   shippingDetails.firstName  || '',
      last_name:    shippingDetails.lastName   || '',
      email:        shippingDetails.email      || '',
      phone:        shippingDetails.phone      || '',
      street:       street,
      house_number: houseNumber,
      city:         shippingDetails.city       || '',
      postal_code:  shippingDetails.postalCode || '',
      country:      shippingDetails.country    || 'IL',
    },
  };

  const response = await apiRequest('POST', '/api/v1/orders', payload);

  const orderId = response.id ?? response.order_id ?? response.orderId;
  if (!orderId) {
    throw new Error(`[bookpod] createOrder: response missing order ID. Full response: ${JSON.stringify(response)}`);
  }

  const result = {
    orderId:        String(orderId),
    trackingNumber: response.tracking_number ?? response.trackingNumber ?? null,
    status:         response.status ?? 'created',
    referenceNum,
  };

  console.log(`[bookpod] createOrder: done — orderId=${result.orderId} tracking=${result.trackingNumber} status=${result.status}`);
  return result;
}

/**
 * Get shipment / production status for an existing order.
 *
 * // GET /api/v1/orders/:orderId
 *
 * @param {string} orderId  Order ID returned by createOrder
 * @returns {Promise<{ orderId: string, status: string, trackingNumber: string|null, trackingUrl: string|null, updatedAt: string|null }>}
 */
async function getShipmentStatus(orderId) {
  console.log(`[bookpod] getShipmentStatus: orderId=${orderId}`);

  const response = await apiRequest('GET', `/api/v1/orders/${encodeURIComponent(orderId)}`);

  const result = {
    orderId:        String(response.id ?? response.order_id ?? orderId),
    status:         response.status ?? 'unknown',
    trackingNumber: response.tracking_number ?? response.trackingNumber ?? null,
    trackingUrl:    response.tracking_url    ?? response.trackingUrl    ?? null,
    updatedAt:      response.updated_at      ?? response.updatedAt      ?? null,
  };

  console.log(`[bookpod] getShipmentStatus: done — status=${result.status} tracking=${result.trackingNumber}`);
  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Helpers
  splitStreetAddress,

  // API functions
  checkBalance,
  checkBalanceOrThrow,
  createBook,
  calculateCost,
  createOrder,       // !! OWNER APPROVAL REQUIRED before calling in production !!
  getShipmentStatus,
};

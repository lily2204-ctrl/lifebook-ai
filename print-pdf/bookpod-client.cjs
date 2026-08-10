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
 *   BOOKPOD_USER_ID      — Bookpod account user id (sent as x-user-id header)
 *   BOOKPOD_API_TOKEN    — API auth token (sent as x-custom-token header; never hard-code)
 *   BOOKPOD_API_BASE_URL — optional override
 *                          (default: https://cloud-function-bookpod-festjdz7ga-ey.a.run.app)
 *
 * Base URL + auth headers confirmed from two cross-referenced sources (2026-08-10):
 *   1. Official Bookpod API docs (CreateBook / CreateOrder PDFs, Jan-2025).
 *   2. Official WordPress plugin "bookpod-author-tools" (bpat-book.php) — same
 *      host hardcoded, same x-user-id + x-custom-token headers.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = process.env.BOOKPOD_API_BASE_URL || 'https://cloud-function-bookpod-festjdz7ga-ey.a.run.app';
const USER_ID = process.env.BOOKPOD_USER_ID;     // sent as x-user-id header
const API_TOKEN = process.env.BOOKPOD_API_TOKEN; // sent as x-custom-token header; never fall back to a literal

// Auth headers used on every request — Bookpod uses x-user-id + x-custom-token,
// NOT an Authorization: Bearer token (confirmed from docs + the official plugin).
function authHeaders() {
  return { 'x-user-id': USER_ID, 'x-custom-token': API_TOKEN };
}

function assertCredentials() {
  if (!USER_ID) return '[bookpod] BOOKPOD_USER_ID env var is not set';
  if (!API_TOKEN) return '[bookpod] BOOKPOD_API_TOKEN env var is not set';
  return null;
}

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
    const credErr = assertCredentials();
    if (credErr) {
      return reject(new Error(credErr));
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
        ...authHeaders(),
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
    const credErr = assertCredentials();
    if (credErr) {
      return reject(new Error(credErr));
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
        ...authHeaders(),
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

// NOTE: There is no balance/credits endpoint in the Bookpod API (confirmed from
// the official docs + the official WordPress plugin). Account credits are viewed
// in the Bookpod dashboard. Live wiring is verified by the draft upload itself.

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

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Helpers
  splitStreetAddress,

  // API functions
  createBook,
  createOrder,       // !! OWNER APPROVAL REQUIRED before calling in production !!
};

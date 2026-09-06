/**
 * bookpod-client.cjs
 * Standalone Bookpod API client for Lifebook AI print-PDF track.
 *
 * ============================================================
 * !! OWNER APPROVAL REQUIRED before calling createOrder !!
 * Every real order consumes pre-paid credits and triggers
 * physical printing + shipping. createOrder lives in
 * bookpod-order.cjs and is gated behind BOOKPOD_ORDERS_ENABLED.
 * ============================================================
 *
 * Env vars required:
 *   BOOKPOD_USER_ID      — Bookpod account user id (sent as x-user-id header)
 *   BOOKPOD_API_TOKEN    — API auth token (sent as x-custom-token header; never hard-code)
 *   BOOKPOD_API_BASE_URL — optional override
 *                          (default: https://cloud-function-bookpod-festjdz7ga-ey.a.run.app)
 *
 * ---------------------------------------------------------------------------
 * Source of truth (2026-08-30): Bookpod's own WordPress plugin,
 * "BookPod Author Tools" v2.2.2, downloaded from wordpress.org. It is the code
 * Bookpod themselves write against this API, so it beats their published PDFs —
 * which are dated January 2025 and describe an upload flow that no longer exists.
 *
 * The first live run against this API returned
 *   HTTP 500 {"success":false,"error":"Unexpected field"}
 * That string is multer's LIMIT_UNEXPECTED_FILE, and the plugin says why, verbatim
 * (bookpod-author-tools.php:615):
 *   "each preview image is sent with the exact field name "images"
 *    (BookPod backend expects upload.fields([{ name: 'images' }]))"
 * POST /api/v1/books accepts exactly one file field — `images`, the store
 * thumbnails. The PDFs do not go through it at all any more. They are PUT
 * straight to Google Cloud Storage against a signed URL, and the book record
 * then references them by gs:// URI. Hence the three steps below.
 * ---------------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const https = require('https');
const http = require('http');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = process.env.BOOKPOD_API_BASE_URL || 'https://cloud-function-bookpod-festjdz7ga-ey.a.run.app';
const USER_ID = process.env.BOOKPOD_USER_ID;     // sent as x-user-id header
const API_TOKEN = process.env.BOOKPOD_API_TOKEN; // sent as x-custom-token header; never fall back to a literal

// Auth headers used on every API request — Bookpod uses x-user-id + x-custom-token,
// NOT an Authorization: Bearer token. Note these are NOT sent when PUTting a file
// to a signed Google Storage URL: that URL carries its own credentials.
function authHeaders() {
  return { 'x-user-id': USER_ID, 'x-custom-token': API_TOKEN };
}

function assertCredentials() {
  if (!USER_ID) return '[bookpod] BOOKPOD_USER_ID env var is not set';
  if (!API_TOKEN) return '[bookpod] BOOKPOD_API_TOKEN env var is not set';
  return null;
}

// ─── Print specification ─────────────────────────────────────────────────────
// The physical product. Values are the exact keys Bookpod's own form offers
// (bpat-book.php:948-990) — anything else is rejected.
//
// sheettype `chromo170` = Chromo Matte 170gr. This is an independent confirmation
// of the paper we had already reverse-engineered from the spine: their
// configurator shows 0.225cm for our 28 pages, and 14 sheets x 0.16mm is the only
// combination in their thickness table that lands there. Two different routes,
// same paper.
//
// laminationtype is deliberately left as a parameter, not settled: `matt` sits
// with our matte paper and our look, but the choice is pending Bookpod's own
// recommendation and the physical proof (owner, 2026-08-30).
const PRINT_DEFAULTS = {
  // `title` is the ONLY naming field Bookpod's API has, so it is also the only
  // thing that distinguishes one book from another in their dashboard. The caller
  // is expected to pass a real one (server.js buildBookpodTitle); the bookId
  // fallback below is a last resort that produces an unreadable row, not a plan.
  title:            null,
  author:           'Lifebook',
  language:         'Hebrew',
  printcolor:       'color',
  sheettype:        'chromo170',   // Chromo Matte 170gr
  laminationtype:   'matt',        // 'none' | 'flat' (gloss) | 'matt' — OPEN, see above
  finishtype:       'soft',        // soft cover — the only option they offer
  readingdirection: 'right',       // right-to-left, Hebrew binding
  widthCm:          19,            // their form allows 12–22
  heightCm:         28.5,          // their form allows 17–29.7
  bleed:            true,          // our files carry 3.2mm bleed on every side
  showInStore:      false,
};

// ---------------------------------------------------------------------------
// Internal HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Make a JSON HTTP request to the Bookpod API.
 * @param {'GET'|'POST'|'PUT'|'DELETE'} method
 * @param {string} endpoint  e.g. '/api/v1/books'
 * @param {object|null} body JSON body (for POST/PUT)
 * @returns {Promise<object>} parsed JSON response
 */
function apiRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const credErr = assertCredentials();
    if (credErr) return reject(new Error(credErr));

    const url = new URL(endpoint, BASE_URL);
    const lib = url.protocol === 'https:' ? https : http;
    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        ...authHeaders(),
        'Accept': 'application/json',
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
 * PUT a file's bytes to a pre-signed Google Cloud Storage URL.
 * No auth headers — the signature in the URL is the credential, and adding our
 * own headers would break it. The response body is XML on failure, never JSON,
 * so this deliberately does not try to parse it.
 */
function putFileToSignedUrl(signedUrl, filePath, mimeType = 'application/pdf') {
  return new Promise((resolve, reject) => {
    const fileData = fs.readFileSync(filePath);
    const url = new URL(signedUrl);
    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'PUT',
      headers: { 'Content-Type': mimeType, 'Content-Length': fileData.length },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(true);
        reject(new Error(`[bookpod] Storage upload failed HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
      });
    });

    req.on('error', (err) => reject(new Error(`[bookpod] Network error during storage upload: ${err.message}`)));
    req.write(fileData);
    req.end();
  });
}

/**
 * Convert a signed Google Storage URL into the gs://bucket/object URI that the
 * book record stores. Both host layouts Google hands out are handled.
 * The query string — where the signature lives — is dropped on purpose.
 */
function signedUrlToGsUri(signedUrl) {
  let url;
  try {
    url = new URL(signedUrl);
  } catch {
    return null;
  }
  const objectPath = url.pathname.replace(/^\/+/, '');

  if (url.hostname === 'storage.googleapis.com') {
    const slash = objectPath.indexOf('/');
    if (slash === -1) return null;
    return `gs://${objectPath.slice(0, slash)}/${objectPath.slice(slash + 1)}`;
  }

  const hostMatch = url.hostname.match(/^(.+)\.storage\.googleapis\.com$/);
  if (hostMatch) return `gs://${hostMatch[1]}/${objectPath}`;

  return null;
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

// NOTE: There is no balance/credits endpoint in the Bookpod API. Account credits
// are viewed in the Bookpod dashboard.

/**
 * STEP 1 of createBook, exposed on its own so the wiring can be verified without
 * creating anything: it only asks for upload slots. Nothing is written to the
 * Bookpod account, no file is transferred, no credits are touched.
 *
 * It also derives the gs:// URIs here rather than in createBook, so that the
 * connection check exercises — and can show — the exact same derivation the real
 * run depends on. If Bookpod ever change their bucket layout, this free call is
 * where we find out, instead of on a live order.
 *
 * POST /api/v1/books/upload-url
 * @returns {Promise<{contentUploadUrl: string, coverUploadUrl: string, contentGsUri: string, coverGsUri: string}>}
 */
async function requestUploadUrls(contentFileName, coverFileName) {
  const res = await apiRequest('POST', '/api/v1/books/upload-url', {
    contentFileName,
    coverFileName,
  });

  const contentUploadUrl = res.contentUploadUrl;
  const coverUploadUrl = res.coverUploadUrl;
  if (!contentUploadUrl || !coverUploadUrl) {
    throw new Error(`[bookpod] upload-url: response missing upload URLs. Full response: ${JSON.stringify(res)}`);
  }

  const contentGsUri = signedUrlToGsUri(contentUploadUrl);
  const coverGsUri = signedUrlToGsUri(coverUploadUrl);
  if (!contentGsUri || !coverGsUri) {
    throw new Error(
      '[bookpod] upload-url: could not derive gs:// URIs from the signed upload URLs. ' +
      `Hosts were: ${new URL(contentUploadUrl).hostname} / ${new URL(coverUploadUrl).hostname}`
    );
  }

  return { contentUploadUrl, coverUploadUrl, contentGsUri, coverGsUri };
}

/**
 * Read back a book that already exists in the Bookpod account.
 *
 * The only read endpoint their API has, and the only way to see what actually
 * landed rather than what we believe we sent — which matters because `title` is
 * the sole naming field and cannot be corrected afterwards. Read-only: creates
 * nothing, changes nothing, costs nothing.
 *
 * `uid` duplicates the x-user-id header in the body; that is how their own
 * plugin calls it (bpat-woocommerce-products.php:453-462), so we match it.
 *
 * @param {string|number} bookpodBookId The id Bookpod returned from createBook
 * @returns {Promise<{found: boolean, isOwner: boolean, title: string, description: string, raw: object}>}
 */
async function verifyBook(bookpodBookId) {
  const res = await apiRequest('POST', '/api/v1/books/verify', {
    bookid: String(bookpodBookId),
    is_set: 'no',
    uid:    USER_ID,
  });

  // Their two negative answers arrive as flags inside a 200, not as HTTP errors.
  const found   = !res.notFound;
  const isOwner = Boolean(res.isOwner);

  return {
    found,
    isOwner,
    title:       String(res.title || ''),
    description: String(res.description || ''),
    raw:         res,
  };
}

/**
 * Create a book record on Bookpod, in the three steps their current API requires:
 *   1. ask for signed upload URLs
 *   2. PUT both PDFs straight to Google Cloud Storage
 *   3. create the book record, referencing the uploaded files by gs:// URI
 *
 * This creates a book in the account but consumes NO credits — only an order does.
 * `showInStore: false` keeps it off Bookpod's public storefront. Note that this is
 * a storefront-visibility flag and NOT a draft state: the book itself is real and
 * live in the account either way. (The old comment here claimed it meant "draft",
 * which was wrong.) `external_id` is gone too — it does not exist anywhere in the
 * current API; traceability now runs through reference_num1 on the order.
 *
 * @param {string} bookId         Internal Lifebook bookId — names the uploaded files
 * @param {string} contentPdfPath Absolute path to the interior PDF (28 pages, 19x28.5cm + bleed)
 * @param {string} coverPdfPath   Absolute path to the flat cover PDF (one sheet, front|spine|back)
 * @param {object} [options]      Overrides for PRINT_DEFAULTS
 * @returns {Promise<string>}     Bookpod book ID
 */
async function createBook(bookId, contentPdfPath, coverPdfPath, options = {}) {
  console.log(`[bookpod] createBook: bookId=${bookId} content=${contentPdfPath} cover=${coverPdfPath}`);

  if (!fs.existsSync(contentPdfPath)) {
    throw new Error(`[bookpod] createBook: content PDF not found at ${contentPdfPath}`);
  }
  if (!fs.existsSync(coverPdfPath)) {
    throw new Error(`[bookpod] createBook: cover PDF not found at ${coverPdfPath}`);
  }

  const spec = { ...PRINT_DEFAULTS, ...options };
  const contentFileName = `${bookId}-content.pdf`;
  const coverFileName = `${bookId}-cover.pdf`;

  // ── Step 1: ask for upload slots ──────────────────────────────────────────
  console.log('[bookpod] createBook: step 1/3 — requesting signed upload URLs...');
  const {
    contentUploadUrl, coverUploadUrl,
    contentGsUri: contentUrl, coverGsUri: coverUrl,
  } = await requestUploadUrls(contentFileName, coverFileName);

  // These two strings are the whole link between the files we upload and the book
  // record. Logged in full because they are otherwise invisible: nothing in the
  // Bookpod dashboard shows which object a book points at, so if a book ever comes
  // out empty again, the Railway log is the only place the answer can be found.
  console.log(`[bookpod] createBook: content -> ${contentUrl}`);
  console.log(`[bookpod] createBook: cover   -> ${coverUrl}`);

  // ── Step 2: transfer the PDFs to Google Cloud Storage ─────────────────────
  console.log('[bookpod] createBook: step 2/3 — uploading both PDFs to storage...');
  await putFileToSignedUrl(contentUploadUrl, contentPdfPath, 'application/pdf');
  await putFileToSignedUrl(coverUploadUrl, coverPdfPath, 'application/pdf');

  // ── Step 3: create the book record ────────────────────────────────────────
  console.log('[bookpod] createBook: step 3/3 — creating the book record...');
  const payload = {
    title:            spec.title || `Lifebook ${bookId}`,
    author:           spec.author,
    category:         [],
    subcategory:      '',
    keywords:         '',
    description:      '',
    price:            null,
    publisher:        '',
    language:         spec.language,
    bookType:         'print',
    epubprice:        null,
    printcolor:       spec.printcolor,
    sheettype:        spec.sheettype,
    laminationtype:   spec.laminationtype,
    finishtype:       spec.finishtype,
    readingdirection: spec.readingdirection,
    width:            spec.widthCm,
    height:           spec.heightCm,
    bleed:            spec.bleed,
    status:           spec.showInStore,
    contentUrl,
    coverUrl,
    ebookFile:        null,
  };

  const response = await apiRequest('POST', '/api/v1/books', payload);

  // Logged in full, on success as well as failure. Bookpod's API answers 200 for
  // outcomes that are not successes, and we have no documentation for this
  // response beyond the id we pick out of it — so the only honest record of what
  // they actually said is the raw body.
  console.log(`[bookpod] createBook: step 3/3 response — ${JSON.stringify(response)}`);

  const bookpodBookId = response.bookId ?? response.bookid ?? response.id;
  if (!bookpodBookId) {
    throw new Error(`[bookpod] createBook: response missing book ID. Full response: ${JSON.stringify(response)}`);
  }

  console.log(`[bookpod] createBook: done — bookpodBookId=${bookpodBookId} (not shown in store)`);
  return String(bookpodBookId);
}

/**
 * !! OWNER APPROVAL REQUIRED — consumes pre-paid credits and prints a physical book !!
 * Implemented in bookpod-order.cjs. Re-exported here so callers keep one entry
 * point. The require is lazy purely to keep the two modules from importing each
 * other at load time.
 */
function createOrder(...args) {
  return require('./bookpod-order.cjs').createOrder(...args);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Shared plumbing, used by bookpod-order.cjs
  apiRequest,

  // API functions
  requestUploadUrls,   // step 1 only — creates nothing, costs nothing
  verifyBook,          // read-only — creates nothing, costs nothing
  createBook,
  createOrder,         // !! OWNER APPROVAL REQUIRED — see bookpod-order.cjs !!

  // Exposed for tests
  __test: { signedUrlToGsUri, PRINT_DEFAULTS },
};

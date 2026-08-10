# Lifebook AI — Project Context & Status
*Last updated: July 14, 2026 (session 15 — reconciled with LIFEBOOK_SPEC.md; print-pdf track added; domain + payment status corrected)*

## 📜 MANDATORY FIRST READ
**Read `LIFEBOOK_SPEC.md` (repo root) in full before any work.** It is the binding working document: iron rules, product architecture (two creation paths × two delivery formats), the full Bookpod print-PDF spec, and the templates workstream. If this file and LIFEBOOK_SPEC.md ever conflict — LIFEBOOK_SPEC.md wins.

## ⚠️ GOLDEN RULES
- **Never modify working code without the owner's explicit approval** — and only after presenting all risks.
- Every new feature: separate Git branch + restore tag. Merge to `main` only with owner approval.
- Before writing code: report plan (files created/changed, risks, AI-call costs) and WAIT for approval.
- Anything that costs money (AI calls, print orders) runs as a small cheap pilot first.
- Always save intermediate artifacts to a debug folder.
- Customer-facing book generation must finish in minutes — no Batch API, no long-running jobs in the customer path.
- **Never `git add -A` / `git add .` in this project.** Always stage commits with an explicit file list, so live-flow files, deleted assets, or debug artifacts can never be swept into a commit by accident.

## ⚠️ DO NOT MODIFY — ALREADY DONE
- `public/assets/branding/lifebook-logo.webp` — main logo (renamed from "lifebook new logo .webp")
- All HTML: `<img src="assets/branding/lifebook-logo.webp" style="height:54px;width:auto;display:block"/>` — NO mix-blend-mode, NO logo.svg, NO logo.png
- `public/accessibility.js` — on ALL pages via `<script src="accessibility.js"></script>` before `</body>`
- `public/404.html` — Hebrew error page
- `server.js` two-email system — `sendPaymentConfirmationEmail` + `sendBookReadyEmail` — DO NOT TOUCH
- `server.js` `updateBookField()` — NO `.select()` — safe for large images — DO NOT CHANGE
- `server.js` `insertBook()` — NO `.select()` — safe for large photos — DO NOT CHANGE
- `public/preview.html` — step tracker loading screen — DO NOT REVERT
- `server.js` `uploadImageToStorage()` — uploads to Supabase Storage bucket "book-images" — DO NOT CHANGE
- `server.js` webhook middleware — `express.raw()` runs BEFORE; `express.json()` explicitly skips `/webhooks/` — DO NOT REORDER
- **Font**: Assistant (Google Fonts, wght 300–800) everywhere. Playfair Display and Lato removed from all HTML/CSS.
- **Sender email**: `lifebooks@lifebooksil.com` — used in server.js Resend calls and all public/ HTML files.
- **Email templates**: `sendPaymentConfirmationEmail` + `sendBookReadyEmail` — both in Hebrew, `dir="rtl"`, Assistant font, logo from `https://lifebooksil.com/assets/branding/lifebook-logo.webp`.
- **RTL rule**: `dir="rtl"` on `<html>` in email templates only. In HTML pages: `dir="rtl"` on content elements (`<section>`, `<main>`, cards) — NEVER on html/body/header.

## ⚠️ CRITICAL DB RULES
```javascript
// ✅ CORRECT — no .select()
await updateBookField(bookId, { fullImages: [...fullImages] });
await updateBookField(bookId, { characterReference });
await updateBookField(bookId, { generatedBook });
// ✅ insertBook also has no .select()

// ❌ WRONG — causes Supabase timeout on large base64 data
await updateBook(bookId, { fullImages });
await updateBook(bookId, { characterReference });
await updateBook(bookId, { generatedBook });
```

---

## Project
AI personalized children's storybook — a live commercial product. Customer flow: wizard → photo → crop → AI generates in background → preview (2 images + pay button) → Shopify checkout → post-payment unlock → email with book link → digital PDF download.

**Two creation paths** (see LIFEBOOK_SPEC.md §2):
1. **Wizard** — fully custom book generated from the customer's photo and details.
2. **Admin templates** — customer orders a template product in the Shopify store and uploads photos via the in-store app; the owner generates the book in the admin.

**Three purchasable formats** (see Commerce Formats below): **digital** (89₪), **printed** softcover (129₪ + shipping), **bundle** digital+printed (149₪ + shipping). The print module works at the bookId level, so any book from any path can be printed. **Only the bundle grants digital access in addition to the printed book. A printed-only order does NOT unlock the digital viewer/PDF** — that customer receives the physical printed book plus a warm confirmation email, not a digital download.

## Commerce Formats — `feature/commerce-formats`
Three Shopify variants, selected on the checkout/summary page (digital is the default, preserving today's single-format behaviour). Variant IDs read from env vars via `GET /api/public-config`; prices digital 89 / printed 129 / bundle 149 (₪).
- **Env vars**: `SHOPIFY_VARIANT_DIGITAL`, `SHOPIFY_VARIANT_PRINTED`, `SHOPIFY_VARIANT_BUNDLE`. Unset print/bundle variants render as disabled cards — nothing breaks.
- **Webhook split** (`orders/paid`): `detectOrderFormat()` maps the line-item variant → digital / printed / bundle.
  - **digital** → existing unlock + two-email path, byte-for-byte unchanged.
  - **printed** → mark `paymentStatus=paid` WITHOUT `purchaseUnlocked` (no digital access) + `sendPrintOrderConfirmationEmail()` + `registerPrintOrder()`.
  - **bundle** → both: digital unlock immediately AND `registerPrintOrder()`.
- **`registerPrintOrder()`** dedups (internal check + UNIQUE(shopify_order_id)), generates the 2 print PDFs, uploads them for review, and STOPS at `status=awaiting_admin_approval`. It NEVER calls Bookpod.
- **Approval station** (owner-only): `print-orders.html` (JWT admin login) lists pending print orders (child name, format, date, 2 PDF links) with an "אשר ושלח לדפוס" button → `POST /api/admin/print-orders/:id/approve`, which runs `bookpod.createBook` (draft) + `bookpod.createOrder` (real order, consumes credits) together and sets `status=sent_to_bookpod`. This is the ONLY path that reaches Bookpod.

## URLs
- Live site: https://lifebooksil.com · App subdomain: https://app.lifebooksil.com
- Railway: https://romantic-patience-production.up.railway.app
- GitHub: lily2204-ctrl/lifebook-ai-new (connected to Railway auto-deploy)
- (Legacy domain lifebooks.online — no longer primary; do not use in new code)

## Stack
Node.js/Express · Supabase Pro (DB + Storage) · OpenAI gpt-4o-mini + gpt-image-1 · Resend (email) · Railway · Shopify (checkout + store) · Replicate Real-ESRGAN (print upscaling, print track only)

---

## Payment Status — Shopify Active
- **Shopify is the active payment provider.** Checkout via cart permalink; webhook `orders/paid` at `POST /webhooks/shopify` — verified working. Post-payment: book unlock + email delivery.
- Stripe: completely removed from server.js, package.json, and all HTML.
- LemonSqueezy: webhook still in server.js (`POST /webhooks/lemonsqueezy`) for legacy orders only — UI no longer points to it.
- Gumroad: webhook still in server.js (`POST /webhooks/gumroad`) for legacy sales only — UI no longer points to it.
- Contact email everywhere: `lifebooks@lifebooksil.com`

## Railway Env Vars
```
OPENAI_API_KEY
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
RESEND_API_KEY
APP_URL
ADMIN_EMAIL=lifebooks@lifebooksil.com
REPLICATE_API_TOKEN          ← print-pdf track (upscaling)
LEMONSQUEEZY_API_KEY         ← legacy only
LEMONSQUEEZY_WEBHOOK_SECRET  ← legacy only
LEMONSQUEEZY_STORE_ID=347433 ← legacy only
LEMONSQUEEZY_VARIANT_ID      ← legacy only
```
Note: must be SUPABASE_SERVICE_ROLE_KEY (not SUPABASE_ANON_KEY) — anon key has no Storage write permission.
Planned: BOOKPOD_API_TOKEN (env var only — never in code or repo).

---

## generate-full Pipeline
```
STEP 1: Analyze photo → updateBookField(characterReference) (~30s)
STEP 2: Write story 12 pages → updateBookField(generatedBook) (~45s)
STEP 3+4a: Cover + pages 0,1 IN PARALLEL → updateBookField each individually (~60s)
STEP 4b: Remaining pages batches of 5, each saved immediately with updateBookField
STEP 5: sendBookReadyEmail ONLY if purchaseUnlocked === true
```
- Each step logs elapsed time in Railway logs: `+Xs` format.
- Language detection logs: `language=Hebrew` or `language=English` at generation start.
- Warm-up: story generation begins on crop page load to reduce perceived wait.

## Print PDF Track — branch `feature/print-pdf`
**Full spec: LIFEBOOK_SPEC.md §3. Zero impact on the digital pipeline — all print code in separate module files.**
- Supplier: Bookpod (bookpod.co.il), print-on-demand, API + pre-paid credits.
- Content file: single pages in sequence, trim 22×22 cm, bleed exactly 3.2 mm (page 22.64×22.64), 300DPI, flat file, no page numbers, no digital-viewer elements. 28 pages exactly (divisible by 4). Hebrew binding: first page on the LEFT when opened.
- Spread = "Option A": illustration page (original image expanded to 1:1 via outpainting — NEVER cropped, never lose heads/details) + text page (background-continuation outpaint under Hebrew RTL text).
- Upscaling via Replicate Real-ESRGAN before assembly. Images embedded as JPEG q85–90; target file < 80MB.
- Intermediates saved to `print-pdf/debug/`. Output in `print-pdf/output/`.
- Cover: SEPARATE flat file (back + spine + front) — NOT implemented yet; waiting on Bookpod paper spec. TODO stub only.
- Endpoint: `POST /api/books/:id/print-pdf` (admin-token protected, owner-only).
- Pilot protocol: 2 spreads first → owner approval → full run → Bookpod preview system check → physical proof copy before first sale.
- Status (14.7): pipeline runs end-to-end (~$0.66/book) but first pilot FAILED the design spec (digital-viewer layout, no outpaint assembly, page numbers, cropped heads, 343MB). Fix per spec before anything else.

## Hebrew Support
- Story generation: if childName OR storyIdea contains Hebrew characters → story generated in Hebrew
- imagePrompts: ALWAYS in English (regardless of story language) for image generation
- title/subtitle/page text: in Hebrew when Hebrew book
- Full site i18n system for customer-facing pages (Hebrew primary)
- PDF Hebrew: rendered via Canvas 2D API (`renderHebrewCanvas()`) → PNG embedded in jsPDF. No TTF font loading. Browser uses native Heebo from Google Fonts in `<head>`. Eliminates all encoding/gibberish issues.
- PDF filename: Hebrew names stripped gracefully; falls back to `{bookId.substring(0,8)}_lifebook.pdf`

## Page Layout — Viewer + Digital PDF
All story pages (both viewer in delivery.html/reader.html AND digital PDF) use a unified split layout:
- **Left half**: solid colored background + text centered vertically, direction:rtl for Hebrew, page number subtle at bottom
- **Right half**: illustration image, object-fit:cover, full bleed, no padding/margin/white border
- **Color palette** rotates per page based on child gender:
  - בן (boy): `#E8F4FD, #E8F8F5, #EAF2FF, #FFF8E7, #F0F4FF` — text `#1a5276`
  - בת (girl): `#FDE8F4, #F3E8FF, #FFF0E8, #E8FDF5, #FFFDE8` — text `#7b1a5a`
- gender detection: `childGender` field, matches boy/male/זכר/בן vs default girl palette
- Cover + back cover keep existing dark/gold design unchanged
- (Print PDF layout is DIFFERENT — see Print PDF Track above; never mix the two.)

---

## Image Storage Architecture
All images are stored in **Supabase Storage** bucket `book-images`, NOT as base64 in the DB.

- Bucket: `book-images` (must be PUBLIC — create in Supabase dashboard if not exists)
- Path structure: `{bookId}/cover.jpg`, `{bookId}/page-0.jpg`, `{bookId}/page-1.jpg` ... `{bookId}/page-11.jpg`
- User photos: `{bookId}/cropped-photo.jpg`, `{bookId}/original-photo.jpg`
- DB columns (`cover_image`, `full_images`, `cropped_photo`, `original_photo`) store **public URLs**, not base64
- Old books (pre-migration) may still have base64 in those columns — backward compat maintained

```javascript
// New helper — DO NOT CHANGE
async function uploadImageToStorage(bookId, imageName, base64data) {
  // Strips data:image/jpeg;base64, prefix → Buffer → uploads to "book-images" bucket
  // Returns public URL. Throws on error.
}
```

### getBookLight vs getBook
- `getBook(bookId)` — `SELECT *` — returns all fields including image URLs — use for delivery/reader
- `getBookLight(bookId)` — excludes `cover_image, full_images, cropped_photo, original_photo, preview_images` — use for metadata-only reads (email decisions, auth checks)
- Main GET `/api/books/:id` uses `getBook()` so frontend sees image URLs (no frontend changes needed)

### Fallback behavior
- If Storage upload fails, `uploadImageToStorage` throws and the catch block falls back to saving base64 in DB
- This ensures book generation never fails due to a Storage error

---

## Key Endpoints
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/books/create` | POST | Creates book, uploads user photos to Storage |
| `/api/books/:id/generate-full` | POST | Full pipeline — background IIFE, returns 200 immediately |
| `/api/books/:id` | GET | Fetch full book including image URLs — used by all pages |
| `/api/books/:id/unlock` | POST | Manual unlock (dev only) |
| `/api/books/:id/resend-email` | POST | Resend book ready link |
| `/api/books/:id/update-photo` | POST | Update cropped photo — uploads to Storage |
| `/api/books/:id/print-pdf` | POST | Print PDF generation (admin token) — `feature/print-pdf` branch |
| `/webhooks/shopify` | POST | orders/paid → unlock book → send emails (ACTIVE) |
| `/webhooks/lemonsqueezy` | POST | Legacy — verify sig (raw body HMAC) → unlock → emails |
| `/webhooks/gumroad` | POST | Legacy — form-urlencoded; bookId from `referrer` field |
| `/api/contact` | POST | Contact form |

---

## Image Generation Rules (gpt-image-1)
- Cover + page images: NEVER render text inside the image
- Cover prompt must include: "NO text, letters, words, numbers, or writing of any kind rendered inside the image" + "NO captions, titles, subtitles, labels, or book title text on the image"
- Page prompt must include same rule + "NO captions, labels, speech bubbles"
- Character prompts end with: "This is the SAME child that must appear identically in every illustration"
- `buildCharacterPromptCore()` has LOCKED CHILD CHARACTER header + 6-rule CONSISTENCY RULES block
- **Character consistency is the product's supreme principle — never compromise it.**

---

## ⚠️ INFRASTRUCTURE — Requires Manual Action
These cannot be fixed in code — need dashboard access:
1. **Supabase paused** — if the DB returns 522/connection timeout, go to supabase.com → project → click "Resume".
2. **Supabase Storage bucket** — `book-images` bucket must exist and be **Public**.
3. **Railway DNS** — if lifebooksil.com / app.lifebooksil.com is unreachable, go to Railway → Settings → Domains and verify the custom domain mapping is active.

## Known Bugs — Open
*(none currently — all known bugs fixed)*

---

## File Structure
```
server.js · CLAUDE.md · LIFEBOOK_SPEC.md · package.json
print-pdf/            ← print track module (feature/print-pdf branch): code, debug/, output/
public/
  index.html       ← landing page, "12-page storybook"
  wizard.html/js   ← child name, age, gender, story idea, photo upload
  crop.html/js     ← circle crop, zoom, → fires generate-full, → preview.html
  preview.html     ← step tracker loading screen → checkout
  checkout.html/js ← Shopify checkout
  delivery.html    ← book viewer + PDF download (jsPDF + Heebo for Hebrew)
  reader.html/js   ← full page-flip reader
  open-book.js     ← legacy; if bookId → redirect delivery.html
  contact.html     ← contact form
  terms.html       ← Refund + Privacy + General Terms
  404.html · accessibility.js · styles.css
  js/state.js · assets/branding/
```

---

## Bugs Fixed History
1. ✅ Supabase NANO crash (20MB+ DB rows) → images moved to Supabase Storage bucket "book-images"
2. ✅ setup.js legacy flow
3. ✅ Stripe webhook 21% errors
4. ✅ PDF emoji garbage → geometric shapes
5. ✅ Logo SVG viewBox
6. ✅ SyntaxError crashes
7. ✅ Cover + pages 0,1 parallel
8. ✅ Each image saves immediately
9. ✅ updateBookField not defined
10. ✅ insertBook had .select()
11. ✅ characterReference/generatedBook used updateBook → fixed to updateBookField
12. ✅ Stripe removed, LemonSqueezy integrated (checkout + webhook)
13. ✅ preview.html Hebrew text → English
14. ✅ crop.js mobile stuck — inline status, createRes.ok check, no alert()
15. ✅ delivery.html PDF null crash — null guards on book + book.generatedBook + fresh
16. ✅ Cover/page AI text bleed — strong NO TEXT rules in all prompts
17. ✅ Character consistency — LOCKED CHILD CHARACTER + 6-rule CONSISTENCY RULES block
18. ✅ "16 pages" → "12 pages" everywhere (server.js, index.html, preview.html, delivery.html)
19. ✅ "Stripe encrypted" → "Secure payment" everywhere (checkout.html, preview.html, index.html)
20. ✅ success.html: openBtn wired to reader.html → fixed to delivery.html
21. ✅ success.html: polled 10×2s (20s) → 30×2s (60s)
22. ✅ success.html: after 60s timeout → redirect to delivery.html (not checkout)
23. ✅ success.html: removed session_id param + unlockBook() auto-fire (Stripe leftover)
24. ✅ server.js webhook: CRITICAL — was using updateBook() (has .select() → Supabase timeout) → fixed to updateBookField()
25. ✅ server.js webhook: accept both x-signature AND x-lemonsqueezy-signature headers
26. ✅ server.js webhook: added 20 detailed console.log lines at every step for Railway log debugging
27. ✅ server.js checkout: added [Checkout] logging — bookId, env vars, redirect URL, LS response
28. ✅ success.html: removed session_id param + unlockBook() auto-fire (Stripe leftover, was calling /unlock without payment verification)
29. ✅ success.html: openBtn wired to reader.html → fixed to delivery.html
30. ✅ success.html: poll 10×2s (20s) → 30×2s (60s)
31. ✅ success.html: after 60s timeout → show "Payment confirmed — opening your book..." then redirect to delivery.html after 2.5s (never goes to checkout)
32. ✅ package.json: removed stripe dependency (was still installed despite full Stripe removal)
33. ✅ contact.html: removed mix-blend-mode:multiply from logo (was making logo invisible), fixed height 36px → 54px
34. ✅ wizard.html, cover.html, reader.html, setup.html, open-book.html: logo height 40px/44px → 54px (matches spec)
35. ✅ success.js: orphaned legacy file with Shopify references + reader.html redirect — gutted, now empty stub
36. ✅ cover.js: redirected to generate.html (legacy) → wizard.html
37. ✅ server.js generate-images endpoint: MIME type data:image/png → data:image/jpeg
38. ✅ CRITICAL ARCHITECTURE: images moved from Supabase DB (base64, 20MB+ rows) to Supabase Storage (URLs) — added uploadImageToStorage() helper, all generate-full image saves now upload to Storage with base64 fallback
39. ✅ /api/books/create: croppedPhoto + originalPhoto uploaded to Storage before DB insert (reduces row size immediately)
40. ✅ /api/books/:id/update-photo: photo uploaded to Storage before DB save
41. ✅ server.js getBookLight(): lightweight DB fetch excluding image columns — used for email-only reads in generate-full STEP 5 and available for metadata-only reads elsewhere
42. ✅ LemonSqueezy webhook 400 fix: express.json() now explicitly skips all /webhooks/ routes so raw buffer is guaranteed intact for HMAC-SHA256 signature verification
43. ✅ generate-full image hang: added `generatePageImageWithRetry()` — 2 retries + 90s timeout per attempt for all page images (pages 0-11); cover also wrapped with 90s timeout; pipeline always reaches STEP 5 even if individual pages fail
44. ✅ generate-full STEP 5 email: improved console.log at every sub-step; always runs after all batches regardless of page failures
45. ✅ success.html title: polling loop now updates title/cover/meta on every poll iteration
46. ✅ terms.html created: Refund + Privacy + General Terms — matches design system
47. ✅ index.html footer: added "Terms & Privacy" link to terms.html
48. ✅ book-ready email never sent — BUG FIX 1: webhook allDone threshold now allows up to 2 image failures (pages.length - 2, min 1)
49. ✅ book-ready email never sent — BUG FIX 2: webhook now extracts payer email from webhook payload and saves to customerEmail
50. ✅ preview.html cover image never shown (mobile Safari): fixed `!coverImage.src` (returns page URL when no src) → `coverImage.getAttribute('src') !== b.coverImage`
51. ✅ preview.html payBtn never enabled: was requiring hasCover && has2Imgs; fixed to enable on hasCover alone
52. ✅ delivery.html PDF redesign: professional layout, Layout A (odd) + Layout B (even) + cover + back cover; loadB64 canvas helper for Storage URLs
53. ✅ Shopify integrated as active payment provider: checkout via cart permalink, orders/paid webhook, post-payment unlock + email
54. ✅ Email unified: lifebooks@lifebooksil.com everywhere (server.js, checkout.html, terms.html, contact.html)
55. ✅ Gumroad webhook added: POST /webhooks/gumroad — form-urlencoded, bookId from referrer field, unlocks book + sends emails
56. ✅ Hebrew PDF fix: delivery.html Heebo font changed from variable font (Heebo[wght].ttf) to static (static/Heebo-Regular.ttf) — jsPDF cannot parse variable fonts, causing Hebrew to render as boxes
57. ✅ Hebrew detection improved: server.js generate-full now checks childName OR storyIdea for Hebrew characters (previously only childName)
58. ✅ PDF filename Hebrew fix: Hebrew child names (all converted to underscores) now fall back to bookId prefix instead of "___lifebook.pdf"
59. ✅ Timing logs added: generate-full logs elapsed time at each step (+Xs format) and language=Hebrew/English at start
60. ✅ preview.html totalPages fallback: was 16 → fixed to 12 (correct page count)
61. ✅ open-book.js: removed broken /api/order/:orderId call (Stripe legacy, endpoint never existed); now redirects directly to delivery.html; removed unused orderId param handling
62. ✅ Illustration style selection: DOM class bug caused style to always default to "Soft Storybook" — fixed; 4 style bugs total including character consistency regression

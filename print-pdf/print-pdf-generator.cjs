/**
 * print-pdf-generator.js
 * Generates a print-ready PDF per Bookpod spec (bookpod.co.il).
 *
 * Page size: 22×22 cm + 3.2mm bleed each side = 226.4×226.4 mm
 * Resolution: 300 DPI
 * Structure: 28 single pages (not spreads) — see LIFEBOOK_SPEC.md section 3
 *
 * Pipeline:
 *   1. Fetch book from Supabase
 *   2. Load images → Buffer
 *   3. Outpaint each image to 1:1 square (left=illustration, right=bg for text)
 *      → save each outpainted image to print-pdf/debug/ immediately
 *   4. Upscale via Replicate Real-ESRGAN
 *      → save each upscaled image to print-pdf/debug/ immediately
 *   5. Render Hebrew text overlays (node-canvas)
 *   6. Build 28-page PDF — single pages, no page numbers, full bleed
 *
 * PILOT MODE: set pilotPages=2 to process only first 2 spreads (4 pages).
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, REPLICATE_API_TOKEN
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const OpenAI           = require('openai');
const PDFDocument      = require('pdfkit');
const fs               = require('fs');
const path             = require('path');

// ─── Print story-text font (Frank Ruhl Libre) ────────────────────────────────
// The printed story text is set in Frank Ruhl Libre (Google Fonts) — a Hebrew
// serif that gives the page a classic, real-book feel (owner-selected from a
// 5-font taste grid). Registered here from static instances (400 / 700)
// extracted from the official variable font so node-canvas draws real glyphs at
// the right weight instead of a generic Arial fallback.
// Assistant is also registered (still used for cover title/subtitle chrome).
try {
  const { registerFont } = require('canvas');
  const FONT_DIR = path.join(__dirname, 'fonts');
  registerFont(path.join(FONT_DIR, 'FrankRuhlLibre-Regular.ttf'), { family: 'FrankRuhlLibre', weight: 'normal' });
  registerFont(path.join(FONT_DIR, 'FrankRuhlLibre-Bold.ttf'),    { family: 'FrankRuhlLibre', weight: 'bold'   });
  registerFont(path.join(FONT_DIR, 'Assistant-Regular.ttf'),      { family: 'Assistant', weight: 'normal' });
  registerFont(path.join(FONT_DIR, 'Assistant-Bold.ttf'),         { family: 'Assistant', weight: 'bold'   });
  console.log('[print-pdf] registered Frank Ruhl Libre (story text) + Assistant (cover chrome)');
} catch (e) {
  console.warn(`[print-pdf] could not register print fonts, falling back to system fonts: ${e.message}`);
}

// ─── Constants ────────────────────────────────────────────────────────────────

// 22cm + 3.2mm bleed × 2 sides = 226.4mm
const BLEED_MM  = 3.2;
const PAGE_MM   = 220 + BLEED_MM * 2;        // 226.4mm
const MM_TO_PT  = 2.83465;                    // 1mm = 2.83465pt
const PAGE_PT   = PAGE_MM * MM_TO_PT;         // ~641.5pt

// Text margins (inside bleed zone, from bleed edge)
const MARGIN_INNER_MM = BLEED_MM + 10;        // 13.2mm from edge → 10mm safe margin
const MARGIN_OUTER_MM = BLEED_MM + 6;         // 9.2mm from edge → 6mm safe margin

const OUTPUT_DIR = path.join(__dirname, 'output');
// DEBUG_DIR is now per-book: path.join(__dirname, 'debug', bookId) — set in generatePrintPDF

// ─── Clients ──────────────────────────────────────────────────────────────────

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('[print-pdf] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key);
}

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('[print-pdf] Missing OPENAI_API_KEY');
  return new OpenAI({ apiKey });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`[print-pdf] HTTP ${res.status} fetching ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function toBuffer(imageValue) {
  if (!imageValue) return null;
  if (typeof imageValue === 'string' && imageValue.startsWith('http')) {
    return fetchBuffer(imageValue);
  }
  if (typeof imageValue === 'string') {
    const match = imageValue.match(/^data:[^;]+;base64,(.+)$/);
    if (match) return Buffer.from(match[1], 'base64');
    return Buffer.from(imageValue, 'base64');
  }
  return null;
}

function elapsed(start) {
  return `+${((Date.now() - start) / 1000).toFixed(1)}s`;
}

/** Write a buffer to the per-book debug dir. Returns the file path. */
function saveDebug(debugDir, filename, buffer) {
  fs.mkdirSync(debugDir, { recursive: true });
  const fp = path.join(debugDir, filename);
  fs.writeFileSync(fp, buffer);
  console.log(`[print-pdf] debug saved: ${fp} (${(buffer.length / 1024).toFixed(0)}KB)`);
  return fp;
}

// ─── Supabase: fetch book ─────────────────────────────────────────────────────

async function fetchBook(bookId) {
  const supabase = getSupabase();
  // Column names are snake_case — matches server.js getBookLight() / dbRowToBook()
  const { data, error } = await supabase
    .from('books')
    .select('book_id, child_name, child_age, child_gender, generated_book, cover_image, full_images, language, character_reference, cropped_photo, illustration_style')
    .eq('book_id', bookId)
    .maybeSingle();

  if (error) throw new Error(`[print-pdf] Supabase fetch failed: ${error.message}`);
  if (!data)  throw new Error(`[print-pdf] Book not found: ${bookId}`);

  return {
    bookId:        data.book_id,
    childName:     data.child_name      || '',
    childAge:      data.child_age       || '',
    childGender:   data.child_gender    || '',
    language:      data.language        || 'he',
    illustrationStyle: data.illustration_style || '',
    generatedBook: data.generated_book  || null,
    coverImage:         data.cover_image         || null,
    fullImages:         data.full_images         || [],
    characterReference: data.character_reference || null,
    croppedPhoto:       data.cropped_photo       || null,
  };
}

// ─── OpenAI outpainting ───────────────────────────────────────────────────────

const OUTPAINT_PAGE_PROMPT =
  'This canvas is 1024×1024 pixels. The LEFT half (x=0..511) contains a children\'s storybook illustration — ' +
  'a character in a scene. The RIGHT half (x=512..1023) is transparent and must be filled. ' +
  'Fill the right half with a natural, bright, quiet continuation of the scene\'s background: ' +
  'same color palette, same lighting, same art style — but absolutely NO characters, NO faces, NO people, NO text, ' +
  'NO foreground objects. The right half must be a clean, simple backdrop suitable for printed Hebrew text. ' +
  'The left half must remain completely unchanged — same pixels, same colors, same character details.';

const OUTPAINT_COVER_PROMPT =
  'Extend this children\'s storybook cover illustration to the right to create a square 1:1 composition. ' +
  'The right half should be a harmonious continuation of the background atmosphere and color palette — ' +
  'soft, warm, no characters, no faces, no text. The left half must remain completely unchanged.';

const OUTPAINT_COVER_CENTERED_PROMPT =
  'This is a children\'s storybook cover illustration centered in a square canvas with transparent padding on the left and right sides. ' +
  'Fill in the transparent areas on both sides with a natural, harmonious continuation of the background atmosphere and color palette — ' +
  'soft, warm colors matching the original scene. No additional characters, no faces, no text. ' +
  'The original illustration in the center must remain completely unchanged.';

// ─── Style locks (per book, NEVER hardcoded) ─────────────────────────────────
// SPEC RULE: the print track must NEVER force a fixed style. The illustration
// style is ALWAYS read from the book record (illustration_style) and mapped to
// a faithful wide-spread lock. Wording mirrors server.js STYLE_LOCK so the print
// file matches what the customer already saw in the digital book.
//
// Covers every style the wizard offers, one-for-one:
//   Soft Storybook → watercolor · Pixar 3D → soft3d
//   Magical Fantasy → fantasy · Minimal Scandinavian → scandi
const WIDE_SPREAD_STYLE_LOCKS = {
  watercolor:
    'Soft Storybook watercolor illustration style: gentle hand-painted watercolor textures, ' +
    'soft muted warm colors, delicate transparent washes, gentle pencil outlines, storybook warmth, ' +
    'expressive rounded characters, soft shadows. Hand-painted watercolor look — NOT 3D, NOT photorealistic, NOT a photo.',
  soft3d:
    'Pixar-style 3D rendered animation: glossy smooth 3D surfaces, big expressive eyes, ' +
    'soft cinematic studio lighting, subsurface scattering on the skin, depth of field, ' +
    'looks like a frame from a high-quality animated movie. NOT a painting, NOT watercolor, NOT a photo.',
  fantasy:
    'Magical fantasy storybook illustration style: enchanted glowing atmosphere, sparkles and soft golden light, ' +
    'rich jewel-tone colors, dreamy painterly rendering, wonder and warmth. NOT 3D render, NOT photorealistic, NOT a photo.',
  scandi:
    'Minimal Scandinavian picture-book illustration style: clean simple shapes, soft muted pastel palette, ' +
    'generous open space, flat gentle textures, subtle grain, modern nordic style. NOT 3D, NOT photorealistic, NOT a photo.',
};

// Mirrors server.js STYLE_NAME_MAP exactly — customer-facing name → lock key.
const PRINT_STYLE_NAME_MAP = {
  'soft storybook': 'watercolor',
  'watercolor': 'watercolor',
  'pixar 3d': 'soft3d',
  'soft3d': 'soft3d',
  'magical fantasy': 'fantasy',
  'fantasy': 'fantasy',
  'minimal scandinavian': 'scandi',
  'scandi': 'scandi',
};

/**
 * buildWideSpreadStyleLock(rawStyle)
 * Resolve the book's illustration_style to a faithful wide-spread style lock.
 * Unknown value → a generic lock that RESPECTS the style name verbatim and
 * NEVER forces a different style (no silent watercolor fallback).
 */
function buildWideSpreadStyleLock(rawStyle) {
  const raw = (rawStyle || '').toLowerCase().trim();
  const key = PRINT_STYLE_NAME_MAP[raw];
  if (key && WIDE_SPREAD_STYLE_LOCKS[key]) return WIDE_SPREAD_STYLE_LOCKS[key];
  const name = (rawStyle || '').trim() || 'children\u2019s storybook';
  return `${name} illustration style: high-quality children\u2019s storybook art rendered faithfully in a ${name} aesthetic, ` +
         'warm and appealing, consistent character design across every spread.';
}

const WIDE_SPREAD_COMPOSITION =
  'COMPOSITION — STRICT SPREAD LAYOUT (physical book, center is bound spine):\n' +
  '• Image is 1536×1024px — a horizontal double-page spread.\n' +
  '• EXTREME WIDE ESTABLISHING SHOT — the camera is FAR from the child. This is NOT a portrait, NOT a bust, NOT a face close-up. The child is a SMALL full-body figure standing/sitting within a large environment. Show the whole room/scene around them.\n' +
  '• SIZE: the child occupies AT MOST HALF (50%) of the image height — smaller is better. The full body (head, hair, torso, both hands, legs, feet) is visible with room to spare.\n' +
  '• GENEROUS MARGINS ON ALL SIDES: at least 20% EMPTY space above the top of the hair, at least 12% below the feet, and clear space on the left/right of the body. Nothing on the character (hair, elbow, hand, foot) may touch or approach any edge of the frame.\n' +
  '• Place ALL characters together on the SAME side, occupying no more than 40% of the total width. All fully visible with clear expressions and complete bodies. Nothing important extends past that 40% boundary.\n' +
  '• CENTER SPINE ZONE (central 20%, 10% each side of midpoint): quiet background ONLY — sky, trees, ground. NO characters, NO animals, NO faces, NO narrative objects here.\n' +
  '• Opposite 40%: calm, open, character-free background. Text will be placed here.\n' +
  '• VERTICAL: the top 12% and bottom 12% may be trimmed for print — keep ALL important content (full head, full body, feet) inside the central 76%. Full head of child always fully visible, never cropped.\n' +
  '• Warm continuous atmosphere across full width.\n' +
  '• ZERO TEXT ANYWHERE IN THE IMAGE — this is absolute. NO letters, words, numbers, Hebrew or Latin script, signs, captions, labels, speech bubbles, watermarks, or logos. This includes text on WALLS, posters, framed pictures, wall art, books, boxes, toys, clothing, furniture, signage, or any background decoration. Walls and surfaces must be BLANK. Any text would be mirrored when the image is flipped and become unreadable gibberish.';

// Emphatic reinforcement appended only on a retry after the character was placed
// centered (rule-4 violation). Deliberately blunt and repetitive.
const WIDE_SPREAD_REINFORCE_40 =
  'CRITICAL PLACEMENT — DO NOT REPEAT THE PREVIOUS MISTAKE:\n' +
  '• The previous attempt placed the character in the CENTER of the image. This is WRONG and unusable.\n' +
  '• The character MUST be pushed fully to ONE side (the LEFT third is ideal) and occupy no more than 40% of the width.\n' +
  '• The entire opposite side and the whole center must be EMPTY background — no character, no limbs, no props reaching across.\n' +
  '• Imagine a vertical line at 45% of the width: the ENTIRE character (head, body, hands, feet) must sit to ONE side of it with clear space to that side edge.';

// Appended on a retry after the character was framed too large / edge-cut (a
// close-up instead of a wide shot). Pushes the camera back hard.
const WIDE_SPREAD_REINFORCE_WIDE =
  'CRITICAL FRAMING — DO NOT REPEAT THE PREVIOUS MISTAKE:\n' +
  '• The previous attempt was a CLOSE-UP — the child was too large and got cut off at the edges. This is WRONG and unusable.\n' +
  '• PULL THE CAMERA WAY BACK. The child must be SMALL — no more than HALF the image height — a full-body figure inside a big room.\n' +
  '• There MUST be large empty space above the hair (≥20%) and below the feet (≥12%). Nothing on the body may touch any edge.\n' +
  '• Think "wide establishing shot of a small child in a large scene", never a face or upper-body portrait.';

// ── Option 1 (2026-07-23): dignified centered SQUARE portrait ────────────────
// The text page is tones-only, so the illustration no longer needs to be a wide
// spread that continues into it. Each illustration page is a single square page —
// a dignified portrait of the character, exactly like the digital book the
// customer already approved. No flip, no binding split, no wide-shot gymnastics.
const PORTRAIT_COMPOSITION =
  'COMPOSITION — DIGNIFIED CENTERED PORTRAIT (single square printed page):\n' +
  '• Image is 1024×1024px — one square page of a printed picture book.\n' +
  '• The child is the clear subject, shown as a COMPLETE figure — full head with ALL hair, whole face, torso, both arms and both hands, and (if standing) legs and feet — naturally posed and centered.\n' +
  '• GENEROUS MARGINS ON ALL FOUR SIDES: clear empty space above the top of the hair, below the body, and to the left and right. NOTHING on the child (a strand of hair, an ear, an elbow, a hand, a foot) may touch, overlap, or be cropped by ANY edge of the frame. When in doubt, make the child smaller and the margins larger.\n' +
  '• The child occupies roughly the central 60–75% of the frame, comfortably inside a safe margin — never a tight face close-up, never edge-to-edge.\n' +
  '• A warm, appealing, uncluttered environment fills the surrounding space, consistent with the scene.\n' +
  '• Keep the SAME character identity — face, hair, skin tone, proportions and outfit — as the reference images.\n' +
  '• ZERO TEXT ANYWHERE IN THE IMAGE — this is absolute. NO letters, words, numbers, Hebrew or Latin script, signs, captions, labels, speech bubbles, watermarks, or logos. This includes text on WALLS, posters, framed pictures, wall art, books, boxes, toys, clothing, furniture, signage, or any background decoration. Walls and surfaces must be BLANK.';

// Appended on a retry after the child was cropped at an edge in the prior attempt.
const PORTRAIT_REINFORCE_MARGIN =
  'CRITICAL FRAMING — DO NOT REPEAT THE PREVIOUS MISTAKE:\n' +
  '• The previous attempt CROPPED the child at an edge (hair, a hand, or the feet were cut off). This is WRONG and unusable.\n' +
  '• ZOOM OUT and re-center. The ENTIRE child must sit inside the frame with a clear empty margin on ALL FOUR sides — top, bottom, left and right.\n' +
  '• Nothing on the body may touch any edge. Leave visible empty space above the hair and below the body.';

const OUTPAINT_PANORAMIC_PROMPT =
  'Continue this children\'s storybook illustration to the left. ' +
  'The RIGHT side of the canvas contains the original illustration — extend the EXACT SAME SCENE leftward: ' +
  'same room, same warm lighting, same color palette, same depth of field, same 3D animated art style, same background elements. ' +
  'The left extension should show more of the same environment (walls, furniture, floor, atmosphere) as if the camera is panning left. ' +
  'The transition between right and left must be completely seamless — no visible seam or color shift. ' +
  'Absolutely no characters, no faces, no people in the left extension. No text. ' +
  'The RIGHT side (original illustration) must remain completely unchanged.';

/**
 * Outpaint image to 1:1 square using crop-then-squish geometry.
 *
 * Geometry (page spreads, not cover):
 *   1. Crop portrait (1024×1536) → square (1024×1024).
 *      cropBias controls vertical position: 0.0=top, 0.5=center (default), 1.0=bottom.
 *      Center is the safe default — keeps head AND bottom narrative elements (animals etc.).
 *      Override per-page via options.cropBiasMap = { 0: 0.3, 5: 0.7, ... }.
 *   2. Squish crop 1024×1024 → 512×1024, place in LEFT half of 1024×1024 canvas.
 *      Right half transparent → OpenAI fills it with clean background.
 *   3. Composite: paste the squished crop back over the left 512px of the AI result
 *      so illustration pixels are 100% original (not AI-reconstructed).
 *
 * Net effect on final illustration page (after splitSquareForPrint):
 *   splitSquareForPrint extracts left 512×1024 → scales to PX×PX square.
 *   The ×2 horizontal stretch of squish is exactly undone by the ÷2 extraction.
 *   Vertical: crop is 1024→1024 (no vertical change) → scales to PX×PX cleanly.
 *   Result: 1:1 proportions, original pixels, no distortion.
 *
 * Returns Buffer of resulting PNG (1024×1024).
 */
async function outpaintToSquare(openai, imageBuffer, label, isCover = false, cropBias = 0.5) {
  console.log(`[print-pdf] outpainting ${label}...`);
  const { createCanvas, Image } = require('canvas');
  const { toFile } = require('openai');

  const CANVAS = 1024;
  const HALF   = 512;

  if (isCover) {
    // Cover uses centered approach (unchanged)
    const prompt = OUTPAINT_COVER_PROMPT;
    const imageFile = await toFile(imageBuffer, 'image.png', { type: 'image/png' });
    const response = await openai.images.edit({ model: 'gpt-image-1', image: imageFile, prompt, size: '1024x1024', n: 1 });
    const result = response.data[0];
    const buf = result.b64_json ? Buffer.from(result.b64_json, 'base64') : result.url ? await fetchBuffer(result.url) : null;
    if (!buf) throw new Error(`[print-pdf] outpaintToSquare (cover): no response for ${label}`);
    console.log(`[print-pdf] outpaintToSquare done for ${label}`);
    return buf;
  }

  // ── Step 1: Load original and crop to square with bias ───────────────────────
  const srcImg = new Image();
  srcImg.src = imageBuffer;
  const srcW = srcImg.width;   // 1024
  const srcH = srcImg.height;  // 1536
  const cropH = srcW;          // 1024 — square crop
  const maxY  = srcH - cropH;  // 512 — max y offset
  const cropY = Math.round(maxY * Math.max(0, Math.min(1, cropBias)));
  console.log(`[print-pdf] ${label}: crop y=${cropY} (bias=${cropBias}, range 0–${maxY})`);

  const cropCanvas = createCanvas(CANVAS, CANVAS);
  cropCanvas.getContext('2d').drawImage(srcImg, 0, cropY, srcW, cropH, 0, 0, CANVAS, CANVAS);
  // crop is now 1024×1024

  // ── Step 2: Squish crop to left half, right half transparent ─────────────────
  const inputCanvas = createCanvas(CANVAS, CANVAS);
  const inputCtx    = inputCanvas.getContext('2d');
  inputCtx.clearRect(0, 0, CANVAS, CANVAS);                           // transparent right half
  inputCtx.drawImage(cropCanvas, 0, 0, HALF, CANVAS);                 // squish 1024→512 wide
  const inputPng = inputCanvas.toBuffer('image/png');

  // ── Step 3: Send to OpenAI — right half gets filled ──────────────────────────
  const imageFile = await toFile(inputPng, 'image.png', { type: 'image/png' });
  const response  = await openai.images.edit({
    model:  'gpt-image-1',
    image:  imageFile,
    prompt: OUTPAINT_PAGE_PROMPT,
    size:   '1024x1024',
    n:      1,
  });
  const result = response.data[0];
  const outpaintedBuf = result.b64_json
    ? Buffer.from(result.b64_json, 'base64')
    : result.url ? await fetchBuffer(result.url) : null;
  if (!outpaintedBuf) throw new Error(`[print-pdf] outpaintToSquare: no response for ${label}`);

  // ── Step 4: Composite — paste squished crop back over left half ───────────────
  // This guarantees illustration pixels = original, not AI reconstruction.
  const outImg = new Image();
  outImg.src = outpaintedBuf;

  const finalCanvas = createCanvas(outImg.width, outImg.height);
  const finalCtx    = finalCanvas.getContext('2d');
  finalCtx.drawImage(outImg, 0, 0);                                    // AI result (full canvas)
  finalCtx.drawImage(cropCanvas, 0, 0, HALF, outImg.height);           // squished crop over left half

  const finalBuf = finalCanvas.toBuffer('image/png');
  console.log(`[print-pdf] outpaintToSquare done for ${label} (crop-squish + composite)`);
  return finalBuf;
}

/**
 * Outpaint a portrait/landscape image to a centered 1:1 square.
 * Places the original image horizontally centered with equal transparent
 * padding on left and right, then lets OpenAI fill the transparent areas.
 * Returns Buffer of resulting PNG.
 */
async function outpaintToSquareCentered(openai, imageBuffer, label) {
  console.log(`[print-pdf] outpainting ${label} centered...`);
  const { createCanvas, Image } = require('canvas');
  const { toFile } = require('openai');

  // Load original to get dimensions
  const srcImg = new Image();
  srcImg.src = imageBuffer;
  const srcW = srcImg.width;
  const srcH = srcImg.height;
  const size  = Math.max(srcW, srcH); // square side length

  // Compose: original centered on transparent square canvas
  const composite = createCanvas(size, size);
  const cCtx = composite.getContext('2d');
  cCtx.clearRect(0, 0, size, size); // transparent
  const offsetX = Math.round((size - srcW) / 2);
  const offsetY = Math.round((size - srcH) / 2);
  cCtx.drawImage(srcImg, offsetX, offsetY, srcW, srcH);

  // Export as PNG with alpha (transparent = areas for OpenAI to fill)
  const compositePng = composite.toBuffer('image/png');

  const imageFile = await toFile(compositePng, 'image.png', { type: 'image/png' });
  const response  = await openai.images.edit({
    model:  'gpt-image-1',
    image:  imageFile,
    prompt: OUTPAINT_COVER_CENTERED_PROMPT,
    size:   '1024x1024',
    n:      1,
  });

  const result = response.data[0];
  const outpaintedBuf = result.b64_json
    ? Buffer.from(result.b64_json, 'base64')
    : result.url ? await fetchBuffer(result.url) : null;
  if (!outpaintedBuf) throw new Error(`[print-pdf] outpaintToSquareCentered: no b64_json or url in response for ${label}`);

  // Composite: paste original pixels back at their centered position within the 1024 output.
  // offsetX and offsetY scale from the source-res composite to the 1024 output.
  const { Image: Img3 } = require('canvas');
  const outImgSize = (() => { const i = new Img3(); i.src = outpaintedBuf; return i.width; })(); // 1024
  const scaleFactor = outImgSize / size; // size = max(srcW,srcH) from above
  const scaledOffsetX = Math.round(offsetX * scaleFactor);
  const scaledOffsetY = Math.round(offsetY * scaleFactor);
  const composited = compositeOriginalOver(outpaintedBuf, imageBuffer, scaledOffsetX, scaledOffsetY);
  console.log(`[print-pdf] composited original over AI result for ${label} (centered, offsetX=${scaledOffsetX})`);
  return composited;
}

/**
 * Outpaint leftward only: original on RIGHT half, AI fills transparent LEFT half.
 * Returns a 1024×1024 PNG (left = AI extension, right = original illustration).
 */
async function outpaintPanoramic(openai, imageBuffer, label) {
  console.log(`[print-pdf] panoramic outpaint ${label} (original → RIGHT 1024×1024 full size, extension ← LEFT 512px)...`);
  const { createCanvas, Image } = require('canvas');
  const { toFile } = require('openai');

  // Use 1536×1024 (OpenAI-supported landscape size).
  // Original (1024×1024) placed at x=512 — fills the RIGHT 1024×1024 area at FULL SIZE, zero squishing.
  // Left 512×1024 = transparent → OpenAI fills.
  const OUT_W = 1536;
  const OUT_H = 1024;
  const ORIG_SIZE = 1024; // original occupies x=512..1536, y=0..1024

  const composite = createCanvas(OUT_W, OUT_H);
  const cCtx = composite.getContext('2d');
  cCtx.clearRect(0, 0, OUT_W, OUT_H); // transparent
  const srcImg = new Image();
  srcImg.src = imageBuffer;
  // Place original at full ORIG_SIZE × ORIG_SIZE on the right
  cCtx.drawImage(srcImg, OUT_W - ORIG_SIZE, 0, ORIG_SIZE, OUT_H);

  const compositePng = composite.toBuffer('image/png');
  const imageFile = await toFile(compositePng, 'image.png', { type: 'image/png' });

  const response = await openai.images.edit({
    model:  'gpt-image-1',
    image:  imageFile,
    prompt: OUTPAINT_PANORAMIC_PROMPT,
    size:   '1536x1024',
    n:      1,
  });

  const result = response.data[0];
  const outpaintedBuf = result.b64_json
    ? Buffer.from(result.b64_json, 'base64')
    : result.url ? await fetchBuffer(result.url) : null;
  if (!outpaintedBuf) throw new Error(`[print-pdf] outpaintPanoramic: no result for ${label}`);

  // Composite: draw AI result, then paste original back on RIGHT 1024×1024 — character identity preserved
  const outImg = new Image(); outImg.src = outpaintedBuf;
  const oW = outImg.width;   // 1536
  const oH = outImg.height;  // 1024

  const finalCanvas = createCanvas(oW, oH);
  const fCtx = finalCanvas.getContext('2d');
  fCtx.drawImage(outImg, 0, 0, oW, oH);
  const origImg = new Image(); origImg.src = imageBuffer;
  // Right 1024×1024 = x = oW - ORIG_SIZE (scale ORIG_SIZE to oW proportionally)
  const scaledOrigSize = Math.round(ORIG_SIZE * oW / OUT_W); // 1024 * 1536/1536 = 1024
  fCtx.drawImage(origImg, oW - scaledOrigSize, 0, scaledOrigSize, oH);

  console.log(`[print-pdf] panoramic composited for ${label} — canvas ${oW}×${oH}, original at x=${oW - scaledOrigSize} (${scaledOrigSize}×${oH}px, no distortion)`);
  return finalCanvas.toBuffer('image/png');
}

/**
 * Composites the original image on top of an AI-outpainted result.
 * The original pixels are preserved 1:1 at their exact position;
 * only the expansion areas come from the AI output.
 *
 * @param {Buffer} outpaintedBuf  — 1024×1024 PNG from OpenAI
 * @param {Buffer} originalBuf   — original source image (any size/format)
 * @param {number} offsetX       — x position of original within the square (pixels, at output size)
 * @param {number} offsetY       — y position of original within the square (pixels, at output size)
 * @returns Buffer  composited PNG at output (1024×1024) resolution
 */
function compositeOriginalOver(outpaintedBuf, originalBuf, offsetX, offsetY) {
  const { createCanvas, Image } = require('canvas');

  // Load outpainted result
  const outImg = new Image();
  outImg.src = outpaintedBuf;
  const size = outImg.width; // 1024

  const canvas = createCanvas(size, size);
  const ctx    = canvas.getContext('2d');

  // Draw AI result as base
  ctx.drawImage(outImg, 0, 0, size, size);

  // Overlay original at its exact position (scaled proportionally to 1024 output)
  const origImg = new Image();
  origImg.src = originalBuf;
  const srcW = origImg.width;
  const srcH = origImg.height;

  // The original occupied (size - 2*offsetX) × (size - 2*offsetY) in the composite input
  // so at 1024 output the same proportions apply
  const scaleX = (size - 2 * offsetX) / srcW;
  const scaleY = (size - 2 * offsetY) / srcH;
  // For outpaintToSquare: offsetX=0, scaleX = size/srcW — fills left half (portrait src → square)
  // For centered: offsetX>0, and we cover just the centre strip
  ctx.drawImage(origImg, offsetX, offsetY, srcW * scaleX, srcH * scaleY);

  return canvas.toBuffer('image/png');
}

// ── Wide-spread helpers ───────────────────────────────────────────────────────

function halfContrastScore(img, side) {
  const { createCanvas } = require('canvas');
  const S = 40, SH = 20;
  const c = createCanvas(S, SH);
  const srcX = side === 'left' ? 0 : Math.round(img.width * 0.6);
  const srcW = Math.round(img.width * 0.4);
  c.getContext('2d').drawImage(img, srcX, Math.round(img.height * 0.1), srcW, Math.round(img.height * 0.8), 0, 0, S, SH);
  const d = c.getContext('2d').getImageData(0, 0, S, SH).data;
  let v = 0;
  for (let i = 0; i < d.length - 4; i += 4) {
    v += Math.abs(0.299*d[i]+0.587*d[i+1]+0.114*d[i+2] - (0.299*d[i+4]+0.587*d[i+5]+0.114*d[i+6]));
  }
  return v;
}

// Explicit bounding box of the main character on the cropped (2:1) spread.
// After the auto-flip the character is left-biased and the background (bright
// window, warm wall) sits to the right, usually separated by a calm gap. The
// detector isolates the CHARACTER — not the busy background — by:
//   1) weighting edge energy by DARKNESS: the character carries dark hair / eyes /
//      outline; a bright window is down-weighted so it can't dominate.
//   2) finding the character's right edge at the FIRST SUSTAINED low-energy VALLEY
//      after the left-side mass — i.e. the wall gap before the window. Background
//      past that gap is ignored. If there is NO gap (character runs to the middle/
//      right with no calm break) the box stays wide → frame invalid → regenerate.
// Deterministic on the same buffer so STEP 3/4/5 agree.
function computeCharacterBBox(img, W, H) {
  const { createCanvas } = require('canvas');
  const SW = 192, SH = 108;
  const c = createCanvas(SW, SH);
  c.getContext('2d').drawImage(img, 0, 0, W, H, 0, 0, SW, SH);
  const d = c.getContext('2d').getImageData(0, 0, SW, SH).data;
  const rawCol = new Float64Array(SW);
  const rowScore = new Float64Array(SH);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW - 1; x++) {
      const i = (y*SW + x)*4, j = i + 4;
      const r = d[i], g = d[i+1], b = d[i+2];
      const lum  = (0.299*r + 0.587*g + 0.114*b) / 255;
      const dark = 1 + (1 - lum) * 1.8;             // dark subject up-weighted, bright bg down-weighted
      const edge = Math.abs(r-d[j]) + Math.abs(g-d[j+1]) + Math.abs(b-d[j+2]);
      const s = edge * dark;
      rawCol[x] += s; rowScore[y] += s;
    }
  }
  // Smooth the column profile (box filter) so single-pixel spikes don't matter.
  const colScore = new Float64Array(SW);
  const R = 3;
  for (let x = 0; x < SW; x++) {
    let s = 0, n = 0;
    for (let k = -R; k <= R; k++) { const xx = x + k; if (xx >= 0 && xx < SW) { s += rawCol[xx]; n++; } }
    colScore[x] = s / n;
  }
  const maxE = Math.max(...colScore, 1), thr = maxE * 0.18;
  // Left edge of the character mass.
  let x0 = 0; while (x0 < SW && colScore[x0] < thr) x0++;
  if (x0 >= SW) x0 = 0;
  // Right edge via TWO-MASS separation. Post-flip the character is the first mass
  // from the left; a bright/busy background (e.g. a window) can form a SECOND mass
  // to the right, separated by a shallow valley that an absolute threshold misses.
  // So: find the character peak in the left 55%, then walk right tracking the
  // running minimum. The character ends at that valley once (a) it dips clearly
  // below the peak and (b) energy climbs back up — a distinct new mass beginning.
  const peakLimit = Math.round(SW * 0.55);
  let xp = x0, peak = 0;
  for (let x = x0; x < peakLimit; x++) if (colScore[x] > peak) { peak = colScore[x]; xp = x; }
  const RISE = 1.7, DIP = 0.5;
  let x1 = SW - 1, runMin = colScore[xp], runMinX = xp;
  for (let x = xp + 1; x < SW; x++) {
    if (colScore[x] < runMin) { runMin = colScore[x]; runMinX = x; }
    // a new mass starts: current energy climbs back well above the valley floor,
    // and the valley floor sat clearly below the character peak.
    if (runMin < peak * DIP && colScore[x] > runMin * RISE) { x1 = runMinX; break; }
  }
  // No second mass (calm background): character ends at last column above thr.
  if (x1 === SW - 1) { let e = SW - 1; while (e > xp && colScore[e] < thr) e--; x1 = e; }
  // Rows: vertical extent of the character mass (threshold both ends).
  const maxR = Math.max(...rowScore, 1), thrR = maxR * 0.18;
  let y0 = 0, y1 = SH - 1;
  while (y0 < SH && rowScore[y0] < thrR) y0++;
  while (y1 > 0  && rowScore[y1] < thrR) y1--;
  if (y0 >= y1) { y0 = 0; y1 = SH - 1; }
  return {
    x0: Math.round(x0 / SW * W), x1: Math.round((x1 + 1) / SW * W),
    y0: Math.round(y0 / SH * H), y1: Math.round((y1 + 1) / SH * H),
  };
}

function findBindingDodgeSplit(img, W, H, xLoOverride, xHiOverride) {
  const { createCanvas } = require('canvas');
  const STEP = 4, STRIP_W = 12;
  const xLo = xLoOverride != null ? Math.round(xLoOverride) : Math.round(W * 0.32);
  const xHi = xHiOverride != null ? Math.round(xHiOverride) : Math.round(W * 0.68);
  const yStart = Math.round(H * 0.12), yEnd = Math.round(H * 0.88);
  const sH2 = yEnd - yStart;
  // The character sits on the LEFT; the illustration page is [0, splitX]. A hand
  // gets clipped when character content touches the split line. Two rules:
  //   1) The binding dodge must move AWAY from the character — i.e. rightward,
  //      toward the spine side — so ties/near-ties resolve to the LARGER x. We add
  //      a small rightward bias to the score (further right = lower cost).
  //   2) Reject any candidate whose immediate-LEFT band (where the character would
  //      be pressing against the split) is busy — that is exactly the clipped-hand
  //      case. We add that left-adjacent energy as a penalty, weighted heavily.
  const LEFT_BAND = 22;                 // px just left of the split (character side)
  const RIGHT_BIAS = 0.04;              // per-px pull toward the spine side
  const stripEnergy = (x0, w) => {
    const c = createCanvas(w, sH2);
    c.getContext('2d').drawImage(img, x0, yStart, w, sH2, 0, 0, w, sH2);
    const d = c.getContext('2d').getImageData(0, 0, w, sH2).data;
    let s = 0;
    for (let j = 0; j < d.length - 4; j += 4)
      s += Math.abs(d[j]-d[j+4]) + Math.abs(d[j+1]-d[j+5]) + Math.abs(d[j+2]-d[j+6]);
    return s / (w * sH2);
  };
  let bestX = Math.round((xLo + xHi) / 2), bestScore = Infinity;  // safe default inside range
  for (let x = xLo + STRIP_W; x <= xHi - STRIP_W; x += STEP) {
    const onLine = stripEnergy(x - Math.floor(STRIP_W/2), STRIP_W);
    const leftAdj = stripEnergy(Math.max(0, x - STRIP_W/2 - LEFT_BAND), LEFT_BAND);
    // rightward bias: strips closer to xLo cost more, strips near xHi cost less
    const bias = (xHi - x) / STEP * RIGHT_BIAS;
    const score = onLine + leftAdj * 1.6 + bias;
    if (score < bestScore) { bestScore = score; bestX = x; }
  }
  console.log(`[print-pdf] binding-dodge: x=${bestX} (range=[${xLo},${xHi}], center=${Math.round(W/2)}, offset=${bestX-Math.round(W/2)}px)`);
  return bestX;
}

function dominantColorFromStrip(croppedImg, splitX) {
  const { createCanvas } = require('canvas');
  const W = croppedImg.width, endX = W;
  // Option 1 square portrait: splitX === W (no separate text strip) → sample tones
  // from the WHOLE illustration so the text page still draws its palette from it.
  const x0 = splitX >= W ? 0 : splitX;
  const S = 24;
  const c = createCanvas(S, S);
  c.getContext('2d').drawImage(croppedImg, x0, 0, endX - x0, croppedImg.height, 0, 0, S, S);
  const d = c.getContext('2d').getImageData(0, 0, S, S).data;
  const buckets = {};
  for (let i = 0; i < d.length; i += 4) {
    const r = Math.round(d[i]/32)*32, g = Math.round(d[i+1]/32)*32, b = Math.round(d[i+2]/32)*32;
    buckets[`${r},${g},${b}`] = (buckets[`${r},${g},${b}`] || 0) + 1;
  }
  let best = [200,180,140], bestN = 0;
  for (const [k, n] of Object.entries(buckets)) if (n > bestN) { bestN = n; best = k.split(',').map(Number); }
  return best;
}

function buildWideTextBgJpeg(croppedImg, splitX) {
  const { createCanvas } = require('canvas');
  const PX = Math.round(PAGE_MM / 25.4 * 300);
  const dom = dominantColorFromStrip(croppedImg, splitX);
  const canvas = createCanvas(PX, PX);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `rgb(${dom[0]},${dom[1]},${dom[2]})`;
  ctx.fillRect(0, 0, PX, PX);
  const rad = ctx.createRadialGradient(PX/2, PX/2, 0, PX/2, PX/2, PX * 0.72);
  rad.addColorStop(0,    'rgba(255,255,255,0.58)');
  rad.addColorStop(0.42, 'rgba(255,255,255,0.32)');
  rad.addColorStop(0.75, 'rgba(255,255,255,0.08)');
  rad.addColorStop(1,    'rgba(0,0,0,0.15)');
  ctx.fillStyle = rad;
  ctx.fillRect(0, 0, PX, PX);
  return canvas.toBuffer('image/jpeg', { quality: 0.875 });
}

// ── Print-quality defaults (calibrated on Ray Yanai) ─────────────────────────
const PRINT_PX            = Math.round(PAGE_MM / 25.4 * 300); // ~2674px at 300 DPI
const MIN_EFFECTIVE_PX    = 2674;   // resolution gate: min source dim after upscale
const SHARPNESS_MIN       = 6;      // Laplacian-variance floor (conservative; log-only calibrate)
const PRINT_BRIGHTEN_PCT  = 0.05;   // ~5% lift — print always darker than screen

// Fix 2 — content-aware vertical crop window.
// Instead of a blind center crop (CROP_Y = (H-cropH)/2), locate the character's
// vertical mass in the left character zone and center the cropH-tall window on it,
// so head + feet stay inside the frame. Deterministic → identical in STEP 4 & 5.
function findVerticalContentWindow(img, W, H, cropH) {
  const { createCanvas } = require('canvas');
  const zoneW = Math.round(W * 0.45);          // left 45% = character zone
  const SW = 60, SH = 128;
  const c = createCanvas(SW, SH);
  c.getContext('2d').drawImage(img, 0, 0, zoneW, H, 0, 0, SW, SH);
  const d = c.getContext('2d').getImageData(0, 0, SW, SH).data;
  const rowE = new Array(SH).fill(0);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW - 1; x++) {
      const i = (y * SW + x) * 4, j = i + 4;
      rowE[y] += Math.abs(d[i]-d[j]) + Math.abs(d[i+1]-d[j+1]) + Math.abs(d[i+2]-d[j+2]);
    }
  }
  const maxE = Math.max(...rowE, 1);
  const thr  = maxE * 0.12;
  let top = 0, bot = SH - 1;
  while (top < SH && rowE[top] < thr) top++;
  while (bot > 0  && rowE[bot] < thr) bot--;
  if (top >= bot) { top = 0; bot = SH - 1; }
  const contentCenterY = ((top + bot) / 2) / SH * H;
  let cropY = Math.round(contentCenterY - cropH / 2);
  cropY = Math.max(0, Math.min(H - cropH, cropY));
  return cropY;
}

// Option 2 (2026-07-23): NO print generation. The illustration page IS the digital
// book's own illustration for this page — pixel-for-pixel identity, exactly the book
// the customer already saw and approved, at zero AI cost. The digital images are
// portrait (1024×1536); crop to a W×W square biased UPWARD so the head keeps a small
// margin and the crop is taken from the bottom (a legitimate knee/waist-up portrait).
// Deterministic — the returned buffer feeds the unchanged square path (upscale + assemble).
function smartSquareCropUp(buffer, label) {
  const { createCanvas, Image } = require('canvas');
  const img = new Image(); img.src = buffer;
  const W = img.width, H = img.height;
  if (H <= W) {
    // already square or landscape — center-crop to square, no vertical bias needed
    const side = Math.min(W, H);
    const c = createCanvas(side, side);
    c.getContext('2d').drawImage(img, Math.round((W - side) / 2), Math.round((H - side) / 2), side, side, 0, 0, side, side);
    console.log(`[print-pdf] smartSquareCropUp ${label||''}: ${W}×${H} (not portrait) → center-crop ${side}²`);
    return c.toBuffer('image/jpeg', { quality: 0.95 });
  }
  const side = W;                       // square side = full width
  // Detect the topmost content row (hair against background) across the FULL width.
  const SW = 96, SH = 192;
  const s = createCanvas(SW, SH);
  s.getContext('2d').drawImage(img, 0, 0, W, H, 0, 0, SW, SH);
  const d = s.getContext('2d').getImageData(0, 0, SW, SH).data;
  const rowE = new Array(SH).fill(0);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW - 1; x++) {
      const i = (y * SW + x) * 4, j = i + 4;
      rowE[y] += Math.abs(d[i]-d[j]) + Math.abs(d[i+1]-d[j+1]) + Math.abs(d[i+2]-d[j+2]);
    }
  }
  const maxE = Math.max(...rowE, 1), thr = maxE * 0.12;
  let topRow = 0; while (topRow < SH && rowE[topRow] < thr) topRow++;
  if (topRow >= SH) topRow = 0;
  const topContentY = topRow / SH * H;
  const headroom = Math.round(H * 0.05);           // small margin above the hair
  let cropY = Math.round(topContentY - headroom);
  cropY = Math.max(0, Math.min(H - side, cropY));  // upward-biased, clamped
  const out = createCanvas(side, side);
  out.getContext('2d').drawImage(img, 0, cropY, side, side, 0, 0, side, side);
  console.log(`[print-pdf] smartSquareCropUp ${label||''}: ${W}×${H} → ${side}² up-biased (topContentY=${Math.round(topContentY)}, cropY=${cropY})`);
  return out.toBuffer('image/jpeg', { quality: 0.95 });
}

// Compute per-page spread geometry from a wide buffer. Deterministic — called by
// both STEP 4 (upscale) and STEP 5 (assemble) so they always agree, no cache of state.
async function computeSpreadGeometry(wideBuffer) {
  const { createCanvas, loadImage } = require('canvas');
  const wImg = await loadImage(wideBuffer);
  const W = wImg.width, H = wImg.height;

  // Option 1 — square portrait: the whole image is the illustration page. No flip,
  // no 2:1 crop, no binding split. splitX = W so downstream treats the full square
  // as the illustration and the text page samples its tones from the whole image.
  // Framing is guaranteed at generation and verified by human eyes.
  if (Math.abs(W - H) <= 2) {
    return {
      W, H, CROP_H: H, cropY: 0, croppedImg: wImg, splitX: W,
      bbox: { x0: 0, x1: W, y0: 0, y1: H },
      frameValid: true,
      frameReason: 'square portrait — full image is the illustration (Option 1)',
    };
  }

  const CROP_H = Math.round(W / 2);            // 2:1 crop → 768 for 1536-wide (legacy wide path)
  const cropY  = findVerticalContentWindow(wImg, W, H, CROP_H);
  const croppedC = createCanvas(W, CROP_H);
  croppedC.getContext('2d').drawImage(wImg, 0, cropY, W, CROP_H, 0, 0, W, CROP_H);
  const croppedImg = await loadImage(croppedC.toBuffer('image/png'));

  // Split is DERIVED FROM THE CHARACTER, not the reverse. Compute the character's
  // explicit bounding box, then the binding line is legal ONLY if the whole bbox
  // plus a 40px margin sits to its LEFT. Within the legal window [bbox.x1+40, xHi]
  // we still pick the quietest seam. If no legal position exists (character sits
  // centered — a rule-4 violation), frameValid=false → caller regenerates.
  const BBOX_MARGIN = 40;
  const bbox     = computeCharacterBBox(croppedImg, W, CROP_H);
  const xHi      = Math.round(W * 0.68);
  const minSplit = Math.ceil(MIN_EFFECTIVE_PX / 4);   // 669px — 300DPI resolution floor
  const lowBound = Math.max(bbox.x1 + BBOX_MARGIN, minSplit);
  let splitX, frameValid, frameReason;
  if (lowBound > xHi) {
    frameValid  = false;
    frameReason = `character not confined to one side: bbox.x1=${bbox.x1} (+${BBOX_MARGIN}px margin) needs split≥${lowBound}, but max legal split=${xHi} → char centered/oversized`;
    splitX      = findBindingDodgeSplit(croppedImg, W, CROP_H); // best-effort (last-resort only)
    console.warn(`[print-pdf] frame INVALID: ${frameReason}`);
  } else {
    frameValid  = true;
    splitX      = findBindingDodgeSplit(croppedImg, W, CROP_H, lowBound, xHi); // quietest seam past the character
    frameReason = `split derived from bbox (bbox=[${bbox.x0},${bbox.x1}]×[${bbox.y0},${bbox.y1}], margin=${BBOX_MARGIN}, split=${splitX})`;
    console.log(`[print-pdf] frame valid: ${frameReason}`);
  }
  return { W, H, CROP_H, cropY, croppedImg, splitX, bbox, frameValid, frameReason };
}

// Option A — uniform-scale cover-crop to a square. NEVER stretches (single scalar).
// Character sits on the LEFT, spine on the RIGHT: any horizontal excess is cropped
// from the RIGHT (spine) side only — never the character side. Vertical excess is
// centered (the vertical content window already framed the character).
function coverCropToSquare(srcImg, targetPX) {
  const { createCanvas } = require('canvas');
  const uw = srcImg.width, uh = srcImg.height;
  const s  = Math.max(targetPX / uw, targetPX / uh); // fill, uniform
  const scaledW = uw * s, scaledH = uh * s;
  const dx = 0;                          // left-align → keep character, crop spine (right)
  const dy = (targetPX - scaledH) / 2;   // center vertically
  const canvas = createCanvas(targetPX, targetPX);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcImg, dx, dy, scaledW, scaledH);
  return canvas;
}

// Sharpness metric: variance of the Laplacian on a 256² grayscale sample.
function laplacianVariance(imgBuffer) {
  const { createCanvas, Image } = require('canvas');
  const img = new Image(); img.src = imgBuffer;
  const S = 256;
  const c = createCanvas(S, S);
  c.getContext('2d').drawImage(img, 0, 0, S, S);
  const d = c.getContext('2d').getImageData(0, 0, S, S).data;
  const gray = new Float64Array(S * S);
  for (let i = 0; i < S * S; i++) gray[i] = 0.299*d[i*4] + 0.587*d[i*4+1] + 0.114*d[i*4+2];
  let mean = 0, n = 0; const vals = [];
  for (let y = 1; y < S - 1; y++) for (let x = 1; x < S - 1; x++) {
    const i = y*S + x;
    const lap = -4*gray[i] + gray[i-1] + gray[i+1] + gray[i-S] + gray[i+S];
    vals.push(lap); mean += lap; n++;
  }
  mean /= n; let v = 0;
  for (const l of vals) v += (l - mean) * (l - mean);
  return v / n;
}

// Fix 3 — automatic quality gate on a built spread. Verifies the main character
// is intact on the illustration page and not cut by the spine or the top/bottom
// edges. Conservative: only fails on a clear violation (regeneration costs money).
function qualityGateSpread(croppedImg, splitX, cropH) {
  const { createCanvas } = require('canvas');
  const SW = 90, SH = 90;
  const c = createCanvas(SW, SH);
  c.getContext('2d').drawImage(croppedImg, 0, 0, splitX, cropH, 0, 0, SW, SH);
  const d = c.getContext('2d').getImageData(0, 0, SW, SH).data;
  // gradient energy per pixel (edge = content)
  const E = (x, y) => {
    if (x >= SW - 1 || y >= SH - 1) return 0;
    const i = (y*SW + x)*4, jx = i+4, jy = i + SW*4;
    return Math.abs(d[i]-d[jx]) + Math.abs(d[i+1]-d[jx+1]) + Math.abs(d[i+2]-d[jx+2]) +
           Math.abs(d[i]-d[jy]) + Math.abs(d[i+1]-d[jy+1]) + Math.abs(d[i+2]-d[jy+2]);
  };
  const bandMean = (x0, x1, y0, y1) => {
    let s = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += E(x, y); n++; }
    return n ? s / n : 0;
  };
  const overall = bandMean(0, SW, 0, SH) || 1;
  const spineBand = bandMean(Math.round(SW*0.90), SW,  0, SH);            // right 10% = spine
  const spineEdge = bandMean(SW - 3, SW,  0, SH);                          // rightmost 3px column (the binding line itself)
  const topBand   = bandMean(0, SW, 0, Math.round(SH*0.06));               // top 6%
  const botBand   = bandMean(0, SW, Math.round(SH*0.94), SH);              // bottom 6%
  const reasons = [];
  // Tightened after a clipped hand slipped through the old 1.15 spine threshold:
  // a hand touching the binding shows as a busy right band / busy edge column.
  if (spineBand > overall * 1.08) reasons.push(`character bleeds into spine (spine=${spineBand.toFixed(0)} vs mean=${overall.toFixed(0)})`);
  if (spineEdge > overall * 1.10) reasons.push(`content touches binding edge (edge=${spineEdge.toFixed(0)} vs mean=${overall.toFixed(0)})`);
  if (topBand   > overall * 1.20) reasons.push(`content touches top edge (top=${topBand.toFixed(0)})`);
  if (botBand   > overall * 1.20) reasons.push(`content touches bottom edge (bot=${botBand.toFixed(0)})`);
  return { pass: reasons.length === 0, reason: reasons.join('; '),
           metrics: { overall, spineBand, spineEdge, topBand, botBand } };
}

// Print compensation: lift brightness ~5% (print is always darker than screen).
// Applied ONLY to illustration + text-background, NEVER to the dark text overlay.
function printBrighten(imgBuffer, pct = PRINT_BRIGHTEN_PCT) {
  const { createCanvas, Image } = require('canvas');
  const img = new Image(); img.src = imgBuffer;
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, img.width, img.height);
  const dt = id.data, f = 1 + pct;
  for (let i = 0; i < dt.length; i += 4) {
    dt[i]   = Math.min(255, dt[i]   * f);
    dt[i+1] = Math.min(255, dt[i+1] * f);
    dt[i+2] = Math.min(255, dt[i+2] * f);
  }
  ctx.putImageData(id, 0, 0);
  return c.toBuffer('image/jpeg', { quality: 0.9 });
}

// Verification summary — printed before ANY paid run. Confirms the exact book,
// style, and reference photo that were fetched (by the long unique bookId only).
// Owner reviews this, then re-runs with dryRun:false to spend.
function printVerificationSummary(book, referenceBuffer, debugDir, styleLock) {
  const line = '─'.repeat(60);
  console.log(`\n[print-pdf] ${line}`);
  console.log('[print-pdf] VERIFICATION SUMMARY — review before paid generation');
  console.log(`[print-pdf] ${line}`);
  console.log(`[print-pdf]   bookId (unique):  ${book.bookId || '(unknown)'}`);
  console.log(`[print-pdf]   child name:       ${book.childName || '(none)'}`);
  console.log(`[print-pdf]   book title:       ${book.generatedBook?.title || '(none)'}`);
  console.log(`[print-pdf]   style (from DB):  ${book.illustrationStyle || '⚠️ (empty — generic fallback)'}`);
  console.log(`[print-pdf]   style lock used:  ${(styleLock || '').slice(0, 70)}...`);
  console.log(`[print-pdf]   story pages:      ${book.generatedBook?.pages?.length ?? 0}`);
  if (referenceBuffer) {
    const refPath = saveDebug(debugDir, 'reference-used.jpg', referenceBuffer);
    console.log(`[print-pdf]   reference photo:  ${(referenceBuffer.length/1024).toFixed(0)}KB → ${refPath}`);
  } else {
    console.log('[print-pdf]   reference photo:  ⚠️ NONE — character consistency at risk');
  }
  console.log(`[print-pdf] ${line}\n`);
}

async function generateWideSpreadImage(openai, referenceBuffer, imagePrompt, characterPromptCore, label, styleLock, digitalPageBuffer, reinforce40, reinforceWide) {
  const { createCanvas, loadImage } = require('canvas');
  const { toFile } = require('openai');

  // Convert a buffer to a PNG file for images.edit.
  const toPngFile = async (buf, name) => {
    const im = await loadImage(buf);
    const c  = createCanvas(im.width, im.height);
    c.getContext('2d').drawImage(im, 0, 0);
    return toFile(c.toBuffer('image/png'), name, { type: 'image/png' });
  };

  // IDENTITY ANCHOR (mirrors the digital pipeline's supreme rule): the character
  // in print MUST be the SAME character as in the finished digital book — not a
  // fresh interpretation of the photo. So we anchor on the digital book's OWN
  // illustration for this page as the PRIMARY visual reference, with the child's
  // photo as a secondary facial-identity backup. gpt-image-1 images.edit accepts
  // an array of reference images.
  const imageFiles = [];
  let identityNote;
  if (digitalPageBuffer) {
    imageFiles.push(await toPngFile(digitalPageBuffer, 'digital-book-page.png'));
    identityNote =
      'IDENTITY — ABSOLUTE: The FIRST reference image is the finished illustration of THIS EXACT ' +
      'character from the customer\u2019s book. Reproduce this character\u2019s face, hair, skin tone, ' +
      'proportions, and outfit IDENTICALLY — same child, not a lookalike. The SECOND reference image ' +
      'is the child\u2019s real photo for facial identity. Do NOT invent a different or generic child.';
  } else {
    identityNote =
      'IDENTITY: The reference image is the child\u2019s real photo. Keep the child\u2019s face, hair, ' +
      'skin tone and identity exactly as in the photo. Do NOT invent a different or generic child.';
  }
  if (referenceBuffer) imageFiles.push(await toPngFile(referenceBuffer, 'child-photo.png'));

  // Option 1: a centered square portrait. The only failure mode is the child being
  // cropped at an edge — on that retry (reinforceWide) hammer the margin rule.
  const reinforce = reinforceWide ? ('\n\n' + PORTRAIT_REINFORCE_MARGIN) : '';
  const prompt = `${styleLock}\n\n${identityNote}\n\nCHARACTER (must match exactly across all spreads):\n${characterPromptCore}\n\nSCENE:\n${imagePrompt}\n\n${PORTRAIT_COMPOSITION}${reinforce}`;
  console.log(`[print-pdf] portrait generate: ${label}... (identity refs: ${imageFiles.length}${digitalPageBuffer ? ', digital-anchored' : ', photo-only'}${reinforceWide ? ', MARGIN-REINFORCED' : ''})`);

  const resp = await openai.images.edit({
    model: 'gpt-image-1',
    image: imageFiles.length === 1 ? imageFiles[0] : imageFiles,
    prompt,
    size:  '1024x1024',
    quality: 'medium',
    n: 1,
  });

  // Single centered square portrait — the whole page IS the illustration. No flip
  // (nothing to mirror) and no binding split. Framing is guaranteed by the prompt
  // and verified by human eyes before any spread is ever presented.
  return Buffer.from(resp.data[0].b64_json, 'base64');
}

/**
 * Split a square panoramic image into two square page buffers at print resolution.
 * Right half → illustration page (for text overlay).
 * Left half → expansion page (clean).
 *
 * The panoramic is square (e.g. 4096×4096 after upscale);
 * each half is 2:1 portrait → stretched to PX×PX square for the print page.
 *
 * @param {Buffer} panoramicBuf
 * @returns {{ rightBuf: Buffer, leftBuf: Buffer }}
 */
function splitPanoramic(panoramicBuf) {
  // Panoramic is 1536×1024 (or 4× upscaled: 6144×4096).
  // RIGHT portion: x = W*2/3 .. W, width = W/3*2 = H, height = H → SQUARE (H×H). Scale uniformly to PX×PX.
  // LEFT portion:  x = 0 .. W/3, width = W/3 = H/2, height = H → portrait (1:2). Stretch to PX×PX.
  //
  // 1536 = 1024 (right/original) + 512 (left/extension).
  // After 4× upscale: 6144×4096 — right = 4096×4096 (square!), left = 2048×4096.
  const { createCanvas, Image } = require('canvas');
  const PX  = Math.round(PAGE_MM / 25.4 * 300); // ~2673px
  const img = new Image();
  img.src   = panoramicBuf;
  const W = img.width;   // e.g. 6144 (upscaled) or 1536 (pre-upscale)
  const H = img.height;  // e.g. 4096 or 1024

  // Right portion = right 2/3 of width = H×H square (since W/H = 1536/1024 = 1.5, right = 1024/1024 = 1:1)
  const leftW  = Math.round(W / 3);    // 512 or 2048 — extension area
  const rightW = W - leftW;            // 1024 or 4096 — original area (square: rightW == H)

  // Right half: source is (leftW, 0, rightW, H) which is a square → scale uniformly to PX×PX
  const rCanvas = createCanvas(PX, PX);
  rCanvas.getContext('2d').drawImage(img, leftW, 0, rightW, H, 0, 0, PX, PX);

  // Left half: source is (0, 0, leftW, H) which is portrait (1:2) → stretch to PX×PX
  const lCanvas = createCanvas(PX, PX);
  lCanvas.getContext('2d').drawImage(img, 0, 0, leftW, H, 0, 0, PX, PX);

  console.log(`[print-pdf] splitPanoramic: W=${W} H=${H} | right=${rightW}×${H} (square→${PX}px) | left=${leftW}×${H} (portrait→${PX}px stretched)`);

  return {
    rightBuf: rCanvas.toBuffer('image/png'),
    leftBuf:  lCanvas.toBuffer('image/png'),
  };
}

/**
 * Punctuation-aware line breaking for Hebrew text.
 * Breaks at commas/periods (nearest break ≤ maxWidth), falls back to word-wrap.
 *
 * @param {CanvasRenderingContext2D} ctx — with font already set
 * @param {string} text
 * @param {number} maxWidth — pixels
 * @returns {string[]}
 */
function punctuationWrap(ctx, text, maxWidth) {
  const PUNCT = /[,\.!?]/;
  const lines = [];
  let remaining = text.trim();

  while (remaining.length > 0) {
    // Does the whole remaining fit?
    if (ctx.measureText(remaining).width <= maxWidth) {
      lines.push(remaining);
      break;
    }

    // Find the last punctuation break point that still fits within maxWidth
    const TRAIL_QUOTE = /["'”’)»]/; // a closing quote/paren belongs to the punctuation before it
    let breakAt = -1;
    let i = 0;
    while (i < remaining.length) {
      if (ctx.measureText(remaining.slice(0, i + 1)).width > maxWidth) break;
      if (PUNCT.test(remaining[i])) {
        // include the punctuation char, plus any trailing closing quote so it
        // never gets orphaned at the start of the next RTL line
        let end = i + 1;
        while (end < remaining.length && TRAIL_QUOTE.test(remaining[end])) end++;
        breakAt = end;
      }
      i++;
    }

    if (breakAt > 0) {
      lines.push(remaining.slice(0, breakAt).trim());
      remaining = remaining.slice(breakAt).trim();
      continue;
    }

    // No punctuation found → word-wrap
    let wordBreakEnd = 0;
    let j = 0;
    while (j < remaining.length) {
      if (ctx.measureText(remaining.slice(0, j + 1)).width > maxWidth) break;
      if (remaining[j] === ' ') wordBreakEnd = j;
      j++;
    }

    if (wordBreakEnd > 0) {
      lines.push(remaining.slice(0, wordBreakEnd).trim());
      remaining = remaining.slice(wordBreakEnd).trim();
    } else {
      // Can't break gracefully — take what fits (at least 1 char)
      const cutAt = Math.max(i, 1);
      lines.push(remaining.slice(0, cutAt).trim());
      remaining = remaining.slice(cutAt).trim();
    }
  }

  return lines;
}

// ─── Replicate Real-ESRGAN upscaling ─────────────────────────────────────────

async function upscaleImage(imageBuffer, label) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error('[print-pdf] Missing REPLICATE_API_TOKEN');

  console.log(`[print-pdf] upscaling ${label} via Real-ESRGAN...`);
  const b64     = imageBuffer.toString('base64');
  const dataUrl = `data:image/png;base64,${b64}`;

  // Use model endpoint (latest version)
  const createRes = await fetch('https://api.replicate.com/v1/models/nightmareai/real-esrgan/predictions', {
    method:  'POST',
    headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { image: dataUrl, scale: 4, face_enhance: false } }),
  });

  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`[print-pdf] Replicate create failed for ${label}: ${createRes.status} — ${body}`);
  }

  const prediction   = await createRes.json();
  const predictionId = prediction.id;
  const deadline     = Date.now() + 6 * 60 * 1000; // 6 min max

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4000));
    const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { Authorization: `Token ${token}` },
    });
    if (!pollRes.ok) throw new Error(`[print-pdf] Replicate poll failed: ${pollRes.status}`);

    const status = await pollRes.json();
    if (status.status === 'succeeded') {
      const outputUrl = Array.isArray(status.output) ? status.output[0] : status.output;
      return fetchBuffer(outputUrl);
    }
    if (status.status === 'failed' || status.status === 'canceled') {
      throw new Error(`[print-pdf] Replicate upscale failed for ${label}: ${status.error || status.status}`);
    }
  }
  throw new Error(`[print-pdf] Replicate upscale timed out for ${label}`);
}

// ─── Hebrew text rendering via node-canvas ────────────────────────────────────

/**
 * Render Hebrew story text to a PNG buffer sized for a full print page.
 * The outpainted image is used as background — this PNG is composited on top.
 * Returns a PNG buffer, or null if canvas is unavailable.
 */
/**
 * Sample the average luminance of the right half of squareBuffer (the outpainted bg area).
 * Returns a value 0–255; < 128 = dark background.
 */
function sampleBgLuminance(squareBuffer) {
  try {
    const { createCanvas, loadImage } = require('canvas');
    // Work at a small size for speed — 100×100 samples the right half
    const SAMP = 100;
    const canvas = createCanvas(SAMP, SAMP);
    const ctx    = canvas.getContext('2d');
    const img    = new (require('canvas').Image)();
    img.src = squareBuffer;
    // Draw only the right half of the square into our sample canvas
    ctx.drawImage(img, img.width / 2, 0, img.width / 2, img.height, 0, 0, SAMP, SAMP);
    const data = ctx.getImageData(0, 0, SAMP, SAMP).data;
    let total = 0;
    const pixels = SAMP * SAMP;
    for (let i = 0; i < data.length; i += 4) {
      // Relative luminance per ITU-R BT.601
      total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return total / pixels;
  } catch (e) {
    // Default to "light background" if sampling fails
    return 200;
  }
}

/**
 * Render Hebrew story text to a PNG buffer sized for a full print page.
 * Adapts text color to background brightness and adds a shadow for legibility.
 * @param {string} text
 * @param {Buffer} squareBuffer — the outpainted square image used to detect bg brightness
 */
/**
 * Split an outpainted square buffer into two half-square images for print pages.
 * Left half  → illustration page (original character area, no distortion, 1:1).
 * Text bg    → heavy blur of the illustration (no AI, no outpaint right-half).
 *
 * Text-page background rule (mandatory per LIFEBOOK_SPEC.md §3):
 *   Take the illustration, apply a very heavy Gaussian-style box blur so that no
 *   shape is recognisable — only soft colour patches remain.  Use this as the
 *   full-bleed background for the text page.  The colours are drawn from the same
 *   illustration as the facing page, creating a visual echo without any figure/object.
 *   Zero AI cost.  If blur result is too dark or too light for text legibility,
 *   a brightness clamp shifts it toward mid-grey without touching the hue.
 *
 * @param {Buffer} squareBuf — outpainted (or any) square PNG/JPEG (must be 1:1)
 * @returns {{ illustrationJpeg: Buffer, textBgJpeg: Buffer }}
 */
function splitSquareForPrint(squareBuf) {
  const { createCanvas, Image } = require('canvas');
  const PX = Math.round(PAGE_MM / 25.4 * 300); // ~2673px at 300 DPI

  const img = new Image();
  img.src = squareBuf;
  const W = img.width; // square — W === H

  // ── Illustration page: left half of the square, scaled to PX×PX ─────────────
  const leftCanvas = createCanvas(PX, PX);
  leftCanvas.getContext('2d').drawImage(img, 0, 0, W / 2, W, 0, 0, PX, PX);
  const illustrationJpeg = leftCanvas.toBuffer('image/jpeg', { quality: 0.875 });

  // ── Text-background page: heavy blur of the illustration ─────────────────────
  // Step 1: downsample to a tiny canvas (controls blur radius implicitly).
  //         32px → upscale back to PX gives ~83px effective blur radius at 300 DPI.
  const BLUR_SMALL = 32; // the smaller this is, the heavier the blur
  const tiny = createCanvas(BLUR_SMALL, BLUR_SMALL);
  tiny.getContext('2d').drawImage(leftCanvas, 0, 0, PX, PX, 0, 0, BLUR_SMALL, BLUR_SMALL);

  // Step 2: upscale tiny back to PX×PX using nearest-neighbour then smooth.
  //         Two round-trips smooth out any remaining pixelation.
  const mid = createCanvas(256, 256);
  mid.getContext('2d').drawImage(tiny, 0, 0, BLUR_SMALL, BLUR_SMALL, 0, 0, 256, 256);

  const blurCanvas = createCanvas(PX, PX);
  const bctx = blurCanvas.getContext('2d');
  bctx.drawImage(mid, 0, 0, 256, 256, 0, 0, PX, PX);

  // Step 3: brightness clamp — if average luminance is extreme, nudge toward 160
  //         (comfortable mid-grey) by blending with a neutral grey overlay.
  //         This preserves hue while improving text legibility.
  const sampleCanvas = createCanvas(32, 32);
  sampleCanvas.getContext('2d').drawImage(blurCanvas, 0, 0, PX, PX, 0, 0, 32, 32);
  const sampleData = sampleCanvas.getContext('2d').getImageData(0, 0, 32, 32).data;
  let lum = 0;
  for (let k = 0; k < sampleData.length; k += 4) {
    lum += 0.299 * sampleData[k] + 0.587 * sampleData[k + 1] + 0.114 * sampleData[k + 2];
  }
  lum /= (sampleData.length / 4);

  // Too dark (<80) → lighten; too light (>200) → darken
  if (lum < 80) {
    bctx.fillStyle = 'rgba(255,255,255,0.35)';
    bctx.fillRect(0, 0, PX, PX);
  } else if (lum > 200) {
    bctx.fillStyle = 'rgba(0,0,0,0.25)';
    bctx.fillRect(0, 0, PX, PX);
  }

  const textBgJpeg = blurCanvas.toBuffer('image/jpeg', { quality: 0.875 });

  return { illustrationJpeg, textBgJpeg };
}

/**
 * Convert any image buffer (PNG/JPEG) to JPEG at q85 via canvas.
 * This is applied to all story images before PDF embedding to keep file < 80MB.
 */
function toJpegBuffer(imgBuffer, quality = 0.85) {
  try {
    const { createCanvas, Image } = require('canvas');
    const img = new Image();
    img.src = imgBuffer;
    const canvas = createCanvas(img.width, img.height);
    canvas.getContext('2d').drawImage(img, 0, 0);
    return canvas.toBuffer('image/jpeg', { quality });
  } catch (e) {
    console.warn(`[print-pdf] toJpegBuffer failed: ${e.message} — using original buffer`);
    return imgBuffer;
  }
}

/**
 * Renders a full-page PNG: original illustration full-bleed +
 * gradient scrim (bottom 42%) + Hebrew text centered at bottom.
 * Matches delivery.html digital PDF layout exactly.
 *
 * @param {string} text          — story page text (Hebrew)
 * @param {Buffer} originalBuf   — original square illustration (JPEG/PNG)
 * @returns Buffer  PNG at 300 DPI
 */
/**
 * Render a full cream story-text page PNG.
 * Cream background (#fdf8f0), double gold border, RTL right-aligned Hebrew text
 * centred vertically, using punctuationWrap for line breaking.
 *
 * @param {string} text  — story page text (Hebrew)
 * @returns Buffer  PNG at 300 DPI
 */
function renderStoryTextPagePng(text) {
  try {
    const { createCanvas } = require('canvas');
    const PX      = Math.round(PAGE_MM / 25.4 * 300); // ~2673px
    const mm2px   = PX / PAGE_MM;
    const canvas  = createCanvas(PX, PX);
    const ctx     = canvas.getContext('2d');

    // Cream background
    ctx.fillStyle = '#fdf8f0';
    ctx.fillRect(0, 0, PX, PX);

    // Double gold border
    ctx.strokeStyle = '#c8a84b';
    ctx.lineWidth   = 1.2 * mm2px;
    ctx.strokeRect(10 * mm2px, 10 * mm2px, PX - 20 * mm2px, PX - 20 * mm2px);
    ctx.lineWidth   = 0.5 * mm2px;
    ctx.strokeRect(14 * mm2px, 14 * mm2px, PX - 28 * mm2px, PX - 28 * mm2px);

    if (!text) return canvas.toBuffer('image/png');

    const MARGIN_PX  = Math.round(MARGIN_INNER_MM / 25.4 * 300);
    const FONT_SIZE  = Math.round(PX * 0.042); // ~112px ≈ 14pt at 300DPI
    const LINE_H     = Math.round(FONT_SIZE * 1.75);
    const MAX_W      = PX - MARGIN_PX * 2;

    ctx.font      = `${FONT_SIZE}px Arial Unicode MS, Arial, sans-serif`;
    ctx.direction = 'rtl';

    const lines   = punctuationWrap(ctx, text, MAX_W);
    const blockH  = lines.length * LINE_H;
    let y = Math.max(MARGIN_PX + FONT_SIZE, (PX - blockH) / 2 + FONT_SIZE);

    ctx.fillStyle = '#2c1a0e';
    ctx.textAlign = 'right';
    ctx.shadowColor   = 'rgba(0,0,0,0)';
    ctx.shadowBlur    = 0;

    for (const line of lines) {
      ctx.fillText(line, PX - MARGIN_PX, y);
      y += LINE_H;
    }

    return canvas.toBuffer('image/png');
  } catch (e) {
    console.warn(`[print-pdf] renderStoryTextPagePng failed: ${e.message}`);
    return null;
  }
}

/**
 * Render Hebrew story text as a transparent PNG overlay.
 * The overlay is placed on top of the squareBuffer illustration in the PDF.
 * Background is transparent — the extension area of the squareBuffer shows through.
 * Uses punctuation-aware line breaking.
 *
 * @param {string} text
 * @param {Buffer} squareBuffer — used only to sample background luminance for text colour
 * @returns Buffer  PNG at 300 DPI (transparent background)
 */
function renderHebrewTextPng(text, squareBuffer) {
  try {
    const { createCanvas } = require('canvas');
    const PX = Math.round(PAGE_MM / 25.4 * 300);  // ~2673px at 300 DPI
    const MARGIN_PX = Math.round(MARGIN_INNER_MM / 25.4 * 300);

    // Brand dark-brown text on the light vignette — NO outline/shadow of any kind.
    // The radial vignette is always brightest at the centre where the text block
    // sits, so dark-brown reads cleanly without any halo; the white outline that
    // used to be here (shadowColor rgba(255,255,255,0.6)) is removed entirely.
    const textColor = '#2c1a0e';
    console.log('[print-pdf] text overlay: brand dark-brown, no outline');

    const canvas = createCanvas(PX, PX);
    const ctx    = canvas.getContext('2d');
    ctx.clearRect(0, 0, PX, PX); // transparent background

    const FONT_SIZE = Math.round(PX * 0.043); // ~115px ≈ 14.5pt at 300DPI — Frank Ruhl Libre is a serif with a lower x-height, so sized up slightly for the same optical weight on the page
    const LINE_H    = Math.round(FONT_SIZE * 1.75); // serif body reads comfortably a hair tighter than the sans; still generous, airy leading
    const MAX_W     = PX - MARGIN_PX * 2;

    // Frank Ruhl Libre — owner-selected Hebrew serif for the printed story text.
    ctx.font      = `400 ${FONT_SIZE}px FrankRuhlLibre, "Arial Unicode MS", Arial, serif`;
    ctx.direction = 'rtl';

    // Punctuation-aware line breaking
    const lines = punctuationWrap(ctx, text, MAX_W);

    ctx.fillStyle     = textColor;
    ctx.textAlign     = 'center';           // each line centred on the horizontal page centre
    ctx.shadowColor   = 'rgba(0,0,0,0)';   // no shadow — brand text sits flat on the vignette
    ctx.shadowBlur    = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    // Block centred both ways: horizontally on PX/2, vertically on the page middle.
    const blockH = lines.length * LINE_H;
    let y = Math.max(MARGIN_PX, (PX - blockH) / 2) + FONT_SIZE;
    for (const line of lines) {
      ctx.fillText(line, PX / 2, y);
      y += LINE_H;
    }

    return canvas.toBuffer('image/png');
  } catch (e) {
    console.warn(`[print-pdf] renderHebrewTextPng failed: ${e.message}`);
    return null;
  }
}

// ─── Logo loader ──────────────────────────────────────────────────────────────

const LOGO_PATH = path.join(__dirname, '..', 'public', 'assets', 'branding', 'lifebook-logo-print-cream.png');

/**
 * Load the Lifebook logo WebP and return it as a PNG Buffer via canvas.
 * Returns null if the file is not found (non-fatal).
 */
async function loadLogoPng() {
  try {
    const { createCanvas, loadImage } = require('canvas');
    const img    = await loadImage(LOGO_PATH);
    // Preserve aspect ratio; render at 600px wide
    const W      = 600;
    const H      = Math.round(img.height * (W / img.width));
    const canvas = createCanvas(W, H);
    canvas.getContext('2d').drawImage(img, 0, 0, W, H);
    return { buffer: canvas.toBuffer('image/png'), w: W, h: H };
  } catch (e) {
    console.warn(`[print-pdf] logo not found at ${LOGO_PATH}: ${e.message}`);
    return null;
  }
}

// ─── Frame page renderer via canvas (Hebrew-safe) ────────────────────────────

/**
 * Render a cream frame page entirely via node-canvas so Hebrew text is never
 * passed to pdfkit directly (which produces broken glyphs).
 *
 * @param {Array<{text,fontSize,color,bold,yFrac}>} textLines
 *   - yFrac: Y position as fraction of page height (0..1)
 *   - fontSize: in mm
 * @param {number[]} ruleYMms   Y positions (mm) for gold horizontal rules
 * @param {object|null} nameLine  If set: {yFrac} draws a gold underline (name field)
 * @param {object|null} logo      If set: {buffer, w, h} — logo image, centered at logoYFrac
 * @param {number} logoYFrac      Y center of logo as fraction (default 0.36)
 * @param {boolean} doubleBorder  If true: draws outer + inner gold rect border (like digital dedication page)
 * @returns Buffer  PNG buffer at 300 DPI
 */
function renderFramePagePng(textLines, ruleYMms = [], nameLine = null, logo = null, logoYFrac = 0.36, doubleBorder = false) {
  const { createCanvas, Image } = require('canvas');
  const PX    = Math.round(PAGE_MM / 25.4 * 300); // ~2673px at 300 DPI
  const mm2px = PX / PAGE_MM;

  const canvas = createCanvas(PX, PX);
  const ctx    = canvas.getContext('2d');

  // Cream background
  ctx.fillStyle = '#fdf8f0';
  ctx.fillRect(0, 0, PX, PX);

  // Double gold border frame (like digital dedication page)
  if (doubleBorder) {
    const PAD_OUT = 10 * mm2px;
    const PAD_IN  = 14 * mm2px;
    ctx.strokeStyle = '#c8a84b';
    ctx.lineWidth   = 1.2 * mm2px;
    ctx.strokeRect(PAD_OUT, PAD_OUT, PX - PAD_OUT * 2, PX - PAD_OUT * 2);
    ctx.lineWidth   = 0.5 * mm2px;
    ctx.strokeRect(PAD_IN, PAD_IN, PX - PAD_IN * 2, PX - PAD_IN * 2);
  }

  // Gold rules
  const ruleW = 1.4 * mm2px;
  for (const yMm of ruleYMms) {
    ctx.strokeStyle = '#c8a84b';
    ctx.lineWidth   = ruleW;
    ctx.beginPath();
    ctx.moveTo(MARGIN_OUTER_MM * mm2px, yMm * mm2px);
    ctx.lineTo((PAGE_MM - MARGIN_OUTER_MM) * mm2px, yMm * mm2px);
    ctx.stroke();
  }

  // Logo image centered
  if (logo) {
    // Logo rendered at ~1/4 of page width
    const logoW  = Math.round(PX * 0.26);
    const logoH  = Math.round(logo.h * (logoW / logo.w));
    const logoX  = (PX - logoW) / 2;
    const logoY  = logoYFrac * PX - logoH / 2;
    const img    = new Image();
    img.src      = logo.buffer;
    ctx.drawImage(img, logoX, logoY, logoW, logoH);

    // Thin gold rule below logo
    const ruleY = logoY + logoH + 18 * mm2px;
    ctx.strokeStyle = '#c8a84b';
    ctx.lineWidth   = 0.7 * mm2px;
    ctx.beginPath();
    ctx.moveTo(PX * 0.32, ruleY);
    ctx.lineTo(PX * 0.68, ruleY);
    ctx.stroke();
  }

  // Name underline (gold line where child writes their name)
  if (nameLine) {
    const y = nameLine.yFrac * PX;
    ctx.strokeStyle = '#c8a84b';
    ctx.lineWidth   = 0.9 * mm2px;
    ctx.beginPath();
    ctx.moveTo(50 * mm2px, y);
    ctx.lineTo((PAGE_MM - 50) * mm2px, y);
    ctx.stroke();
  }

  // Text — all via canvas so Hebrew renders correctly
  ctx.textAlign = 'center';
  ctx.direction = 'rtl';
  for (const line of textLines) {
    if (!line.text) continue;
    const fsPx = line.fontSize * mm2px;
    ctx.font      = `${line.bold ? '700 ' : '400 '}${fsPx}px Arial Unicode MS, Arial, sans-serif`;
    ctx.fillStyle = line.color || '#2c1a0e';
    ctx.fillText(line.text, PX / 2, line.yFrac * PX);
  }

  return canvas.toBuffer('image/png');
}

// ─── PDF builder — 28 single pages ───────────────────────────────────────────

async function buildPDF(book, spreads, outputPath, logo) {
  const doc = new PDFDocument({
    size:          [PAGE_PT, PAGE_PT],
    margin:        0,
    autoFirstPage: false,
    info: {
      Title:   book.generatedBook?.title || 'Lifebook — Print Edition',
      Author:  'Lifebook AI',
      Creator: 'Lifebook print-pdf-generator v2',
    },
  });

  const writeStream = fs.createWriteStream(outputPath);
  doc.pipe(writeStream);

  const title    = book.generatedBook?.title    || `הרפתקת ${book.childName}`;
  const subtitle = book.generatedBook?.subtitle || 'ספר ילדים מותאם אישית';

  // Helper: add a frame page from a canvas PNG buffer
  function addFramePage(pngBuffer) {
    doc.addPage();
    doc.image(pngBuffer, 0, 0, { width: PAGE_PT, height: PAGE_PT });
  }

  // ── PARITY NOTE ─────────────────────────────────────────────────────────────
  // Hebrew RTL binding (Bookpod): odd pages = LEFT, even pages = RIGHT when opened.
  // Verified against approved Ariel Yosef book:
  //   Page 1  (odd=left):   הקדשה — cream frame page
  //   Page 2  (even=right): TEXT  כפולה 1  ← cream frame page + Hebrew text
  //   Page 3  (odd=left):   ILLUS כפולה 1  ← illustration full-bleed 1:1
  //   Page 4  (even=right): TEXT  כפולה 2
  //   Page 5  (odd=left):   ILLUS כפולה 2
  //   ...
  //   Page 2N   (even=right): TEXT  כפולה N
  //   Page 2N+1 (odd=left):   ILLUS כפולה N
  //   Star pages (0–3, dynamic) at END — fill to total ÷ 4
  //   Closing: "נכתב במיוחד עבור [שם]"
  //   Back cover / logo

  function makeStarPage() {
    const { createCanvas } = require('canvas');
    const PX    = Math.round(PAGE_MM / 25.4 * 300);
    const mm2px = PX / PAGE_MM;
    const canvas = createCanvas(PX, PX);
    const ctx    = canvas.getContext('2d');
    ctx.fillStyle = '#fdf8f0';
    ctx.fillRect(0, 0, PX, PX);
    ctx.strokeStyle = '#c8a84b';
    ctx.lineWidth   = 1.0 * mm2px;
    ctx.strokeRect(10 * mm2px, 10 * mm2px, PX - 20 * mm2px, PX - 20 * mm2px);
    ctx.lineWidth   = 0.4 * mm2px;
    ctx.strokeRect(14 * mm2px, 14 * mm2px, PX - 28 * mm2px, PX - 28 * mm2px);
    const stars = [
      [0.20, 0.22, 22], [0.78, 0.18, 16], [0.50, 0.12, 30],
      [0.30, 0.55, 14], [0.70, 0.50, 18], [0.50, 0.52, 36],
      [0.15, 0.80, 16], [0.85, 0.76, 20], [0.50, 0.85, 24],
    ];
    for (const [xF, yF, sizeMm] of stars) {
      const fsPx = sizeMm * mm2px;
      const alpha = sizeMm > 25 ? 0.85 : sizeMm > 15 ? 0.55 : 0.35;
      ctx.font      = `${fsPx}px Arial Unicode MS, Arial, sans-serif`;
      ctx.fillStyle = `rgba(200,168,75,${alpha})`;
      ctx.textAlign = 'center';
      ctx.fillText('✦', xF * PX, yF * PX);
    }
    return canvas.toBuffer('image/png');
  }

  // ── Page 1 (odd=left): הקדשה ─────────────────────────────────────────────────
  addFramePage(renderFramePagePng(
    [
      { text: title,            fontSize: 12,  yFrac: 0.36, bold: true,  color: '#2c1a0e' },
      { text: subtitle,         fontSize:  7,  yFrac: 0.46, bold: false, color: '#7a5c3a' },
      { text: '✦  ✦  ✦',       fontSize:  5,  yFrac: 0.56, bold: false, color: '#c8a84b' },
      { text: 'lifebooksil.com',fontSize:  3.5,yFrac: 0.92, bold: false, color: '#b0905a' },
    ],
    [], null, logo, 0.80, true
  ));

  // ── Pages 2..: N spreads — text(even=right) then illus(odd=left) ─────────────
  for (let i = 0; i < spreads.length; i++) {
    const spread = spreads[i];
    if (!spread.illustrationJpeg) {
      throw new Error(`[print-pdf] spread ${i}: missing illustrationJpeg. Stopping.`);
    }

    // Page A — TEXT (even = RIGHT): outpainted extension bg + transparent Hebrew text overlay
    doc.addPage();
    doc.image(spread.textBgJpeg, 0, 0, { width: PAGE_PT, height: PAGE_PT });
    if (spread.textOverlayPng) {
      doc.image(spread.textOverlayPng, 0, 0, { width: PAGE_PT, height: PAGE_PT });
    }

    // Page B — ILLUSTRATION (odd = LEFT): original character, full-bleed, 1:1, zero distortion
    doc.addPage();
    doc.image(spread.illustrationJpeg, 0, 0, { width: PAGE_PT, height: PAGE_PT });
  }

  // ── Star pages (dynamic) at END before closing ────────────────────────────────
  // Fixed pages: 1 dedication + N×2 spreads + 1 closing + 1 back = 2N+3
  {
    const fixedPages  = 1 + spreads.length * 2 + 2; // dedication + spreads + closing + back
    const starsNeeded = ((4 - (fixedPages % 4)) % 4);
    console.log(`[print-pdf] spreads: ${spreads.length}, fixed: ${fixedPages}, stars: ${starsNeeded}, total: ${fixedPages + starsNeeded}`);
    for (let s = 0; s < starsNeeded; s++) addFramePage(makeStarPage());
  }

  // ── עמוד סיום — "ספר זה נכתב במיוחד עבור [שם]" ─────────────────────────────
  addFramePage(renderFramePagePng(
    [
      { text: `ספר זה נכתב במיוחד עבור ${book.childName}`, fontSize: 8,   yFrac: 0.60, bold: false, color: '#2c1a0e' },
      { text: 'שכל הרפתקה מתחילה ממך',                      fontSize: 6.5, yFrac: 0.68, bold: false, color: '#7a5c3a' },
      { text: 'lifebooksil.com',                              fontSize: 4.5, yFrac: 0.78, bold: false, color: '#a08060' },
    ],
    [18, PAGE_MM - 18], null, logo, 0.34
  ));

  // ── עמוד אחורי — לוגו בלבד ───────────────────────────────────────────────────
  addFramePage(renderFramePagePng(
    [
      { text: 'lifebooksil.com', fontSize: 5, yFrac: 0.62, bold: false, color: '#a08060' },
    ],
    [20, PAGE_MM - 20], null, logo, 0.40
  ));

  doc.end();
  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error',  reject);
  });
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * generatePrintPDF(bookId, options)
 *   options.pilotPages — number of spreads to process (default: 12, pilot: 2)
 */
async function generatePrintPDF(bookId, options = {}) {
  const titleOverride = options.titleOverride ?? null;
  // cropBiasMap: per-page crop bias override. Key = page index (0-based), value = 0.0–1.0.
  // 0.0 = top, 0.5 = center (default), 1.0 = bottom.
  // Example: { 2: 0.7 } shifts page 2 crop downward to include bottom elements.
  const cropBiasMap = options.cropBiasMap ?? {};
  // pilotPages resolved after book fetch — defaults to actual page count (not hardcoded 12)
  const globalStart = Date.now();
  let costEstimate  = 0;

  console.log(`[print-pdf] ── START ── bookId: ${bookId} pilotPages: ${options.pilotPages ?? 'auto'}`);
  console.log(`[print-pdf] Page size: ${PAGE_MM}×${PAGE_MM}mm (22cm + ${BLEED_MM}mm bleed each side)`);

  // Per-book debug dir — isolates files per book, prevents cross-contamination
  const debugDir   = path.join(__dirname, 'debug', bookId);
  fs.mkdirSync(debugDir,   { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`[print-pdf] Debug dir: ${debugDir}`);

  // ── STEP 1: Fetch book ──────────────────────────────────────────────────────
  console.log(`[print-pdf] STEP 1: fetching book...`);
  const book = await fetchBook(bookId);
  if (titleOverride && book.generatedBook) book.generatedBook.title = titleOverride;
  const actualPages  = book.generatedBook?.pages?.length || 12;
  const pilotPages   = options.pilotPages ?? actualPages; // explicit override or actual count
  const suffix       = (options.pilotPages && options.pilotPages < actualPages) ? `-pilot${pilotPages}` : '';
  const outputPath   = path.join(OUTPUT_DIR, `book-${bookId}${suffix}-print.pdf`);
  // Style is ALWAYS read from the book record — never a hardcoded constant.
  const styleLock = buildWideSpreadStyleLock(book.illustrationStyle);
  console.log(`[print-pdf] STEP 1 done — child: ${book.childName}, title: ${book.generatedBook?.title || ''}, style: ${book.illustrationStyle || '(empty→generic)'}, pages: ${actualPages} (processing: ${pilotPages}) ${elapsed(globalStart)}`);

  // ── STEP 2: Load images as Buffers ─────────────────────────────────────────
  console.log(`[print-pdf] STEP 2: loading images...`);
  const pageBuffers = [];
  // Per-page reason why an illustration could not be loaded. Feeds the readiness
  // gate below so a failure names the exact page AND the exact cause.
  const missingReasons = {};
  const dbImageCount = (book.fullImages || []).filter(Boolean).length;
  for (let i = 0; i < pilotPages; i++) {
    // If all downstream cached files exist, skip Storage fetch entirely
    const cachedUpscaled   = path.join(debugDir, `page-${i}-upscaled.png`);
    const cachedOutpainted = path.join(debugDir, `page-${i}-outpainted.png`);
    const cachedOriginal   = path.join(debugDir, `page-${i}-original.jpg`);
    if (fs.existsSync(cachedUpscaled) || fs.existsSync(cachedOutpainted)) {
      console.log(`[print-pdf] STEP 2: page ${i} → downstream cache exists, skipping Storage fetch`);
      pageBuffers.push(null); // not needed — STEP 3 will use cache
      continue;
    }
    const imageRef = book.fullImages[i] || null;
    let buf = null;
    if (!imageRef) {
      missingReasons[i] = `no image URL in the book record (full_images holds ${dbImageCount} of ${pilotPages} illustrations) — the digital generation pipeline has most likely not written this page yet`;
    } else {
      try {
        buf = await toBuffer(imageRef);
        if (!buf) missingReasons[i] = `image reference present but unreadable (not a URL and not valid base64)`;
      } catch (e) {
        missingReasons[i] = `fetch from Storage failed — ${e.message}`;
        console.warn(`[print-pdf] STEP 2: page ${i} Storage fetch failed (${e.message})`);
      }
    }
    if (!buf && fs.existsSync(cachedOriginal)) {
      buf = fs.readFileSync(cachedOriginal);
      delete missingReasons[i];
      console.log(`[print-pdf] STEP 2: page ${i} → loaded from debug cache`);
    }
    if (!buf) console.warn(`[print-pdf] STEP 2: page ${i} image missing — ${missingReasons[i]}`);
    else      saveDebug(debugDir, `page-${i}-original.jpg`, buf);
    pageBuffers.push(buf);
  }
  console.log(`[print-pdf] STEP 2 done — ${pageBuffers.filter(Boolean).length}/${pilotPages} page images loaded ${elapsed(globalStart)}`);

  // ── READINESS GATE ───────────────────────────────────────────────────────────
  // Fail here — BEFORE the first paid step (STEP 4 upscaling) — with a message that
  // names every missing page and why. Historically the run limped on and died with an
  // opaque "page N has no wide image" in STEP 5, after money had already been spent on
  // the pages that did load. Root cause seen in production (order 7255021748470): the
  // orders/paid webhook fired ~40s before the digital pipeline finished writing the
  // last page images, so the print run read a half-written book.
  // A page is satisfied by exactly what STEP 3 can consume: a freshly loaded buffer,
  // a cached square crop, or a cached original on disk.
  const missingPages = [];
  for (let i = 0; i < pilotPages; i++) {
    const usable = !!pageBuffers[i]
      || fs.existsSync(path.join(debugDir, `page-${i}-wide.jpg`))
      || fs.existsSync(path.join(debugDir, `page-${i}-original.jpg`));
    if (!usable) missingPages.push(i);
  }
  if (missingPages.length) {
    const detail = missingPages
      .map(i => `  · page ${i}: ${missingReasons[i] || 'illustration unavailable'}`)
      .join('\n');
    throw new Error(
      `[print-pdf] Book ${bookId} ("${book.childName || 'unknown child'}") is NOT ready for print — ` +
      `${missingPages.length} of ${pilotPages} illustrations unavailable.\n` +
      `Missing pages (0-based): ${missingPages.join(', ')}\n${detail}\n` +
      `Nothing was generated and $0.00 was spent. Retry once the book is complete.`
    );
  }

  // Load reference photo and character description for wide spread generation
  const charRef = book.characterReference || {};
  const characterPromptCore = charRef.characterPromptCore ||
    `A young child named ${book.childName || 'the child'} aged ${book.childAge || '5'}, warm storybook illustration style.`;
  let referenceBuffer = null;
  if (book.croppedPhoto && book.croppedPhoto.startsWith('http')) {
    try {
      referenceBuffer = await fetchBuffer(book.croppedPhoto);
      console.log(`[print-pdf] STEP 2.5: reference photo loaded (${(referenceBuffer.length/1024).toFixed(0)}KB)`);
    } catch(e) {
      console.warn(`[print-pdf] STEP 2.5: reference photo failed — ${e.message}`);
    }
  }
  if (!referenceBuffer && pageBuffers[0]) {
    referenceBuffer = pageBuffers[0];
    console.log(`[print-pdf] STEP 2.5: using page-0 as reference fallback`);
  }

  // ── VERIFICATION SUMMARY + run gate ──────────────────────────────────────────
  // Option 2: illustrations come from the digital book — NO paid generation.
  // The only paid step is Real-ESRGAN upscaling (~$0.01/page) in STEP 4.
  const pagesNeedingPrep = [];
  for (let i = 0; i < pilotPages; i++) {
    if (!fs.existsSync(path.join(debugDir, `page-${i}-wide.jpg`))) pagesNeedingPrep.push(i);
  }
  printVerificationSummary(book, referenceBuffer, debugDir, styleLock);
  if (options.dryRun) {
    console.log(`[print-pdf] dryRun: ${pagesNeedingPrep.length} page(s) would be prepared from the digital book ($0.00 generation; upscale ~$${(pilotPages*0.01).toFixed(2)} total on paid run). Re-run with dryRun:false.`);
    return { dryRun: true, outputPath, debugDir, pagesNeedingPrep, costEstimate: 0 };
  }

  // ── STEP 3: Illustration = the digital book's OWN image, smart-cropped to square ──
  // Option 2 (2026-07-23): NO print generation. Pixel-for-pixel identity — exactly the
  // book the customer already saw and approved — at zero AI cost. The digital
  // illustration (portrait 1024×1536) is cropped to a W×W square biased UPWARD
  // (`smartSquareCropUp`), then fed to the unchanged square path (upscale + assemble).
  console.log(`[print-pdf] STEP 3: preparing ${pilotPages} illustration(s) from the digital book...`);
  const wideBuffers = [];

  for (let i = 0; i < pilotPages; i++) {
    const cachedWide = path.join(debugDir, `page-${i}-wide.jpg`);
    if (fs.existsSync(cachedWide)) {
      console.log(`[print-pdf] STEP 3: page ${i} → cached square illustration`);
      wideBuffers.push(fs.readFileSync(cachedWide));
      continue;
    }
    // Digital illustration for THIS page. pageBuffers[i] may be null if a downstream
    // cache existed; fall back to the cached original on disk.
    let digitalPageBuffer = pageBuffers[i] || null;
    if (!digitalPageBuffer) {
      const origPath = path.join(debugDir, `page-${i}-original.jpg`);
      if (fs.existsSync(origPath)) digitalPageBuffer = fs.readFileSync(origPath);
    }
    if (!digitalPageBuffer) {
      console.warn(`[print-pdf] STEP 3: page ${i} — no digital illustration available, skipping`);
      wideBuffers.push(null);
      continue;
    }
    const squareBuf = smartSquareCropUp(digitalPageBuffer, `page-${i}`);
    saveDebug(debugDir, `page-${i}-wide.jpg`, squareBuf);
    wideBuffers.push(squareBuf);
    console.log(`[print-pdf] STEP 3: page ${i} done — square crop, $0.00 ${elapsed(globalStart)}`);
  }
  console.log(`[print-pdf] STEP 3 done ${elapsed(globalStart)}`);

  // ── STEP 4: Upscale illustration portion via Replicate Real-ESRGAN ───────────
  console.log(`[print-pdf] STEP 4: upscaling ${pilotPages} illustration portion(s)...`);
  const upscaledIllusBuffers = [];

  for (let i = 0; i < pilotPages; i++) {
    const cachedUpscaled = path.join(debugDir, `page-${i}-wide-upscaled.png`);
    if (fs.existsSync(cachedUpscaled)) {
      console.log(`[print-pdf] STEP 4: page ${i} → cached upscaled`);
      upscaledIllusBuffers.push(fs.readFileSync(cachedUpscaled));
      continue;
    }
    if (!wideBuffers[i]) { upscaledIllusBuffers.push(null); continue; }

    // Extract illustration portion via content-aware geometry (Fix 2, same as STEP 5)
    const { createCanvas, Image } = require('canvas');
    const { croppedImg, splitX, CROP_H } = await computeSpreadGeometry(wideBuffers[i]);
    const illusRaw = createCanvas(splitX, CROP_H);
    illusRaw.getContext('2d').drawImage(croppedImg, 0, 0, splitX, CROP_H, 0, 0, splitX, CROP_H);
    const illusPng = illusRaw.toBuffer('image/png');
    saveDebug(debugDir, `page-${i}-illus-preupscale.png`, illusPng);

    const upscaled = await upscaleImage(illusPng, `page-${i}`);
    costEstimate += 0.01;

    // Resolution check (defensive — STEP 3 gate already guarantees split ≥ 669px)
    const upProbe = new Image(); upProbe.src = upscaled;
    const minDim = Math.min(upProbe.width, upProbe.height);
    if (minDim < MIN_EFFECTIVE_PX)
      console.warn(`[print-pdf] STEP 4: page ${i} ⚠️ RESOLUTION ${minDim}px < ${MIN_EFFECTIVE_PX}px`);
    // Sharpness check — logged now, threshold calibrated on Ray before hard-enforce
    const sharp = laplacianVariance(upscaled);
    if (sharp < SHARPNESS_MIN)
      console.warn(`[print-pdf] STEP 4: page ${i} ⚠️ SHARPNESS low — Laplacian var ${sharp.toFixed(1)} < ${SHARPNESS_MIN}`);
    else
      console.log(`[print-pdf] STEP 4: page ${i} sharpness=${sharp.toFixed(1)}, upscaled ${upProbe.width}×${upProbe.height}`);

    saveDebug(debugDir, `page-${i}-wide-upscaled.png`, upscaled);
    upscaledIllusBuffers.push(upscaled);
    console.log(`[print-pdf] STEP 4: page ${i} upscaled (+$0.01 ~$${costEstimate.toFixed(2)}) ${elapsed(globalStart)}`);
  }
  console.log(`[print-pdf] STEP 4 done ${elapsed(globalStart)}`);

  // ── STEP 5: Build spreads (illustration + text page) ─────────────────────────
  console.log(`[print-pdf] STEP 5: building ${pilotPages} spread(s)...`);
  const storyPages = book.generatedBook?.pages || [];
  const spreads    = [];

  for (let i = 0; i < pilotPages; i++) {
    // Safety net — the STEP 2 readiness gate should already have caught this.
    if (!wideBuffers[i]) throw new Error(
      `[print-pdf] STEP 5: page ${i} of book ${bookId} ("${book.childName || 'unknown child'}") has no square ` +
      `illustration to assemble — ${missingReasons[i] || 'the source illustration could not be prepared in STEP 3'}`
    );
    const { loadImage } = require('canvas');
    const PX = PRINT_PX;

    // Content-aware geometry (identical deterministic call as STEP 4)
    const { croppedImg, splitX, CROP_H } = await computeSpreadGeometry(wideBuffers[i]);

    // Illustration page — Option A: uniform-scale cover-crop to square, ZERO stretch.
    // Any excess is cropped from the spine (right) side only, never the character.
    let illusSrc;
    if (upscaledIllusBuffers[i]) {
      illusSrc = await loadImage(upscaledIllusBuffers[i]);   // full upscaled region (splitX×CROP_H ×4)
    } else {
      // Fallback (no upscale): extract raw illustration region at native res
      const { createCanvas } = require('canvas');
      const illusC = createCanvas(splitX, CROP_H);
      illusC.getContext('2d').drawImage(croppedImg, 0, 0, splitX, CROP_H, 0, 0, splitX, CROP_H);
      illusSrc = await loadImage(illusC.toBuffer('image/png'));
    }
    const illusCanvas = coverCropToSquare(illusSrc, PX);      // uniform scale + spine-side crop
    let illustrationJpeg = illusCanvas.toBuffer('image/jpeg', { quality: 0.9 });
    illustrationJpeg = printBrighten(illustrationJpeg);       // print compensation ~5%

    // Text background + overlay (brighten bg only, NEVER the dark text overlay)
    let textBgJpeg      = buildWideTextBgJpeg(croppedImg, splitX);
    textBgJpeg          = printBrighten(textBgJpeg);
    const storyText     = storyPages[i]?.text || '';
    const textOverlayPng = storyText ? renderHebrewTextPng(storyText, null) : null;

    // FINAL composited text page = textbg (light vignette) + dark-brown text merged,
    // exactly as it prints. Saved to debug so review sees the real page, not the
    // transparent overlay layer. Same draw order as the PDF assembly below.
    let textPageJpeg = textBgJpeg;
    if (textOverlayPng) {
      const { createCanvas, loadImage } = require('canvas');
      const bgImg  = await loadImage(textBgJpeg);
      const ovImg  = await loadImage(textOverlayPng);
      const comp   = createCanvas(PX, PX);
      const cctx   = comp.getContext('2d');
      cctx.drawImage(bgImg, 0, 0, PX, PX);
      cctx.drawImage(ovImg, 0, 0, PX, PX);
      textPageJpeg = comp.toBuffer('image/jpeg', { quality: 0.9 });
    }

    saveDebug(debugDir, `page-${i}-illustration.jpg`, illustrationJpeg);
    saveDebug(debugDir, `page-${i}-textbg.jpg`, textBgJpeg);
    if (textOverlayPng) saveDebug(debugDir, `page-${i}-text-overlay.png`, textOverlayPng);
    saveDebug(debugDir, `page-${i}-text-page.jpg`, textPageJpeg);

    spreads.push({ illustrationJpeg, textBgJpeg, textOverlayPng });
    console.log(`[print-pdf] STEP 5: spread ${i} built ${elapsed(globalStart)}`);
  }
  console.log(`[print-pdf] STEP 5 done ${elapsed(globalStart)}`);

  // ── STEP 6: Build PDF ───────────────────────────────────────────────────────
  // Structure: 1 dedication + N×2 spreads + stars + 1 closing + 1 back = 2N+3+stars
  const fixedPages    = 1 + pilotPages * 2 + 2; // dedication + spreads×2 + closing + back
  const starsNeeded   = ((4 - (fixedPages % 4)) % 4);
  const expectedPages = fixedPages + starsNeeded;
  console.log(`[print-pdf] STEP 6: building PDF — ${expectedPages} pages (${pilotPages} spreads, ${starsNeeded} star pages)...`);

  const logo = await loadLogoPng();
  await buildPDF(book, spreads, outputPath, logo);

  const totalSec = ((Date.now() - globalStart) / 1000).toFixed(1);
  console.log(`[print-pdf] ── DONE ── ${totalSec}s — estimated cost: ~$${costEstimate.toFixed(2)}`);
  console.log(`[print-pdf] Output PDF:  ${outputPath}`);
  console.log(`[print-pdf] Debug files: ${debugDir}`);

  return { outputPath, debugDir, costEstimate, totalSeconds: parseFloat(totalSec), pages: expectedPages };
}

// ─── Cover PDF ────────────────────────────────────────────────────────────────

/**
 * generateCoverPDF(bookId, { subtitleOverride })
 *
 * Produces a TWO-page PDF, each page at book trim size + bleed (square,
 * 226.4×226.4mm — identical to the content pages). NO spine, NO wrap/spread.
 * Bookpod assembles the spine themselves from these two page-sized files.
 *
 *   Page 1 = FRONT (חזית) — child photo (outpainted to square) + title text.
 *   Page 2 = BACK  (גב)   — cream, logo, dedication.
 *
 * RTL direction: in a Hebrew book the spine sits on the RIGHT of the front
 * cover, so front is the LEFT panel of any flat spread. We do NOT build a flat
 * spread — front and back are separate pages, page-1 first, page-2 second.
 * The old [back|spine|front] flat layout (front on the RIGHT, LTR order) was
 * the likely cause of Ariel's flip and has been removed.
 *
 * Front uses one AI outpaint (cover → square, centered, heads preserved),
 * cached in debug. Output: print-pdf/output/{bookId}-cover.pdf
 */
async function generateCoverPDF(bookId, options = {}) {
  const subtitleOverride = options.subtitleOverride ?? null;
  const globalStart = Date.now();

  const COVER_MM = PAGE_MM;              // 226.4mm — trim 220 + bleed 3.2 each side
  const COVER_PT = COVER_MM * MM_TO_PT;
  const COVER_PX = PRINT_PX;             // ~2674px square at 300 DPI (same as pages)
  const mm2px    = COVER_PX / COVER_MM;
  const bleedPx  = Math.round(BLEED_MM * mm2px);

  console.log(`[cover-pdf] ── START ── bookId: ${bookId}`);
  console.log(`[cover-pdf] 2 pages, each ${COVER_MM.toFixed(1)}×${COVER_MM.toFixed(1)}mm (${COVER_PX}×${COVER_PX}px at 300DPI), no spine`);

  const debugDir = path.join(__dirname, 'debug', bookId);
  fs.mkdirSync(debugDir,   { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // ── Fetch book ──────────────────────────────────────────────────────────────
  const book  = await fetchBook(bookId);
  const title = subtitleOverride ?? (book.generatedBook?.title || '');
  console.log(`[cover-pdf] child: ${book.childName}, title: ${title}`);

  // ── Load cover image ────────────────────────────────────────────────────────
  if (!book.coverImage) throw new Error('[cover-pdf] book has no coverImage in Supabase');
  const coverBuf = await toBuffer(book.coverImage);
  if (!coverBuf)  throw new Error('[cover-pdf] failed to load coverImage');
  saveDebug(debugDir, 'cover-source.jpg', coverBuf);
  console.log(`[cover-pdf] cover image loaded (${(coverBuf.length / 1024).toFixed(0)}KB)`);

  // ── Load logo ────────────────────────────────────────────────────────────────
  const logo = await loadLogoPng();

  const { createCanvas, Image } = require('canvas');

  // ═══ PAGE 1 — FRONT (child photo + title), full-bleed square ═════════════════
  const frontCanvas = createCanvas(COVER_PX, COVER_PX);
  const fctx        = frontCanvas.getContext('2d');
  {
    // Load or generate a 1:1 square via outpainting (never center-crop — preserves heads)
    const cachedSquarePath = path.join(debugDir, 'cover-square.png');
    let squareBuf;
    if (fs.existsSync(cachedSquarePath)) {
      squareBuf = fs.readFileSync(cachedSquarePath);
      console.log('[cover-pdf] cover-square.png loaded from cache');
    } else {
      console.log('[cover-pdf] outpainting cover to square, centered (~$0.04)…');
      const openai = getOpenAI();
      squareBuf = await outpaintToSquareCentered(openai, coverBuf, 'cover');
      saveDebug(debugDir, 'cover-square.png', squareBuf);
      console.log('[cover-pdf] cover-square.png saved to debug');
    }

    const img = new Image();
    img.src   = squareBuf;

    // Title banner across the top; the illustration fills the rest full-bleed.
    // The banner gives the title a clean home AND lets us crop the bottom of the
    // source clean off the page — that bottom strip is where the AI rendered a
    // gibberish "book spine" of nonsense letters. Ray himself is untouched.
    const BAND_H = Math.round(COVER_PX * 0.18);

    // Illustration: source window drops the top 4% (empty sky, hidden behind the
    // banner anyway) and the bottom 14% (the gibberish book). Uniform scale — the
    // source window and destination share the same aspect, so nothing stretches.
    // Ray stays whole: head just under the banner, feet near the bottom edge.
    const srcY = Math.round(img.height * 0.04);
    const srcH = Math.round(img.height * 0.82);
    fctx.drawImage(img, 0, srcY, img.width, srcH, 0, BAND_H, COVER_PX, COVER_PX - BAND_H);

    // ── Top title banner — tone sampled from the cover's own sky for continuity ──
    const skyStrip = fctx.getImageData(0, BAND_H + 2, COVER_PX, 4).data;
    let tr = 0, tg = 0, tb = 0, tn = 0;
    for (let i = 0; i < skyStrip.length; i += 4) { tr += skyStrip[i]; tg += skyStrip[i+1]; tb += skyStrip[i+2]; tn++; }
    tr = Math.round(tr/tn * 0.72); tg = Math.round(tg/tn * 0.72); tb = Math.round(tb/tn * 0.72);
    const bandGrad = fctx.createLinearGradient(0, 0, 0, BAND_H);
    bandGrad.addColorStop(0, `rgb(${Math.round(tr*0.7)},${Math.round(tg*0.7)},${Math.round(tb*0.7)})`);
    bandGrad.addColorStop(1, `rgb(${tr},${tg},${tb})`);
    fctx.fillStyle = bandGrad;
    fctx.fillRect(0, 0, COVER_PX, BAND_H);
    // gold hairline where banner meets illustration
    fctx.strokeStyle = '#c8a84b';
    fctx.lineWidth   = Math.round(COVER_PX * 0.0035);
    fctx.beginPath();
    fctx.moveTo(0, BAND_H); fctx.lineTo(COVER_PX, BAND_H); fctx.stroke();

    // Text colour follows banner luminance (robust for light-sky books too)
    const bandLum   = 0.299*tr + 0.587*tg + 0.114*tb;
    const onBand    = bandLum < 140 ? '#f6efdd' : '#2a1608';
    const onBandSub = bandLum < 140 ? 'rgba(246,239,221,0.9)' : 'rgba(42,22,8,0.85)';
    const bandShadow = bandLum < 140 ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.5)';

    // ── Title text in the banner (Frank Ruhl Libre, RTL, centred) ────────────────
    const centreX = COVER_PX / 2;
    fctx.textAlign   = 'center';
    fctx.direction   = 'rtl';

    if (book.childName) {
      const nameFs = Math.round(COVER_PX * 0.058);
      fctx.shadowColor = bandShadow;
      fctx.shadowBlur  = Math.round(COVER_PX * 0.006);
      fctx.font        = `700 ${nameFs}px FrankRuhlLibre, "Arial Hebrew", sans-serif`;
      fctx.fillStyle   = onBand;
      const nameY = Math.round(BAND_H * 0.52);
      fctx.fillText(book.childName, centreX, nameY);

      // gold rule under the name
      fctx.shadowBlur  = 0;
      fctx.strokeStyle = '#c8a84b';
      fctx.lineWidth   = Math.round(COVER_PX * 0.0025);
      const ruleW = COVER_PX * 0.26;
      const ruleY = nameY + Math.round(nameFs * 0.35);
      fctx.beginPath();
      fctx.moveTo(centreX - ruleW/2, ruleY); fctx.lineTo(centreX + ruleW/2, ruleY); fctx.stroke();

      if (title) {
        const titleFs = Math.round(COVER_PX * 0.030);
        fctx.shadowColor = bandShadow;
        fctx.shadowBlur  = Math.round(COVER_PX * 0.005);
        fctx.font        = `400 ${titleFs}px FrankRuhlLibre, "Arial Hebrew", sans-serif`;
        fctx.fillStyle   = onBandSub;
        fctx.fillText(title, centreX, ruleY + Math.round(titleFs * 1.5));
      }
    }
    fctx.shadowBlur = 0;
  }
  const frontJpeg = frontCanvas.toBuffer('image/jpeg', { quality: 0.90 });
  saveDebug(debugDir, 'cover-front.jpg', frontJpeg);

  // ═══ PAGE 2 — BACK (cream, logo, dedication), full-bleed square ══════════════
  const backCanvas = createCanvas(COVER_PX, COVER_PX);
  const bctx       = backCanvas.getContext('2d');
  {
    bctx.fillStyle = '#fdf8f0';
    bctx.fillRect(0, 0, COVER_PX, COVER_PX);

    // Double gold border (inside the bleed zone, safe margins)
    bctx.strokeStyle = '#c8a84b';
    bctx.lineWidth   = Math.round(1.2 * mm2px);
    const b1 = 10 * mm2px;
    bctx.strokeRect(b1, b1, COVER_PX - b1 * 2, COVER_PX - b1 * 2);
    bctx.lineWidth = Math.round(0.5 * mm2px);
    const b2 = 14 * mm2px;
    bctx.strokeRect(b2, b2, COVER_PX - b2 * 2, COVER_PX - b2 * 2);

    // Logo — centred, upper third
    if (logo) {
      const logoW   = Math.round(COVER_PX * 0.32);
      const logoH   = Math.round(logo.h * (logoW / logo.w));
      const logoX   = (COVER_PX - logoW) / 2;
      const logoY   = COVER_PX * 0.30 - logoH / 2;
      const logoImg = new Image();
      logoImg.src   = logo.buffer;
      bctx.drawImage(logoImg, logoX, logoY, logoW, logoH);

      // Thin gold rule below logo
      const ruleY = logoY + logoH + 8 * mm2px;
      bctx.strokeStyle = '#c8a84b';
      bctx.lineWidth   = Math.round(0.7 * mm2px);
      bctx.beginPath();
      bctx.moveTo(COVER_PX * 0.35, ruleY);
      bctx.lineTo(COVER_PX * 0.65, ruleY);
      bctx.stroke();
    }

    // "ספר זה נכתב במיוחד עבור [שם]" — Hebrew canvas text, centred
    const centreX = COVER_PX / 2;
    bctx.textAlign  = 'center';
    bctx.direction  = 'rtl';
    bctx.shadowBlur = 0;

    const dedicFsPx = Math.round(COVER_PX * 0.042);
    bctx.fillStyle = '#2c1a0e';
    bctx.font = `400 ${dedicFsPx}px Arial Unicode MS, Arial, sans-serif`;
    bctx.fillText('ספר זה נכתב במיוחד עבור', centreX, COVER_PX * 0.55);
    if (book.childName) {
      bctx.font = `600 ${Math.round(dedicFsPx * 1.15)}px Arial Unicode MS, Arial, sans-serif`;
      bctx.fillText(book.childName, centreX, COVER_PX * 0.55 + dedicFsPx * 1.6);
    }

    // lifebooksil.com — small, near bottom
    const domainFsPx = Math.round(COVER_PX * 0.026);
    bctx.font      = `400 ${domainFsPx}px Arial Unicode MS, Arial, sans-serif`;
    bctx.fillStyle = '#a08060';
    bctx.fillText('lifebooksil.com', centreX, COVER_PX * 0.70);
  }
  const backJpeg = backCanvas.toBuffer('image/jpeg', { quality: 0.90 });
  saveDebug(debugDir, 'cover-back.jpg', backJpeg);

  // ── Build TWO-page PDF (page 1 = front, page 2 = back) ───────────────────────
  const outputPath = path.join(OUTPUT_DIR, `${bookId}-cover.pdf`);
  const doc = new PDFDocument({
    size:          [COVER_PT, COVER_PT],
    margin:        0,
    autoFirstPage: true,
    info: {
      Title:   `${title} — Cover`,
      Author:  'Lifebook AI',
      Creator: 'Lifebook print-pdf-generator cover',
    },
  });

  const writeStream = fs.createWriteStream(outputPath);
  doc.pipe(writeStream);
  doc.image(frontJpeg, 0, 0, { width: COVER_PT, height: COVER_PT });   // page 1 — front
  doc.addPage({ size: [COVER_PT, COVER_PT], margin: 0 });
  doc.image(backJpeg,  0, 0, { width: COVER_PT, height: COVER_PT });   // page 2 — back
  doc.end();
  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error',  reject);
  });

  const fileSizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
  const totalSec   = ((Date.now() - globalStart) / 1000).toFixed(1);
  console.log(`[cover-pdf] ── DONE ── ${totalSec}s | 2 pages | ${COVER_MM.toFixed(1)}×${COVER_MM.toFixed(1)}mm each | ${fileSizeMB}MB`);
  console.log(`[cover-pdf] Output: ${outputPath}`);

  return {
    outputPath, pages: 2,
    widthMM: COVER_MM, heightMM: COVER_MM,
    frontDebug: path.join(debugDir, 'cover-front.jpg'),
    backDebug:  path.join(debugDir, 'cover-back.jpg'),
    fileSizeMB: parseFloat(fileSizeMB), totalSeconds: parseFloat(totalSec),
  };
}

module.exports = { generatePrintPDF, generateCoverPDF,
  __test: { computeSpreadGeometry, computeCharacterBBox } };

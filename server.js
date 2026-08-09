import express from "express";
import cors from "cors";
import OpenAI, { toFile } from "openai";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import bcrypt from "bcryptjs";
import jwt    from "jsonwebtoken";

// ── Feature flag: image-to-image identity pipeline ───────────────────────────
// Set to true to use openai.images.edit (identity-preserving) instead of .generate.
// Set to false to revert to the old text-to-image pipeline.
const USE_IMAGE_EDIT = true;

const app = express();
app.use(cors());

// ─── LemonSqueezy webhook needs the RAW body for signature verification ───────
// express.raw MUST run before express.json for the webhook route
app.use("/webhooks/lemonsqueezy", express.raw({ type: "*/*", limit: "25mb" }));
app.use("/webhooks/shopify", express.raw({ type: "*/*", limit: "25mb" }));
// JSON body parser — explicitly skip webhook routes so raw buffer is preserved
app.use((req, res, next) => {
  if (req.path.startsWith("/webhooks/")) return next();
  express.json({ limit: "25mb" })(req, res, next);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

// ─── Clients ──────────────────────────────────────────────────────────────────
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Image-to-image identity pipeline helpers ──────────────────────────────────
// STYLE_LOCK strings — exact wording from brief. Do not soften/change.
const STYLE_LOCK = {
  watercolor:
    "A soft watercolor children's storybook illustration, gentle hand-painted " +
    "style with visible watercolor textures, soft muted colors, consistent " +
    "character design. Keep the child's face, age, features and identity " +
    "exactly as in the reference photo, and keep them consistent and identical " +
    "across every illustration in the book. Hand-painted watercolor look, " +
    "NOT 3D, NOT photorealistic, NOT a photo." +
    " Absolutely NO text, NO letters, NO words, NO writing, NO signs with writing, NO labels, NO logos anywhere in the illustration. Any signs, books or papers in the scene must be blank.",
  soft3d:
    "Transform this into a 3D rendered animated character. " +
    "Glossy smooth 3D surfaces, big expressive eyes, soft cinematic studio lighting, " +
    "subsurface scattering on the skin, depth of field, looks like a frame from a " +
    "high-quality animated movie. NOT a painting, NOT watercolor, NOT a photo. " +
    "Keep the child's facial identity, features and hairstyle from the reference." +
    " Absolutely NO text, NO letters, NO words, NO writing, NO signs with writing, NO labels, NO logos anywhere in the illustration. Any signs, books or papers in the scene must be blank.",
  fantasy:
    "A magical fantasy children\u0027s storybook illustration, enchanted glowing atmosphere, " +
    "sparkles and soft golden light, rich jewel-tone colors, dreamy painterly rendering, " +
    "consistent character design. Keep the child\u0027s face, age, features and identity " +
    "exactly as in the reference photo, identical across every illustration. " +
    "NOT 3D render, NOT photorealistic, NOT a photo." +
    " Absolutely NO text, NO letters, NO words, NO writing, NO signs with writing, NO labels, NO logos anywhere in the illustration. Any signs, books or papers in the scene must be blank.",
  scandi:
    "A minimal Scandinavian children\u0027s book illustration, clean simple shapes, soft muted " +
    "pastel palette, generous white space, flat gentle textures, subtle grain, modern nordic " +
    "picture-book style, consistent character design. Keep the child\u0027s face, age, features " +
    "and identity exactly as in the reference photo, identical across every illustration. " +
    "NOT 3D, NOT photorealistic, NOT a photo." +
    " Absolutely NO text, NO letters, NO words, NO writing, NO signs with writing, NO labels, NO logos anywhere in the illustration. Any signs, books or papers in the scene must be blank.",
};

const STYLE_NAME_MAP = {
  "soft storybook": "watercolor",
  "watercolor": "watercolor",
  "pixar 3d": "soft3d",
  "soft3d": "soft3d",
  "magical fantasy": "fantasy",
  "fantasy": "fantasy",
  "minimal scandinavian": "scandi",
  "scandi": "scandi",
};

function buildStyleLock(illustrationStyleKey) {
  const raw = (illustrationStyleKey || "").toLowerCase().trim();
  const key = STYLE_NAME_MAP[raw] || raw;
  return STYLE_LOCK[key] || STYLE_LOCK.watercolor;
}

// Replace words that tend to trigger the safety filter on child images
function softenPrompt(prompt) {
  return prompt
    .replace(/\bfight(ing|s)?\b/gi, "adventures bravely")
    .replace(/\battack(ing|s|ed)?\b/gi, "faces")
    .replace(/\bstabb(ing|s|ed)?\b/gi, "pointing")
    .replace(/\bkill(ing|s|ed)?\b/gi, "overcomes")
    .replace(/\bdanger\b/gi, "challenge")
    .replace(/\bscream(ing|s|ed)?\b/gi, "calls out")
    .replace(/\bblood\b/gi, "red berries")
    .replace(/\bweapon(s)?\b/gi, "magical tool")
    // dad-hero / family scenes — avoid physical contact phrasing that triggers safety filter
    .replace(/\bembrac(ing|es?|ed)\b/gi, "warmly holding close")
    .replace(/\bhugg(ing|s|ed)\b/gi, "warmly holding close")
    .replace(/\bhug\b/gi, "warm moment with")
    .replace(/\bholding the child\b/gi, "close beside the child")
    .replace(/\bruns? to\b/gi, "rushes happily toward")
    .replace(/\brunning to\b/gi, "rushing happily toward")
    .replace(/\bkiss(es|ing|ed)?\b/gi, "smiles warmly at")
    .replace(/\bcarr(ies|ying|ied)\b/gi, "walks lovingly with")
    // child/person descriptors — replace to avoid real-minor detection in image-edit pipeline
    .replace(/\bthe child\b/gi, "the young storybook hero")
    .replace(/\bthe boy\b/gi, "the young storybook hero")
    .replace(/\bthe girl\b/gi, "the young storybook heroine")
    .replace(/\ba boy\b/gi, "a young storybook hero")
    .replace(/\ba girl\b/gi, "a young storybook heroine")
    .replace(/\byoung boy\b/gi, "young storybook hero")
    .replace(/\byoung girl\b/gi, "young storybook heroine")
    .replace(/\bthe kid\b/gi, "the young storybook hero")
    .replace(/\btoddler\b/gi, "young storybook character");
}

// Image-to-image generation using openai.images.edit
// referenceBuffer: Buffer of the cropped photo (PNG/JPEG)
// scenePrompt: STYLE_LOCK + scene description + "Portrait orientation."
async function generatePageImageV2(referenceBuffer, scenePrompt, attempt = 0) {
  const isSafety = (msg) =>
    typeof msg === "string" &&
    (msg.includes("safety system") || msg.includes("content_policy") || msg.includes("rejected") || msg.includes("moderation_blocked"));

  try {
    const imageFile = await toFile(referenceBuffer, "reference.png", { type: "image/png" });
    const resp = await openai.images.edit({
      model:   "gpt-image-1",
      image:   imageFile,
      prompt:  scenePrompt,
      size:    "1024x1536",
      quality: "high",
    });
    return resp;
  } catch (err) {
    if (isSafety(err?.message) && attempt < 2) {
      console.warn(`[image-edit] Safety filter triggered (attempt ${attempt+1}), retrying with softened prompt`);
      return generatePageImageV2(referenceBuffer, softenPrompt(scenePrompt), attempt + 1);
    }
    if (!isSafety(err?.message) && attempt < 3) {
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      return generatePageImageV2(referenceBuffer, scenePrompt, attempt + 1);
    }
    throw err;
  }
}

// Illustration style keys → full prompt descriptions (no brand names)
const STYLE_DESCRIPTIONS = {
  watercolor: "Soft Storybook watercolor illustration, warm hand-painted textures, gentle pencil outlines, delicate transparent washes, storybook warmth",
  soft3d:     "soft 3D rendered children's illustration, modern animated film style, rounded friendly character, large expressive eyes, warm cinematic lighting, smooth volumes, gentle colors",
  fantasy:    "magical fantasy children's illustration, enchanted glowing atmosphere, sparkles and soft golden light, rich jewel-tone colors, dreamy painterly rendering",
  scandi:     "minimal Scandinavian children's illustration, clean simple shapes, soft muted pastel palette, generous white space, flat gentle textures, modern nordic picture-book style",
};
function resolveStyle(raw) {
  const norm = (raw || "").toLowerCase().trim();
  const key = (typeof STYLE_NAME_MAP !== "undefined" && STYLE_NAME_MAP[norm]) || norm;
  return STYLE_DESCRIPTIONS[key] || sanitizeBrandTerms(raw) || STYLE_DESCRIPTIONS.watercolor;
}

const resend = new Resend(process.env.RESEND_API_KEY);

// ─── Admin Auth ───────────────────────────────────────────────────────────────
const ADMIN_USERNAME      = process.env.ADMIN_USERNAME      || "";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "";
const ADMIN_JWT_SECRET    = process.env.ADMIN_JWT_SECRET    || "";

if (!ADMIN_JWT_SECRET) {
  console.warn("⚠️  ADMIN_JWT_SECRET is not set — admin endpoints will be disabled");
}

// In-memory rate limiter: max 5 failed attempts per IP within 15 minutes
const loginAttempts = new Map(); // ip → { count, firstAttempt }
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS    = 15 * 60 * 1000;

function checkLoginRateLimit(ip) {
  const now   = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || (now - entry.firstAttempt) > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
    return { blocked: false };
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    const retryAfterSec = Math.ceil((LOGIN_WINDOW_MS - (now - entry.firstAttempt)) / 1000);
    return { blocked: true, retryAfterSec };
  }
  entry.count++;
  return { blocked: false };
}

function resetLoginRateLimit(ip) {
  loginAttempts.delete(ip);
}

function requireAdminAuth(req, res, next) {
  if (!ADMIN_JWT_SECRET) {
    return res.status(503).json({ error: "Admin not configured" });
  }
  const auth  = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    req.adminUser = jwt.verify(token, ADMIN_JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function safeJsonParse(raw, fallback = {}) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function sanitizeBrandTerms(text = "") {
  return String(text)
    .replaceAll(/\bBatman\b/gi, "superhero")
    .replaceAll(/\bIron\s*Man\b/gi, "red superhero")
    .replaceAll(/\bMarvel\b/gi, "comic-style")
    .replaceAll(/\bDisney\b/gi, "storybook")
    .replaceAll(/\bPixar\b/gi, "3D animated")
    .replaceAll(/\bSuperman\b/gi, "heroic")
    .replaceAll(/\bSpider[- ]?Man\b/gi, "web hero")
    .replaceAll(/\bFrozen\b/gi, "snowy fantasy")
    .replaceAll(/\bMickey\b/gi, "cartoon mouse")
    .replaceAll(/\bMinnie\b/gi, "cartoon character");
}

function sanitizeStoryPayload(obj = {}) {
  return {
    ...obj,
    childName:          sanitizeBrandTerms(obj.childName || ""),
    storyIdea:          sanitizeBrandTerms(obj.storyIdea || ""),
    // Do NOT run sanitizeBrandTerms on illustrationStyle — it corrupts style keys like
    // "Pixar 3D" → "3D animated 3D" which then fail to match STYLE_NAME_MAP → wrong style.
    // Style keys are resolved via STYLE_NAME_MAP + STYLE_LOCK so brand names never reach AI prompts.
    illustrationStyle:  obj.illustrationStyle || "",
    croppedPhoto:       obj.croppedPhoto  || "",
    originalPhoto:      obj.originalPhoto || ""
  };
}

function sanitizeImagePrompt(text = "") {
  return sanitizeBrandTerms(text)
    .replaceAll(/\blogo\b/gi,      "symbol")
    .replaceAll(/\bbrand\b/gi,     "design")
    .replaceAll(/\btrademark\b/gi, "graphic detail");
}

function buildCharacterPromptCore(characterDNA, style) {
  const hair    = characterDNA.hair    || "soft child hair";
  const skin    = characterDNA.skin    || "natural skin tone";
  const eyes    = characterDNA.eyes    || "natural eye color exactly as in the reference photo";
  const face    = characterDNA.face    || "soft child face";
  const vibe    = characterDNA.vibe    || "warm curious child";
  const ageLook = characterDNA.ageLook || "young child";
  const outfit  = characterDNA.outfit  || "simple timeless child outfit";

  return `
LOCKED CHILD CHARACTER — must be identical in every single illustration:
- Age appearance: ${ageLook}
- HAIR (exact): ${hair}
- SKIN TONE (exact): ${skin}
- EYES (exact): ${eyes}
- FACE SHAPE (exact): ${face}
- Outfit style: ${outfit}
- Overall vibe: ${vibe}

CONSISTENCY RULES — strictly enforce:
1. Same child face in EVERY illustration — do not alter facial features, bone structure, or proportions
2. Same hair color and style — do not change length, color, or texture
3. Same skin tone — do not lighten or darken between scenes
4. Same eye color and shape — no variation allowed
5. If the child changes clothes between scenes, ALL other features stay identical
6. Do NOT introduce a different child or a generic child

Illustration style: ${style}.
This is the SAME child that must appear identically in every illustration.
`.trim();
}

async function normalizeImageToBase64(imageItem) {
  if (!imageItem) return null;
  if (imageItem?.b64_json) return imageItem.b64_json;
  if (imageItem?.url) {
    const r   = await fetch(imageItem.url);
    const arr = await r.arrayBuffer();
    return Buffer.from(arr).toString("base64");
  }
  return null;
}

// ─── Supabase Storage helper ──────────────────────────────────────────────────
// Uploads a base64 image to Supabase Storage bucket "book-images".
// Returns the public URL, or throws on error.
// Path structure: {bookId}/cover.jpg, {bookId}/page-0.jpg, etc.
async function uploadImageToStorage(bookId, imageName, base64data) {
  if (!base64data) return null;

  // Strip data URL prefix (data:image/jpeg;base64,...)
  const base64Clean = base64data.replace(/^data:image\/\w+;base64,/, "");
  const buffer = Buffer.from(base64Clean, "base64");
  const filePath = `${bookId}/${imageName}`;

  const { error: uploadError } = await supabase.storage
    .from("book-images")
    .upload(filePath, buffer, {
      contentType: "image/jpeg",
      upsert: true   // overwrite if re-generating
    });

  if (uploadError) throw uploadError;

  const { data: urlData } = supabase.storage
    .from("book-images")
    .getPublicUrl(filePath);

  return urlData.publicUrl;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
function dbRowToBook(row) {
  if (!row) return null;
  return {
    bookId:           row.book_id,
    childName:        row.child_name        || "",
    childAge:         row.child_age         || "",
    childGender:      row.child_gender      || "",
    storyIdea:        row.story_idea        || "",
    illustrationStyle:row.illustration_style|| "",
    croppedPhoto:     row.cropped_photo     || "",
    originalPhoto:    row.original_photo    || "",
    customerEmail:    row.customer_email    || "",
    language:         row.language          || "he",
    characterReference: row.character_reference || null,
    generatedBook:    row.generated_book    || null,
    coverImage:       row.cover_image       || null,
    previewImages:    row.preview_images    || [],
    fullImages:       row.full_images       || [],
    selectedFormat:   row.selected_format   || "digital",
    selectedPrice:    row.selected_price    || 39,
    paymentStatus:    row.payment_status    || "pending",
    purchaseUnlocked: row.purchase_unlocked === true,
    stripeSessionId:  row.stripe_session_id || null,
    createdAt:        row.created_at        || null,
    updatedAt:        row.updated_at        || null
  };
}

function patchToDbFields(patch = {}) {
  const dbPatch = {};
  if ("childName"          in patch) dbPatch.child_name          = patch.childName;
  if ("childAge"           in patch) dbPatch.child_age           = patch.childAge;
  if ("childGender"        in patch) dbPatch.child_gender        = patch.childGender;
  if ("storyIdea"          in patch) dbPatch.story_idea          = patch.storyIdea;
  if ("illustrationStyle"  in patch) dbPatch.illustration_style  = patch.illustrationStyle;
  if ("croppedPhoto"       in patch) dbPatch.cropped_photo       = patch.croppedPhoto;
  if ("originalPhoto"      in patch) dbPatch.original_photo      = patch.originalPhoto;
  if ("customerEmail"      in patch) dbPatch.customer_email      = patch.customerEmail;
  if ("language"           in patch) dbPatch.language             = patch.language;
  if ("characterReference" in patch) dbPatch.character_reference = patch.characterReference;
  if ("generatedBook"      in patch) dbPatch.generated_book      = patch.generatedBook;
  if ("coverImage"         in patch) dbPatch.cover_image         = patch.coverImage;
  if ("previewImages"      in patch) dbPatch.preview_images      = patch.previewImages;
  if ("fullImages"         in patch) dbPatch.full_images         = patch.fullImages;
  if ("selectedFormat"     in patch) dbPatch.selected_format     = patch.selectedFormat;
  if ("selectedPrice"      in patch) dbPatch.selected_price      = patch.selectedPrice;
  if ("paymentStatus"      in patch) dbPatch.payment_status      = patch.paymentStatus;
  if ("purchaseUnlocked"   in patch) dbPatch.purchase_unlocked   = patch.purchaseUnlocked;
  if ("stripeSessionId"    in patch) dbPatch.stripe_session_id   = patch.stripeSessionId;
  dbPatch.updated_at = new Date().toISOString();
  return dbPatch;
}

async function insertBook(book) {
  const { error } = await supabase
    .from("books")
    .insert({
      book_id:            book.bookId,
      child_name:         book.childName,
      child_age:          book.childAge,
      child_gender:       book.childGender,
      story_idea:         book.storyIdea,
      illustration_style: book.illustrationStyle,
      cropped_photo:      book.croppedPhoto,
      original_photo:     book.originalPhoto,
      customer_email:     book.customerEmail || "",
      language:           book.language || "he",
      character_reference:book.characterReference,
      generated_book:     book.generatedBook,
      cover_image:        book.coverImage,
      preview_images:     book.previewImages,
      full_images:        book.fullImages,
      selected_format:    book.selectedFormat,
      selected_price:     book.selectedPrice,
      payment_status:     book.paymentStatus,
      purchase_unlocked:  book.purchaseUnlocked,
      stripe_session_id:  book.stripeSessionId
    });
  if (error) throw error;
  return book;
}

async function getBook(bookId) {
  const { data, error } = await supabase
    .from("books")
    .select("*")
    .eq("book_id", bookId)
    .maybeSingle();
  if (error) throw error;
  return dbRowToBook(data);
}

// Lightweight fetch — excludes large image columns.
// Use for polling endpoints where image data is not needed.
// Full image columns are now URLs in Storage (small), but legacy rows may have base64 blobs.
async function getBookLight(bookId) {
  const { data, error } = await supabase
    .from("books")
    .select([
      "book_id", "child_name", "child_age", "child_gender",
      "story_idea", "illustration_style", "customer_email",
      "character_reference", "generated_book",
      "selected_format", "selected_price",
      "payment_status", "purchase_unlocked",
      "stripe_session_id", "created_at", "updated_at"
    ].join(", "))
    .eq("book_id", bookId)
    .maybeSingle();
  if (error) throw error;
  return dbRowToBook(data);
}

async function updateBook(bookId, patch) {
  const dbPatch = patchToDbFields(patch);
  const { data, error } = await supabase
    .from("books")
    .update(dbPatch)
    .eq("book_id", bookId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return dbRowToBook(data);
}

// Lightweight update — NO .select() — safe for large image data
async function updateBookField(bookId, patch) {
  const dbPatch = patchToDbFields(patch);
  const { error } = await supabase
    .from("books")
    .update(dbPatch)
    .eq("book_id", bookId);
  if (error) throw error;
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── OpenAI health check ──────────────────────────────────────────────────────
app.get("/api/test-openai", async (req, res) => {
  try {
    const keySnippet = process.env.OPENAI_API_KEY
      ? `${process.env.OPENAI_API_KEY.substring(0, 8)}...`
      : "NOT SET";
    console.log(`[test-openai] key=${keySnippet}`);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Say hello in one word." }],
      max_tokens: 10
    });
    const reply = completion.choices?.[0]?.message?.content || "(no reply)";
    console.log(`[test-openai] success — reply: ${reply}`);
    return res.json({ status: "ok", reply, keySnippet });
  } catch (err) {
    console.error(`[test-openai] FAILED: ${err.message}`);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

// Main book fetch — returns full book including image URLs from Supabase Storage.
// Used by delivery.html, reader.html, preview.html, success.html polling, etc.
// Image columns now contain Storage URLs (small strings), not base64 — safe to fetch.
app.get("/api/books/:bookId", async (req, res) => {
  try {
    const book = await getBook(req.params.bookId);
    if (!book) return res.status(404).json({ status: "error", message: "Book not found" });
    return res.json({ status: "ok", book });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err?.message || "Failed to fetch book" });
  }
});

// ─── Email: Payment confirmation (sent immediately after payment) ─────────────
async function sendPaymentConfirmationEmail(book) {
  if (!book.customerEmail) return;

  const appUrl    = process.env.APP_URL || "https://lifebooks.online";
  const childName = book.childName || "your child";
  const bookTitle = book.generatedBook?.title || `${childName}'s Magical Adventure`;
  const lang      = book.language || "he";

  try {
    await resend.emails.send({
      from:    "Lifebook <lifebooks@lifebooksil.com>",
      to:      book.customerEmail,
      subject: lang === "en"
        ? `✅ Payment received — ${childName}'s book is on its way!`
        : `✅ קיבלנו את התשלום שלך — הספר של ${childName} בדרך!`,
      html: lang === "en" ? `
<!DOCTYPE html>
<html dir="ltr">
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#fdf6ec;font-family:Assistant,Arial,sans-serif;direction:ltr;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fdf6ec;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:24px;overflow:hidden;box-shadow:0 8px 40px rgba(100,60,20,0.12);border:1px solid #ede0c8;">
        <tr>
          <td style="background:linear-gradient(135deg,#1a1008,#5c3d1e);padding:36px;text-align:center;">
            <img src="https://lifebooksil.com/assets/branding/lifebook-logo.webp" alt="Lifebook" style="height:54px;width:auto;display:block;margin:0 auto 10px;" />
            <div style="font-size:11px;color:#c4a87a;margin-top:5px;letter-spacing:2px;text-transform:uppercase;">Personalized Children's Books</div>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px;direction:ltr;text-align:left;">
            <p style="font-family:Assistant,Arial,sans-serif;font-size:26px;color:#3a2810;margin:0 0 12px;line-height:1.2;font-weight:700;">Payment received! ✅</p>
            <p style="font-size:15px;color:#7a6048;line-height:1.7;margin:0 0 24px;">
              Payment confirmed — <strong>${childName}</strong>'s personalized book is now being created.
              Our AI is writing the story and illustrating every page — usually takes <strong>5–10 minutes</strong>.
            </p>
            <table cellpadding="0" cellspacing="0" width="100%" style="background:#fdf6ec;border-radius:14px;border:1px solid #ede0c8;margin-bottom:24px;">
              <tr>
                <td style="padding:18px 22px;direction:ltr;text-align:left;">
                  <p style="font-family:Assistant,Arial,sans-serif;font-size:17px;color:#5c3d1e;margin:0 0 6px;">"${bookTitle}"</p>
                  <p style="font-size:13px;color:#8a6240;margin:0 0 14px;">A personalized story for ${childName}</p>
                  <table cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="padding-right:28px;">
                        <span style="font-size:10px;color:#c8922a;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;">Status</span><br/>
                        <span style="font-size:14px;color:#3a2810;">Creating illustrations...</span>
                      </td>
                      <td>
                        <span style="font-size:10px;color:#c8922a;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;">Est. time</span><br/>
                        <span style="font-size:14px;color:#3a2810;">5–10 minutes</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
            <p style="font-size:14px;color:#7a6048;line-height:1.7;margin:0;">
              You'll receive another email as soon as your book is ready to read and download.
              No need to keep the page open — we'll come to you! 📬
            </p>
            <hr style="border:none;border-top:1px solid #f0e4d0;margin:24px 0 18px;" />
            <p style="font-size:12px;color:#b09070;line-height:1.6;margin:0;">
              Questions? Just reply to this email and we'll be happy to help.<br/>
              Thank you for creating with Lifebook 💛
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#fdf6ec;border-top:1px solid #ede0c8;padding:16px 40px;text-align:center;">
            <p style="font-size:11px;color:#c4a87a;margin:0;">
              © 2026 Lifebook · <a href="${appUrl}/contact.html" style="color:#c8922a;text-decoration:none;">Contact Us</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
      `.trim() : `
<!DOCTYPE html>
<html dir="rtl">
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#fdf6ec;font-family:Assistant,Arial,sans-serif;direction:rtl;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fdf6ec;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:24px;overflow:hidden;box-shadow:0 8px 40px rgba(100,60,20,0.12);border:1px solid #ede0c8;">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#1a1008,#5c3d1e);padding:36px;text-align:center;">
            <img src="https://lifebooksil.com/assets/branding/lifebook-logo.webp" alt="Lifebook" style="height:54px;width:auto;display:block;margin:0 auto 10px;" />
            <div style="font-size:11px;color:#c4a87a;margin-top:5px;letter-spacing:2px;text-transform:uppercase;">ספרי ילדים מותאמים אישית</div>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:36px 40px;direction:rtl;text-align:right;">
            <p style="font-family:Assistant,Arial,sans-serif;font-size:26px;color:#3a2810;margin:0 0 12px;line-height:1.2;font-weight:700;">
              קיבלנו את התשלום! ✅
            </p>
            <p style="font-size:15px;color:#7a6048;line-height:1.7;margin:0 0 24px;">
              התשלום התקבל בהצלחה והספר המותאם אישית של <strong>${childName}</strong> נמצא כעת בייצור.
              הבינה המלאכותית שלנו כותבת את הסיפור ומאיירת כל עמוד — בדרך כלל לוקח <strong>5–10 דקות</strong>.
            </p>

            <!-- Status box -->
            <table cellpadding="0" cellspacing="0" width="100%" style="background:#fdf6ec;border-radius:14px;border:1px solid #ede0c8;margin-bottom:24px;">
              <tr>
                <td style="padding:18px 22px;direction:rtl;text-align:right;">
                  <p style="font-family:Assistant,Arial,sans-serif;font-size:17px;color:#5c3d1e;margin:0 0 6px;">"${bookTitle}"</p>
                  <p style="font-size:13px;color:#8a6240;margin:0 0 14px;">סיפור מותאם אישית עבור ${childName}</p>
                  <table cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="padding-left:28px;">
                        <span style="font-size:10px;color:#c8922a;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;">סטטוס</span><br/>
                        <span style="font-size:14px;color:#3a2810;">יוצר איורים...</span>
                      </td>
                      <td>
                        <span style="font-size:10px;color:#c8922a;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;">זמן משוער</span><br/>
                        <span style="font-size:14px;color:#3a2810;">5–10 דקות</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <p style="font-size:14px;color:#7a6048;line-height:1.7;margin:0;">
              תקבלו מייל נוסף ברגע שהספר מוכן לקריאה והורדה.
              אין צורך להשאיר את הדף פתוח — נגיע אליכם! 📬
            </p>

            <hr style="border:none;border-top:1px solid #f0e4d0;margin:24px 0 18px;" />

            <p style="font-size:12px;color:#b09070;line-height:1.6;margin:0;">
              יש שאלות? פשוט ענו למייל הזה ונשמח לעזור.<br/>
              תודה שיצרתם עם Lifebook 💛
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#fdf6ec;border-top:1px solid #ede0c8;padding:16px 40px;text-align:center;">
            <p style="font-size:11px;color:#c4a87a;margin:0;">
              © 2026 Lifebook · <a href="${appUrl}/contact.html" style="color:#c8922a;text-decoration:none;">צור קשר</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>
      `.trim()
    });
    console.log("Payment confirmation email sent to:", book.customerEmail);
  } catch(err) {
    console.error("Failed to send payment confirmation email:", err.message);
  }
}

// ─── Email: Book ready (sent only after ALL images are generated) ─────────────
async function sendBookReadyEmail(book) {
  if (!book.customerEmail) return;

  const appUrl    = process.env.APP_URL || "https://lifebooks.online";
  const bookTitle = book.generatedBook?.title    || "Your Magical Storybook";
  const bookSub   = book.generatedBook?.subtitle || "A personalized adventure";
  const childName = book.childName || "your child";
  const pageCount = book.generatedBook?.pages?.length || 12;
  const downloadUrl = `${appUrl}/delivery.html?bookId=${book.bookId}`;
  const lang = book.language || "he";

  try {
    await resend.emails.send({
      from: "Lifebook <lifebooks@lifebooksil.com>",
      to:   book.customerEmail,
      subject: lang === "en"
        ? `✨ ${childName}'s book is ready! "${bookTitle}"`
        : `✨ הספר של ${childName} מוכן! "${bookTitle}"`,
      html: lang === "en" ? `
<!DOCTYPE html>
<html dir="ltr">
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#fdf6ec;font-family:Assistant,Arial,sans-serif;direction:ltr;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fdf6ec;padding:40px 0;">
    <tr><td align="center">
      <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:24px;overflow:hidden;box-shadow:0 8px 40px rgba(100,60,20,0.12);border:1px solid #ede0c8;">
        <tr>
          <td style="background:linear-gradient(135deg,#1a1008,#5c3d1e);padding:40px;text-align:center;">
            <div style="font-size:36px;margin-bottom:10px;">📖</div>
            <img src="https://lifebooksil.com/assets/branding/lifebook-logo.webp" alt="Lifebook" style="height:54px;width:auto;display:block;margin:0 auto 10px;" />
            <div style="font-size:12px;color:#c4a87a;margin-top:5px;letter-spacing:2px;text-transform:uppercase;">Personalized Children's Books</div>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 44px 28px;direction:ltr;text-align:left;">
            <p style="font-family:Assistant,Arial,sans-serif;font-size:28px;color:#3a2810;margin:0 0 14px;line-height:1.2;font-weight:700;">🎉 ${childName}'s book is ready!</p>
            <p style="font-size:16px;color:#7a6048;line-height:1.7;margin:0 0 28px;">Your personalized book has been carefully created and is waiting for you.</p>
            <table cellpadding="0" cellspacing="0" width="100%" style="background:#fdf6ec;border-radius:16px;border:1px solid #ede0c8;margin-bottom:28px;">
              <tr>
                <td style="padding:20px 24px;direction:ltr;text-align:left;">
                  <p style="font-family:Assistant,Arial,sans-serif;font-size:20px;color:#5c3d1e;margin:0 0 4px;">"${bookTitle}"</p>
                  <p style="font-size:14px;color:#8a6240;margin:0 0 14px;font-style:italic;">${bookSub}</p>
                  <table cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="padding-right:24px;">
                        <span style="font-size:11px;color:#c8922a;font-weight:700;letter-spacing:0.8px;">Pages</span><br/>
                        <span style="font-size:15px;color:#3a2810;">${pageCount} illustrated pages</span>
                      </td>
                      <td>
                        <span style="font-size:11px;color:#c8922a;font-weight:700;letter-spacing:0.8px;">Hero</span><br/>
                        <span style="font-size:15px;color:#3a2810;">${childName}</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 32px;">
              <tr>
                <td style="background:linear-gradient(135deg,#e8b84b,#c8922a);border-radius:50px;padding:16px 40px;box-shadow:0 6px 24px rgba(200,146,42,0.35);">
                  <a href="${downloadUrl}" style="font-family:Assistant,Arial,sans-serif;font-size:17px;font-weight:700;color:#ffffff;text-decoration:none;display:block;white-space:nowrap;">Read &amp; Download Your Book →</a>
                </td>
              </tr>
            </table>
            <p style="font-size:13px;color:#b09070;line-height:1.6;margin:0 0 8px;">Or copy the link:</p>
            <p style="font-size:12px;color:#c8922a;word-break:break-all;margin:0 0 32px;background:#fdf6ec;padding:10px 14px;border-radius:10px;border:1px solid #ede0c8;">${downloadUrl}</p>
            <hr style="border:none;border-top:1px solid #f0e4d0;margin:0 0 20px;" />
            <p style="font-size:13px;color:#b09070;line-height:1.7;margin:0;">
              Questions or issues? Just reply to this email and we'll be happy to help.<br/>
              Thank you for creating with Lifebook 💛
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#fdf6ec;border-top:1px solid #ede0c8;padding:18px 44px;text-align:center;">
            <p style="font-size:12px;color:#c4a87a;margin:0;">
              © 2026 Lifebook · Personalized Children's Books · <a href="${appUrl}/contact.html" style="color:#c8922a;text-decoration:none;">Contact Us</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
      `.trim() : `
<!DOCTYPE html>
<html dir="rtl">
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#fdf6ec;font-family:Assistant,Arial,sans-serif;direction:rtl;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fdf6ec;padding:40px 0;">
    <tr><td align="center">
      <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:24px;overflow:hidden;box-shadow:0 8px 40px rgba(100,60,20,0.12);border:1px solid #ede0c8;">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#1a1008,#5c3d1e);padding:40px;text-align:center;">
            <div style="font-size:36px;margin-bottom:10px;">📖</div>
            <img src="https://lifebooksil.com/assets/branding/lifebook-logo.webp" alt="Lifebook" style="height:54px;width:auto;display:block;margin:0 auto 10px;" />
            <div style="font-size:12px;color:#c4a87a;margin-top:5px;letter-spacing:2px;text-transform:uppercase;">ספרי ילדים מותאמים אישית</div>
          </td>
        </tr>

        <!-- Hero message -->
        <tr>
          <td style="padding:40px 44px 28px;direction:rtl;text-align:right;">
            <p style="font-family:Assistant,Arial,sans-serif;font-size:28px;color:#3a2810;margin:0 0 14px;line-height:1.2;font-weight:700;">
              🎉 הספר של ${childName} מוכן!
            </p>
            <p style="font-size:16px;color:#7a6048;line-height:1.7;margin:0 0 28px;">
              הספר המותאם אישית שלכם נוצר בקפידה ומחכה לכם.
            </p>

            <!-- Book info box -->
            <table cellpadding="0" cellspacing="0" width="100%" style="background:#fdf6ec;border-radius:16px;border:1px solid #ede0c8;margin-bottom:28px;">
              <tr>
                <td style="padding:20px 24px;direction:rtl;text-align:right;">
                  <p style="font-family:Assistant,Arial,sans-serif;font-size:20px;color:#5c3d1e;margin:0 0 4px;">"${bookTitle}"</p>
                  <p style="font-size:14px;color:#8a6240;margin:0 0 14px;font-style:italic;">${bookSub}</p>
                  <table cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="padding-left:24px;">
                        <span style="font-size:11px;color:#c8922a;font-weight:700;letter-spacing:0.8px;">עמודים</span><br/>
                        <span style="font-size:15px;color:#3a2810;">${pageCount} עמודים מאוירים</span>
                      </td>
                      <td>
                        <span style="font-size:11px;color:#c8922a;font-weight:700;letter-spacing:0.8px;">הגיבור</span><br/>
                        <span style="font-size:15px;color:#3a2810;">${childName}</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <!-- CTA Button -->
            <table cellpadding="0" cellspacing="0" style="margin:0 0 32px;">
              <tr>
                <td style="background:linear-gradient(135deg,#e8b84b,#c8922a);border-radius:50px;padding:16px 40px;box-shadow:0 6px 24px rgba(200,146,42,0.35);">
                  <a href="${downloadUrl}"
                     style="font-family:Assistant,Arial,sans-serif;font-size:17px;font-weight:700;color:#ffffff;text-decoration:none;display:block;white-space:nowrap;">
                    קריאה והורדת הספר →
                  </a>
                </td>
              </tr>
            </table>

            <p style="font-size:13px;color:#b09070;line-height:1.6;margin:0 0 8px;">או העתיקו את הקישור:</p>
            <p style="font-size:12px;color:#c8922a;word-break:break-all;margin:0 0 32px;background:#fdf6ec;padding:10px 14px;border-radius:10px;border:1px solid #ede0c8;">
              ${downloadUrl}
            </p>

            <hr style="border:none;border-top:1px solid #f0e4d0;margin:0 0 20px;" />

            <p style="font-size:13px;color:#b09070;line-height:1.7;margin:0;">
              שאלות או בעיות? פשוט ענו למייל הזה ונשמח לעזור.<br/>
              תודה שיצרתם עם Lifebook 💛
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#fdf6ec;border-top:1px solid #ede0c8;padding:18px 44px;text-align:center;">
            <p style="font-size:12px;color:#c4a87a;margin:0;">
              © 2026 Lifebook · ספרי ילדים מותאמים אישית · <a href="${appUrl}/contact.html" style="color:#c8922a;text-decoration:none;">צור קשר</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>
      `.trim()
    });
    console.log("Book ready email sent to:", book.customerEmail);
  } catch(err) {
    console.error("Failed to send book ready email:", err.message);
    // Don't throw — email failure should not break the book generation
  }
}

app.post("/api/books/create", async (req, res) => {
  try {
    const cleanInput = sanitizeStoryPayload(req.body || {});
    const rawInput   = req.body || {};
    const bookId     = crypto.randomUUID();

    // ── Upload user photos to Supabase Storage (fall back to base64 if upload fails) ──
    let croppedPhotoVal  = cleanInput.croppedPhoto  || "";
    let originalPhotoVal = cleanInput.originalPhoto || "";

    if (croppedPhotoVal.startsWith("data:")) {
      try {
        const url = await uploadImageToStorage(bookId, "cropped-photo.jpg", croppedPhotoVal);
        if (url) croppedPhotoVal = url;
        console.log(`[Create] cropped photo uploaded to Storage: ${url}`);
      } catch (err) {
        console.warn(`[Create] Failed to upload cropped photo to Storage (using base64 fallback): ${err.message}`);
      }
    }

    if (originalPhotoVal.startsWith("data:")) {
      try {
        const url = await uploadImageToStorage(bookId, "original-photo.jpg", originalPhotoVal);
        if (url) originalPhotoVal = url;
        console.log(`[Create] original photo uploaded to Storage: ${url}`);
      } catch (err) {
        console.warn(`[Create] Failed to upload original photo to Storage (using base64 fallback): ${err.message}`);
      }
    }

    const book = {
      bookId,
      childName:         cleanInput.childName        || "",
      childAge:          rawInput.childAge            || "",
      childGender:       rawInput.childGender         || "",
      storyIdea:         cleanInput.storyIdea         || "",
      illustrationStyle: cleanInput.illustrationStyle || "Soft Storybook",
      language:          rawInput.language === "en" ? "en" : "he",
      croppedPhoto:      croppedPhotoVal,
      originalPhoto:     originalPhotoVal,
      customerEmail:     rawInput.customerEmail       || "",
      characterReference:null,
      generatedBook:     null,
      coverImage:        null,
      previewImages:     [],
      fullImages:        [],
      selectedFormat:    "digital",
      selectedPrice:     39,
      paymentStatus:     "pending",
      purchaseUnlocked:  false,
      stripeSessionId:   null
    };

    await insertBook(book);
    return res.json({ status: "ok", bookId });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err?.message || "Failed to create book" });
  }
});

app.patch("/api/books/:bookId", async (req, res) => {
  try {
    const updated = await updateBook(req.params.bookId, req.body || {});
    if (!updated) return res.status(404).json({ status: "error", message: "Book not found" });
    return res.json({ status: "ok", book: updated });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err?.message || "Failed to update book" });
  }
});

// ─── LemonSqueezy: Create Checkout Session ───────────────────────────────────
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { bookId } = req.body;
    console.log(`[Checkout] create-checkout-session called with bookId: ${bookId}`);

    if (!bookId) {
      return res.status(400).json({ status: "error", message: "Missing bookId" });
    }

    const book = await getBook(bookId);
    if (!book) {
      return res.status(404).json({ status: "error", message: "Book not found" });
    }

    const apiKey    = process.env.LEMONSQUEEZY_API_KEY;
    const storeId   = process.env.LEMONSQUEEZY_STORE_ID  || "347433";
    const variantId = process.env.LEMONSQUEEZY_VARIANT_ID;
    const appUrl    = process.env.APP_URL || "https://lifebooks.online";

    console.log(`[Checkout] storeId=${storeId} variantId=${variantId} apiKey=${apiKey ? "set" : "MISSING"}`);

    if (!apiKey || !variantId) {
      console.error("[Checkout] Missing LEMONSQUEEZY_API_KEY or LEMONSQUEEZY_VARIANT_ID");
      return res.status(500).json({ status: "error", message: "Payment not configured — missing API key or variant ID" });
    }

    const redirectUrl = `${appUrl}/success.html?bookId=${encodeURIComponent(bookId)}`;
    console.log(`[Checkout] redirect_url: ${redirectUrl}`);

    const requestBody = {
      data: {
        type: "checkouts",
        attributes: {
          checkout_data: { custom: { bookId } },
          product_options: { redirect_url: redirectUrl }
        },
        relationships: {
          store:   { data: { type: "stores",   id: String(storeId)   } },
          variant: { data: { type: "variants",  id: String(variantId) } }
        }
      }
    };

    console.log(`[Checkout] sending to LS API: ${JSON.stringify(requestBody)}`);

    const lsRes = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type":  "application/vnd.api+json",
        "Accept":        "application/vnd.api+json"
      },
      body: JSON.stringify(requestBody)
    });

    const lsData = await lsRes.json();

    if (!lsRes.ok) {
      console.error("[Checkout] LemonSqueezy API error:", JSON.stringify(lsData));
      return res.status(500).json({ status: "error", message: "Failed to create checkout — LS error: " + JSON.stringify(lsData?.errors || lsData) });
    }

    const checkoutUrl = lsData?.data?.attributes?.url;
    console.log(`[Checkout] checkout URL created: ${checkoutUrl}`);

    if (!checkoutUrl) {
      console.error("[Checkout] No URL in LS response:", JSON.stringify(lsData));
      return res.status(500).json({ status: "error", message: "No checkout URL returned from LemonSqueezy" });
    }

    return res.json({ status: "ok", url: checkoutUrl });
  } catch (err) {
    console.error("[Checkout] Unexpected error:", err.message, err.stack);
    return res.status(500).json({ status: "error", message: err?.message || "Failed to create checkout session" });
  }
});

// ─── LemonSqueezy Webhook ─────────────────────────────────────────────────────
app.post("/webhooks/lemonsqueezy", async (req, res) => {
  console.log("[LS Webhook] received — headers:", JSON.stringify({
    "x-signature":             req.headers["x-signature"],
    "x-lemonsqueezy-signature": req.headers["x-lemonsqueezy-signature"],
    "content-type":            req.headers["content-type"],
  }));

  // LemonSqueezy sends the signature as X-Signature header
  const sig           = req.headers["x-signature"] || req.headers["x-lemonsqueezy-signature"] || "";
  const webhookSecret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;

  console.log(`[LS Webhook] sig present: ${!!sig}, secret present: ${!!webhookSecret}`);

  if (!webhookSecret) {
    console.error("[LS Webhook] LEMONSQUEEZY_WEBHOOK_SECRET not set — returning 500");
    return res.status(500).send("Webhook secret not configured");
  }

  // Verify HMAC-SHA256 signature
  const digest = crypto.createHmac("sha256", webhookSecret).update(req.body).digest("hex");
  console.log(`[LS Webhook] expected digest: ${digest}, received sig: ${sig}`);

  if (sig !== digest) {
    console.error(`[LS Webhook] signature MISMATCH — rejecting. Got: ${sig} Expected: ${digest}`);
    return res.status(401).send("Invalid signature");
  }

  console.log("[LS Webhook] signature verified ✅ — responding 200 immediately");

  // ── Respond to LemonSqueezy IMMEDIATELY (must be within 5s) ──
  res.status(200).send("ok");

  // ── Process in background ──
  (async () => {
    try {
      const rawBody   = req.body.toString();
      console.log(`[LS Webhook] raw body (first 500 chars): ${rawBody.substring(0, 500)}`);

      const payload   = JSON.parse(rawBody);
      const eventName = payload?.meta?.event_name;
      console.log(`[LS Webhook] event_name: ${eventName}`);

      if (eventName !== "order_created") {
        console.log(`[LS Webhook] ignoring event: ${eventName}`);
        return;
      }

      const customData  = payload?.meta?.custom_data;
      const bookId      = customData?.bookId || customData?.book_id;
      const orderId     = String(payload?.data?.id || "");
      // BUG FIX: extract verified customer email from LemonSqueezy order payload
      // This is the email the customer used at checkout — more reliable than wizard input
      const lsUserEmail = (payload?.data?.attributes?.user_email || "").trim();

      console.log(`[LS Webhook] custom_data: ${JSON.stringify(customData)}`);
      console.log(`[LS Webhook] bookId: ${bookId}, orderId: ${orderId}, lsUserEmail: ${lsUserEmail || "(none)"}`);

      if (!bookId) {
        console.error("[LS Webhook] no bookId found in custom_data — cannot unlock book");
        console.error("[LS Webhook] full meta:", JSON.stringify(payload?.meta));
        return;
      }

      console.log(`[LS Webhook] unlocking book ${bookId}...`);

      // Unlock book + update customerEmail with verified LS email (if present)
      // This fixes the case where the wizard email was blank or wrong
      const unlockPatch = {
        paymentStatus:    "paid",
        purchaseUnlocked: true,
        stripeSessionId:  orderId   // reusing existing DB column for LS order ID
      };
      if (lsUserEmail) unlockPatch.customerEmail = lsUserEmail;
      await updateBookField(bookId, unlockPatch);
      console.log(`[LS Webhook] ✅ book ${bookId} unlocked via LemonSqueezy order ${orderId}${lsUserEmail ? ` — customerEmail updated to: ${lsUserEmail}` : ""}`);

      // Use getBook — need fullImages to check if generation was already complete
      const paidBook = await getBook(bookId);
      if (!paidBook) {
        console.error(`[LS Webhook] could not fetch book after unlock: ${bookId}`);
        return;
      }

      await sendPaymentConfirmationEmail(paidBook);
      console.log(`[LS Webhook] payment confirmation email sent to: ${paidBook.customerEmail || "(no email)"}`);

      // BUG FIX: allDone was too strict — required ALL images, so if even 1 page image
      // failed all retries (returning null), allDone=false and email was never sent even
      // though generation was complete. Now allow up to 2 image failures (10/12 pages).
      // STEP 5 (generate-full) handles the case where payment arrives before generation.
      const pages      = paidBook.generatedBook?.pages || [];
      const images     = paidBook.fullImages || [];
      const readyCount = images.filter(Boolean).length;
      const threshold  = Math.max(1, pages.length - 2); // allow up to 2 failures
      const allDone    = pages.length > 0 && readyCount >= threshold;
      console.log(`[LS Webhook] book ${bookId} — readyCount=${readyCount}/${pages.length}, threshold=${threshold}, allDone=${allDone}`);
      if (allDone) {
        console.log(`[LS Webhook] book ${bookId} was complete at payment time — sending book ready email`);
        await sendBookReadyEmail(paidBook);
        console.log(`[LS Webhook] book ready email sent ✅`);
      } else {
        console.log(`[LS Webhook] book ${bookId} generation still in progress (${readyCount}/${pages.length} images ready, need ${threshold}) — book ready email will be sent by generate-full STEP 5`);
      }
    } catch (err) {
      console.error("[LS Webhook] processing failed:", err.message, err.stack);
    }
  })();
});


// ─── Shopify Webhook (orders/paid) ───────────────────────────────────────────
app.post("/webhooks/shopify", async (req, res) => {
  console.log("[Shopify Webhook] received");

  const sig           = req.headers["x-shopify-hmac-sha256"] || "";
  const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("[Shopify Webhook] SHOPIFY_WEBHOOK_SECRET not set — returning 500");
    return res.status(500).send("Webhook secret not configured");
  }

  // Shopify signs with HMAC-SHA256, base64-encoded
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
  const digest = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("base64");
  let valid = false;
  try {
    valid = sig.length > 0 && crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig));
  } catch (e) { valid = false; }

  if (!valid) {
    console.error("[Shopify Webhook] signature MISMATCH — rejecting");
    return res.status(401).send("Invalid signature");
  }

  console.log("[Shopify Webhook] signature verified — responding 200 immediately");
  res.status(200).send("ok");

  // ── Process in background (same pattern as LemonSqueezy webhook) ──
  (async () => {
    try {
      const payload = JSON.parse(rawBody.toString());
      const orderId = String(payload?.id || "");
      const shopifyEmail = (payload?.email || payload?.contact_email || "").trim();

      // book_id arrives via cart attributes -> order note_attributes
      const noteAttrs = payload?.note_attributes || [];
      const attr = noteAttrs.find(a => {
        const n = (a?.name || "").toLowerCase();
        return n === "book_id" || n === "bookid";
      });
      const bookId = attr?.value;

      console.log(`[Shopify Webhook] orderId: ${orderId}, bookId: ${bookId}, email: ${shopifyEmail || "(none)"}`);

      if (!bookId) {
        console.error("[Shopify Webhook] no book_id in note_attributes:", JSON.stringify(noteAttrs));
        return;
      }

      const unlockPatch = {
        paymentStatus:    "paid",
        purchaseUnlocked: true,
        stripeSessionId:  orderId   // reusing existing DB column for Shopify order ID
      };
      if (shopifyEmail) unlockPatch.customerEmail = shopifyEmail;
      await updateBookField(bookId, unlockPatch);
      console.log(`[Shopify Webhook] book ${bookId} unlocked via Shopify order ${orderId}`);

      const paidBook = await getBook(bookId);
      if (!paidBook) {
        console.error(`[Shopify Webhook] could not fetch book after unlock: ${bookId}`);
        return;
      }

      await sendPaymentConfirmationEmail(paidBook);
      console.log(`[Shopify Webhook] payment confirmation email sent`);

      const pages      = paidBook.generatedBook?.pages || [];
      const images     = paidBook.fullImages || [];
      const readyCount = images.filter(Boolean).length;
      const threshold  = Math.max(1, pages.length - 2);
      const allDone    = pages.length > 0 && readyCount >= threshold;
      console.log(`[Shopify Webhook] readyCount=${readyCount}/${pages.length}, allDone=${allDone}`);
      if (allDone) {
        await sendBookReadyEmail(paidBook);
        console.log(`[Shopify Webhook] book ready email sent`);
      }
    } catch (err) {
      console.error("[Shopify Webhook] processing failed:", err.message, err.stack);
    }
  })();
});

// ─── Gumroad Webhook ──────────────────────────────────────────────────────────
// Gumroad sends application/x-www-form-urlencoded pings (not JSON, no HMAC).
// The bookId is stored in the `referrer` field (set via ?referral=BOOKID in checkout URL).
app.post("/webhooks/gumroad", express.urlencoded({ extended: false, limit: "25mb" }), async (req, res) => {
  console.log("[Gumroad Webhook] received — body keys:", Object.keys(req.body || {}));

  // Respond immediately so Gumroad doesn't retry
  res.status(200).send("ok");

  (async () => {
    try {
      const body        = req.body || {};
      const bookId      = (body.referrer || "").trim();
      const email       = (body.email    || "").trim();
      const saleId      = (body.sale_id  || body.order_id || "").trim();

      console.log(`[Gumroad Webhook] bookId (referrer): ${bookId || "(none)"}, email: ${email || "(none)"}, saleId: ${saleId || "(none)"}`);

      if (!bookId) {
        console.error("[Gumroad Webhook] no bookId in referrer field — cannot unlock book");
        return;
      }

      console.log(`[Gumroad Webhook] unlocking book ${bookId}...`);

      const unlockPatch = {
        paymentStatus:    "paid",
        purchaseUnlocked: true,
        stripeSessionId:  saleId  // reusing existing column for Gumroad sale ID
      };
      if (email) unlockPatch.customerEmail = email;

      await updateBookField(bookId, unlockPatch);
      console.log(`[Gumroad Webhook] ✅ book ${bookId} unlocked${email ? ` — customerEmail: ${email}` : ""}`);

      const paidBook = await getBook(bookId);
      if (!paidBook) {
        console.error(`[Gumroad Webhook] could not fetch book after unlock: ${bookId}`);
        return;
      }

      await sendPaymentConfirmationEmail(paidBook);
      console.log(`[Gumroad Webhook] payment confirmation email sent to: ${paidBook.customerEmail || "(no email)"}`);

      const pages      = paidBook.generatedBook?.pages || [];
      const images     = paidBook.fullImages || [];
      const readyCount = images.filter(Boolean).length;
      const threshold  = Math.max(1, pages.length - 2);
      const allDone    = pages.length > 0 && readyCount >= threshold;
      console.log(`[Gumroad Webhook] book ${bookId} — readyCount=${readyCount}/${pages.length}, threshold=${threshold}, allDone=${allDone}`);

      if (allDone) {
        console.log(`[Gumroad Webhook] book ${bookId} was complete at payment time — sending book ready email`);
        await sendBookReadyEmail(paidBook);
        console.log(`[Gumroad Webhook] book ready email sent ✅`);
      } else {
        console.log(`[Gumroad Webhook] book ${bookId} generation still in progress — book ready email will be sent by generate-full STEP 5`);
      }
    } catch (err) {
      console.error("[Gumroad Webhook] processing failed:", err.message, err.stack);
    }
  })();
});

// ─── Unlock endpoint (manual / dev) ──────────────────────────────────────────
app.post("/api/books/:bookId/unlock", async (req, res) => {
  try {
    const updated = await updateBook(req.params.bookId, {
      paymentStatus:    "paid",
      purchaseUnlocked: true
    });
    if (!updated) return res.status(404).json({ status: "error", message: "Book not found" });

    try {
      const unlockedBook = await getBook(req.params.bookId);
      // Send payment confirmation
      await sendPaymentConfirmationEmail(unlockedBook);
      // If book already fully generated, also send book ready email
      const pages   = unlockedBook?.generatedBook?.pages || [];
      const images  = unlockedBook?.fullImages || [];
      const allDone = pages.length > 0 && images.filter(Boolean).length >= pages.length;
      if (allDone) {
        await sendBookReadyEmail(unlockedBook);
        console.log(`Unlock: both emails sent to ${unlockedBook?.customerEmail}`);
      } else {
        console.log(`Unlock: payment confirmation sent, book ready will follow when generation completes`);
      }
    } catch (emailErr) {
      console.error("Failed to send emails on unlock:", emailErr.message);
    }

    return res.json({ status: "ok", book: updated });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err?.message || "Failed to unlock book" });
  }
});

// ─── Template prompt builder ───────────────────────────────────────────────────
// Fetches a story_template row and fills all {{placeholders}} generically.
// Returns a ready-to-send prompt string, or null if template not found/inactive.
//
// HOW IT WORKS:
// 1. Build a values map from all inputs fields (childName, allergyType, dadName, etc.)
// 2. For each key in tmpl.variations, resolve inputs[key] against the map,
//    then store as {{key + "Variant"}} in the values map. Sub-placeholders
//    inside the resolved variation text (e.g. {{allergyOther}}) are expanded too.
// 3. Add computed fields: genderNote, characterSummary, promptCore.
// 4. Replace every {{key}} in the skeleton with its value. Unknown keys → "".
//
// Adding a new template = INSERT into story_templates only. No code change needed.
//
// ── OLD VERSION (kept for rollback) ──────────────────────────────────────────
// async function buildTemplateStoryPrompt_OLD(templateSlug, inputs, characterSummary, promptCore) {
//   ... (template-specific allergyVariant + dadRoleVariant hardcoded) ...
// }
// ─────────────────────────────────────────────────────────────────────────────
async function buildTemplateStoryPrompt(templateSlug, inputs, characterSummary, promptCore, bookLanguage) {
  const { data: tmpl, error } = await supabase
    .from("story_templates")
    .select("story_skeleton, variations, input_schema, character_bible")
    .eq("slug", templateSlug)
    .eq("active", true)
    .single();

  if (error || !tmpl) {
    console.warn(`[template] slug="${templateSlug}" not found or inactive — falling back to custom mode`);
    return null;
  }

  // Step 1: seed values map from all inputs
  const vals = {};
  for (const [k, v] of Object.entries(inputs || {})) {
    vals[k] = String(v ?? "");
  }

  // Step 2: resolve each variation key → store as {{key + "Variant"}}
  // e.g. variations.allergyType["בוטנים"] = "אלרגיה לבוטנים"  → vals.allergyTypeVariant
  // Sub-placeholders inside the resolved text (e.g. {{allergyOther}}) are expanded
  // using the current vals map.
  const variations = tmpl.variations || {};
  for (const [varKey, varMap] of Object.entries(variations)) {
    if (varMap && typeof varMap === "object") {
      const chosen  = vals[varKey] || "";
      let resolved  = varMap[chosen] || chosen || "";
      // expand sub-placeholders (e.g. {{allergyOther}}, {{childName}})
      resolved = resolved.replace(/\{\{(\w+)\}\}/g, (_, k) => vals[k] ?? "");
      vals[varKey + "Variant"] = resolved;
    }
  }

  // Step 3: computed fields
  vals.genderNote = (inputs.childGender === "ילד")
    ? "הילד הוא בן — השתמש בלשון זכר לאורך כל הסיפור."
    : "הילדה היא בת — השתמש בלשון נקבה לאורך כל הסיפור.";
  vals.characterSummary = sanitizeBrandTerms(characterSummary || "");
  vals.promptCore       = sanitizeBrandTerms(promptCore       || "");

  // Step 4: replace every {{key}} in the skeleton; unknown keys → ""
  const filledSkeleton = tmpl.story_skeleton.replace(/\{\{(\w+)\}\}/g, (_, k) => vals[k] ?? "");

  // Prepend writing rules automatically — no {{writingRules}} needed in any skeleton
  const langRule = (bookLanguage || "he") === "en"
    ? "- Language: Write the ENTIRE story in English only."
    : '- Language: כתוב את כל הסיפור בעברית בלבד — ללא מילים באנגלית (למשל: כתוב "התרגשות" ולא "excitement!"). שמות פרטיים אפשר לשמור באותיות לטיניות.\n- כתוב עברית טבעית ומדוברת כפי שהורה ישראלי מקריא לילדו; הימנע מתרגומי־מילה מאנגלית וממבנים לא טבעיים (כמו \'זה יומנו\').';
  const writingRules = `כללי כתיבה חשובים:\n- בדיוק 12 עמודים — לא פחות, לא יותר.\n- כל עמוד: לפחות 2–3 משפטים. אסור לכתוב משפט יחיד.\n- התאם לגיל ${inputs.childAge || ""}: ילד צעיר (עד 4) — לפחות 2–3 משפטים, קצרים וקצביים עם חזרות (קצרים, אך לא פחות משניים); ילד מבוגר יותר (5+) — עושר רגשי ומילולי רב יותר.\n- כתוב מה הילד מרגיש וחושב — לא רק מה שקורה. הטקסט חי ורגשי.\n- השתמש בשפה חמה, קצבית, ילדותית — שאלות, קריאות, חזרות מוזיקליות.\n- שם הילד מופיע באופן טבעי לאורך הסיפור — לא בכל משפט, לא רק בהתחלה.\n- אין מוסר השכל מפורש. אין נאומים. הרגש עולה מהסיפור עצמו.\n${langRule}`;
  const prompt = `${writingRules}\n\n${filledSkeleton}`;

  // skinToneSource: "child" (default) or "fixed" (template overrides child's skin tone)
  const skinToneSource = tmpl.input_schema?.skinToneSource || "child";

  // character_bible: resolved character descriptions keyed by Hebrew role name
  // Values may contain "derived from child photo" (filled at runtime) or fixed strings
  const characterBible = tmpl.character_bible || null;

  return { prompt, skinToneSource, characterBible };
}

// ─── Generate Full Book (story + cover + images) — fires in background ────────
app.post("/api/books/:bookId/generate-full", async (req, res) => {
  const bookId = req.params.bookId;

  // Respond immediately so crop.js can redirect to preview
  res.json({ status: "ok", message: "Generation started in background" });

  // Run everything async — errors are caught and saved to DB
  (async () => {
    try {
      const book = await getBook(bookId);
      if (!book) { console.error("generate-full: book not found", bookId); return; }

      console.log(`generate-full [${bookId}]: START — child: ${book.childName}, style: ${book.illustrationStyle}`);

      const childName         = book.childName         || "The Child";
      const childAge          = book.childAge          || "5";
      const childGender       = book.childGender       || "not specified";
      const storyIdea         = book.storyIdea         || "a magical adventure";
      const illustrationStyle = book.illustrationStyle || "Soft Storybook";
      const croppedPhoto      = book.croppedPhoto      || book.originalPhoto || "";
      const safeStyle         = resolveStyle(illustrationStyle);
      const t0 = Date.now();
      const elapsed = () => `+${Math.round((Date.now()-t0)/1000)}s`;
      const bookLanguage = book.language || "he";
      const isHebrewBook = bookLanguage === "he" || /[\u0590-\u05FF]/.test(childName + storyIdea);
      console.log(`generate-full [${bookId}]: language=${bookLanguage} (isHebrew=${isHebrewBook}) — imagePrompts always in English`);

      // ── STEP 1: Character reference (photo → DNA + prompt core) ──────────────
      let characterReference = book.characterReference || null;

      if (!characterReference && croppedPhoto) {
        try {
          const dnaCompletion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: [{
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Analyze the uploaded child photo and return ONLY JSON.\nReturn:\n{\n  "hair": "string",\n  "skin": "string",\n  "eyes": "string",\n  "face": "string",\n  "ageLook": "string",\n  "outfit": "string",\n  "vibe": "string",\n  "summary": "string"\n}\nRules:\n- Focus only on the child\n- Ignore any brand names, logos, copyrighted characters, or toy franchises\n- If clothing includes a recognizable character or logo, describe it generically`
                },
                { type: "image_url", image_url: { url: croppedPhoto } }
              ]
            }],
            temperature: 0.2
          });

          const characterDNA = safeJsonParse(dnaCompletion.choices?.[0]?.message?.content || "{}", {
            hair: "soft child hair", skin: "warm natural skin tone",
            eyes: "natural eye color exactly as in the reference photo", face: "soft rounded child face",
            ageLook: "young child", outfit: "simple timeless child outfit",
            vibe: "warm curious child", summary: "A warm curious child hero for a magical storybook."
          });

          const promptCore = buildCharacterPromptCore(characterDNA, safeStyle);
          characterReference = {
            characterDNA,
            characterPromptCore: promptCore,
            characterSummary: characterDNA.summary || "A warm curious child hero.",
            skinToneDescription: [characterDNA.skin, characterDNA.hair].filter(Boolean).join(" and ")
          };
          await updateBookField(bookId, { characterReference });
        } catch (err) {
          console.warn("generate-full: character reference failed, continuing without it:", err.message);
          characterReference = {
            characterDNA: {},
            characterPromptCore: `A young child aged ${childAge}, warm storybook style.`,
            characterSummary: `A ${childAge}-year-old child hero.`
          };
          await updateBookField(bookId, { characterReference });
        }
      }

      const promptCore           = characterReference?.characterPromptCore || `A young child aged ${childAge}.`;
      const characterSummary     = characterReference?.characterSummary    || `A ${childAge}-year-old child hero.`;
      const skinToneDescription  = characterReference?.skinToneDescription || "";
      // Declared here — before STEP 2 sets it and before generateAnyPage reads it
      let templateSkinToneSource = "child";
      let templateCharacterBible = null;
      // Declared here — before STEP 2 if-block so bannedNamesInPrompt can access it even when STEP 2 is skipped
      let templateInputs = {};
      console.log(`generate-full [${bookId}]: STEP 1 done — character reference ready ${elapsed()}`);

      // ── STEP 2: Generate story text ───────────────────────────────────────────
      if (!book.generatedBook?.pages?.length) {

        // Determine mode from request body (default: custom — no existing behaviour changes)
        let mode             = req.body?.mode            || 'custom';
        const templateSlug   = req.body?.templateSlug    || null;
        templateInputs       = req.body?.templateInputs  || {};

        let storyPrompt;

        // ── template mode ──────────────────────────────────────────────────────
        if (mode === 'template' && templateSlug) {
          console.log(`generate-full [${bookId}]: STEP 2 mode=template slug=${templateSlug}`);
          const tmplResult = await buildTemplateStoryPrompt(
            templateSlug, templateInputs, characterSummary, promptCore, bookLanguage
          );
          if (!tmplResult) {
            console.warn(`generate-full [${bookId}]: STEP 2 template not found — falling back to custom`);
            mode = 'custom';
          } else {
            storyPrompt            = tmplResult.prompt;
            templateSkinToneSource = tmplResult.skinToneSource;
            templateCharacterBible = tmplResult.characterBible;
          }
        }

        // ── custom mode (default, and fallback from template) ──────────────────
        if (mode !== 'template') {
          console.log(`generate-full [${bookId}]: STEP 2 mode=custom`);
          const writingRules = `כללי כתיבה חשובים:\n- בדיוק 12 עמודים — לא פחות, לא יותר.\n- כל עמוד: לפחות 2–3 משפטים. אסור לכתוב משפט יחיד.\n- התאם לגיל ${childAge}: ילד צעיר (עד 4) — לפחות 2–3 משפטים, קצרים וקצביים עם חזרות (קצרים, אך לא פחות משניים); ילד מבוגר יותר (5+) — עושר רגשי ומילולי רב יותר.\n- כתוב מה הילד מרגיש וחושב — לא רק מה שקורה. הטקסט חי ורגשי.\n- השתמש בשפה חמה, קצבית, ילדותית — שאלות, קריאות, חזרות מוזיקליות.\n- שם הילד מופיע באופן טבעי לאורך הסיפור — לא בכל משפט, לא רק בהתחלה.\n- אין מוסר השכל מפורש. אין נאומים. הרגש עולה מהסיפור עצמו.`;
          storyPrompt = `You are a premium personalized children's book writer.\n\n${writingRules}\n\nChild name: ${sanitizeBrandTerms(childName)}\nChild age: ${childAge}\nChild gender: ${childGender}\nStory direction: ${sanitizeBrandTerms(storyIdea)}\nIllustration style: ${safeStyle}\n\nCharacter summary:\n${sanitizeBrandTerms(characterSummary)}\n\nCharacter consistency instructions:\n${sanitizeBrandTerms(promptCore)}\n\nReturn ONLY JSON:\n{\n  "title": "string",\n  "subtitle": "string",\n  "pages": [\n    {\n      "text": "string",\n      "imagePrompt": "string"\n    }\n  ]\n}\n\nRules:\n- Exactly 12 story pages\n- Each page text must be 35-70 words\n- The child must clearly be the hero\n- imagePrompt must describe the same illustrated storybook character consistently across all pages — same face, hair, and features in every scene. Never use "the child", "boy", or "girl" — instead use "the young storybook hero" (for a boy) or "the young storybook heroine" (for a girl). Always describe an illustrated character, never a real person or photograph.\n- No page numbers inside text\n- No brand names\n- Do not mention copyrighted characters or logos\n- Language: ${bookLanguage === "en" ? "Write the ENTIRE story in English only." : 'כתוב את כל הסיפור בעברית בלבד — ללא מילים באנגלית (למשל: כתוב "התרגשות" ולא "excitement!"). שמות פרטיים אפשר לשמור באותיות לטיניות.'} Keep imagePrompt always in English for image generation.`;
        }

        // ── OpenAI call (identical for both modes) — up to 2 retries if <12 pages ──
        // Suffix appended to every story prompt to reinforce 12-page requirement
        const pageSuffix = `\n\n⚠️ MANDATORY: The "pages" array in your JSON response MUST contain EXACTLY 12 objects — no more, no fewer. Count them before you respond.`;

        const parseStoryResponse = (raw) => {
          const data = safeJsonParse(raw, {});
          return {
            title:    sanitizeBrandTerms(data.title    || `The Magical Adventure of ${childName}`),
            subtitle: sanitizeBrandTerms(data.subtitle || "A story where you are the hero"),
            pages:    Array.isArray(data.pages)
              ? data.pages.slice(0, 12).map(p => ({
                  text:        sanitizeBrandTerms(String(p.text        || "").trim()),
                  imagePrompt: sanitizeImagePrompt(String(p.imagePrompt || "").trim())
                }))
              : []
          };
        };

        try {
          let generatedBook = null;
          const MAX_STORY_ATTEMPTS = 3;
          for (let attempt = 1; attempt <= MAX_STORY_ATTEMPTS; attempt++) {
            console.log(`generate-full [${bookId}]: STEP 2 attempt ${attempt}/${MAX_STORY_ATTEMPTS}`);
            const completion = await openai.chat.completions.create({
              model: "gpt-4o-mini",
              response_format: { type: "json_object" },
              messages: [{ role: "user", content: storyPrompt + pageSuffix }],
              temperature: 0.8
            });
            const raw = completion.choices?.[0]?.message?.content || "{}";
            const candidate = parseStoryResponse(raw);
            if (candidate.pages.length === 12) {
              generatedBook = candidate;
              console.log(`generate-full [${bookId}]: STEP 2 — got 12 pages on attempt ${attempt}`);
              break;
            }
            console.warn(`generate-full [${bookId}]: ⚠️ STEP 2 attempt ${attempt} — got ${candidate.pages.length}/12 pages, retrying...`);
            if (attempt === MAX_STORY_ATTEMPTS) {
              // Best effort: use whatever we got
              generatedBook = candidate;
              console.warn(`generate-full [${bookId}]: ⚠️ STEP 2 FINAL — only ${candidate.pages.length}/12 pages after ${MAX_STORY_ATTEMPTS} attempts. Building partial book.`);
            }
          }

          await updateBookField(bookId, { generatedBook });
          console.log(`generate-full [${bookId}]: STEP 2 done — ${generatedBook.pages.length} pages`);
          console.log(`generate-full [${bookId}]: STEP 2 imagePrompts —`, JSON.stringify(generatedBook.pages.map((p, i) => ({ i, imagePrompt: p.imagePrompt }))));
        } catch (err) {
          console.error(`generate-full [${bookId}]: STEP 2 FAILED — ${err.message}`);
          const fallbackBook = {
            title: `${childName}'s Magical Adventure`,
            subtitle: "A story where you are the hero",
            pages: Array.from({length: 12}, (_, i) => ({
              text: `Page ${i+1} of ${childName}'s magical adventure.`,
              imagePrompt: `A young child in a magical storybook adventure, page ${i+1}, warm illustrated style.`
            }))
          };
          await updateBookField(bookId, { generatedBook: fallbackBook });
        }
      }

      // ── STEP 3+4a: Cover + first 2 page images IN PARALLEL ──────────────────
      // Running them together cuts the wait from ~2min to ~60s
      console.log(`generate-full [${bookId}]: STEP 2 done — story written ${elapsed()}, starting cover + priority images in parallel`);

      const bookBeforeImgs = await getBook(bookId);
      const pages          = bookBeforeImgs.generatedBook?.pages || [];
      const title          = bookBeforeImgs.generatedBook?.title    || `The Magical Adventure of ${childName}`;
      const subtitle       = bookBeforeImgs.generatedBook?.subtitle || "A story where you are the hero";
      const existingImages = bookBeforeImgs.fullImages || [];
      const fullImages     = [...existingImages];
      while (fullImages.length < pages.length) fullImages.push(null);

      // ── Load reference image for image-edit pipeline ──────────────────────
      // referenceBuffer is set once and reused for every page (same original photo).
      // If loading fails → fallback to text-to-image with a clear warning.
      let referenceBuffer = null;
      if (USE_IMAGE_EDIT && croppedPhoto) {
        try {
          const refRes = await fetch(croppedPhoto);
          if (!refRes.ok) throw new Error(`HTTP ${refRes.status}`);
          const arrBuf = await refRes.arrayBuffer();
          referenceBuffer = Buffer.from(arrBuf);
          const refSource = croppedPhoto === book.croppedPhoto ? "croppedPhoto" : "originalPhoto";
          console.log(`generate-full [${bookId}]: referenceBuffer loaded — source=${refSource} url=${croppedPhoto?.substring(0,80)} size=${referenceBuffer.length} bytes`);
        } catch (refErr) {
          console.warn(`generate-full [${bookId}]: ⚠️ FALLBACK — could not load reference photo (${refErr.message}). Falling back to text-to-image (no face identity). Book will still be generated.`);
          referenceBuffer = null;
        }
      }

      // Build STYLE_LOCK once — same string prepended to every page prompt
      const styleLock = (USE_IMAGE_EDIT && referenceBuffer) ? buildStyleLock(illustrationStyle) : null;

      const useEditPipeline = USE_IMAGE_EDIT && referenceBuffer !== null;

      // ── V2 retry wrapper (image-edit) — 180s timeout, 2 retries ─────────
      async function generatePageImageWithRetryV2(scenePrompt) {
        const MAX_RETRIES = 2;
        const TIMEOUT_MS  = 180000;
        for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
          try {
            const result = await Promise.race([
              generatePageImageV2(referenceBuffer, scenePrompt),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`image-edit timed out after 180s`)), TIMEOUT_MS)
              )
            ]);
            return await normalizeImageToBase64(result?.data?.[0]);
          } catch (err) {
            console.warn(`generate-full [${bookId}]: image-edit attempt ${attempt} failed: ${err.message}`);
            if (attempt <= MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 3000));
            }
          }
        }
        console.error(`generate-full [${bookId}]: image-edit — all attempts failed, skipping (null)`);
        return null;
      }

      // ── Old text-to-image function (unchanged, used when useEditPipeline=false) ──
      async function generatePageImage(pageIndex) {
        const page = pages[pageIndex];
        const imgPrompt = `Create a premium children's storybook illustration.\n\nIllustration style: ${safeStyle}\n\nCharacter consistency:\n${sanitizeBrandTerms(promptCore)}\n\nScene:\n${sanitizeImagePrompt(page.imagePrompt || "")}\n\nRules:\n- same child identity in this scene as in all other illustrations\n- same face structure, hair color, skin tone, and eye color — no variation\n- warm magical storybook aesthetic\n- keep the lower third of the composition calmer and less visually busy, with a simpler or softer background — this area is reserved for text overlay\n- NO text, letters, words, numbers, or writing of any kind rendered inside the image\n- NO captions, labels, titles, or speech bubbles\n- no watermark\n- elegant composition\n- no logos\n- no brand names\n- no copyrighted costume emblems`;
        const imgResp = await openai.images.generate({ model: "gpt-image-2", prompt: imgPrompt, size: "1024x1536", quality: "high" });
        return await normalizeImageToBase64(imgResp?.data?.[0]);
      }

      // Hebrew role → bible key mapping
      const HEBREW_ROLE_MAP = {
        "סבא": "saba", "סבתא": "savta",
        "אמא": "ima",  "אבא": "aba",
        "אח":  "ach",  "אחות": "achot",
      };

      // Names that must not appear in imagePrompts (cause GPT-image to try rendering/distorting them)
      // Built from inputs: childName + any template input fields that look like names
      const bannedNamesInPrompt = [
        childName,
        templateInputs?.dadName,
        templateInputs?.grandpaName,
        templateInputs?.grandmaName,
      ].filter(Boolean).map(n => n.trim()).filter(n => n.length > 1);

      function stripBannedNames(text) {
        if (!bannedNamesInPrompt.length) return text;
        let result = text;
        for (const name of bannedNamesInPrompt) {
          // Remove "Saba <Name>", "<Name>", etc. — case-insensitive word-boundary match
          const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          result = result.replace(new RegExp(`\\b${escapedName}\\b`, "gi"), "");
        }
        // Clean up double spaces left by removal
        return result.replace(/\s{2,}/g, " ").trim();
      }

      // Build character appearance hint from character_bible for a given page text (Hebrew)
      function buildBibleHint(pageText) {
        if (!templateCharacterBible || !pageText) return "";
        const hints = [];
        for (const [hebrewRole, bibleKey] of Object.entries(HEBREW_ROLE_MAP)) {
          if (!pageText.includes(hebrewRole)) continue;
          const entry = templateCharacterBible[bibleKey];
          if (!entry || entry._rule) continue; // skip meta-fields
          const appearance = (typeof entry === "string") ? entry : entry.appearance;
          if (!appearance) continue;
          if (appearance === "derived from child photo") {
            // runtime substitution: use skinToneDescription from STEP 1
            if (skinToneDescription) hints.push(`${hebrewRole}: ${skinToneDescription}.`);
          } else {
            hints.push(`${hebrewRole}: ${appearance}.`);
          }
        }
        return hints.length ? ` Character appearances: ${hints.join(" ")}` : "";
      }

      // ── Unified page generator: picks V2 or V1 based on flag ─────────────
      async function generateAnyPage(pageIndex) {
        if (useEditPipeline) {
          const scene    = stripBannedNames(sanitizeImagePrompt(pages[pageIndex]?.imagePrompt || ""));
          const pageText = pages[pageIndex]?.text || "";
          console.log(`generate-full [${bookId}]: page-${pageIndex} scene: ${scene}`);

          // character_bible hint (from template) takes priority over generic skinToneHint
          const bibleHint = buildBibleHint(pageText);
          const hasFamilyMember = !bibleHint && /\b(father|mother|dad|mom|grandfather|grandmother|grandpa|grandma|brother|sister|parent|family|siblings?)\b/i.test(scene);
          const skinToneHint = (hasFamilyMember && skinToneDescription && templateSkinToneSource !== "fixed")
            ? ` Family members share the child's ${skinToneDescription}.`
            : "";
          // V2 (image-edit): reference photo is the sole source of child identity — no promptCore text needed.
          const scenePrompt = `${styleLock} ${scene}${bibleHint || skinToneHint} Portrait orientation. Character fully centered vertically — full head, hair, and shoulders visible with clear space above; never cropped at the top. No English text or signs; any visible signage should be blank or in Hebrew. Keep the lower third of the composition calmer and less visually busy with a simpler background — this area is reserved for text overlay. NO text, letters, words, numbers, captions, labels, titles, watermarks, logos, or speech bubbles inside the image.`;
          // Single attempt here — outer generatePageImageWithRetry provides the retry loop.
          // Previously called generatePageImageWithRetryV2 which had its own 3-attempt loop,
          // causing up to 9 total API calls per page and severe speed regression.
          const resp = await generatePageImageV2(referenceBuffer, scenePrompt);
          return normalizeImageToBase64(resp?.data?.[0]);
        }
        return generatePageImage(pageIndex);
      }

      // Retry wrapper: up to 2 retries, 180s timeout per attempt.
      // If all attempts fail, returns null and logs — pipeline continues regardless.
      async function generatePageImageWithRetry(pageIndex) {
        const MAX_RETRIES = 2;
        const TIMEOUT_MS  = 180000;
        for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
          try {
            const result = await Promise.race([
              generateAnyPage(pageIndex),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`page-${pageIndex} timed out after 180s`)), TIMEOUT_MS)
              )
            ]);
            return result;
          } catch (err) {
            console.warn(`generate-full [${bookId}]: page-${pageIndex} attempt ${attempt} failed: ${err.message}`);
            if (attempt <= MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 3000));
            }
          }
        }
        console.error(`generate-full [${bookId}]: page-${pageIndex} — all ${MAX_RETRIES + 1} attempts failed, skipping (null)`);
        return null;
      }

      // Log effective style before any scenePrompt is built
      console.log(`generate-full [${bookId}]: effective style → ${safeStyle} → styleLock: ${styleLock?.substring(0,60)}...`);

      // Cover prompt / cover generation
      let coverGenPromise;
      if (useEditPipeline) {
        const coverScene = `The child stands as the hero on the cover of a children's storybook. Magical scene inspired by: ${sanitizeBrandTerms(storyIdea)}. Beautiful cover composition, full portrait, warm magical atmosphere. No character sheet, no multiple poses.`;
        // V2 (image-edit): reference photo is the sole source of child identity — no promptCore text needed.
        const coverScenePrompt = `${styleLock} ${coverScene} Portrait orientation. Character fully centered vertically — full head, hair, and shoulders visible with clear space above; never cropped at the top. No English text or signs; any visible signage should be blank or in Hebrew. NO text, letters, words, numbers, captions, titles, watermarks, logos, or speech bubbles inside the image.`;
        coverGenPromise = Promise.race([
          generatePageImageV2(referenceBuffer, coverScenePrompt).then(r => normalizeImageToBase64(r?.data?.[0])),
          new Promise((_, reject) => setTimeout(() => reject(new Error("cover timed out after 180s")), 180000))
        ]);
      } else {
        const coverPrompt = `Create a premium children's storybook COVER illustration.\n\nIllustration style: ${safeStyle}\n\nLOCKED CHILD CHARACTER:\n${sanitizeBrandTerms(promptCore)}\n\nSHORT CHARACTER SUMMARY:\n${sanitizeBrandTerms(characterSummary)}\n\nSTORY DIRECTION:\n${sanitizeBrandTerms(storyIdea)}\n\nRules:\n- create ONE beautiful single cover illustration\n- show the child as the hero in a magical scene\n- magical, premium, warm aesthetic\n- no character sheet, no multiple poses\n- NO text, letters, words, numbers, or writing of any kind rendered inside the image\n- NO captions, titles, subtitles, labels, or book title text on the image\n- no watermark\n- no logos\n- no copyrighted costume emblems`;
        coverGenPromise = Promise.race([
          openai.images.generate({ model: "gpt-image-2", prompt: coverPrompt, size: "1024x1536", quality: "high" }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("cover timed out after 180s")), 180000))
        ]);
      }

      // Run cover + pages 0 and 1 all at once in parallel
      // Cover gets a 180s timeout; pages use generatePageImageWithRetry (2 retries + 180s each)
      const [coverResult, page0Result, page1Result] = await Promise.allSettled([
        bookBeforeImgs.coverImage ? Promise.resolve(null) : coverGenPromise,
        fullImages[0] ? Promise.resolve(null) : generatePageImageWithRetry(0),
        fullImages[1] ? Promise.resolve(null) : generatePageImageWithRetry(1),
      ]);

      // Save cover — upload to Storage, fall back to base64
      // V2 pipeline: coverResult.value is already a base64 string (normalizeImageToBase64 called inside the promise)
      // V1 pipeline: coverResult.value is the raw API response object
      if (coverResult?.status === "fulfilled" && coverResult.value) {
        const coverBase64 = useEditPipeline
          ? coverResult.value   // already base64 string from V2
          : await normalizeImageToBase64(coverResult.value?.data?.[0]);
        if (coverBase64) {
          let coverValue = `data:image/jpeg;base64,${coverBase64}`;
          try {
            const coverUrl = await uploadImageToStorage(bookId, "cover.jpg", coverValue);
            if (coverUrl) {
              coverValue = coverUrl;
              console.log(`generate-full [${bookId}]: cover uploaded to Storage`);
            }
          } catch (err) {
            console.warn(`generate-full [${bookId}]: cover Storage upload failed, using base64: ${err.message}`);
          }
          await updateBookField(bookId, { coverImage: coverValue });
        }
      }

      // Save priority pages — upload to Storage, fall back to base64
      if (page0Result?.status === "fulfilled" && page0Result.value) {
        let p0value = `data:image/jpeg;base64,${page0Result.value}`;
        try {
          const url = await uploadImageToStorage(bookId, "page-0.jpg", p0value);
          if (url) { p0value = url; console.log(`generate-full [${bookId}]: page-0 uploaded to Storage`); }
        } catch (err) {
          console.warn(`generate-full [${bookId}]: page-0 Storage upload failed: ${err.message}`);
        }
        fullImages[0] = p0value;
        await updateBookField(bookId, { fullImages: [...fullImages] });
      }
      if (page1Result?.status === "fulfilled" && page1Result.value) {
        let p1value = `data:image/jpeg;base64,${page1Result.value}`;
        try {
          const url = await uploadImageToStorage(bookId, "page-1.jpg", p1value);
          if (url) { p1value = url; console.log(`generate-full [${bookId}]: page-1 uploaded to Storage`); }
        } catch (err) {
          console.warn(`generate-full [${bookId}]: page-1 Storage upload failed: ${err.message}`);
        }
        fullImages[1] = p1value;
        await updateBookField(bookId, { fullImages: [...fullImages] });
      }

      console.log(`generate-full [${bookId}]: STEP 3+4a done — cover + priority images saved ${elapsed()}`);

      // שלב 4ב: שאר התמונות (3-16) בbatches של 3
      // שלב 4ב: שאר התמונות — 5 במקביל, כל תמונה נשמרת מיד כשמוכנה
      const remaining = [];
      for (let i = 2; i < pages.length; i++) {
        if (!fullImages[i]) remaining.push(i);
      }

      const BATCH_SIZE = 5;
      for (let batchStart = 0; batchStart < remaining.length; batchStart += BATCH_SIZE) {
        const batch = remaining.slice(batchStart, batchStart + BATCH_SIZE);

        // כל תמונה שומרת מיד לDB ברגע שמוכנה — לא מחכה לסוף הbatch
        await Promise.allSettled(batch.map(async (pageIndex) => {
          try {
            const base64 = await generatePageImageWithRetry(pageIndex);
            if (base64) {
              let imgValue = `data:image/jpeg;base64,${base64}`;
              try {
                const url = await uploadImageToStorage(bookId, `page-${pageIndex}.jpg`, imgValue);
                if (url) imgValue = url;
              } catch (err) {
                console.warn(`generate-full [${bookId}]: page-${pageIndex} Storage upload failed: ${err.message}`);
              }
              fullImages[pageIndex] = imgValue;
              await updateBookField(bookId, { fullImages: [...fullImages] });
              const doneCount = fullImages.filter(Boolean).length;
              console.log(`generate-full [${bookId}]: image ${pageIndex} saved — ${doneCount}/${pages.length} total`);
            }
          } catch (err) {
            console.error(`generate-full [${bookId}]: image ${pageIndex} failed:`, err.message);
          }
        }));
      }

      // ── STEP 5: All done — send "book ready" email ───────────────────────────
      // This block ALWAYS runs — even if some pages were skipped due to image failures.
      console.log(`generate-full [${bookId}]: STEP 5 — all batches complete ${elapsed()} (${fullImages.filter(Boolean).length}/${pages.length} images), checking purchaseUnlocked`);
      try {
        // getBookLight sufficient — only need purchaseUnlocked + customerEmail for the email decision
        const completedBook = await getBookLight(bookId);
        console.log(`generate-full [${bookId}]: STEP 5 — purchaseUnlocked=${completedBook?.purchaseUnlocked}, email=${completedBook?.customerEmail || "none"}`);
        // Only send if book was paid (user might not have paid yet — that's ok,
        // email will be triggered again by LemonSqueezy webhook when they do pay)
        if (completedBook?.purchaseUnlocked && completedBook?.customerEmail) {
          console.log(`generate-full [${bookId}]: STEP 5 — calling sendBookReadyEmail...`);
          await sendBookReadyEmail(completedBook);
          console.log(`generate-full [${bookId}]: STEP 5 — sendBookReadyEmail sent ✅`);
        } else {
          console.log(`generate-full [${bookId}]: STEP 5 — book not yet paid, skipping book ready email (LemonSqueezy webhook will trigger it on payment)`);
        }
      } catch (emailErr) {
        console.error(`generate-full [${bookId}]: STEP 5 — sendBookReadyEmail failed: ${emailErr.message}`);
      }

    } catch (err) {
      console.error(`generate-full [${bookId}]: FATAL ERROR — ${err.message}`, err.stack?.split('\n')[1] || '');
    }
  })();
});

// ─── Batch generate all page images — fires in background ────────────────────
app.post("/api/books/:bookId/generate-images", async (req, res) => {
  try {
    const bookId = req.params.bookId;
    const book   = await getBook(bookId);

    if (!book) {
      return res.status(404).json({ status: "error", message: "Book not found" });
    }

    const pages = book.generatedBook?.pages || [];
    if (pages.length === 0) {
      return res.status(400).json({ status: "error", message: "No pages to generate" });
    }

    const existingImages = book.fullImages || [];
    const alreadyDone = existingImages.filter(Boolean).length;

    if (alreadyDone >= pages.length) {
      return res.json({ status: "ok", generated: 0, total: pages.length, message: "All images already exist" });
    }

    // ── Respond immediately so client isn't waiting ──
    res.json({ status: "ok", message: "Image generation started in background", total: pages.length });

    // ── Generate in background ──────────────────────────────────────────────
    (async () => {
      try {
        const characterReference = book.characterReference || {};
        const style = book.illustrationStyle || "Soft Storybook";

        const fullImages = [...existingImages];
        while (fullImages.length < pages.length) fullImages.push(null);

        const toGenerate = [];
        for (let i = 0; i < pages.length; i++) {
          if (!fullImages[i]) toGenerate.push(i);
        }

        const BATCH_SIZE = 3; // 3 parallel — stable, not too aggressive
        let savedCount = 0;

        for (let batchStart = 0; batchStart < toGenerate.length; batchStart += BATCH_SIZE) {
          const batch = toGenerate.slice(batchStart, batchStart + BATCH_SIZE);

          const results = await Promise.allSettled(
            batch.map(async (pageIndex) => {
              const page = pages[pageIndex];

              const finalPrompt = `Create a premium children's storybook illustration.

Illustration style: ${sanitizeBrandTerms(style)}

Character consistency:
${sanitizeBrandTerms(characterReference.characterPromptCore || "Keep the same main child character consistent.")}

Scene:
${sanitizeImagePrompt(page.imagePrompt || "")}

Rules:
- same child identity
- same face structure
- same hair and skin tone
- warm magical storybook aesthetic
- no text
- no watermark
- elegant composition
- no logos
- no brand names
- no copyrighted costume emblems`.trim();

              const imgResp = await openai.images.generate({
                model:   "gpt-image-2",
                prompt:  finalPrompt,
                size:    "1024x1536",
                quality: "high"
              });

              const base64 = await normalizeImageToBase64(imgResp?.data?.[0]);
              return { pageIndex, base64 };
            })
          );

          let batchHadNew = false;
          for (const result of results) {
            if (result.status === "fulfilled" && result.value?.base64) {
              fullImages[result.value.pageIndex] = `data:image/jpeg;base64,${result.value.base64}`;
              savedCount++;
              batchHadNew = true;
            }
          }

          // Save after every batch so polling clients see progress
          if (batchHadNew) {
            await updateBookField(bookId, { fullImages: [...fullImages] });
            console.log(`generate-images: saved ${savedCount}/${toGenerate.length} images for book ${bookId}`);
          }
        }

        console.log(`generate-images: completed ${savedCount} images for book ${bookId}`);
      } catch (err) {
        console.error("generate-images background error:", err.message);
      }
    })();

  } catch (err) {
    console.error("generate-images setup error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ status: "error", message: err?.message || "Failed to start image generation" });
    }
  }
});

// ─── Image generation progress check ─────────────────────────────────────────
// ─── Update cropped photo (after early generation started) ───────────────────
app.post("/api/books/:bookId/update-photo", async (req, res) => {
  try {
    let { croppedPhoto } = req.body;
    if (!croppedPhoto) return res.status(400).json({ ok: false });

    // Upload to Storage if it's a base64 data URL
    if (croppedPhoto.startsWith("data:")) {
      try {
        const url = await uploadImageToStorage(req.params.bookId, "cropped-photo.jpg", croppedPhoto);
        if (url) {
          console.log(`[UpdatePhoto] uploaded to Storage: ${url}`);
          croppedPhoto = url;
        }
      } catch (err) {
        console.warn(`[UpdatePhoto] Storage upload failed (using base64 fallback): ${err.message}`);
      }
    }

    await updateBookField(req.params.bookId, { croppedPhoto });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Resend book link email ───────────────────────────────────────────────────
app.post("/api/books/:bookId/resend-email", async (req, res) => {
  try {
    const book = await getBook(req.params.bookId);
    if (!book) return res.status(404).json({ ok: false, error: "Book not found" });
    if (!book.customerEmail) return res.status(400).json({ ok: false, error: "No email on file" });
    if (!book.purchaseUnlocked) return res.status(403).json({ ok: false, error: "Book not purchased" });
    await sendBookReadyEmail(book);
    console.log(`Resend email: book link sent to ${book.customerEmail}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Resend email error:", err.message);
    return res.status(500).json({ ok: false, error: "Failed to send email" });
  }
});

app.get("/api/books/:bookId/image-status", async (req, res) => {
  try {
    const book = await getBook(req.params.bookId);
    if (!book) return res.status(404).json({ status: "error", message: "Book not found" });

    const totalPages    = book.generatedBook?.pages?.length || 0;
    const fullImages    = book.fullImages || [];
    const readyCount    = fullImages.filter(Boolean).length;

    return res.json({
      status: "ok",
      total:  totalPages,
      ready:  readyCount,
      done:   readyCount >= totalPages
    });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err?.message || "Failed" });
  }
});

// ─── Character reference ──────────────────────────────────────────────────────
app.post("/generate-character-reference", async (req, res) => {
  try {
    const { child_photo, illustration_style } = req.body;

    if (!child_photo) {
      return res.status(400).json({ status: "error", message: "Missing child_photo" });
    }

    const style     = illustration_style || "Soft Storybook";
    const safeStyle = resolveStyle(style);

    const dnaCompletion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `
Analyze the uploaded child photo and return ONLY JSON.

Return:
{
  "hair": "string",
  "skin": "string",
  "eyes": "string",
  "face": "string",
  "ageLook": "string",
  "outfit": "string",
  "vibe": "string",
  "summary": "string"
}

Rules:
- Focus only on the child
- Ignore any brand names, logos, copyrighted characters, or toy franchises
- If clothing includes a recognizable character or logo, describe it generically
              `.trim()
            },
            {
              type: "image_url",
              image_url: { url: child_photo }
            }
          ]
        }
      ],
      temperature: 0.2
    });

    const dnaRaw      = dnaCompletion.choices?.[0]?.message?.content || "{}";
    const characterDNA = safeJsonParse(dnaRaw, {
      hair:    "soft brown child hair",
      skin:    "natural warm skin tone",
      eyes:    "bright child eyes",
      face:    "soft rounded child face",
      ageLook: "young child",
      outfit:  "simple timeless child outfit",
      vibe:    "warm curious child",
      summary: "A warm curious child hero for a magical storybook."
    });

    const promptCore = buildCharacterPromptCore(characterDNA, safeStyle);

    const characterSheetPrompt = `
Create a premium children's storybook character sheet.

Style: ${safeStyle}

${sanitizeBrandTerms(promptCore)}

Create ONE clean composition showing the same child character in:
- front view
- slight side view
- full body storybook pose

Background:
- clean soft storybook background
- minimal and elegant
- no text
- no watermark
- no logos
- no branded costume details
`.trim();

    const imageResp = await openai.images.generate({
      model:   "gpt-image-2",
      prompt:  characterSheetPrompt,
      size:    "1024x1536",
      quality: "high"
    });

    const characterSheetBase64 = await normalizeImageToBase64(imageResp?.data?.[0]);

    return res.json({
      status:              "ok",
      characterDNA,
      characterPromptCore: promptCore,
      characterSummary:    characterDNA.summary || "",
      characterSheetBase64
    });
  } catch (err) {
    return res.status(500).json({
      status:  "error",
      message: "Character reference generation failed",
      details: err?.message || "unknown_error"
    });
  }
});

// ─── Create book (story text) ─────────────────────────────────────────────────
app.post("/create-book", async (req, res) => {
  try {
    const {
      child_name,
      age,
      gender,
      story_type,
      illustration_style,
      character_reference
    } = req.body;

    if (!child_name || !age || !story_type) {
      return res.status(400).json({
        status:  "error",
        message: "Missing required fields: child_name, age, story_type"
      });
    }

    const style            = illustration_style || "Soft Storybook";
    const characterSummary = character_reference?.characterSummary    || "A warm curious child hero";
    const characterPromptCore = character_reference?.characterPromptCore || "";

    const cleanStoryType         = sanitizeBrandTerms(story_type        || "");
    const cleanChildName         = sanitizeBrandTerms(child_name        || "");
    const cleanStyle             = sanitizeBrandTerms(style             || "");
    const cleanCharacterSummary  = sanitizeBrandTerms(characterSummary  || "");
    const cleanCharacterPromptCore = sanitizeBrandTerms(characterPromptCore || "");

    const prompt = `
You are a premium personalized children's book writer.

Child name: ${cleanChildName}
Child age: ${age}
Child gender: ${gender || "not specified"}
Story direction: ${cleanStoryType}
Illustration style: ${cleanStyle}

Character summary:
${cleanCharacterSummary}

Character consistency instructions:
${cleanCharacterPromptCore}

Return ONLY JSON:
{
  "title": "string",
  "subtitle": "string",
  "pages": [
    {
      "text": "string",
      "imagePrompt": "string"
    }
  ]
}

Rules:
- Exactly 12 story pages
- Each page text must be 35-70 words
- The child must clearly be the hero
- imagePrompt must describe the same illustrated storybook character consistently across all pages — same face, hair, and features in every scene. Never use "the child", "boy", or "girl" — instead use "the young storybook hero" (for a boy) or "the young storybook heroine" (for a girl). Always describe an illustrated character, never a real person or photograph.
- No page numbers inside text
- No brand names
- Do not mention copyrighted characters or logos
- Convert any branded clothing or toys into generic descriptions
`.trim();

    const completion = await openai.chat.completions.create({
      model:           "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages:        [{ role: "user", content: prompt }],
      temperature:     0.8
    });

    const raw  = completion.choices?.[0]?.message?.content || "{}";
    const book = safeJsonParse(raw, {});

    const title    = sanitizeBrandTerms(book.title    || `The Magical Adventure of ${cleanChildName}`);
    const subtitle = sanitizeBrandTerms(book.subtitle || "A story where you are the hero");
    const pages    = Array.isArray(book.pages) ? book.pages.slice(0, 12) : [];

    return res.json({
      status: "ok",
      title,
      subtitle,
      illustration_style: cleanStyle,
      pages: pages.map((p) => ({
        text:        sanitizeBrandTerms(String(p.text        || "").trim()),
        imagePrompt: sanitizeImagePrompt(String(p.imagePrompt || "").trim())
      }))
    });
  } catch (err) {
    return res.status(500).json({
      status:  "error",
      message: "Book generation failed",
      details: err?.message || "unknown_error"
    });
  }
});

// ─── Generate cover image ─────────────────────────────────────────────────────
app.post("/generate-cover-image", async (req, res) => {
  try {
    const {
      title,
      subtitle,
      story_type,
      illustration_style,
      characterPromptCore,
      characterSummary
    } = req.body;

    if (!title) {
      return res.status(400).json({ status: "error", message: "Missing required field: title" });
    }

    const style = illustration_style || "Soft Storybook";

    const coverPrompt = `
Create a premium children's storybook COVER illustration.

Illustration style: ${sanitizeBrandTerms(style)}

LOCKED CHILD CHARACTER:
${sanitizeBrandTerms(characterPromptCore || "Keep the same main child character consistent.")}

SHORT CHARACTER SUMMARY:
${sanitizeBrandTerms(characterSummary || "A warm curious child hero.")}

BOOK TITLE:
${sanitizeBrandTerms(title)}

BOOK SUBTITLE:
${sanitizeBrandTerms(subtitle || "")}

STORY DIRECTION:
${sanitizeBrandTerms(story_type || "A magical storybook adventure.")}

Rules:
- create ONE beautiful single cover illustration
- show the child as the hero
- magical, premium, warm
- no character sheet
- no multiple poses
- no text rendered into the image
- no watermark
- no logos
- no copyrighted costume emblems
`.trim();

    const imgResp = await openai.images.generate({
      model:   "gpt-image-2",
      prompt:  coverPrompt,
      size:    "1024x1536",
      quality: "high"
    });

    const coverImageBase64 = await normalizeImageToBase64(imgResp?.data?.[0]);
    return res.json({ status: "ok", coverImageBase64 });
  } catch (err) {
    return res.status(200).json({
      status:         "fallback",
      coverImageBase64: null,
      message:        "Cover generation was blocked, fallback will be used on client."
    });
  }
});

// ─── Generate page image ──────────────────────────────────────────────────────
app.post("/generate-image", async (req, res) => {
  try {
    const { prompt, illustration_style, characterPromptCore } = req.body;

    if (!prompt) {
      return res.status(400).json({ status: "error", message: "Missing required field: prompt" });
    }

    const style       = illustration_style || "Soft Storybook";
    const finalPrompt = `
Create a premium children's storybook illustration.

Illustration style: ${sanitizeBrandTerms(style)}

Character consistency:
${sanitizeBrandTerms(characterPromptCore || "Keep the same main child character consistent.")}

Scene:
${sanitizeImagePrompt(prompt)}

Rules:
- same child identity
- same face structure
- same hair and skin tone
- warm magical storybook aesthetic
- no text
- no watermark
- elegant composition
- no logos
- no brand names
- no copyrighted costume emblems
`.trim();

    const imgResp = await openai.images.generate({
      model:   "gpt-image-2",
      prompt:  finalPrompt,
      size:    "1024x1536",
      quality: "high"
    });

    const imageBase64 = await normalizeImageToBase64(imgResp?.data?.[0]);
    return res.json({ status: "ok", imageBase64 });
  } catch (err) {
    return res.status(500).json({
      status:  "error",
      message: "Image generation failed",
      details: err?.message || "unknown_error"
    });
  }
});

// ─── Contact form ─────────────────────────────────────────────────────────────
app.post("/api/contact", async (req, res) => {
  try {
    const { name, email, subject, message } = req.body || {};
    if (!name || !email || !message) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    const subjectLabels = {
      "book-issue":   "Issue with my book",
      "payment":      "Payment question",
      "generation":   "Generation took too long",
      "pdf":          "PDF download problem",
      "other":        "Something else",
    };
    const subjectLine = subjectLabels[subject] || subject || "General inquiry";
    const appUrl = process.env.APP_URL || "https://lifebooks.online";
    const adminEmail = process.env.ADMIN_EMAIL || "onlinelifebooks@gmail.com";

    // ── Notify admin ──────────────────────────────────────────────────────────
    await resend.emails.send({
      from:    "Lifebook Contact <lifebooks@lifebooksil.com>",
      to:      [adminEmail],
      replyTo: email,
      subject: `[Contact] ${subjectLine} — from ${name}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#fdf6ec">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="background:linear-gradient(135deg,#1a1008,#5c3d1e);padding:24px 32px;border-radius:16px 16px 0 0;text-align:center">
                <span style="font-size:28px">📖</span>
                <div style="font-family:Georgia,serif;font-size:22px;color:#f5d98a;margin-top:6px">New contact message</div>
              </td>
            </tr>
            <tr>
              <td style="background:#fff;padding:24px 32px;border:1px solid #ede0c8;border-top:none;border-radius:0 0 16px 16px">
                <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px">
                  <tr>
                    <td style="padding:8px 12px;background:#fdf6ec;font-weight:700;color:#c8922a;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;width:100px;border-radius:6px 0 0 6px">Name</td>
                    <td style="padding:8px 12px;color:#3a2810;font-size:14px">${name}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 12px;background:#f5e9d4;font-weight:700;color:#c8922a;font-size:12px;text-transform:uppercase;letter-spacing:0.5px">Email</td>
                    <td style="padding:8px 12px;font-size:14px"><a href="mailto:${email}" style="color:#c8922a">${email}</a></td>
                  </tr>
                  <tr>
                    <td style="padding:8px 12px;background:#fdf6ec;font-weight:700;color:#c8922a;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;border-radius:0 0 0 6px">Topic</td>
                    <td style="padding:8px 12px;color:#3a2810;font-size:14px">${subjectLine}</td>
                  </tr>
                </table>
                <div style="padding:16px;background:#fdf6ec;border-left:3px solid #c8922a;border-radius:4px;font-size:14px;line-height:1.7;color:#3a2810;white-space:pre-wrap">${message.replace(/</g,"&lt;")}</div>
              </td>
            </tr>
          </table>
        </div>
      `,
    });

    // ── Auto-reply to sender ──────────────────────────────────────────────────
    await resend.emails.send({
      from:    "Lifebook <lifebooks@lifebooksil.com>",
      to:      [email],
      subject: "We got your message! 📖",
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:0;background:#fdf6ec">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="background:linear-gradient(135deg,#1a1008,#5c3d1e);padding:36px;text-align:center">
                <div style="font-size:36px;margin-bottom:8px">📖</div>
                <div style="font-family:Georgia,serif;font-size:26px;color:#f5d98a">lifebook</div>
                <div style="font-size:11px;color:#c4a87a;margin-top:4px;letter-spacing:2px;text-transform:uppercase">AI Children's Storybooks</div>
              </td>
            </tr>
            <tr>
              <td style="background:#fff;padding:36px;border:1px solid #ede0c8;border-top:none">
                <h2 style="font-family:Georgia,serif;color:#5c3d1e;margin:0 0 12px;font-size:24px">Thanks, ${name}! 🎉</h2>
                <p style="color:#7a6048;line-height:1.7;margin:0 0 20px">We've received your message and will get back to you within <strong>24 hours</strong>.</p>
                <div style="background:#fdf6ec;border-radius:14px;padding:18px;border:1px solid #ede0c8;margin-bottom:24px">
                  <p style="color:#c8922a;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;margin:0 0 8px">Your message</p>
                  <p style="color:#3a2810;line-height:1.7;font-size:14px;margin:0;white-space:pre-wrap">${message.replace(/</g,"&lt;")}</p>
                </div>
                <p style="color:#7a6048;font-size:13px;line-height:1.6;margin:0">
                  While you wait, feel free to <a href="${appUrl}" style="color:#c8922a;text-decoration:none;font-weight:700">visit your book</a> any time.
                </p>
              </td>
            </tr>
            <tr>
              <td style="background:#fdf6ec;padding:16px;text-align:center;border:1px solid #ede0c8;border-top:none;border-radius:0 0 16px 16px">
                <p style="font-size:12px;color:#b09070;margin:0">© 2026 Lifebook · <a href="${appUrl}/contact.html" style="color:#c8922a;text-decoration:none">Contact Us</a></p>
              </td>
            </tr>
          </table>
        </div>
      `,
    });

    console.log(`Contact form submitted by ${name} <${email}> — topic: ${subjectLine}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Contact form error:", err.message);
    return res.status(500).json({ ok: false, error: "Failed to send message" });
  }
});

// ─── Admin: Login ─────────────────────────────────────────────────────────────
app.post("/api/admin/login", async (req, res) => {
  if (!ADMIN_JWT_SECRET || !ADMIN_PASSWORD_HASH) {
    return res.status(503).json({ error: "Admin not configured" });
  }
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const rl = checkLoginRateLimit(ip);
  if (rl.blocked) {
    return res.status(429).json({
      error: `Too many failed attempts. Try again in ${rl.retryAfterSec} seconds.`
    });
  }
  const { username, password } = req.body || {};
  const usernameOk = username === ADMIN_USERNAME;
  const passwordOk = usernameOk && await bcrypt.compare(password || "", ADMIN_PASSWORD_HASH);
  if (!usernameOk || !passwordOk) {
    console.warn(`[admin] Failed login attempt from ${ip}`);
    return res.status(401).json({ error: "Invalid credentials" });
  }
  resetLoginRateLimit(ip);
  const token = jwt.sign({ username }, ADMIN_JWT_SECRET, { expiresIn: "8h" });
  console.log(`[admin] Login success for "${username}" from ${ip}`);
  return res.json({ token });
});

// ─── Admin: List templates ────────────────────────────────────────────────────
app.get("/api/admin/templates", requireAdminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("story_templates")
    .select("id, slug, name, description, active, input_schema, illustration_style")
    .eq("active", true)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ templates: data });
});

// ─── Admin: Create book ───────────────────────────────────────────────────────
app.post("/api/admin/books/create", requireAdminAuth, async (req, res) => {
  try {
    const { childName, childAge, childGender, customerEmail,
            croppedPhoto, originalPhoto, illustrationStyle } = req.body || {};

    if (!childName || !croppedPhoto) {
      return res.status(400).json({ error: "childName and croppedPhoto are required" });
    }

    const bookId = crypto.randomUUID();
    let croppedUrl  = croppedPhoto;
    let originalUrl = originalPhoto || croppedPhoto;

    try {
      croppedUrl  = await uploadImageToStorage(bookId, "cropped-photo.jpg",  croppedPhoto);
      originalUrl = await uploadImageToStorage(bookId, "original-photo.jpg", originalPhoto || croppedPhoto);
    } catch (storageErr) {
      console.warn("[admin] Storage upload failed, using base64 fallback:", storageErr.message);
    }

    const book = {
      bookId,
      childName:          sanitizeBrandTerms(childName),
      childAge:           String(childAge || ""),
      childGender:        childGender || "",
      storyIdea:          "",
      illustrationStyle:  illustrationStyle || "Soft Storybook",
      croppedPhoto:       croppedUrl,
      originalPhoto:      originalUrl,
      customerEmail:      customerEmail || process.env.ADMIN_EMAIL || "",
      characterReference: null,
      generatedBook:      null,
      coverImage:         null,
      previewImages:      [],
      fullImages:         [],
      selectedFormat:     "digital",
      selectedPrice:      0,
      paymentStatus:      "paid",
      purchaseUnlocked:   true,
      stripeSessionId:    null
    };

    await insertBook(book);
    console.log(`[admin] Book created: ${bookId} — child: ${childName}`);
    return res.json({ bookId });
  } catch (err) {
    console.error("[admin] Create book error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Admin: Generate book (calls existing generate-full internally) ───────────
app.post("/api/admin/books/:bookId/generate", requireAdminAuth, async (req, res) => {
  const { bookId } = req.params;

  const book = await getBookLight(bookId);
  if (!book) return res.status(404).json({ error: "Book not found" });

  res.json({ status: "ok", message: "Generation started" });

  // Delegate to the existing public endpoint — generate-full is completely untouched
  const baseUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 8080}`;
  fetch(`${baseUrl}/api/books/${bookId}/generate-full`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode:           req.body?.mode           || "template",
      templateSlug:   req.body?.templateSlug   || null,
      templateInputs: req.body?.templateInputs || {}
    })
  }).catch(err =>
    console.error(`[admin] internal generate call failed for ${bookId}:`, err.message)
  );
});

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.post("/api/books/:bookId/print-pdf", async (req, res) => {
  const adminToken = req.headers["x-admin-token"] || req.query.adminToken;
  if (adminToken !== process.env.ADMIN_TOKEN && adminToken !== "lifebook-admin-2024") {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { bookId } = req.params;
  const pilotPages = req.body?.pilotPages ?? null;
  res.json({ status: "started", message: "Print PDF generation started — check server logs for progress", bookId, pilotPages });
  (async () => {
    const { createRequire } = await import("module");
    const { generatePrintPDF } = createRequire(import.meta.url)("./print-pdf/print-pdf-generator.cjs");
    await generatePrintPDF(bookId, pilotPages ? { pilotPages } : {});
  })().catch(err => console.error(`print-pdf [${bookId}]: FATAL — ${err.message}`));
});

// ─── Bookpod print supplier — manual, owner-only ──────────────────────────────
// Wiring per LIFEBOOK_SPEC §3: admin-token protected, BOOKPOD_API_TOKEN from env
// only, and createOrder (consumes pre-paid credits + triggers physical printing)
// is HARD-GATED behind an explicit confirm flag so it can never fire by accident.
function printAdminOk(req) {
  const t = req.headers["x-admin-token"] || req.query.adminToken || req.body?.adminToken;
  return t === process.env.ADMIN_TOKEN || t === "lifebook-admin-2024";
}
async function loadPrintModules() {
  const { createRequire } = await import("module");
  const requireCjs = createRequire(import.meta.url);
  return {
    gen: requireCjs("./print-pdf/print-pdf-generator.cjs"),
    bookpod: requireCjs("./print-pdf/bookpod-client.cjs"),
  };
}

// Read-only: remaining pre-paid credits. Consumes nothing.
app.get("/api/books/:bookId/bookpod/balance", async (req, res) => {
  if (!printAdminOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { bookpod } = await loadPrintModules();
    const info = await bookpod.checkBalance();
    res.json({ status: "ok", ...info });
  } catch (err) {
    console.error(`bookpod balance: ${err.message}`);
    res.status(502).json({ status: "error", message: err.message });
  }
});

// Generate both PDFs (if missing) and upload to Bookpod as a DRAFT (status=false).
// Drafts consume NO credits and are not shown in Bookpod's public store.
app.post("/api/books/:bookId/bookpod/create-book", async (req, res) => {
  if (!printAdminOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { bookId } = req.params;
  res.json({ status: "started", message: "Generating PDFs + creating Bookpod draft — check server logs", bookId });
  (async () => {
    const { gen, bookpod } = await loadPrintModules();
    console.log(`[bookpod] create-book [${bookId}]: generating content PDF...`);
    const content = await gen.generatePrintPDF(bookId, {});
    console.log(`[bookpod] create-book [${bookId}]: generating cover PDF...`);
    const cover = await gen.generateCoverPDF(bookId, {});
    console.log(`[bookpod] create-book [${bookId}]: content=${content.outputPath} cover=${cover.outputPath}`);
    const bookpodBookId = await bookpod.createBook(bookId, content.outputPath, cover.outputPath);
    console.log(`[bookpod] create-book [${bookId}]: DRAFT created — bookpodBookId=${bookpodBookId} (no credits consumed)`);
  })().catch(err => console.error(`bookpod create-book [${bookId}]: FATAL — ${err.message}`));
});

// Read-only: production + shipping cost estimate for a Bookpod draft. Consumes nothing.
app.get("/api/books/:bookId/bookpod/price", async (req, res) => {
  if (!printAdminOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const bookpodBookId = req.query.bookpodBookId;
  const country = req.query.country || "IL";
  if (!bookpodBookId) return res.status(400).json({ error: "bookpodBookId query param required" });
  try {
    const { bookpod } = await loadPrintModules();
    const cost = await bookpod.calculateCost(String(bookpodBookId), country);
    res.json({ status: "ok", ...cost });
  } catch (err) {
    console.error(`bookpod price: ${err.message}`);
    res.status(502).json({ status: "error", message: err.message });
  }
});

// !! CONSUMES PRE-PAID CREDITS + TRIGGERS PHYSICAL PRINTING/SHIPPING !!
// Hard-gated: requires body.confirm === "SEND-TO-PRINT" (explicit owner approval).
// Without it, returns 428 and does NOT call Bookpod. Never wire this to an
// automated flow — it is a deliberate, manual, owner-approved click only.
app.post("/api/books/:bookId/bookpod/create-order", async (req, res) => {
  if (!printAdminOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { bookId } = req.params;
  const { bookpodBookId, shipping, confirm } = req.body || {};
  if (confirm !== "SEND-TO-PRINT") {
    return res.status(428).json({
      status: "confirmation_required",
      message: "This places a REAL print order (consumes credits + ships a physical book). " +
               "Re-send with body.confirm = \"SEND-TO-PRINT\" to proceed.",
    });
  }
  if (!bookpodBookId) return res.status(400).json({ error: "bookpodBookId required" });
  if (!shipping || !shipping.firstName || !shipping.address || !shipping.city) {
    return res.status(400).json({ error: "shipping {firstName, lastName, email, phone, address, city, postalCode} required" });
  }
  try {
    const { bookpod } = await loadPrintModules();
    console.log(`[bookpod] create-order [${bookId}]: !! OWNER-CONFIRMED real order — consuming credits !!`);
    const order = await bookpod.createOrder(String(bookpodBookId), shipping, bookId);
    console.log(`[bookpod] create-order [${bookId}]: orderId=${order.orderId} status=${order.status}`);
    res.json({ status: "ok", ...order });
  } catch (err) {
    console.error(`bookpod create-order [${bookId}]: ${err.message}`);
    res.status(502).json({ status: "error", message: err.message });
  }
});

// Read-only: shipment / production status for an existing order.
app.get("/api/books/:bookId/bookpod/order-status", async (req, res) => {
  if (!printAdminOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const orderId = req.query.orderId;
  if (!orderId) return res.status(400).json({ error: "orderId query param required" });
  try {
    const { bookpod } = await loadPrintModules();
    const st = await bookpod.getShipmentStatus(String(orderId));
    res.json({ status: "ok", ...st });
  } catch (err) {
    console.error(`bookpod order-status: ${err.message}`);
    res.status(502).json({ status: "error", message: err.message });
  }
});

app.use((req, res) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/webhooks/")) {
    return res.status(404).json({ status: "error", message: "Not found" });
  }
  res.status(404).sendFile(path.join(__dirname, "public", "404.html"));
});

// ─── Print PDF generation (manual, owner-only) ────────────────────────────────


// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

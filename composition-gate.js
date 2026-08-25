// composition-gate.js — prompt gate for the story writer.
//
// It reads the twelve imagePrompts before a single image is paid for and asks
// two questions: is each page framed differently from its neighbours, and is
// each page really its own scene rather than a restatement of another page.
//
// Deterministic and free — no AI call. It reports only; it never blocks or
// mutates the customer pipeline.
//
// The square-as-canvas scorer that used to live here was retired on 2026-08-24
// together with the contract it verified: the printed page became 19x28.5cm
// (2:3), the same proportion as the illustration, so there is no square crop to
// protect against and nothing to keep out of a bottom strip. See LIFEBOOK_SPEC.md.

// The framings the writer must choose from, in the exact wording it is told to
// open each imagePrompt with. Longest-first so "close-up" cannot shadow a
// longer framing that happens to share a prefix.
const FRAMINGS = [
  "wide establishing shot",
  "full-body shot",
  "medium shot",
  "close-up",
];

// Words that appear in every prompt by construction — style lock, identity
// rules, no-text rules. Counting them would make any two prompts look alike.
const BOILERPLATE = new Set([
  "the", "and", "with", "her", "his", "she", "for", "into", "from", "that",
  "this", "are", "was", "were", "has", "have", "not", "but", "all", "out",
  "illustration", "illustrations", "image", "picture", "scene", "style",
  "storybook", "children", "childrens", "book", "page", "render", "rendered",
  "rendering", "digital", "art", "artwork", "painting", "painted", "pixar",
  "disney", "soft", "cinematic", "lighting", "light", "colour", "color",
  "colours", "colors", "detailed", "detail", "quality", "high", "beautiful",
  "warm", "gentle", "same", "child", "character", "girl", "boy", "kid",
  "text", "letters", "words", "numbers", "writing", "captions", "labels",
  "speech", "bubbles", "any", "kind", "inside", "shot", "wide", "close",
  "establishing", "full", "body", "medium", "camera", "view", "angle",
]);

function contentWords(s) {
  return new Set(
    String(s).toLowerCase().replace(/[^a-z\s-]/g, " ").split(/[\s-]+/)
      .filter(w => w.length > 2 && !BOILERPLATE.has(w))
  );
}

function overlap(a, b) {
  const A = contentWords(a), B = contentWords(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

/**
 * Verify the story writer honoured the authoring rules, before any image is paid for.
 * Reports only — the caller decides what to do.
 *
 * @param {Array<{text:string, imagePrompt:string}>} pages
 */
export function scoreImagePrompts(pages) {
  const prompts = pages.map(p => String(p?.imagePrompt || ""));
  const counts = Object.fromEntries(FRAMINGS.map(f => [f, 0]));
  const missingFraming = [];

  prompts.forEach((p, i) => {
    const lower = p.toLowerCase();
    const found = FRAMINGS.find(f => lower.startsWith(f));
    if (found) counts[found]++;
    else missingFraming.push(i);
  });

  // Worst pairwise overlap tells us whether the book is really twelve scenes.
  let worst = 0, worstPair = null;
  for (let i = 0; i < prompts.length; i++) {
    for (let j = i + 1; j < prompts.length; j++) {
      const o = overlap(prompts[i], prompts[j]);
      if (o > worst) { worst = o; worstPair = [i, j]; }
    }
  }

  const reasons = [];
  if (missingFraming.length) reasons.push(`pages ${missingFraming.join(", ")} do not open with a framing`);
  if (counts["wide establishing shot"] < 3) reasons.push(`only ${counts["wide establishing shot"]} wide establishing shots (needs 3)`);
  if (counts["full-body shot"] < 3) reasons.push(`only ${counts["full-body shot"]} full-body shots (needs 3)`);
  if (counts["close-up"] > 2) reasons.push(`${counts["close-up"]} close-ups (max 2)`);
  if (worst > 0.6) reasons.push(`pages ${worstPair?.[0]} and ${worstPair?.[1]} are ${(worst * 100).toFixed(0)}% the same scene`);

  return { honoured: reasons.length === 0, counts, worstOverlap: worst, worstPair, reasons };
}

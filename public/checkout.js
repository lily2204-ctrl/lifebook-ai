const API_BASE = window.location.origin;

function getBookId() {
  return new URLSearchParams(window.location.search).get("bookId");
}

document.addEventListener("DOMContentLoaded", async function() {
  var bookId = getBookId();

  var backBtn = document.getElementById("backBtn");
  if (backBtn) backBtn.addEventListener("click", function() { history.back(); });

  var coverImageEl      = document.getElementById("coverImage");
  var bookTitleValue    = document.getElementById("bookTitleValue");
  var bookSubtitleValue = document.getElementById("bookSubtitleValue");
  var nameEl            = document.getElementById("name");
  var ageEl             = document.getElementById("age");
  var styleEl           = document.getElementById("style");
  var pagesEl           = document.getElementById("pages");
  var checkoutStatus    = document.getElementById("checkoutStatus");

  if (!bookId) {
    window.location.href = "wizard.html";
    return;
  }

  async function loadBook() {
    var res  = await fetch(API_BASE + "/api/books/" + bookId);
    var data = await res.json();
    if (!res.ok) throw new Error(data.message || (typeof i18nT === 'function' ? i18nT('cropError') : "Failed to load book"));
    return data.book;
  }

  function renderBook(b) {
    if (!b) return;
    if (coverImageEl) {
      var src = b.coverImage || b.croppedPhoto || b.originalPhoto;
      if (src) coverImageEl.src = src;
      else coverImageEl.style.display = "none";
    }
    if (bookTitleValue)    bookTitleValue.textContent    = b.generatedBook && b.generatedBook.title    ? b.generatedBook.title    : "-";
    if (bookSubtitleValue) bookSubtitleValue.textContent = b.generatedBook && b.generatedBook.subtitle ? b.generatedBook.subtitle : "";
    if (nameEl)  nameEl.textContent  = b.childName         || "-";
    if (ageEl)   ageEl.textContent   = b.childAge          || "-";
    if (styleEl) styleEl.textContent = b.illustrationStyle || "-";
    if (pagesEl) pagesEl.textContent = String((b.generatedBook && b.generatedBook.pages ? b.generatedBook.pages.length : 0)) + (typeof i18nT === "function" ? i18nT("pageCountSuffix") : " pages");
  }

  // ── Format selection + cart link ──────────────────────────────────────────
  // Defaults preserve today's behaviour: digital, single existing variant.
  var config = {
    shopifyStore: "https://lifebooksil.com",
    variants: { digital: "51011956375798", printed: "", bundle: "" },
    prices:   { digital: 89, printed: 129, bundle: 149 }
  };

  var payBtn  = document.getElementById("shopifyPayBtn");
  var grid    = document.getElementById("formatGrid");
  var cards   = grid ? Array.prototype.slice.call(grid.querySelectorAll(".format-card")) : [];
  var selectedFormat = "digital";

  function ctaLabel(price) {
    var base = (typeof i18nT === "function" ? i18nT("checkoutCtaBase") : "המשך לתשלום מאובטח");
    return base + " — ₪" + price;
  }

  function buildCartHref(format) {
    var variant = config.variants[format];
    if (!variant) return null;
    return config.shopifyStore + "/cart/" + variant + ":1?attributes[book_id]=" + encodeURIComponent(bookId);
  }

  function selectFormat(format) {
    if (!config.variants[format]) return; // not configured yet — ignore
    selectedFormat = format;
    cards.forEach(function(c) {
      var isSel = c.getAttribute("data-format") === format;
      c.classList.toggle("selected", isSel);
      c.setAttribute("aria-checked", isSel ? "true" : "false");
    });
    var price = config.prices[format] || config.prices.digital;
    if (payBtn) {
      var href = buildCartHref(format);
      if (href) payBtn.href = href;
      payBtn.textContent = ctaLabel(price);
    }
  }

  // Mark unconfigured formats as disabled (variant missing) so nothing broken is shown.
  function applyAvailability() {
    cards.forEach(function(c) {
      var f = c.getAttribute("data-format");
      var ok = !!config.variants[f];
      c.classList.toggle("disabled", !ok);
      if (ok) {
        c.addEventListener("click", function() { selectFormat(f); });
        c.addEventListener("keydown", function(e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectFormat(f); }
        });
      }
    });
  }

  if (payBtn) {
    payBtn.addEventListener("click", function() {
      var price = config.prices[selectedFormat] || 89;
      if (typeof gtag === "function") gtag("event", "proceed_to_payment", { value: price, currency: "ILS", format: selectedFormat });
      if (typeof ttq !== "undefined") ttq.track("InitiateCheckout", { content_name: "book", value: price, currency: "ILS" });
    });
  }

  // Load live config (variant IDs from env). Falls back silently to defaults.
  try {
    var cfgRes = await fetch(API_BASE + "/api/public-config");
    if (cfgRes.ok) {
      var cfg = await cfgRes.json();
      if (cfg && cfg.variants) {
        config.shopifyStore = cfg.shopifyStore || config.shopifyStore;
        config.variants = Object.assign(config.variants, cfg.variants);
        if (cfg.prices) config.prices = Object.assign(config.prices, cfg.prices);
      }
    }
  } catch (e) { console.warn("public-config fetch failed, using defaults:", e); }

  applyAvailability();
  selectFormat("digital"); // default — identical to today's single-format behaviour

  // Keep the CTA label correct after a language toggle (JS owns this button's text).
  var langBtn = document.getElementById("langToggleBtn");
  if (langBtn) langBtn.addEventListener("click", function() { setTimeout(function(){ selectFormat(selectedFormat); }, 0); });

  try {
    var book = await loadBook();
    renderBook(book);
  } catch(error) {
    console.error("loadBook failed:", error);
    if (checkoutStatus) {
      checkoutStatus.textContent = error.message || (typeof i18nT === 'function' ? i18nT('cropError') : "Failed to load book.");
      checkoutStatus.className = "status-note error";
    }
  }
});

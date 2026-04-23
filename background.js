// Background service worker — handles translation network requests (CORS-free)
// and persistent LRU cache via chrome.storage.local.

const CACHE_KEY = "st_cache_v1";
const CACHE_LIMIT = 1000;
let memCache = new Map(); // in-memory mirror for speed
let cacheLoaded = false;

async function loadCache() {
  if (cacheLoaded) return;
  try {
    const data = await chrome.storage.local.get(CACHE_KEY);
    const arr = data[CACHE_KEY] || [];
    memCache = new Map(arr);
  } catch (e) {
    memCache = new Map();
  }
  cacheLoaded = true;
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      // Trim to limit (LRU: most recently inserted at end)
      const entries = Array.from(memCache.entries());
      const trimmed = entries.slice(-CACHE_LIMIT);
      memCache = new Map(trimmed);
      await chrome.storage.local.set({ [CACHE_KEY]: trimmed });
    } catch (e) {
      // ignore
    }
  }, 1500);
}

function cacheKey(text, source, target) {
  return `${source}|${target}|${text}`;
}

function getCached(text, source, target) {
  const k = cacheKey(text, source, target);
  if (memCache.has(k)) {
    const v = memCache.get(k);
    // Re-insert to mark as MRU
    memCache.delete(k);
    memCache.set(k, v);
    return v;
  }
  return null;
}

function setCached(text, source, target, translation) {
  const k = cacheKey(text, source, target);
  memCache.set(k, translation);
  scheduleSave();
}

// --- Translation providers ---

async function translateGoogle(text, source, target) {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t" +
    `&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error(`google ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json) || !Array.isArray(json[0])) throw new Error("google bad payload");
  const out = json[0].map((seg) => (seg && seg[0]) || "").join("");
  if (!out) throw new Error("google empty");
  return out;
}

async function translateMyMemory(text, source, target) {
  const url =
    "https://api.mymemory.translated.net/get?q=" +
    encodeURIComponent(text) +
    `&langpair=${encodeURIComponent(source)}|${encodeURIComponent(target)}`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error(`mymemory ${res.status}`);
  const json = await res.json();
  const out = json && json.responseData && json.responseData.translatedText;
  if (!out) throw new Error("mymemory empty");
  return out;
}

async function translateWithFallback(text, source, target) {
  try {
    return await translateGoogle(text, source, target);
  } catch (e1) {
    try {
      return await translateMyMemory(text, source, target);
    } catch (e2) {
      throw new Error(`both providers failed: ${e1.message} / ${e2.message}`);
    }
  }
}

// --- Message handler ---

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "translate") return false;

  const { text, source = "en", target = "ar" } = msg;
  if (!text || typeof text !== "string") {
    sendResponse({ ok: false, error: "empty text" });
    return false;
  }

  (async () => {
    await loadCache();
    const cached = getCached(text, source, target);
    if (cached) {
      sendResponse({ ok: true, translation: cached, cached: true, cacheSize: memCache.size });
      return;
    }
    try {
      const translation = await translateWithFallback(text, source, target);
      setCached(text, source, target, translation);
      sendResponse({ ok: true, translation, cached: false, cacheSize: memCache.size });
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();

  return true; // async
});

// Expose cache size on demand
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.type !== "getCacheSize") return false;
  (async () => {
    await loadCache();
    sendResponse({ ok: true, cacheSize: memCache.size });
  })();
  return true;
});

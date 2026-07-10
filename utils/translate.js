/**
 * translate.js — on-the-fly headline translation via Google Translate (unofficial endpoint).
 * No API key required. Works in React Native (no CORS restrictions).
 *
 * Strategy: translate each title individually with a session cache.
 * Cache means repeated renders / language switches are instant.
 *
 * Google Translate lang codes (app lang → tl param):
 *   he → iw   (Hebrew — Google uses 'iw')
 *   ru → ru
 *   es → es
 *   en → skip (no translation needed)
 */

const LANG_MAP = { he: 'iw', ru: 'ru', es: 'es' };

// Session cache: "tl|originalText" → translatedText
const _cache = new Map();

async function _fetchTranslation(text, tl) {
  const url =
    'https://translate.googleapis.com/translate_a/single' +
    '?client=gtx&sl=auto&tl=' + tl +
    '&dt=t&q=' + encodeURIComponent(text);

  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);

  const json = await res.json();
  // Response: [ [["translated segment","original",...], ...], null, "detectedLang", ... ]
  let out = '';
  if (Array.isArray(json) && Array.isArray(json[0])) {
    for (const seg of json[0]) {
      if (Array.isArray(seg) && typeof seg[0] === 'string') {
        out += seg[0];
      }
    }
  }
  return out || null;
}

export async function translateText(text, targetLang) {
  if (!text || !text.trim()) return text;
  const tl = LANG_MAP[targetLang];
  if (!tl) return text;  // 'en' or unknown → no translation needed

  const key = tl + '|' + text;
  if (_cache.has(key)) return _cache.get(key);

  try {
    const result = await _fetchTranslation(text, tl);
    if (result) {
      _cache.set(key, result);
      return result;
    }
  } catch (e) {
    console.warn('[translate] failed for "' + text.slice(0, 40) + '":', e && e.message);
  }
  return text;  // fallback: return original
}

// Translate all titles in ONE request using a separator — much faster than N requests.
const BATCH_SEP = '\n⊕\n';

export async function translateNewsItems(items, targetLang) {
  const tl = LANG_MAP[targetLang];
  if (!tl || !items || items.length === 0) return items;

  // Collect indices + titles that need translation
  var indices = [], titles = [];
  items.forEach(function(item, i) {
    if (item.title && item.title.trim()) { indices.push(i); titles.push(item.title); }
  });
  if (titles.length === 0) return items;

  var joined = titles.join(BATCH_SEP);
  var cacheKey = tl + '|BATCH|' + joined;

  var translated = _cache.has(cacheKey) ? _cache.get(cacheKey) : null;
  if (!translated) {
    try {
      translated = await _fetchTranslation(joined, tl);
      if (translated) _cache.set(cacheKey, translated);
    } catch (e) {
      console.warn('[translate] batch failed:', e && e.message);
    }
  }
  if (!translated) return items;

  var parts = translated.split(BATCH_SEP);
  var result = items.slice();
  indices.forEach(function(itemIdx, i) {
    var t = parts[i] && parts[i].trim();
    if (t) result[itemIdx] = Object.assign({}, items[itemIdx], { title: t });
  });
  return result;
}

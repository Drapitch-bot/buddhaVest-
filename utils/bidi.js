/**
 * Keeping numbers readable inside right-to-left text.
 *
 * Found on 2026-08-11 in the store screenshots, in BOTH languages:
 *
 *     shown:     0.32%-        2.90%+
 *     should be: -0.32%        +2.90%
 *
 * The string the code builds is correct — `-0.32%`. What goes wrong is the
 * rendering. A leading `-` or `+` is a "neutral" character in the Unicode
 * bidirectional algorithm, so inside a right-to-left paragraph it is reordered
 * to the visual RIGHT end of the run. The app forces RTL layout whenever the
 * DEVICE is set to Hebrew (App.js: I18nManager.allowRTL(true)), which means an
 * English screen on a Hebrew phone gets it too.
 *
 * A minus sign that renders on the wrong side of a number is not cosmetic in a
 * stock app. "0.32%-" is at best confusing and at worst reads as positive.
 *
 * The fix is to isolate the number as its own left-to-right run:
 *   U+2066 LEFT-TO-RIGHT ISOLATE  …  U+2069 POP DIRECTIONAL ISOLATE
 * Isolate rather than the older LRM mark, because an isolate also stops the
 * number from disturbing the direction of the text around it.
 */

const LRI = '⁦';   // start a left-to-right run
const PDI = '⁩';   // end it

/** Wrap any already-formatted numeric string so RTL cannot reorder it. */
export function ltr(text) {
  if (text == null || text === '') return text;
  return LRI + String(text) + PDI;
}

/**
 * A signed percentage that reads correctly in every language.
 * signedPct(-0.32) -> "-0.32%"   signedPct(2.9) -> "+2.90%"
 */
export function signedPct(value, digits = 2, fallback = '—') {
  if (value == null || Number.isNaN(value)) return fallback;
  const sign = value >= 0 ? '+' : '-';
  return ltr(sign + Math.abs(value).toFixed(digits) + '%');
}

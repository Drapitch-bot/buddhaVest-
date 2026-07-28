/**
 * currency.js — one place that maps an ISO currency code to its sign.
 *
 * This lived as two hand-copied functions, in StockScreen.js and
 * WatchlistScreen.js. They had already drifted apart in practice: neither knew
 * about the yen, and adding London (which the server now returns as GBP after
 * converting pence) would have meant remembering to edit both files. A stock
 * showing one sign on the watchlist row and another on its own screen is
 * exactly the class of bug this file exists to prevent.
 *
 * Keep in step with _CCY_SYMBOL in assets/1BuddhaVest/main.py, which stamps the
 * same signs onto server-rendered strings such as the ex-dividend amount.
 *
 * Minor units (ILA = agorot, GBp = pence, ZAc = SA cents) are converted to the
 * major unit server-side, so they should never reach here; ILA is mapped anyway
 * because an older cached response can still carry it.
 */
const SYMBOLS = {
  USD: '$',
  ILS: '₪',   // ₪
  ILA: '₪',   // agorot — same sign, server already divided by 100
  EUR: '€',   // €
  GBP: '£',   // £
  JPY: '¥',   // ¥
  CNY: '¥',
  RUB: '₽',   // ₽
  INR: '₹',   // ₹
  KRW: '₩',   // ₩
  CHF: 'Fr',
  ZAR: 'R',
  CAD: 'C$',
  AUD: 'A$',
  HKD: 'HK$',
  SEK: 'kr',
  NOK: 'kr',
  DKK: 'kr',
  PLN: 'zł',
  BRL: 'R$',
  MXN: 'Mx$',
  TRY: '₺',   // ₺
};

/** Sign for a currency code. Unknown or missing codes fall back to '$'. */
export function symbolFor(code) {
  if (!code) return '$';
  return SYMBOLS[String(code).toUpperCase()] || '$';
}

/**
 * True when the price is quoted in US dollars — the only case where the app's
 * secondary line (price x USD/ILS rate) is meaningful. Applying that rate to a
 * euro price turned EUR 37.95 into "ILS 115.75", which is why this is a
 * positive test for USD rather than "not shekel".
 */
export function isUsd(code) {
  return !code || String(code).toUpperCase() === 'USD';
}

export default symbolFor;

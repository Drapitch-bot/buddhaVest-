// Failure classification — one place, so every screen tells the user the same
// truth about the same failure.
//
// Why this file exists: the app had three error strings for eight failure
// sites, and the client actively DESTROYED the information needed to tell them
// apart. StockScreen did `if (!r.ok) throw new Error('Server error')` — the
// server had already answered 404 for a ticker that doesn't exist, 504 when
// Yahoo timed out, 429 when the rate limit fired — and all three arrived at the
// user as "Couldn't connect to the server. Check your internet connection."
// Someone typing a typo'd symbol was told to check their Wi-Fi.
//
// The server's own vocabulary (assets/1BuddhaVest/main.py):
//   400  invalid ticker string
//   404  ticker not found / no price data
//   429  rate limit (20/min heavy, 60/min normal, 120/min light)
//   502  provider could not be reached
//   504  provider did not answer inside the deadline
//   500  the report could not be built

export const ERR = {
  OFFLINE:      'offline',
  NOT_FOUND:    'not_found',
  RATE_LIMITED: 'rate_limited',
  PROVIDER:     'provider',
  SERVER:       'server',
  UNKNOWN:      'unknown',
};

// Carries the HTTP status through the throw. A plain Error loses it, which is
// exactly how every distinction above was being thrown away.
export function httpError(status) {
  const e = new Error('HTTP ' + status);
  e.httpStatus = status;
  return e;
}

// Marks a rejection as OUR client-side timeout rather than a transport failure.
export function timeoutError() {
  const e = new Error('timeout');
  e.isTimeout = true;
  return e;
}

export function classifyError(e) {
  if (!e) return ERR.UNKNOWN;

  const status = e.httpStatus;
  if (typeof status === 'number') {
    if (status === 404 || status === 400) return ERR.NOT_FOUND;
    if (status === 429)                   return ERR.RATE_LIMITED;
    if (status === 502 || status === 503 || status === 504) return ERR.PROVIDER;
    if (status >= 500)                    return ERR.SERVER;
    return ERR.SERVER;
  }

  // Our own deadline elapsed. The server's internal deadline is 25s and it
  // answers 504 when it trips, so if nothing came back at all the request never
  // reached a working server — same user-facing meaning as a provider stall.
  if (e.isTimeout || e.name === 'AbortError') return ERR.PROVIDER;

  // React Native's fetch throws exactly this string when the request never
  // reached anything: airplane mode, no signal, captive portal, DNS failure.
  // We cannot distinguish "the phone has no internet" from "the host is
  // unreachable" without probing a third party, so the message deliberately
  // says "no response from the network" rather than asserting the phone is
  // offline. Honest about what we actually know.
  const msg = String((e && e.message) || '');
  if (/network request failed|failed to fetch|network error|networkerror/i.test(msg)) {
    return ERR.OFFLINE;
  }

  return ERR.UNKNOWN;
}

// Retrying a symbol that does not exist produces the same 404 forever, and
// retrying a 429 spends a request against the limit that just rejected us.
export function canRetry(code) {
  return code !== ERR.NOT_FOUND && code !== ERR.RATE_LIMITED;
}

const TITLE = {
  [ERR.OFFLINE]:      'err_offline_title',
  [ERR.NOT_FOUND]:    'err_notfound_title',
  [ERR.RATE_LIMITED]: 'err_rate_title',
  [ERR.PROVIDER]:     'err_provider_title',
  [ERR.SERVER]:       'err_server_title',
  [ERR.UNKNOWN]:      'err_unknown_title',
};
const BODY = {
  [ERR.OFFLINE]:      'err_offline_msg',
  [ERR.NOT_FOUND]:    'err_notfound_msg',
  [ERR.RATE_LIMITED]: 'err_rate_msg',
  [ERR.PROVIDER]:     'err_provider_msg',
  [ERR.SERVER]:       'err_server_msg',
  [ERR.UNKNOWN]:      'err_unknown_msg',
};

// Returns { title, msg } already translated and interpolated.
// `code` may be any ERR value, or `true`/anything unrecognised (older call
// sites that only knew "something failed") — those fall back to UNKNOWN rather
// than rendering an empty box.
export function errorText(code, t, vars) {
  const key = TITLE[code] ? code : ERR.UNKNOWN;
  const ticker = (vars && vars.ticker) || '';
  const fill = function(s) { return String(s || '').replace('{ticker}', ticker); };
  return {
    title: fill((t && t[TITLE[key]]) || ''),
    msg:   fill((t && t[BODY[key]])  || ''),
  };
}

/**
 * monitoring.js — crash and quiet-failure reporting for the app.
 *
 * Why this exists: every bug found during the pre-release review was discovered
 * by a person looking at a screen and saying "this is wrong" — a price 100x too
 * large, a chart that never appeared, a header clipped in half, a watchlist that
 * lost its prices a second after showing them. Not one of them produced a crash,
 * so not one of them would have surfaced on its own. Once the app is on Play and
 * the people using it are strangers, nobody will send a screenshot; they will
 * uninstall it and leave one star.
 *
 * Two things are reported:
 *   captureError   — an exception we caught and handled
 *   captureIssue   — something finished "successfully" but wrong (empty chart,
 *                    missing field, provider timeout). This is the valuable one.
 *
 * Sentry is loaded lazily and optionally. With no DSN configured — which is the
 * state right now — every function here is a no-op that logs to the console, so
 * the app behaves identically whether or not monitoring is switched on. There is
 * deliberately no second code path to drift out of sync.
 *
 * To switch it on: set EXPO_PUBLIC_SENTRY_DSN and add @sentry/react-native.
 */

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN || '';

let Sentry = null;
let ready = false;

export function initMonitoring() {
  if (ready || !DSN) return;
  try {
    // Required lazily: when the package isn't installed this throws and we carry
    // on unmonitored rather than crashing at startup — the worst possible
    // outcome would be monitoring code taking the app down.
    Sentry = require('@sentry/react-native');
    Sentry.init({
      dsn: DSN,
      tracesSampleRate: 0,        // errors only
      sendDefaultPii: false,      // no device identifiers, no IPs
      enableAutoSessionTracking: true,
    });
    ready = true;
  } catch (e) {
    // No Sentry package or bad DSN — stay silent, keep running.
  }
}

/** An exception we caught. `where` should say which screen/function. */
export function captureError(where, error, extra) {
  const msg = (error && error.message) || String(error || 'unknown');
  console.warn('[error]', where, msg, extra || '');
  if (!ready) return;
  try {
    Sentry.withScope(function (scope) {
      scope.setTag('where', where);
      if (extra) {
        Object.keys(extra).forEach(function (k) {
          scope.setTag(k, String(extra[k]).slice(0, 200));
        });
      }
      Sentry.captureException(error instanceof Error ? error : new Error(msg));
    });
  } catch (e) {
    // Deliberately silent, and one of only a handful in the codebase that is.
    // Monitoring must never be the thing that breaks the app, and reporting a
    // reporting failure would recurse.
  }
}

/**
 * Something completed without throwing but produced a wrong or empty result.
 * `kind` is a stable short string so occurrences group together —
 * 'empty_chart', 'missing_price', 'provider_timeout'.
 */
export function captureIssue(kind, extra) {
  console.warn('[issue]', kind, extra || '');
  if (!ready) return;
  try {
    Sentry.withScope(function (scope) {
      scope.setLevel('warning');
      if (extra) {
        Object.keys(extra).forEach(function (k) {
          scope.setTag(k, String(extra[k]).slice(0, 200));
        });
      }
      Sentry.captureMessage(kind);
    });
  } catch (e) {
    // Deliberately silent — see captureError above.
  }
}

export default { initMonitoring, captureError, captureIssue };

"""
Where failures get recorded instead of erased.

This lives in its own module for one reason: `main.py` imports `analyzer.py`,
`data_fetcher.py` and `stooq_fallback.py`, so those three cannot import back
from `main.py` without a cycle — and those three are exactly where the most
damaging silent failures were. `data_fetcher._enrich_with_fast_info` is the
fallback that keeps prices alive when Yahoo's authenticated endpoint returns
nothing; it ended in `except Exception: pass`, so when the safety net itself
tore, the app just showed blanks and nobody could have known why.

Two functions, one distinction:

  report(kind, **fields)   something went wrong and the user will SEE it
  swallow(where, exc)      something went wrong and we deliberately continue

Both always print, so they work on Render with no Sentry DSN configured.
"""

import os
import threading
import time

SENTRY_DSN = os.environ.get("SENTRY_DSN", "")
_SENTRY = False

if SENTRY_DSN:
    try:
        import logging
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.logging import LoggingIntegration
        sentry_sdk.init(
            dsn=SENTRY_DSN,
            integrations=[
                FastApiIntegration(),
                # yfinance reports its own failures through the logging module.
                # By default sentry-sdk turns every logger.error() into its own
                # issue, which is how a single Yahoo 401 arrived as an
                # unattributed "HTTP Error 401" event. Those are kept as
                # breadcrumbs (context on a real event) but no longer raise
                # issues of their own — the reports that matter are the ones
                # this file sends deliberately, via report() and
                # swallow(notify=True), where we control the wording and the
                # rate.
                LoggingIntegration(level=logging.INFO, event_level=None),
            ],
            traces_sample_rate=0.0,     # errors only — traces cost money and add latency
            send_default_pii=False,     # never ship IPs or headers
            environment=os.environ.get("RENDER_SERVICE_NAME", "local"),
            release=os.environ.get("RENDER_GIT_COMMIT", "dev")[:12],
        )
        _SENTRY = True
        print("[startup] Sentry enabled")
    except Exception as _e:
        print(f"[startup] Sentry unavailable: {_e}")


def _safe(v, limit: int = 200) -> str:
    """
    str() that cannot raise.

    Found by testing this module rather than trusting it: `swallow(where, exc)`
    formatted the exception with str(exc), and an object whose __str__ itself
    raises turned a HANDLED failure into an unhandled crash — strictly worse
    than the `except: pass` it replaced. Anything that reports on failure must
    be total, because it only ever runs when something is already wrong.
    """
    try:
        return str(v)[:limit]
    except Exception:
        try:
            return "<unprintable %s>" % type(v).__name__
        except Exception:
            return "<unprintable>"


def _fields_str(fields: dict) -> str:
    try:
        return " ".join("%s=%s" % (k, _safe(v)) for k, v in fields.items())
    except Exception:
        return "<unprintable fields>"


# ── One event per problem, not one per occurrence ────────────────────────────
# Sentry's free tier allows 5,000 errors a month. When Yahoo starts refusing
# requests it refuses ALL of them: /market-overview alone fetches 15 tickers and
# refreshes every 60 seconds, so an outage produces ~900 identical reports an
# hour — about 21,600 a day. A six-hour outage would burn the entire monthly
# quota on one repeated fact, and the next real, different bug would be dropped
# on the floor because the quota was gone.
#
# So the same (kind, where) reaches Sentry at most once every 5 minutes. The
# printed log line is never throttled — it costs nothing and Render keeps it, so
# the full picture is still there when you need the detail.
_SENTRY_THROTTLE_SECONDS = 300
_THROTTLE_MAX_KEYS = 500
_last_sent: dict = {}
_suppressed: dict = {}
_throttle_lock = threading.Lock()


def _should_send(key) -> tuple:
    """(send?, how many were suppressed since the last send)."""
    now = time.time()
    with _throttle_lock:
        last = _last_sent.get(key, 0)
        if now - last < _SENTRY_THROTTLE_SECONDS:
            _suppressed[key] = _suppressed.get(key, 0) + 1
            return False, 0
        held = _suppressed.pop(key, 0)
        _last_sent[key] = now

        # Keep the table bounded on a long-lived process.
        #
        # The first version only dropped entries older than a few windows, which
        # is not a bound at all — a burst of distinct keys arriving faster than
        # they age out grows forever. That is not hypothetical here: when a
        # report carries no `at`, the key falls back to the TICKER, and the set
        # of tickers a user can search is unbounded. A test that pushed 2,000
        # distinct keys left 2,003 entries in memory, on a 512MB instance.
        #
        # Age them out first, then hard-cap by dropping the oldest.
        if len(_last_sent) > _THROTTLE_MAX_KEYS:
            cutoff = now - _SENTRY_THROTTLE_SECONDS * 4
            for k in [k for k, t in _last_sent.items() if t < cutoff]:
                _last_sent.pop(k, None)
                _suppressed.pop(k, None)
            if len(_last_sent) > _THROTTLE_MAX_KEYS:
                for k, _ in sorted(_last_sent.items(), key=lambda kv: kv[1])[
                        :len(_last_sent) - _THROTTLE_MAX_KEYS]:
                    _last_sent.pop(k, None)
                    _suppressed.pop(k, None)
        return True, held


def _to_sentry(kind: str, line: str, fields: dict, level: str):
    if not _SENTRY:
        return
    send, held = _should_send((kind, fields.get("at") or fields.get("ticker") or ""))
    if not send:
        return
    if held:
        # Say how many were folded in, so a throttled event is not mistaken for
        # a one-off.
        fields = dict(fields, suppressed_since_last=held)
        line = f"{line}  (+{held} more in the last {_SENTRY_THROTTLE_SECONDS}s)"
    try:
        import sentry_sdk
        with sentry_sdk.push_scope() as scope:
            for k, v in fields.items():
                scope.set_tag(k, _safe(v))
            scope.level = level
            sentry_sdk.capture_message(f"{kind}: {line}"[:400])
    except Exception:
        # Monitoring must never be the thing that breaks the request. This is
        # the ONE swallow in the codebase that stays completely silent, because
        # anything else here risks recursing into itself.
        pass


def report(kind: str, **fields):
    """
    Record something that went wrong but did NOT raise.

    This is the important half. A crash is loud; the failures that actually hurt
    this app are quiet — an empty chart, a missing company name, a multiple that
    silently disappeared. Those return a valid response and no one ever knows.

    Always prints, so it shows up in Render's log even without a DSN.
    """
    line = _fields_str(fields)
    print(f"[{kind}] {line}")
    _to_sentry(kind, line, fields, "warning")


def swallow(where: str, exc: BaseException = None, notify: bool = False, **fields):
    """
    A failure we deliberately continue past — but refuse to erase.

    `except Exception: pass` appeared 40 times in this codebase. Each one was a
    decision that the surrounding work could proceed without this piece, and
    most of those decisions were correct. What was NOT correct is that the
    decision left no trace: when a whole card came back empty there was no way
    to tell which of the forty had fired, or whether any had.

    Costs nothing on the happy path — this only runs when something actually
    threw, which is rare. `notify=True` marks the ones where the swallow makes
    something the user can see disappear; those also go to Sentry.
    """
    try:
        kind = type(exc).__name__ if exc is not None else "no-exception"
    except Exception:
        kind = "unknown"
    detail = _safe(exc, 160) if exc is not None else ""
    line = _fields_str(fields)
    print(f"[swallowed] at={_safe(where)} err={kind}: {detail} {line}".rstrip())
    if notify:
        payload = dict(fields, at=where, err=kind, detail=detail)
        _to_sentry("swallowed", f"{where} — {kind}: {detail}", payload, "warning")

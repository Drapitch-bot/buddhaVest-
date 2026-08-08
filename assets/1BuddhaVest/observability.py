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

SENTRY_DSN = os.environ.get("SENTRY_DSN", "")
_SENTRY = False

if SENTRY_DSN:
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        sentry_sdk.init(
            dsn=SENTRY_DSN,
            integrations=[FastApiIntegration()],
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


def _to_sentry(kind: str, line: str, fields: dict, level: str):
    if not _SENTRY:
        return
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

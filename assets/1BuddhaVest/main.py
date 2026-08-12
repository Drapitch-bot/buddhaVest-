"""
Copyright (c) 2026, the creator of this application. All rights reserved.
Part of the BuddhaVest personal stock-research application.
Unauthorized copying, distribution, or use of this code, in whole or in part,
without explicit written permission from the copyright holder is prohibited.
"""

"""
main.py
שרת ה-API של BuddhaVest.
מריצים עם: uvicorn main:app --reload
ואז פותחים בדפדפן: http://127.0.0.1:8000/docs כדי לראות ולבדוק את ה-API

Endpoints:
  GET /analyze/{ticker}  -> ניתוח מלא של מנייה (ציון, המלצה, מדדים)
  GET /market-overview    -> תמונת מצב שוק כללית (מדדים מרכזיים)
"""

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
import hashlib
import json
import math
import os
import time
import threading

import httpx

from data_fetcher import get_stock_data, get_quote, get_news, get_google_news
# Timeout-bounded yf.Ticker. Without it a hung Yahoo call holds uvicorn's
# single worker forever and every route stops answering — see data_fetcher.
from data_fetcher import _ticker as _yf_ticker
from analyzer import calculate_score
from news_signals import analyze_signals
from i18n_data import render_explanation, translate_signal_category
from ticker_search import search_tickers
from stooq_fallback import get_stooq_quote, get_stooq_daily

# Tiingo API — key comes ONLY from the environment (Render env var).
# Never hardcode it: this file is in a public git repo.
TIINGO_TOKEN = os.environ.get("TIINGO_TOKEN", "")

# ── Error monitoring ─────────────────────────────────────────────────────────
# There was none. Every problem found today — the 100x London price, the share
# count that emptied every multiple, the custom session that silently blanked
# stock.info, the request that hung past three minutes — was discovered because
# a human looked at a screen and said "this is wrong". None of them raised
# anywhere anyone could see.
#
# SENTRY_DSN is read from the environment. With no DSN these calls are inert,
# so the server runs identically whether or not monitoring is configured — no
# second code path to get out of sync.
#
# `report` and `swallow` live in observability.py rather than here because
# main.py imports analyzer / data_fetcher / stooq_fallback, so those three
# cannot import back from main.py without a cycle — and those three contain
# some of the most damaging silent failures in the codebase.
from observability import SENTRY_DSN, report, swallow
from observability import _SENTRY as _SENTRY_ACTIVE


# ─── Shared thread pools ──────────────────────────────────────────────────────
# Eight separate `with ThreadPoolExecutor(...)` blocks were built and torn down
# INSIDE request handlers. Every /quotes, every /market-overview, every article
# translation created its own pool, spawned up to ten OS threads, and joined
# them again — on a 0.5 vCPU instance with one uvicorn worker. At peak the
# server could hold roughly forty short-lived threads whose only purpose was to
# wait on the network.
#
# These are created once and reused. Counted honestly: the pools below total 33
# threads (8 io + 6 translate + 3 index + 4 movers + 4 stooq + 8 deadline),
# created lazily on first use and then kept — instead of up to 54 thread
# creations and teardowns per full workload cycle. The win is the churn, not a
# smaller steady-state number.
#
# Split by ROLE, not for tidiness: a task running in a pool must never block
# waiting on a task in the SAME pool, or a saturated pool deadlocks. Endpoint
# bodies run in the deadline pool and fan out into the I/O pool; translation has
# its own so a burst of quote fetches cannot starve an article the user is
# waiting to read.
_POOLS: dict = {}
_POOLS_LOCK = threading.Lock()


def _pool(name: str, size: int):
    p = _POOLS.get(name)
    if p is not None:
        return p
    with _POOLS_LOCK:
        p = _POOLS.get(name)
        if p is None:
            from concurrent.futures import ThreadPoolExecutor
            p = ThreadPoolExecutor(max_workers=size, thread_name_prefix=name)
            _POOLS[name] = p
        return p


def io_pool():
    """Network fan-out inside an endpoint: quotes, movers, indices, Stooq, link resolution."""
    return _pool("bv-io", 8)


def translate_pool():
    """Translation batches — kept separate so article reads are not queued behind market data."""
    return _pool("bv-xlate", 6)


# The three below keep their original, deliberately SMALL worker counts. Those
# numbers are a politeness limit on Yahoo and Stooq, not a memory decision —
# folding them into the shared I/O pool would have quietly tripled how many
# requests hit the provider at once, which is the exact behaviour that gets this
# server's IP throttled and empties `stock.info`.
def index_pool():
    """S&P / Nasdaq / VIX / FX — 3 at a time."""
    return _pool("bv-index", 3)


def movers_pool():
    """The 15-symbol market table — 4 at a time."""
    return _pool("bv-movers", 4)


def fallback_pool():
    """Stooq backfill — 4 at a time; a throttled path is the last one to hammer."""
    return _pool("bv-stooq", 4)



# ─── Translation ──────────────────────────────────────────────────────────────
# Maps app lang codes → Google Translate target codes
_TRANSLATE_LANG = {"he": "iw", "ru": "ru", "es": "es"}
# RTL languages — prepend U+200F (RLM) so Unicode Bidi algorithm treats paragraph as RTL
# even when text starts with an LTR word (e.g. "Apple היא חברה...")
_RTL_LANGS = {"he"}

def _rtl_wrap(text: str, lang: str) -> str:
    """Prepend RLM marker to RTL-language text so bidi rendering is correct."""
    if lang in _RTL_LANGS and text and not text.startswith("‏"):
        return "‏" + text
    return text

try:
    from deep_translator import GoogleTranslator as _GT
    def _translate_text(text: str, lang: str) -> str:
        """
        Translate a single string. Returns original if lang is 'en'.
        Retries once on failure (Google occasionally rate-limits bursts) so a
        momentary block doesn't silently serve English to he/ru/es users —
        especially important because responses get cached.
        """
        if not text or lang == "en":
            return text
        target = _TRANSLATE_LANG.get(lang, lang)
        for attempt in range(2):
            try:
                result = _GT(source="auto", target=target).translate(text)
                if result:
                    return _rtl_wrap(result, lang)
            except Exception as _e:
                swallow("main:_translate_text", _e)
            if attempt == 0:
                time.sleep(0.5)
        return text

    def _translate_batch(texts: list, lang: str) -> list:
        """
        Translate a list of strings IN PARALLEL (deep_translator sends one
        HTTP request per string, so sequential batches were very slow —
        15 news titles took 10-15s; in parallel it's ~1-2s).
        Returns originals on error.
        """
        if not texts or lang == "en":
            return texts
        from concurrent.futures import ThreadPoolExecutor
        def _one(txt):
            try:
                return _translate_text(txt, lang)
            except Exception:
                return txt
        try:
            return list(translate_pool().map(_one, texts))
        except Exception:
            return texts
except ImportError:
    def _translate_text(text: str, lang: str) -> str:
        return text
    def _translate_batch(texts: list, lang: str) -> list:
        return texts
# ─────────────────────────────────────────────────────────────────────────────

# ─── Cache system ────────────────────────────────────────────────────────────
# כל קריאה ל-yfinance נשמרת כאן לפרק זמן מוגדר.
# כך 100 משתמשים שמחפשים AAPL יגרמו לבקשה אחת בלבד ל-Yahoo, לא 100.
_cache: dict = {}
_cache_lock = threading.Lock()

CACHE_TTL = {
    "quote": 60,        # מחיר חי – מתעדכן כל דקה
    "stock": 3600,      # ניתוח מלא – מתעדכן כל שעה (נתונים פונדמנטליים משתנים לאט)
    "news": 900,        # חדשות – מתעדכנות כל 15 דקות
    "market": 60,       # תמונת שוק – כל דקה
    "exchange": 60,     # שער מטבע – כל דקה
}

_CACHE_MAX = 300  # hard cap on cached entries — bounds the memory footprint

# History window for metric-history calculations.
# These endpoints used period="max": for an old listing (KO trades since 1962)
# that pulls ~16,000 daily rows into pandas just to emit ~44 monthly points,
# because the financial statements behind the calculation only go back ~5 years
# anyway. 10 years is comfortably more than the data can support and cuts the
# per-request memory spike dramatically.
_HIST_PERIOD = "10y"

# ── Input sanitizers ──
# Tickers reach outbound URLs (Tiingo/Yahoo/Stooq) and cache keys, so restrict
# them to the characters real symbols use: letters, digits, '.', '-', '^'.
# This blocks path traversal ("../"), cache-key collisions and URL breakage.
_TICKER_OK = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-^=")
_VALID_LANGS = ("he", "en", "ru", "es")

def _clean_ticker(t: str) -> str:
    t = (t or "").strip()[:20]
    cleaned = "".join(c for c in t if c in _TICKER_OK)
    if not cleaned:
        raise HTTPException(status_code=400, detail="Invalid ticker.")
    return cleaned

def _clean_lang(l: str) -> str:
    l = (l or "").strip().lower()[:5]
    return l if l in _VALID_LANGS else "en"

# Article pages are fetched from URLs the client supplies, so the response size
# must be bounded: an oversized target (a video, an archive, a huge feed) would
# otherwise be pulled entirely into memory on a small instance.
_MAX_HTML_BYTES = 3 * 1024 * 1024   # 3 MB
_MAX_HTML_CHARS = 3 * 1024 * 1024

def _too_large(resp) -> bool:
    try:
        cl = resp.headers.get("content-length")
        return cl is not None and int(cl) > _MAX_HTML_BYTES
    except Exception:
        return False

def _validate_public_url(u: str) -> str:
    """
    Guards the server-side article fetcher against SSRF.

    /translate-article takes a URL from the client and fetches it FROM THE
    SERVER. Without this check, a crafted URL could point at loopback, a
    private LAN address or the cloud metadata service (169.254.169.254) and the
    response would be handed straight back to the caller — a standard way to
    read internal endpoints or credentials.
    """
    import ipaddress
    from urllib.parse import urlparse

    u = (u or "").strip()
    if len(u) > 2048:
        raise HTTPException(status_code=400, detail="Invalid URL.")
    parsed = urlparse(u)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Invalid URL.")
    host = (parsed.hostname or "").lower()
    if not host:
        raise HTTPException(status_code=400, detail="Invalid URL.")
    # Block obvious local names
    if host in ("localhost", "localhost.localdomain") or host.endswith(".local") \
            or host.endswith(".internal") or host == "metadata.google.internal":
        raise HTTPException(status_code=400, detail="Invalid URL.")
    # Block literal private / loopback / link-local IPs
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise HTTPException(status_code=400, detail="Invalid URL.")
    except HTTPException:
        raise
    except ValueError:
        pass  # a normal hostname, not an IP literal
    return u

def _cache_get(key: str):
    with _cache_lock:
        entry = _cache.get(key)
        if entry and time.time() < entry["expires"]:
            return entry["data"]
        return None

def _cache_get_stale(key: str):
    """
    The cached value even if its TTL has passed.

    Used only as a last resort: when the upstream provider is unreachable, a
    five-minute-old market snapshot is far more useful than a screen of dashes,
    and it is labelled `stale: true` so the caller knows what it is holding.
    """
    with _cache_lock:
        entry = _cache.get(key)
        return entry["data"] if entry else None


def _cache_set(key: str, data, ttl: int):
    with _cache_lock:
        _cache[key] = {"data": data, "expires": time.time() + ttl}
        # Never let the cache grow without bound. Drop expired entries first,
        # then the ones closest to expiry (oldest data) until under the cap.
        if len(_cache) > _CACHE_MAX:
            now = time.time()
            for k in [k for k, v in _cache.items() if now >= v["expires"]]:
                del _cache[k]
            if len(_cache) > _CACHE_MAX:
                for k in sorted(_cache, key=lambda k: _cache[k]["expires"])[: len(_cache) - _CACHE_MAX]:
                    del _cache[k]

# ── Request coalescing (single-flight) ──
# Without this, N users asking for the same ticker while the cache is cold each
# triggered a full, independent Yahoo fetch (financials + balance + cashflow +
# history — heavy DataFrames). Serialising per cache key means the first caller
# does the work and the rest read the cache it just filled: same answer, a
# fraction of the peak memory.
_key_locks = {}
_key_locks_guard = threading.Lock()
_KEY_LOCKS_MAX = 200

def _key_lock(key: str):
    with _key_locks_guard:
        lk = _key_locks.get(key)
        if lk is None:
            if len(_key_locks) > _KEY_LOCKS_MAX:
                # drop locks nobody is holding, so the dict can't grow forever
                for k, v in list(_key_locks.items()):
                    if not v.locked():
                        _key_locks.pop(k, None)
            lk = threading.Lock()
            _key_locks[key] = lk
        return lk

def _cache_clear_expired():
    """מנקה entries פגי תוקף כדי לא לצבור זיכרון"""
    with _cache_lock:
        now = time.time()
        expired = [k for k, v in _cache.items() if now >= v["expires"]]
        for k in expired:
            del _cache[k]

# ── Last-known-good persistence ──
# The LKG dicts (volume/market-cap backfill) live in the in-memory cache, which
# dies on every Render restart/deploy — exactly when Yahoo is coldest and the
# backfill is needed most. Mirror them to disk (best-effort) so they survive.
# ── Last-known-good store ────────────────────────────────────────────────────
# This holds the most recent non-null volume, average volume and market cap for
# each ticker. It is what keeps the market table populated when Yahoo answers
# with a price but nothing else — a real and frequent condition.
#
# It lived in /tmp, which Render wipes on EVERY deploy. Six deploys in one
# afternoon meant the safety net was destroyed six times, each time at the exact
# moment it was needed. The file was doing its job perfectly and still helped
# nobody, because it never survived long enough to be read.
#
# LKG_DIR points at a mounted disk when one exists; otherwise it falls back to
# /tmp and says so at startup, so the limitation is visible in the log instead of
# being discovered from a screenshot.
# ── Where it is stored ───────────────────────────────────────────────────────
# Three backends, tried in this order. Only the FIRST actually survives a
# deploy, which is the entire point:
#
#   1. Upstash Redis   — UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
#                        Free tier, lives outside the container, so a deploy
#                        cannot touch it. This is the configured path.
#   2. A mounted disk  — LKG_DIR / RENDER_DISK_PATH, if one is ever attached.
#   3. /tmp            — works, but Render erases it on every single deploy.
#
# Deliberately ONE save/load implementation with a swappable backend rather than
# two parallel paths. A second code path here would be exercised only in the
# configuration nobody is looking at, which is how the /tmp problem stayed
# invisible for so long.
_UPSTASH_URL = (os.environ.get("UPSTASH_REDIS_REST_URL") or "").rstrip("/")
_UPSTASH_TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN") or ""
_LKG_REDIS = bool(_UPSTASH_URL and _UPSTASH_TOKEN)

_LKG_DIR = os.environ.get("LKG_DIR") or os.environ.get("RENDER_DISK_PATH") or "/tmp"
try:
    os.makedirs(_LKG_DIR, exist_ok=True)
except Exception:
    _LKG_DIR = "/tmp"
_LKG_FILE = os.path.join(_LKG_DIR, "buddhavest_lkg.json")
_LKG_REDIS_KEY = "buddhavest:lkg"

if _LKG_REDIS:
    _LKG_PERSISTENT = True
    # Deliberately does NOT say "persistent" yet — nothing has been proven at
    # this point. The load below is the first real call, and it is what decides
    # whether the credentials work. Claiming success before testing it is how
    # the 401 went unnoticed.
    print("[startup] LKG store: Upstash Redis configured — verifying...")
else:
    # Path comparison, not a string prefix. `startswith("/tmp")` also matches
    # "/tmpdata" and "/tmp_disk", so a genuinely mounted disk at such a path
    # would have been labelled EPHEMERAL — and this label is the only thing
    # telling anyone whether the safety net actually survives a deploy.
    _abs = os.path.abspath(_LKG_DIR)
    _LKG_PERSISTENT = not (_abs == "/tmp" or _abs.startswith("/tmp" + os.sep))
    print(f"[startup] LKG store: {_LKG_FILE} "
          f"({'persistent' if _LKG_PERSISTENT else 'EPHEMERAL — wiped on every deploy'})")

_LKG_KEYS = ("mover_lkg", "analyze_overview_lkg")


# Configured is not the same as working. The first deploy with Upstash wired up
# logged "LKG store: Upstash Redis (persistent — survives deploys)" and then, on
# the very next line, a 401 from Upstash — and /status still cheerfully reported
# lkg="redis" because it only looked at whether the env vars existed. That is a
# false reassurance about the one thing this store exists to guarantee, and it
# is exactly the failure mode the comment in render.yaml warns about.
#
# None = not tried yet. True/False = what actually happened on the last call.
_LKG_REDIS_OK = None
_LKG_REDIS_FAILS = 0
# After this many consecutive failures, stop calling Redis on every flush and
# use the local file instead. A rejected token does not fix itself, and retrying
# it once a minute forever burns a request and writes a log line each time while
# the safety net stays empty. The file is ephemeral, but ephemeral beats nothing.
_LKG_REDIS_MAX_FAILS = 3


def _upstash(command: list, timeout: int = 5):
    """
    One Upstash REST call. Returns the decoded `result`, or raises.

    Upstash's REST API takes the Redis command as a JSON array, which means no
    redis client dependency — httpx is already here. Keeping the dependency
    count at zero matters on a 512MB instance.
    """
    global _LKG_REDIS_OK, _LKG_REDIS_FAILS
    try:
        r = httpx.post(_UPSTASH_URL, json=command, timeout=timeout,
                       headers={"Authorization": f"Bearer {_UPSTASH_TOKEN}"})
        r.raise_for_status()
        _LKG_REDIS_OK, _LKG_REDIS_FAILS = True, 0
        return r.json().get("result")
    except Exception:
        _LKG_REDIS_OK = False
        _LKG_REDIS_FAILS += 1
        raise


def _lkg_use_redis() -> bool:
    """Redis is configured AND has not failed repeatedly."""
    return _LKG_REDIS and _LKG_REDIS_FAILS < _LKG_REDIS_MAX_FAILS


def lkg_backend() -> str:
    """
    What the store is ACTUALLY doing right now — for /status.

    Distinguishes "configured and working" from "configured and rejected",
    because those two look identical from outside and mean opposite things.
    """
    if not _LKG_REDIS:
        return "disk" if _LKG_PERSISTENT else "ephemeral"
    if _LKG_REDIS_OK is True:
        return "redis"
    if _LKG_REDIS_OK is False:
        return "redis-failing" if _lkg_use_redis() else "redis-rejected"
    return "redis-untested"


# ── Writes are coalesced, not immediate ──────────────────────────────────────
# `_lkg_file_save()` is called from inside /analyze, which runs on every cache
# miss. Against a local file that was a cheap syscall. Against Redis it is a
# network round trip on the request path — inside the 25s deadline — and at the
# rate limit's ceiling (20 heavy requests/minute) it would be ~28,800 writes a
# day, well past Upstash's 10,000/day free tier.
#
# So callers now only mark the store dirty; one background thread flushes at
# most once every 60s. That bounds writes to ~1,440/day no matter the traffic,
# takes the network call out of the request path entirely, and is strictly
# cheaper than the file version was. Losing up to 60s of updates on a hard kill
# is acceptable: this is a best-effort backfill cache, not a source of record.
_LKG_DIRTY = threading.Event()
_LKG_FLUSH_SECONDS = 60


def _lkg_mark_dirty():
    _LKG_DIRTY.set()


def _lkg_flush_loop():
    while True:
        time.sleep(_LKG_FLUSH_SECONDS)
        if _LKG_DIRTY.is_set():
            _LKG_DIRTY.clear()
            _lkg_file_save()


def _lkg_file_save():
    # Written atomically: a deploy or an OOM kill mid-write used to be able to
    # leave a truncated file that then failed to parse on the next boot, quietly
    # discarding everything. Redis has the same property for free — SET is
    # atomic, so a half-written value is not representable.
    try:
        data = {k: (_cache_get(k) or {}) for k in _LKG_KEYS}
        blob = json.dumps(data)
        if _lkg_use_redis():
            _upstash(["SET", _LKG_REDIS_KEY, blob])
            return
        if _LKG_REDIS:
            # Redis was configured but has failed repeatedly (a rejected token
            # is the common case). Keep the safety net working locally instead
            # of writing nowhere at all.
            report("lkg_redis_giving_up", fails=_LKG_REDIS_FAILS, falling_back_to=_LKG_FILE)
        tmp = _LKG_FILE + ".tmp"
        with open(tmp, "w") as f:
            f.write(blob)
        os.replace(tmp, _LKG_FILE)
    except Exception as e:
        report("lkg_save_failed",
               backend="redis" if _LKG_REDIS else _LKG_FILE, error=str(e)[:120])


def _lkg_file_load():
    try:
        if _lkg_use_redis():
            raw = _upstash(["GET", _LKG_REDIS_KEY])
            if not raw:
                print("[startup] LKG empty (first run against this Redis)")
                return
            data = json.loads(raw)
        else:
            with open(_LKG_FILE, "r") as f:
                data = json.load(f)
        loaded = 0
        for k in _LKG_KEYS:
            if data.get(k):
                _cache_set(k, data[k], 86400)
                loaded += len(data[k]) if isinstance(data[k], dict) else 1
        print(f"[startup] LKG restored: {loaded} entries (backend: {lkg_backend()})")
    except FileNotFoundError:
        print("[startup] LKG empty (first run on this volume)")
    except Exception as e:
        # Neither a corrupt file nor an unreachable Redis may stop the server
        # from booting. An empty safety net is a degraded start; no start at all
        # is an outage.
        # Spelled out, because a 401 here is a configuration mistake the
        # operator can fix in thirty seconds — and the previous wording buried
        # it as "unreadable" next to a line claiming persistence was on.
        if _LKG_REDIS and "401" in str(e):
            report("lkg_redis_unauthorized", url=_UPSTASH_URL)
            print("[startup] LKG: Upstash REJECTED the token (401). "
                  "Check UPSTASH_REDIS_REST_TOKEN — it must be the token that "
                  "belongs to this database, and not the read-only one. "
                  "Falling back to a local file until it is fixed.")
        else:
            print(f"[startup] LKG unreadable, starting empty: {e}")

_lkg_file_load()  # seed from disk on boot (no-op on first ever run)

# ניקוי cache + החזרת זיכרון פנוי ל-OS כל 5 דקות ברקע (thread נפרד, לא משפיע על בקשות)
def _cleanup_loop():
    import gc
    while True:
        time.sleep(300)
        _cache_clear_expired()
        gc.collect()

threading.Thread(target=_cleanup_loop, daemon=True).start()
threading.Thread(target=_lkg_flush_loop, daemon=True).start()
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(title="BuddhaVest API")

# ── Rate limiting ────────────────────────────────────────────────────────────
# There was none. Every endpoint here fans out to Yahoo, /analyze pulls three
# full financial statements, and the service runs one uvicorn worker on 0.5 vCPU
# with 512MB. A single client in a loop could take the whole thing down — and
# just as importantly, a burst from one IP is what gets the SERVER's IP throttled
# by Yahoo, which empties the app for everyone at once. That happened today.
#
# Limits are per client IP and deliberately generous: a real user opening the app
# and tapping through a few stocks stays far below them.
_RATE_LIMITS = {
    "heavy": "20/minute",    # /analyze, /financials, /metric-history — statements
    "normal": "60/minute",   # /quotes, /market-overview, /events, /signals
    "light": "120/minute",   # /status, /exchange-rate, /search
}

try:
    from slowapi import Limiter, _rate_limit_exceeded_handler
    from slowapi.util import get_remote_address
    from slowapi.errors import RateLimitExceeded
    from slowapi.middleware import SlowAPIMiddleware

    limiter = Limiter(key_func=get_remote_address, default_limits=["120/minute"])
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.add_middleware(SlowAPIMiddleware)
    _RATE_LIMITING = True
except Exception as _e:  # slowapi missing → run unlimited rather than not at all
    print(f"[startup] rate limiting unavailable: {_e}")
    limiter = None
    _RATE_LIMITING = False


def rate_limit(tier: str):
    """
    Decorator that applies a rate limit, and is a no-op if slowapi is absent.
    Keeps the endpoint definitions readable and lets the app boot either way.
    """
    def deco(fn):
        if limiter is None:
            return fn
        return limiter.limit(_RATE_LIMITS.get(tier, _RATE_LIMITS["normal"]))(fn)
    return deco


# CORS: the only client is the mobile app, which is not a browser and therefore
# not subject to CORS at all. The wildcard is kept because /privacy is opened in
# a browser and the docs page is useful, but it is no longer the ONLY thing
# standing between an anonymous caller and the upstream provider — the rate
# limiter above is what actually protects the service.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def sanitize(obj):
    """
    מחליף רקורסיבית NaN/Infinity/-Infinity ב-None.
    חשוב: Python's json.dumps כותב NaN/Infinity כ"NaN"/"Infinity" שהם לא JSON תקני -
    JSON.parse בדפדפן נכשל על זה (שגיאה שקטה שמקפיאה את הדף).
    yfinance מחזיר לפעמים NaN במקום None עבור שדות חסרים, אז זה קריטי.
    """
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj
    if isinstance(obj, dict):
        return {k: sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize(v) for v in obj]
    return obj


class SanitizedJSONResponse(JSONResponse):
    """JSONResponse שמנקה NaN/Infinity לפני סריאליזציה"""
    def render(self, content) -> bytes:
        return super().render(sanitize(content))


app.router.default_response_class = SanitizedJSONResponse


@app.middleware("http")
async def _no_http_cache(request: Request, call_next):
    """
    Force revalidation on every API response.

    FastAPI sends no Cache-Control, which lets ANY layer between us and the
    user store a response indefinitely: a CDN/proxy, and — the one that
    actually bit us — Android's OkHttp cache inside the app itself.

    That is how a Tel-Aviv stock kept showing 8173 instead of 81.73 long after
    the agorot fix shipped: the phone was replaying a response body produced by
    the old server code. Proven by fetching the same ticker under a cache key
    that had never been used, which returned the correct 84.45 with
    price_currency "ILS".

    The server keeps its own in-memory cache (that is what protects Yahoo from
    load); this only stops COPIES of a response outliving a deploy.

    /privacy used to be excluded here, on the reasoning that a static legal page
    is cheap to cache. That reasoning was backwards and it bit us: after the
    privacy text was corrected, https://buddhavest.onrender.com/privacy still
    served the PREVIOUS wording, while the same URL with an unused query string
    served the new one — proving the body was a cached copy, not stale server
    code. A privacy policy is the one page where a stale copy is most expensive:
    Google Play compares it against the Data Safety declaration, and the old
    copy said the watchlist "is never transmitted to our servers", which the
    declaration contradicts. Correctness beats saving a few kilobytes, so there
    is no longer an exception for any path.
    """
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return response


# ─── Article domain blocklist ────────────────────────────────────────────────
# Sites that require login / paywall to read articles — remove from the news
# feed entirely so users only see articles they can actually open and read.
_NO_SHOW_DOMAINS = [
    'nytimes.com', 'nyti.ms',
    'wsj.com', 'barrons.com', 'bloomberg.com', 'ft.com',
    'reuters.com', 'economist.com', 'washingtonpost.com',
    'seekingalpha.com', 'investors.com', 'businessinsider.com',
    'marketwatch.com', 'fortune.com', 'theinformation.com',
    # Sites whose articles can't be translated (bot-walls / hard paywalls).
    # NOTE: domain-only — Motley Fool articles syndicated on finance.yahoo.com
    # are fine and stay in the feed.
    'fool.com', 'theglobeandmail.com',
]
_NO_SHOW_PUBLISHERS = [
    'New York Times', 'The New York Times',
    'WSJ', 'Wall Street Journal', "Barron's", 'Barrons',
    'Bloomberg', 'Financial Times', 'Reuters', 'The Economist',
    'Washington Post', 'Seeking Alpha', "Investor's Business Daily",
    'Business Insider', 'MarketWatch', 'Fortune', 'The Information',
]

def _filter_articles(articles: list) -> list:
    return [a for a in articles if not (
        any(d in (a.get('link') or '') for d in _NO_SHOW_DOMAINS) or
        any(p in (a.get('publisher') or '') for p in _NO_SHOW_PUBLISHERS)
    )]


_GNEWS_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def _decode_gnews_link(url: str) -> str:
    """
    Decode a Google News RSS article URL to the real article URL.
    Google's redirect is JavaScript-based (not HTTP), so we use the same
    internal batchexecute API their page calls to resolve the target URL.
    """
    import re as _re
    import json as _json
    from urllib.parse import quote as _quote

    m = _re.search(r"news\.google\.com/rss/articles/([^?/&#]+)", url or "")
    if not m:
        return url
    art_id = m.group(1)
    hdrs = {"User-Agent": _GNEWS_UA}
    try:
        page = httpx.get(f"https://news.google.com/rss/articles/{art_id}",
                         headers=hdrs, timeout=6, follow_redirects=True).text
        sg = _re.search(r'data-n-a-sg="([^"]+)"', page)
        ts = _re.search(r'data-n-a-ts="([^"]+)"', page)
        if not sg or not ts:
            return url
        inner = _json.dumps([
            "garturlreq",
            [["X", "X", ["X", "X"], None, None, 1, 1, "US:en", None, 1,
              None, None, None, None, None, 0, 1],
             "X", "X", 1, [1, 1, 1], 1, 1, None, 0, 0, None, 0],
            art_id, int(ts.group(1)), sg.group(1),
        ])
        freq = _json.dumps([[["Fbv4je", inner, None, "generic"]]])
        resp = httpx.post(
            "https://news.google.com/_/DotsSplashUi/data/batchexecute",
            content="f.req=" + _quote(freq),
            headers={**hdrs,
                     "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
            timeout=6,
        )
        m2 = (_re.search(r'\\"garturlres\\",\\"(https?://[^\\"]+)', resp.text)
              or _re.search(r'"garturlres","(https?://[^"]+)', resp.text))
        if m2:
            real = m2.group(1).replace("\\u003d", "=").replace("\\u0026", "&")
            if 'news.google.com' not in real:
                return real
    except Exception as _e:
        swallow("main:_decode_gnews_link", _e)
    return url


def _resolve_gnews_link(url: str) -> str:
    """Resolve a Google News RSS link to the real article URL."""
    if not url or 'news.google.com/rss/articles' not in url:
        return url
    # Primary: decode via Google's internal API (JS redirect can't be followed)
    real = _decode_gnews_link(url)
    if real != url:
        return real
    # Fallback: old-style HTTP redirect (works for some legacy links)
    try:
        resp = httpx.head(url, follow_redirects=True, timeout=4,
                          headers={"User-Agent": _GNEWS_UA})
        final = str(resp.url)
        if final and 'news.google.com' not in final and final.startswith('http'):
            return final
    except Exception as _e:
        swallow("main:_resolve_gnews_link", _e)
    return url


def _resolve_gnews_articles(articles: list) -> list:
    """Resolve Google News redirect links in parallel (max 6s total)."""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    gnews = [(i, a) for i, a in enumerate(articles)
             if 'news.google.com/rss/articles' in (a.get('link') or '')]
    if not gnews:
        return articles
    result = list(articles)
    # No `with` block, deliberately. Exiting one calls shutdown(wait=True),
    # which blocked until every link had resolved — so the timeout=15 below was
    # only ever a timeout on the LOOP, not on the work. A slow link still held
    # the request open past the deadline. On the shared pool the stragglers keep
    # running detached and we return with whatever resolved in time.
    ex = io_pool()
    futures = {ex.submit(_resolve_gnews_link, a['link']): (i, a) for i, a in gnews}
    try:
        for fut in as_completed(futures, timeout=15):
            i, a = futures[fut]
            try:
                real_url = fut.result()
                if real_url != a['link']:
                    result[i] = dict(a, link=real_url)
            except Exception as _e:
                swallow("main:_resolve_gnews_articles", _e)
    except Exception as _e:
        swallow("main:_resolve_gnews_articles", _e)  # timeout — keep whatever resolved so far
    return result


_PREWARM_BUSY = set()
_PREWARM_LOCK = threading.Lock()
# True only while the boot-time news warm-up runs. Article pre-translation is
# suppressed during that window — see _prewarm_news for why.
_BOOTING = True

def _prewarm_articles(urls: list, lang: str):
    """
    Fire-and-forget: translate the top articles in the background so that
    opening them in the app is an instant cache hit.
    """
    import threading
    import os as _os
    if lang == "en" or _BOOTING:
        return
    # check-and-claim under a lock: two simultaneous /news requests could both
    # pass a bare `in` test and start duplicate warm-up loops.
    with _PREWARM_LOCK:
        if lang in _PREWARM_BUSY:
            return
        _PREWARM_BUSY.add(lang)
    port = _os.environ.get("PORT", "8000")

    def _run():
        try:
            # Three articles, not six, and a breath between them: each one is a
            # full page download plus a translation round-trip, so warming six
            # back-to-back produced a large memory spike for a feature that only
            # saves a second on the article the user actually taps.
            for u in urls[:3]:
                if not u or 'news.google.com' in u:
                    continue
                try:
                    httpx.get(f"http://127.0.0.1:{port}/translate-article",
                              params={"url": u, "lang": lang}, timeout=30)
                except Exception as _e:
                    swallow("main:_run", _e)
                time.sleep(2)
        finally:
            _PREWARM_BUSY.discard(lang)

    threading.Thread(target=_run, daemon=True).start()

# ─── Cache pre-warming ────────────────────────────────────────────────────────
# כשהשרת מתעורר (cold start ב-Render) – מאחסן חדשות לכל השפות ברקע,
# כדי שהמשתמש הראשון יקבל תשובה מהירה מה-cache ולא יחכה לתרגום.
def _prewarm_news():
    """
    Warms the news cache for all four languages after boot.

    This used to run all four languages back-to-back, and each non-English one
    also kicked off six full article downloads + translations — roughly 18 heavy
    fetches inside the first minute of the process's life. On a small instance
    that is the worst possible moment for a memory spike, and if it pushed the
    container over its limit the restart simply replayed the same burst.

    Now: the languages are spaced out, and `_BOOTING` suppresses article
    pre-translation until the warm-up is done, so boot costs one translate pass
    per language instead of a stampede.
    """
    global _BOOTING
    try:
        time.sleep(15)  # let the server settle before doing any real work
        for _lang in ["en", "he", "ru", "es"]:
            try:
                # The implementation, not the HTTP endpoint — see the note on
                # _general_news_uncached.
                _general_news_uncached(_lang)
            except Exception as _e:
                swallow("main:_prewarm_news", _e, lang=_lang, notify=True)
            time.sleep(10)   # spread the load instead of spiking it
    finally:
        _BOOTING = False     # from here on, normal request-driven prewarming

threading.Thread(target=_prewarm_news, daemon=True).start()


# ─── Keep-alive ───────────────────────────────────────────────────────────────
# Render free tier spins the service down after ~15 min without inbound
# traffic, and waking it back up takes 30-60s (that's the "slow first open").
# Pinging our own public URL every 10 min counts as inbound traffic and keeps
# the service warm around the clock — no external monitor needed.
def _keepalive_loop():
    url = os.environ.get("RENDER_EXTERNAL_URL", "https://buddhavest.onrender.com")
    while True:
        time.sleep(600)
        try:
            httpx.get(f"{url.rstrip('/')}/status", timeout=10)
        except Exception as _e:
            swallow("main:_keepalive_loop", _e)

if os.environ.get("RENDER"):  # only on Render, not when running locally
    threading.Thread(target=_keepalive_loop, daemon=True).start()
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/")
def root():
    return {"status": "ok"}


# The server modules whose contents define "the running code". Listed rather
# than globbed so that adding a file is a deliberate act and a stray .py left in
# the directory cannot change the digest.
_SOURCE_FILES = (
    "main.py", "analyzer.py", "data_fetcher.py", "observability.py",
    "i18n_data.py", "news_signals.py", "stooq_fallback.py", "ticker_search.py",
)
_source_digest_cache = None


def _source_digest() -> str:
    """
    Short digest of the source files this process loaded.

    Computed once and cached: the files cannot change under a running process,
    and /status is polled by the app on every cold start.

    Carriage returns are stripped before hashing. Git checks these files out
    with CRLF on Windows and LF on Render's Linux builders, so hashing raw
    bytes would report a mismatch for identical code — a checker that cries
    wolf gets ignored, which is worse than having no checker.
    """
    global _source_digest_cache
    if _source_digest_cache is not None:
        return _source_digest_cache
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        h = hashlib.sha256()
        for name in sorted(_SOURCE_FILES):
            path = os.path.join(here, name)
            try:
                with open(path, "rb") as fh:
                    body = fh.read().replace(b"\r\n", b"\n")
            except FileNotFoundError:
                body = b""          # absence is itself part of the fingerprint
            h.update(name.encode("utf-8"))
            h.update(b"\0")
            h.update(body)
            h.update(b"\0")
        _source_digest_cache = h.hexdigest()[:12]
    except Exception as _e:
        swallow("main:_source_digest", _e)
        _source_digest_cache = "unknown"
    return _source_digest_cache


@app.api_route("/status", methods=["GET", "HEAD"])
def status():
    """
    בדיקת סטטוס שה-frontend קורא לה לפני שטוען כל דבר אחר. אם קובץ MAINTENANCE.flag
    קיים באותה תיקייה כמו main.py - מציגים מסך "תחת תחזוקה" באפליקציה במקום התוכן הרגיל.
    כדי להפעיל/לכבות מצב תחזוקה: ליצור/למחוק את הקובץ MAINTENANCE.flag בתיקייה.
    """
    flag_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "MAINTENANCE.flag")
    # `build` and `lkg` exist because on 2026-08-08 a fix was pushed, the code
    # was confirmed committed, and the live server kept returning the old
    # behaviour — and there was no way to tell from outside whether the deploy
    # had happened, whether the process had restarted, or whether the fix was
    # simply wrong. Guessing between those three wasted a round trip each time.
    #
    # `build` is Render's commit SHA, so "is my fix live?" becomes one request.
    # `lkg` reports which storage backend is actually in use, so the same
    # question about Upstash does not require reading the startup log.
    #
    # Neither leaks anything: a short commit hash and a backend name. No
    # credentials, no host, no token.
    return {
        "maintenance": os.path.exists(flag_path),
        "build": (os.environ.get("RENDER_GIT_COMMIT") or "dev")[:7],
        # `code` exists because `build` turned out to be untrustworthy.
        #
        # On 2026-08-12 the P/E fix was pushed, Render deployed it, and the
        # live endpoint provably ran the new code (ORA.TA went from 16955.4 to
        # "not reported") while this field still reported a commit from two
        # pushes earlier. RENDER_GIT_COMMIT is an environment variable, and an
        # environment variable can be stale, overridden in the dashboard, or
        # absent — so it describes what Render was told, not what is running.
        # That is the exact failure `build` was added to prevent, one level up.
        #
        # This one cannot drift: it is a digest of the source files actually
        # loaded into this process. If it matches the digest of the working
        # copy, the deployed code IS the local code, whatever any env var says.
        "code": _source_digest(),
        "lkg": lkg_backend(),
        # Same lesson as `lkg`: monitoring that is coded but has no DSN is
        # monitoring that does not exist, and it looks identical from outside.
        # The Upstash 401 sat unnoticed for exactly this reason.
        "sentry": "on" if _SENTRY_ACTIVE else "off",
    }


@app.get("/privacy")
def privacy():
    """Privacy Policy page — required by Google Play and App Store."""
    html = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BuddhaVest — Privacy Policy</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         max-width: 780px; margin: 0 auto; padding: 32px 20px;
         color: #1a1a2e; background: #f9fafb; line-height: 1.7; }
  h1   { font-size: 26px; color: #0f1117; margin-bottom: 4px; }
  h2   { font-size: 17px; color: #1e293b; margin-top: 32px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
  p, li { font-size: 15px; color: #374151; }
  a    { color: #f59e0b; }
  .meta { font-size: 13px; color: #6b7280; margin-bottom: 32px; }
  .box  { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 14px 18px;
          border-radius: 0 8px 8px 0; margin: 24px 0; }
</style>
</head>
<body>

<h1>BuddhaVest — Privacy Policy</h1>
<p class="meta">Last updated: July 2026 &nbsp;·&nbsp; Contact: <a href="mailto:supportbuddhavest@gmail.com">supportbuddhavest@gmail.com</a></p>

<div class="box">
  <strong>BuddhaVest is a stock research tool, not a financial advisor.</strong>
  All data, scores, and analysis are for informational purposes only and do not constitute investment advice.
  Past performance does not guarantee future results.
</div>

<h2>1. Information We Collect</h2>
<p>BuddhaVest does <strong>not</strong> require account registration and does <strong>not</strong> collect personal information such as your name, email address, or financial account details.</p>
<p>The following data is <strong>stored only on your device</strong> (via AsyncStorage). We never
  store it on our servers and never share it with anyone:</p>
<ul>
  <li>Your watchlist (ticker symbols you save)</li>
  <li>Your research journal entries — these <strong>never leave your device at all</strong></li>
  <li>App preferences: language, color theme, notification seen state</li>
</ul>
<p>To be precise about the watchlist: it is <em>saved</em> only on your device, but in order to
  show you a price and a score for each entry, the app has to ask our server about those
  ticker symbols. So the symbols themselves are sent with the request. They are used to fetch
  market data, are not written to any database, and are not linked to you or to any identifier.
  Your language setting is sent the same way, so the response comes back in your language.</p>

<h2>2. Data We Process on Our Servers</h2>
<p>When you use the app, our backend server processes the following to serve you data:</p>
<ul>
  <li><strong>Ticker symbols</strong> you search, view, or keep in your watchlist (e.g., "AAPL") — used to fetch market data. Not stored, and not linked to your identity.</li>
  <li><strong>Language preference</strong> — sent with analysis requests to translate content server-side. Not stored.</li>
  <li><strong>Article links</strong> you open with in-app translation enabled — the page address is sent so the article text can be fetched and translated. Not stored.</li>
</ul>
<p>We do not build user profiles and do not tie requests to your identity. As with any
  web server, our hosting provider keeps standard technical logs (which can include the
  requesting IP address and the URL requested) for a short period for security and
  troubleshooting. We do not use these logs for advertising or profiling.</p>

<h2>3. Third-Party Services</h2>
<p>BuddhaVest retrieves market data and news from public financial data sources. Article translation is powered by Google Translate. These services have their own privacy policies:</p>
<ul>
  <li><a href="https://policies.google.com/privacy" target="_blank">Google Privacy Policy</a></li>
</ul>
<p>We do not share your data with advertisers or any third party for commercial purposes.</p>

<h2>4. Children's Privacy</h2>
<p>BuddhaVest is not directed at children under 13. We do not knowingly collect data from children.</p>

<h2>5. Data Security</h2>
<p>All communication between the app and our server uses HTTPS. Locally stored data remains on your device and is subject to your device's own security.</p>

<h2>6. Changes to This Policy</h2>
<p>We may update this policy from time to time. The "Last updated" date at the top reflects the most recent revision. Continued use of the app after changes constitutes acceptance of the updated policy.</p>

<h2>7. Contact</h2>
<p>Questions about this policy? Email us at <a href="mailto:supportbuddhavest@gmail.com">supportbuddhavest@gmail.com</a>.</p>

</body>
</html>"""
    from fastapi.responses import HTMLResponse
    return HTMLResponse(content=html)


@app.get("/search")
@rate_limit("light")
def search(request: Request, q: str):
    """
    חיפוש סימול לפי שם חברה (עברית/אנגלית) או חלק משם - לדוגמה "אינטל" -> INTC.
    אם q הוא כבר סימול מדויק וקיים, עדיף לקרוא ל-/analyze/{ticker} ישירות -
    זה ה-endpoint לכל מקרה שהקלט הוא שם ולא סימול.
    """
    if not q or not q.strip():
        return {"query": q, "results": []}
    # Cap the query length — no real company name is longer, and this keeps an
    # oversized request from being forwarded upstream or blowing up the cache.
    q = q.strip()[:64]
    results = search_tickers(q)

    # אם לא נמצא כלום ב-Yahoo (לא כינוי, לא חיפוש חי) - ננסה גיבוי חינמי (Stooq).
    # שימושי בעיקר כשהקלט הוא כבר סימול קרוב לנכון, רק שYahoo לא מזהה אותו.
    if not results:
        stooq_result = get_stooq_quote(q.strip())
        if stooq_result:
            results.append({
                "ticker": stooq_result["symbol"],
                "name": stooq_result["symbol"],
                "exchange": "Stooq",
            })

    return {"query": q, "results": results}


@app.get("/analyze/{ticker}")
@rate_limit("heavy")
def analyze(request: Request, ticker: str, lang: str = "he"):
    """מחזיר ניתוח מלא למנייה בודדת. lang: he/en/ru/es - שולט בשפת הטקסטים ההסברתיים."""
    ticker = _clean_ticker(ticker)
    lang = _clean_lang(lang)
    cache_key = f"analyze_{ticker.upper()}_{lang}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    # Coalesce duplicate concurrent requests for this exact ticker+lang.
    _lk = _key_lock(cache_key)
    # 28s, not 50: the fetch itself is now capped at 25s, so a waiter that blocks
    # for 50 outlives the work it is waiting for and becomes a second way to hang
    # past the client's own budget.
    _got = _lk.acquire(timeout=28)
    try:
        if _got:
            # Someone may have filled the cache while we waited for the lock.
            cached = _cache_get(cache_key)
            if cached is not None:
                return cached
        return _analyze_uncached(ticker, lang, cache_key)
    finally:
        if _got:
            _lk.release()


def _analyze_uncached(ticker: str, lang: str, cache_key: str):
    """The expensive path — only ever entered by one caller per key at a time."""
    # Hard ceiling on the whole fetch. Without it this call had no upper bound:
    # /analyze/AMD was measured still open after 180 seconds while Yahoo was
    # unresponsive, and because uvicorn runs one worker, that single stuck
    # request stopped the server answering ANY route. The phone showed
    # "Analyzing AMD…" indefinitely.
    #
    # 25s is comfortably above a healthy fetch (2-6s) and well under the
    # client's own 20s/40s attempts, so the app sees a clean failure it already
    # knows how to display instead of a silence it cannot interpret.
    try:
        data = _with_deadline(lambda: get_stock_data(ticker), 25, default=None)
    except Exception as e:
        # Don't echo the raw exception to clients (internal detail leak).
        report("analyze_fetch_failed", ticker=ticker, error=str(e)[:120])
        raise HTTPException(status_code=502, detail="Could not fetch data for this ticker.")
    if data is None:
        report("analyze_timeout", ticker=ticker)
        raise HTTPException(status_code=504, detail="Data provider did not respond in time.")

    # אם yfinance מחזיר info ריק - הסימול כנראה לא קיים (או שזו בעיית סיומת בורסה)
    if not data.get("info") or (
        data["info"].get("currentPrice") is None and
        data["info"].get("regularMarketPrice") is None and
        data["info"].get("navPrice") is None
    ):
        # ניסיון גיבוי חינמי (Stooq, בלי מפתח API) - לפעמים Yahoo לא מזהה מנייה
        # שכן קיימת, בעיקר בבורסות לא-אמריקאיות. Stooq נותן רק מחיר, לא ניתוח
        # פונדמנטלי מלא - אז זה נשאר "תוצאה חלקית" עם הסבר ברור, לא ניתוח מלא.
        stooq_result = get_stooq_quote(ticker)
        if stooq_result:
            return {
                "ticker": stooq_result["symbol"],
                "company_name": stooq_result["symbol"],
                "current_price": stooq_result["price"],
                "partial_data": True,
                "partial_data_source": "stooq",
                "partial_data_note": render_explanation([("stooq_partial_note", {})], lang),
                "final_score": None,
                "recommendation": None,
                "recommendation_color": None,
                "metrics": {},
                "dividend_summary": None,
                "buyback_summary": None,
                "history": None,
                "overview": {},
                "usd_ils": None,
            }
        raise HTTPException(status_code=404, detail=f"Ticker '{ticker}' not found or has no price data.")

    result = calculate_score(data)

    # תרגום הסברי המדדים לשפה המבוקשת (התוויות כמו "P/E Ratio" נשארות תמיד באנגלית)
    if lang != "he":
        for metric in result["metrics"].values():
            parts = metric.get("explanation_parts")
            if parts:
                metric["explanation"] = render_explanation(parts, lang)
        # Also translate the top-level summaries (recommendation, dividend,
        # buyback) — previously only metric explanations were translated and
        # these three stayed Hebrew in non-Hebrew responses.
        for field, parts_field in (
            ("recommendation_explanation", "recommendation_parts"),
            ("dividend_summary", "dividend_summary_parts"),
            ("buyback_summary", "buyback_summary_parts"),
        ):
            _p = result.get(parts_field)
            if _p:
                result[field] = render_explanation(_p, lang)

    # הוספת היסטוריית מחיר לגרף (12 חודשים אחרונים, נקודה לשבוע כדי לא להעמיס)
    history = data.get("history")
    if history is not None and not history.empty and "Close" in history.columns:
        try:
            close = history["Close"].dropna()
            if len(close) >= 2:
                # אם יש מעט מאוד נקודות מסחר (למשל מנייה שהונפקה לאחרונה) - מציגים את כולן.
                # אחרת - sampling של נקודה לשבוע בערך כדי לא להעמיס.
                step = 5 if len(close) > 10 else 1
                indices = list(range(0, len(close), step))
                # קריטי: מבטיחים שהנקודה האחרונה (המחיר העדכני ביותר) תמיד נכללת,
                # גם אם אורך הסדרה לא מתחלק בדיוק ב-step. בלי זה, הנקודה האחרונה
                # בגרף יכולה "לפגר" עד step-1 ימי מסחר אחורה מהמחיר החי שמוצג
                # במקום אחר במסך - מבלבל במיוחד במניה תנודתית שמשנה מחיר במהירות.
                last_idx = len(close) - 1
                if indices[-1] != last_idx:
                    indices.append(last_idx)
                sampled = close.iloc[indices]
                result["history"] = {
                    "dates": [d.strftime("%b %d") for d in sampled.index],
                    "prices": [round(float(p), 2) for p in sampled.values],
                }
            else:
                result["history"] = None
        except Exception:
            result["history"] = None
    else:
        result["history"] = None

    # נתוני "תמונה כללית" - שווי שוק, טווח 52 שבועות, נפח מסחר, סקטור
    info = data.get("info", {})
    result["overview"] = {
        "market_cap": info.get("marketCap"),
        "week52_low": info.get("fiftyTwoWeekLow"),
        "week52_high": info.get("fiftyTwoWeekHigh"),
        "volume": info.get("volume") or info.get("regularMarketVolume"),
        "avg_volume": info.get("averageVolume"),
        "sector": info.get("sector"),
        "industry": info.get("industry"),
        "business_summary": _translate_text((info.get("longBusinessSummary") or "")[:1500], lang) or None,
    }

    # ── Last-known-good backfill (DISPLAY STATS ONLY — never the score/fundamentals) ──
    # Yahoo sometimes returns a live price but null market cap / volume / 52-week
    # range when throttling. Reuse the last non-null value per ticker so the header
    # stats stay populated instead of flickering to "—", matching /market-overview.
    _ov = result["overview"]
    _ov_key = (result.get("ticker") or ticker).upper()
    _ov_fields = ("market_cap", "week52_low", "week52_high", "volume", "avg_volume")
    _ov_lkg = _cache_get("analyze_overview_lkg") or {}
    _prev = _ov_lkg.get(_ov_key, {})
    for _f in _ov_fields:
        if _ov.get(_f) is None and _prev.get(_f) is not None:
            _ov[_f] = _prev[_f]
    _ov_lkg[_ov_key] = {
        _f: (_ov.get(_f) if _ov.get(_f) is not None else _prev.get(_f))
        for _f in _ov_fields
    }
    _cache_set("analyze_overview_lkg", _ov_lkg, 86400)
    _lkg_mark_dirty()  # flushed by _lkg_flush_loop, off the request path

    # Forward P/E ו-Sector comparison
    try:
        info = data.get("info", {})
        forward_pe = info.get("forwardPE")
        trailing_pe = info.get("trailingPE")
        sector = info.get("sector")
        # (no industry/sector average: yfinance does not expose one, and the
        # placeholder variable that used to sit here was never read)
        
        # A NEGATIVE multiple is not a cheap multiple — it means there are no
        # earnings (or no EBITDA, or negative equity) to divide by, so the ratio
        # carries no information. analyzer.py already refuses a negative P/E for
        # the scored metric; these display-only fields never did, so a
        # cash-burning company showed "Forward P/E -8.47" and, worse,
        # "EV/EBITDA -6.72" coloured GREEN, because the tile's rule is
        # `< 10 -> green` and -6.72 passes it. Verified live on RIVN.
        def _pos(v):
            try:
                f = float(v)
            except (TypeError, ValueError):
                return None
            return round(f, 2) if f > 0 else None

        ve = {
            "forward_pe":     _pos(forward_pe),
            "trailing_pe":    _pos(trailing_pe),
            "price_to_book":  _pos(info.get("priceToBook")),
            "price_to_sales": _pos(info.get("priceToSalesTrailing12Months")),
            "ev_to_ebitda":   _pos(info.get("enterpriseToEbitda")),
            "sector": sector,
        }

        # ── Fallback: compute from the financial statements ──
        # All five of these come from stock.info, which is Yahoo's AUTHENTICATED
        # endpoint. When Yahoo throttles a cloud IP that endpoint returns empty
        # while the statement endpoints keep working — so the whole "Additional
        # Valuation Multiples" card vanished at the same moment company names and
        # volume did. One upstream failure, three parts of the UI blank.
        #
        # The statements carry everything needed for four of the five, and the
        # historical charts already compute exactly this way. Only forward P/E
        # cannot be derived (it needs an analyst estimate, not a reported figure).
        #
        # Used ONLY to fill a gap: a value Yahoo did provide is never replaced.
        # Skipped for minor-unit listings (Tel Aviv, London, Johannesburg), where
        # the quote and the statements are in different units — the same reason
        # _tase_price_mismatch suppresses the historical charts.
        try:
            price = (info.get("currentPrice") or info.get("navPrice")
                     or info.get("regularMarketPrice"))
            if price and not _tase_price_mismatch(ticker):
                price = float(price)
                inc, bal = data.get("income"), data.get("balance")

                def _latest(df, aliases):
                    s = _row_series(df, aliases)
                    if s is None or not len(s):
                        return None
                    v = float(s.iloc[-1])          # newest column
                    return v if v == v else None   # drop NaN

                shares = _latest(bal, _SHARE_ROWS) or _latest(inc, _SHARE_ROWS)
                if shares and shares > 0:
                    if ve.get("price_to_book") is None:
                        eq = _latest(bal, ["Stockholders Equity", "Common Stock Equity"])
                        if eq and eq > 0:
                            ve["price_to_book"] = _pos(price / (eq / shares))
                    if ve.get("price_to_sales") is None:
                        rev = _latest(inc, ["Total Revenue", "Operating Revenue"])
                        if rev and rev > 0:
                            ve["price_to_sales"] = _pos(price / (rev / shares))
                    if ve.get("ev_to_ebitda") is None:
                        ebitda = _latest(inc, ["EBITDA", "Normalized EBITDA"])
                        if ebitda and ebitda > 0:
                            debt = _latest(bal, ["Total Debt",
                                                 "Long Term Debt And Capital Lease Obligation"]) or 0
                            cash = _latest(bal, ["Cash And Cash Equivalents",
                                                 "Cash Cash Equivalents And Short Term Investments"]) or 0
                            ve["ev_to_ebitda"] = _pos((price * shares + debt - cash) / ebitda)
                if ve.get("trailing_pe") is None:
                    eps = _latest(inc, ["Diluted EPS", "Basic EPS"])
                    if eps and eps > 0:
                        ve["trailing_pe"] = _pos(price / eps)
        except Exception as _e:
            swallow("main:_analyze_uncached", _e, notify=True)

        result["valuation_extra"] = ve
    except Exception:
        result["valuation_extra"] = {}

    # שער דולר-שקל - כדי שה-frontend יוכל להציג מחיר גם בשקלים
    try:
        fx_data = get_quote("ILS=X")
        result["usd_ils"] = fx_data["info"].get("currentPrice") or fx_data["info"].get("regularMarketPrice")
    except Exception:
        result["usd_ils"] = None

    # היסטוריה בסיסית של מדדים נפוצים – מהירה יותר מבקשות נפרדות
    try:
        import yfinance as yf
        _stk = _yf_ticker(ticker)
        fin = _get_quarterly_income(_stk)
        if fin is not None and not fin.empty:
            # שמות שורות מאומתים
            ROW_ALIASES = {
                "Revenue":          ["Total Revenue", "Operating Revenue"],
                "Gross Profit":     ["Gross Profit"],
                "Operating Income": ["Operating Income", "EBIT"],
                "Net Income":       ["Net Income", "Net Income Common Stockholders"],
                "Diluted EPS":      ["Diluted EPS", "Basic EPS"],
            }
            def find_row(df, name):
                for alias in ROW_ALIASES.get(name, [name]):
                    if alias in df.index:
                        return alias
                return None

            def quick_series(df, f1, f2=None, pct=False):
                r1 = find_row(df, f1)
                r2 = find_row(df, f2) if f2 else None
                if not r1: return []
                import math
                rows = []
                for col in df.columns:
                    try:
                        raw1 = df.loc[r1, col]
                        raw2 = df.loc[r2, col] if r2 else None
                        if raw1 is None or (isinstance(raw1, float) and math.isnan(raw1)): continue
                        if r2 and (raw2 is None or (isinstance(raw2, float) and math.isnan(raw2))): continue
                        v1 = float(raw1)
                        v2 = float(raw2) if raw2 is not None else None
                        if pct:
                            if not v2 or v2 == 0: continue
                            val = round(v1/v2*100, 2)
                        else:
                            val = round(v1, 4)
                        if math.isnan(val) or math.isinf(val): continue
                        rows.append({"date": col.strftime("%b %Y") if hasattr(col,"strftime") else str(col)[:7], "value": val})
                    # `except Exception`, not a bare `except`: a bare one also
                    # catches KeyboardInterrupt and SystemExit, so a shutdown
                    # signal arriving mid-loop would be swallowed as "bad row".
                    # Not logged per-row on purpose — a rejected row is normal
                    # (NaN, missing field) and would spam a line per data point;
                    # when EVERY row is rejected the caller already reports
                    # empty_chart with reason="all_points_rejected".
                    except Exception: continue
                return list(reversed(rows))
            fin_annual = _get_annual_income(_stk)
            def make_entry(q_series, a_df, f1, f2=None, pct=False):
                a_series = quick_series(a_df, f1, f2, pct) if a_df is not None and not a_df.empty else []
                return {"quarterly": q_series, "annual": a_series}

            gm_q  = quick_series(fin, "Gross Profit", "Revenue", pct=True)
            om_q  = quick_series(fin, "Operating Income", "Revenue", pct=True)
            nm_q  = quick_series(fin, "Net Income", "Revenue", pct=True)
            rev_q = quick_series(fin, "Revenue")
            ni_q  = quick_series(fin, "Net Income")
            eps_q = quick_series(fin, "Diluted EPS")

            result["inline_history"] = {
                "gross_margin":     make_entry(gm_q,  fin_annual, "Gross Profit", "Revenue", pct=True),
                "operating_margin": make_entry(om_q,  fin_annual, "Operating Income", "Revenue", pct=True),
                "net_margin":       make_entry(nm_q,  fin_annual, "Net Income", "Revenue", pct=True),
                "revenue":          make_entry(rev_q, fin_annual, "Revenue"),
                "net_income":       make_entry(ni_q,  fin_annual, "Net Income"),
                "eps":              make_entry(eps_q, fin_annual, "Diluted EPS"),
            }
    except Exception:
        result["inline_history"] = {}

    # ── Israeli (TASE) listings ──
    # Yahoo quotes Tel-Aviv stocks in agorot (1/100 ILS), while revenue, net
    # income and cash stay in the statements' own currency. Convert the
    # per-share PRICE fields to shekel and tag the currency so the app shows ₪
    # and skips the (wrong) USD→ILS conversion.
    #
    # Two claims that used to sit here were both false and both shipped a wrong
    # number to users:
    #   "marketCap stays in shekel"  — it does not; see _reconcile_market_cap.
    #   "ratios are unit-free"       — true of a ratio the PROVIDER computed,
    #                                  false of one computed here from a price;
    #                                  see _price_eps_units_agree in analyzer.py.
    #
    # Detection is by BOTH the ".TA" suffix (TASE equities are always quoted in
    # agorot) AND the currency field ("ILA"/"ILS") — belt and suspenders, since
    # Yahoo is inconsistent about which currency code it reports.
    _ticker_up = (result.get("ticker") or ticker or "").upper()
    _ccy_raw = (info.get("currency") or "").strip()
    _ccy = _ccy_raw.upper()
    _is_tase = _ticker_up.endswith(".TA") or _ccy in ("ILA", "ILS")
    if _is_tase:
        result["price_currency"] = "ILS"
        # agorot → shekel. Skip only if Yahoo explicitly says the quote is
        # already in shekel ("ILS"); every other TASE case is agorot.
        if _ccy != "ILS":
            _scale_price_fields(result, 100.0)
            _reconcile_market_cap(result, info, 100.0)
    else:
        # Yahoo reports the real trading currency; using it means a German, UK
        # or Japanese listing is no longer stamped with a dollar sign. The old
        # rule was binary — TASE or "USD" — so DHER.DE (Delivery Hero, quoted in
        # euro) came back as USD and the app printed "$37.95" for a €37.95 share.
        #
        # London and Johannesburg go one step further: they quote in the MINOR
        # unit, so the number needs dividing as well as relabelling.
        _minor = _minor_unit_for(_ccy_raw)
        if _minor:
            result["price_currency"] = _minor[0]
            _scale_price_fields(result, _minor[1])
            _reconcile_market_cap(result, info, _minor[1])
        else:
            result["price_currency"] = _ccy or "USD"

    # A company can TRADE in one currency and REPORT in another. Elbit Systems
    # (ESLT.TA) trades in shekels but publishes its statements in dollars, so
    # the app stamped a shekel sign on $925M of cash and showed "₪925.27M" — a
    # threefold error in the number the user reads. Yahoo exposes the reporting
    # currency separately; pass it through so the client can label
    # statement-derived figures (cash, cash flow, revenue, net income, cost of
    # revenue) correctly, while price and market cap keep the trading currency.
    _fin_ccy = (info.get("financialCurrency") or "").upper()
    if _fin_ccy == "ILA":          # agorot is never a reporting currency
        _fin_ccy = "ILS"

    # When the provider does not report it, the old code fell back to the
    # trading currency. Measured on ORA.TA on 2026-08-12: financialCurrency was
    # absent, the fallback stamped ILS on statements written in dollars, and the
    # app showed "ILS 989.5M" of revenue for a company that earned USD 989.5M —
    # ILS 2.96B. A threefold error on revenue, net income, cash and cash flow,
    # presented with a currency sign that made it look precise.
    #
    # The guess is only dangerous where the split actually happens: a listing
    # quoted in a minor unit is one whose company may well report abroad, and
    # Elbit, Ormat and Teva all do. For an ordinary listing the trading currency
    # is the reporting currency often enough that dropping the sign would be a
    # worse trade. So: guess where it is safe, say nothing where it is not.
    _fin_known = bool(_fin_ccy)
    if not _fin_known and not _minor_unit_for(_ccy_raw) and not _is_tase:
        _fin_ccy = result["price_currency"]
        _fin_known = True

    result["financial_currency"] = _fin_ccy or None
    # The client needs to tell "USD, confirmed" from "we do not know", because
    # the honest rendering of the second is a number with no currency sign.
    result["financial_currency_known"] = _fin_known

    _cache_set(cache_key, result, CACHE_TTL["stock"])
    return result


# ── Minor-unit quotes ──
# Several exchanges quote in a currency's MINOR unit (1/100 of the major one)
# while marketCap / revenue / net income stay in the MAJOR unit. Yahoo signals
# this in `info["currency"]`, and the signal is CASE-SENSITIVE: "GBp" is pence,
# "GBP" is pounds. The old code ran `.upper()` before every comparison, which
# collapsed the two — so a Shell share quoted at 2578.5 pence was published as
# "£2578.50" instead of "£25.79", a 100x error on the headline number.
#
# Tel Aviv (agorot, "ILA") was already special-cased by ticker suffix; London
# ("GBp"/"GBX") and Johannesburg ("ZAc") had no handling at all.
_MINOR_UNIT = {
    "GBp": ("GBP", 100.0),   # London — pence.  NOTE: "GBP" is NOT in this map.
    "GBX": ("GBP", 100.0),   # same thing under its ISO-ish alias
    "GBx": ("GBP", 100.0),
    "ZAc": ("ZAR", 100.0),   # Johannesburg — cents
    "ZAC": ("ZAR", 100.0),
    "ILA": ("ILS", 100.0),   # Tel Aviv — agorot
    "ILa": ("ILS", 100.0),
}


def _minor_unit_for(raw_ccy: str):
    """Return (major_currency, divisor) when `raw_ccy` is a minor unit, else None."""
    return _MINOR_UNIT.get((raw_ccy or "").strip())


# Mirrors symbolFor() in StockScreen.js / WatchlistScreen.js — keep the two in
# step, or the same stock shows one sign on the tile and another in an event.
_CCY_SYMBOL = {"ILS": "₪", "ILA": "₪", "EUR": "€", "GBP": "£", "RUB": "₽", "JPY": "¥"}


def _ccy_symbol(code: str) -> str:
    return _CCY_SYMBOL.get((code or "").upper(), "$")


def _scale_price_fields(result: dict, divisor: float) -> None:
    """
    Divide every PER-SHARE field by `divisor`, in place.

    Deliberately does NOT touch revenue, net income or cash: those come from the
    financial statements, which are already in the major unit, so dividing them
    would introduce the mirror image of the bug this fixes.

    It does not touch market cap either, but NOT because market cap is safe.
    That claim used to be here — "Verified on Tel Aviv, where marketCap is in
    shekel while the quote is in agorot" — and it is wrong. Measured on
    2026-08-12, ORA.TA and POLI.TA both reported a market cap 100x too large,
    and the app showed Bank Hapoalim as a ILS 10 trillion company. Market cap is
    handled by _reconcile_market_cap instead, which checks it against shares x
    price rather than believing either version of this comment.
    """
    if result.get("current_price") is not None:
        result["current_price"] = round(result["current_price"] / divisor, 2)
    _ov = result.get("overview") or {}
    for _k in ("week52_low", "week52_high"):
        if _ov.get(_k) is not None:
            _ov[_k] = round(_ov[_k] / divisor, 2)
    _h = result.get("history")
    if _h and _h.get("prices"):
        _h["prices"] = [round(p / divisor, 2) for p in _h["prices"]]


def _shares_outstanding(result: dict, info: dict):
    """
    Share count, from whichever source is available. None if neither is.

    Two sources on purpose. `sharesOutstanding` is the direct one but lives in
    the part of quoteSummary that degrades. Net income divided by diluted EPS
    is arithmetic on the income statement, which arrives separately — and it is
    unit-free, so it stays correct even when the statements are in a different
    currency from the quote (Ormat reports in dollars and trades in shekels).
    """
    direct = info.get("sharesOutstanding") if isinstance(info, dict) else None
    # Type-checked instead of wrapped in try/except, for two reasons. CI forbids
    # a silent handler and it was right to: an `except: pass` here was the first
    # thing I wrote and it hid the second reason, which is that `float(True)` is
    # 1.0. A boolean in this field would have become a share count of one, and
    # a market cap "reconciled" against one share is worse than none at all.
    # Strings are not accepted: yfinance normalises this field to a number, and
    # anything else arriving here is not a share count.
    if isinstance(direct, (int, float)) and not isinstance(direct, bool):
        direct = float(direct)
        if direct > 0 and direct == direct and direct != float("inf"):
            return direct
    try:
        hist = (result.get("inline_history") or {})
        ni = ((hist.get("net_income") or {}).get("annual") or [])
        eps = ((hist.get("eps") or {}).get("annual") or [])
        if ni and eps:
            n = float(ni[-1]["value"])
            e = float(eps[-1]["value"])
            if e > 0 and n > 0:
                return n / e
    except Exception as _e:
        swallow("main:_shares_outstanding", _e)
    return None


def _reconcile_market_cap(result: dict, info: dict, divisor: float) -> None:
    """
    Make market cap agree with shares x price, or publish nothing.

    _scale_price_fields deliberately leaves market cap alone, on the stated
    grounds that "marketCap is in shekel while the quote is in agorot". Measured
    on 2026-08-12, that is false for both tickers checked:

        ORA.TA   reported  ILS 2,106.27B   shares x price  ILS  21.01B   x100.3
        POLI.TA  reported  ILS 10,048.53B  shares x price  ILS 101.49B   x99.0

    Bank Hapoalim is a ~ILS 100B company and the app was calling it a ILS 10
    trillion one, on the stock screen and in the market table. One of those two
    tickers reports in dollars and one in shekels, so this is not a
    reporting-currency artefact — the quote unit reaches market cap too.

    Blindly dividing by 100 would be trading one assumption for another, and
    whoever wrote that docstring presumably saw something. So this does not
    assume: it reconstructs the market cap from the share count and the price
    that were already converted, and acts on the ratio.

      ratio near 1        the value is already in the major unit — leave it
      ratio near divisor  it is in the minor unit — divide, and say so
      anything else       we cannot explain it, so we do not publish it

    Suppressing is the right third branch. A market cap the user can read is
    worth less than not being lied to, and `report()` means the case reaches
    Sentry instead of a screenshot.
    """
    try:
        overview = result.get("overview") or {}
        mc = overview.get("market_cap")
        price = result.get("current_price")
        if mc is None or not price or price <= 0:
            return

        shares = _shares_outstanding(result, info)
        if not shares:
            # Unverifiable. Both tickers measured were in the minor unit, but
            # one unverified guess is what produced this bug, so say nothing.
            overview["market_cap"] = None
            report("market_cap_unverifiable", ticker=result.get("ticker"),
                   reported=mc, reason="no share count from either source")
            return

        expected = shares * price
        if expected <= 0:
            return
        ratio = mc / expected

        if 0.5 <= ratio <= 2.0:
            return                                  # already correct
        if divisor * 0.5 <= ratio <= divisor * 2.0:
            overview["market_cap"] = mc / divisor
            report("market_cap_rescaled", ticker=result.get("ticker"),
                   was=mc, now=overview["market_cap"], divisor=divisor,
                   ratio=round(ratio, 2))
            return

        overview["market_cap"] = None
        report("market_cap_unexplained", ticker=result.get("ticker"),
               reported=mc, expected=round(expected, 2), ratio=round(ratio, 2))
    except Exception as _e:
        swallow("main:_reconcile_market_cap", _e, notify=True,
                ticker=result.get("ticker"))


# Exchanges whose quotes arrive in a MINOR unit while the financial statements
# are in the MAJOR one. Suffix-based on purpose: this runs before stock.info is
# read, and a false positive costs a chart (the screen falls back to the price
# series) whereas a false negative publishes a number that is 100x wrong.
_MINOR_UNIT_SUFFIXES = (".TA", ".L", ".JO")


def _tase_price_mismatch(ticker: str) -> bool:
    """
    True for listings where a price-derived multiple computed here CANNOT be
    trusted, because the quote and the financial statements use different units.

    Tel Aviv (agorot), London (pence) and Johannesburg (cents) all quote in
    1/100 of the reporting currency.

    Yahoo quotes TASE equities in agorot (1/100 ILS) while the financial
    statements are in shekels. Every multiple built from
    `stock.history()["Close"]` therefore mixes two units. Verified live on
    DLEKG.TA: the tile showed P/B 1.62 and this endpoint returned 164.63 (x101),
    and EV/EBITDA 17.53 against 316.49 (x18 — not a clean x100, because the debt
    and cash terms are already in shekels and partly offset the inflated market
    cap).

    Scaling the price by 100 looks like the obvious fix, but the EPS series unit
    could not be established from the data: reconciling reported EPS, net income
    and shares outstanding is off by a factor of 10 in BOTH directions, so a
    blind correction risks breaking P/E, which currently returns plausible
    values. Until that is settled, these endpoints fall through to the price
    chart instead of publishing a number that is provably wrong.
    """
    return (ticker or "").upper().endswith(_MINOR_UNIT_SUFFIXES)


def _with_deadline(fn, seconds, default=None):
    """
    Run `fn()` and give up waiting after `seconds`, returning `default`.

    Why not a timeout inside yfinance: handing it a custom HTTP session broke
    `stock.info` for every ticker while leaving `fast_info` working, so prices
    still appeared but names, volume and average volume all went null — a
    silent, invisible degradation. yfinance owns its session; we do not touch it.

    This bounds the REQUEST instead. The worker thread may still be blocked on
    Yahoo, but the endpoint returns, so the phone gets an answer rather than
    sitting on "Analyzing…" forever, and uvicorn's worker is free again.
    """
    from concurrent.futures import TimeoutError as _FTimeout
    # Bounded on purpose: abandoned threads cannot pile up without limit on a
    # 512MB instance. Registered in the same pool table as the others so every
    # long-lived thread in the process is created in one place — and so the
    # deadline pool stays SEPARATE from the I/O pool it fans out into. A task
    # here waiting on a task in the same pool would deadlock once saturated.
    try:
        return _pool("bv-deadline", 8).submit(fn).result(timeout=seconds)
    except _FTimeout:
        report("deadline_exceeded", seconds=seconds, fn=getattr(fn, "__name__", "lambda"))
        return default
    except Exception as _e:
        swallow("main:_with_deadline", _e, fn=getattr(fn, "__name__", "lambda"))
        return default


def _find_row(df, aliases):
    """First matching row label in `df`, trying exact aliases then substring."""
    if df is None or getattr(df, "empty", True):
        return None
    for alias in aliases:
        if alias in df.index:
            return alias
    for alias in aliases:
        low = alias.lower()
        for idx in df.index:
            if low in str(idx).lower():
                return idx
    return None


def _row_series(df, aliases):
    """Row from `df` as a clean, tz-naive, date-sorted float Series (or None)."""
    row = _find_row(df, aliases)
    if row is None:
        return None
    try:
        s = df.loc[row].sort_index().dropna()
        if hasattr(s.index, "tz") and s.index.tz:
            s.index = s.index.tz_localize(None)
        s = s.apply(float)
        return s if len(s) else None
    except Exception:
        return None


# Where a share count can be found, in order of preference. Outstanding shares
# come first (they exclude treasury stock, which is what a per-share figure
# needs); the averaged income-statement counts are a last resort.
_SHARE_ROWS = ["Ordinary Shares Number", "Share Issued",
               "Diluted Average Shares", "Basic Average Shares"]


def _shares_lookup(info: dict, balance_q, balance_a, income_q, income_a):
    """
    Return `shares_at(date)` — the share count in effect at a given date — plus a
    flag saying whether ANY source was found.

    Why this exists as one shared function: the share count was read straight
    from info["sharesOutstanding"] in TWO separate places, and Yahoo simply does
    not return that field for every ticker. For AMD it is absent, so a single
    `if not shares` wiped out the entire history of P/B, P/S, EV/EBITDA, Forward
    P/E *and* buyback yield — while the tiles kept showing values, because those
    come from Yahoo's own summary ratios and never needed a share count. A blank
    chart with a populated tile is the worst possible failure: it looks like
    missing data rather than a bug.

    Every statement AMD publishes carries the number (Ordinary Shares Number =
    1,630,410,843). Reading it per date is also more accurate than one current
    count stretched across five years of prices, since buybacks change it.

    Both call sites now use this, so the two copies cannot drift apart again.
    """
    sq = _row_series(balance_q, _SHARE_ROWS)
    if sq is None:
        sq = _row_series(income_q, _SHARE_ROWS)
    sa = _row_series(balance_a, _SHARE_ROWS)
    if sa is None:
        sa = _row_series(income_a, _SHARE_ROWS)

    static = info.get("sharesOutstanding") or info.get("impliedSharesOutstanding")
    try:
        static = float(static) if static else None
    except (TypeError, ValueError):
        static = None

    def shares_at(date):
        for s in (sq, sa):
            if s is not None:
                past = s[s.index <= date].tail(1)
                if len(past) == 1:
                    v = float(past.iloc[0])
                    if v > 0:
                        return v
        # Before the earliest statement, fall back to the oldest known count
        # rather than dropping the point entirely.
        for s in (sq, sa):
            if s is not None and len(s):
                v = float(s.iloc[0])
                if v > 0:
                    return v
        return static

    have_any = (sq is not None) or (sa is not None) or (static is not None)
    return shares_at, have_any


def _annual_from_monthly(series_q: list) -> list:
    """
    Collapse a monthly series into one point per YEAR — the LAST month of each
    year, not the first.

    The previous logic walked the ascending monthly series and kept the first
    point it saw for a year, which is JANUARY. So the "Annual" toggle showed
    January snapshots labelled with the year: KO's 2023 annual P/E read 25.25
    (Jan) when the year actually closed at 22.19 (Dec) — a 14% gap presented to
    the user as that year's figure. Year-end is the conventional annual reading
    and matches what the annual financial statements represent.
    """
    by_year = {}
    for pt in series_q:                      # ascending, so the last write wins
        by_year[str(pt["date"]).split(" ")[-1]] = pt
    return [by_year[y] for y in sorted(by_year)]


def _get_quarterly_income(stock):
    for attr in ["quarterly_income_stmt", "quarterly_financials", "quarterly_incomestmt"]:
        try:
            df = getattr(stock, attr)
            if df is not None and not df.empty: return df
        except Exception as _e:
            swallow("main:_get_quarterly_income", _e)
    return None

def _get_annual_income(stock):
    for attr in ["income_stmt", "financials", "incomestmt"]:
        try:
            df = getattr(stock, attr)
            if df is not None and not df.empty: return df
        except Exception as _e:
            swallow("main:_get_annual_income", _e)
    return None

def _get_quarterly_balance(stock):
    for attr in ["quarterly_balance_sheet", "quarterly_balancesheet"]:
        try:
            df = getattr(stock, attr)
            if df is not None and not df.empty: return df
        except Exception as _e:
            swallow("main:_get_quarterly_balance", _e)
    return None

def _get_annual_balance(stock):
    for attr in ["balance_sheet", "balancesheet"]:
        try:
            df = getattr(stock, attr)
            if df is not None and not df.empty: return df
        except Exception as _e:
            swallow("main:_get_annual_balance", _e)
    return None

def _get_quarterly_cashflow(stock):
    for attr in ["quarterly_cash_flow", "quarterly_cashflow"]:
        try:
            df = getattr(stock, attr)
            if df is not None and not df.empty: return df
        except Exception as _e:
            swallow("main:_get_quarterly_cashflow", _e)
    return None

def _get_annual_cashflow(stock):
    for attr in ["cash_flow", "cashflow"]:
        try:
            df = getattr(stock, attr)
            if df is not None and not df.empty: return df
        except Exception as _e:
            swallow("main:_get_annual_cashflow", _e)
    return None

# ── REMOVED: /debug-pe and /debug-rows ──
# These were development-only inspectors left publicly reachable. They were
# removed because they:
#   1. returned a full Python traceback to the caller on error (leaking file
#      paths, code structure and library versions),
#   2. took an unvalidated ticker straight into yfinance,
#   3. had no cache and pulled 5 years of history / 10 statement DataFrames per
#      call — an unauthenticated way for anyone to exhaust a memory-limited
#      instance (the same pressure behind the Render out-of-memory restarts).
# No client code ever called them. Re-add locally if needed for debugging.

@app.get("/metric-history/{ticker}/{metric}")
@rate_limit("heavy")
def metric_history(request: Request, ticker: str, metric: str):
    # Time-bounded: see _with_deadline. An unbounded upstream call here can
    # occupy uvicorn's single worker and take the whole service down.
    return _with_deadline(lambda: _metric_history_uncached(ticker, metric), 20, default={"use_price": True, "quarterly": [], "annual": [], "empty_reason": "timeout"})


def _metric_history_uncached(ticker: str, metric: str):
    """מחזיר היסטוריה של מדד פיננסי ספציפי ל-5 שנים רבעונית/שנתית"""
    ticker = _clean_ticker(ticker)
    metric = "".join(c for c in (metric or "")[:40] if c.isalnum() or c == "_")
    cache_key = f"metric_history_{ticker.upper()}_{metric}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        import yfinance as yf
        import pandas as pd
        stock = _yf_ticker(ticker)

        # מיפוי מדדים לשדות ב-yfinance
        # שמות שורות מאומתים מ-yfinance האמיתי
        ROW_ALIASES = {
            "Revenue":          ["Total Revenue", "Operating Revenue"],
            "Gross Profit":     ["Gross Profit"],
            "Operating Income": ["Operating Income", "EBIT"],
            "Net Income":       ["Net Income", "Net Income Common Stockholders", "Net Income From Continuing Operation Net Minority Interest"],
            "Diluted EPS":      ["Diluted EPS", "Basic EPS"],
            "Total Debt":       ["Total Debt", "Long Term Debt And Capital Lease Obligation"],
            "Stockholders Equity": ["Stockholders Equity", "Common Stock Equity"],
            "Current Assets":   ["Current Assets"],
            "Current Liabilities": ["Current Liabilities"],
            "Total Liabilities Net Minority Interest": ["Total Liabilities Net Minority Interest"],
            # totalCash (what the tile shows) is cash PLUS short-term investments, so the
            # STI-inclusive row has to come first — otherwise the tile read $12.35B
            # while its own chart topped out at $6.0B.
            "Cash And Cash Equivalents": ["Cash Cash Equivalents And Short Term Investments", "Cash And Cash Equivalents"],
            "Operating Cash Flow": ["Operating Cash Flow", "Cash Flow From Continuing Operating Activities"],
            "Free Cash Flow":   ["Free Cash Flow"],
        }

        def find_row(df, name):
            for alias in ROW_ALIASES.get(name, [name]):
                if alias in df.index:
                    return alias
            # חיפוש חלקי
            name_lower = name.lower()
            for idx in df.index:
                if name_lower in str(idx).lower():
                    return idx
            return None

        METRIC_MAP = {
            # Income statement
            "gross_margin":     ("income", "Gross Profit", "Revenue", "pct"),
            "operating_margin": ("income", "Operating Income", "Revenue", "pct"),
            "net_margin":       ("income", "Net Income", "Revenue", "pct"),
            "revenue":          ("income", "Revenue", None, "abs"),
            "net_income":       ("income", "Net Income", None, "abs"),
            "eps":              ("income", "Diluted EPS", None, "abs"),
            # Balance sheet
            "debt_equity":      ("balance", "Total Debt", "Stockholders Equity", "ratio"),
            "current_ratio":    ("balance", "Current Assets", "Current Liabilities", "ratio"),
            "liab_equity":      ("balance", "Total Liabilities Net Minority Interest", "Stockholders Equity", "ratio"),
            "cash_position":    ("balance", "Cash And Cash Equivalents", None, "abs"),
            # Cash flow
            "operating_cf":     ("cashflow", "Operating Cash Flow", None, "abs"),
            "free_cf":          ("cashflow", "Free Cash Flow", None, "abs"),
            # Calculated
            "pe_ratio":         ("calc_pe", None, None, None),
            "peg_ratio":        ("calc_peg", None, None, None),
            # Valuation multiples (price-based)
            "forward_pe":       ("calc_forward_pe", None, None, None),
            "price_to_book":    ("calc_pb", None, None, None),
            "price_to_sales":   ("calc_ps", None, None, None),
            "ev_to_ebitda":     ("calc_ev_ebitda", None, None, None),
            # Income statement — direct fields
            "cost_of_revenue":  ("income", "Cost Of Revenue", None, "abs"),
        }

        CALC_SPECIAL = {"buyback", "dividend"}

        result_data = {"ticker": ticker.upper(), "metric": metric, "quarterly": [], "annual": [], "use_price": False}

        if metric not in METRIC_MAP and metric not in CALC_SPECIAL:
            # מדד ללא היסטוריה – החזר היסטוריית מחיר
            result_data["use_price"] = True
            result_data["empty_reason"] = "metric_not_tracked"
            report("empty_chart", metric=metric, ticker=ticker, reason="metric_not_tracked")
        elif metric in ("pe_ratio", "peg_ratio"):
            try:
                import math as _math          # pandas already imported above
                hist = stock.history(period=_HIST_PERIOD)
                eps_q_df = _get_quarterly_income(stock)
                eps_a_df = _get_annual_income(stock)

                def get_eps_series(df):
                    if df is None or df.empty: return None
                    for key in ["Diluted EPS", "Basic EPS"]:
                        if key in df.index:
                            s = df.loc[key].sort_index().dropna()
                            if hasattr(s.index, "tz") and s.index.tz:
                                s.index = s.index.tz_localize(None)
                            return s
                    return None

                eps_q = get_eps_series(eps_q_df)
                eps_a = get_eps_series(eps_a_df)

                if hist is None or hist.empty or (eps_q is None and eps_a is None):
                    result_data["use_price"] = True
                    result_data["empty_reason"] = "no_eps_series"
                    report("empty_chart", metric=metric, ticker=ticker, reason="no_eps_series")
                else:
                    price_monthly = hist["Close"].resample("ME").last()
                    if hasattr(price_monthly.index, "tz") and price_monthly.index.tz:
                        price_monthly.index = price_monthly.index.tz_localize(None)

                    series_q = []

                    for date, price in price_monthly.items():
                        price = float(price)
                        ttm_eps = None

                        # נסה TTM מ-4 רבעונים
                        if eps_q is not None:
                            past = eps_q[eps_q.index <= date].tail(4)
                            if len(past) == 4:
                                ttm_eps = float(past.sum())

                        # fallback לשנתי
                        if (ttm_eps is None or ttm_eps == 0) and eps_a is not None:
                            past_a = eps_a[eps_a.index <= date].tail(1)
                            if len(past_a) == 1:
                                ttm_eps = float(past_a.iloc[0])

                        if not ttm_eps or ttm_eps == 0:
                            continue
                        pe = round(price / ttm_eps, 2)
                        if pe <= 0 or pe > 3000 or _math.isnan(pe) or _math.isinf(pe):
                            continue

                        if metric == "pe_ratio":
                            pt = {"date": date.strftime("%b %Y"), "value": pe}
                            series_q.append(pt)

                        elif metric == "peg_ratio":
                            prev_ttm = None
                            if eps_q is not None:
                                past_prev = eps_q[eps_q.index <= date - pd.DateOffset(years=1)].tail(4)
                                if len(past_prev) == 4:
                                    prev_ttm = float(past_prev.sum())
                            if (prev_ttm is None or prev_ttm == 0) and eps_a is not None:
                                past_a_prev = eps_a[eps_a.index <= date - pd.DateOffset(years=1)].tail(1)
                                if len(past_a_prev) == 1:
                                    prev_ttm = float(past_a_prev.iloc[0])
                            if not prev_ttm or prev_ttm == 0:
                                continue
                            growth = ((ttm_eps - prev_ttm) / abs(prev_ttm)) * 100
                            if growth <= 0:
                                continue
                            peg = round(pe / growth, 3)
                            if 0 < peg < 200 and not _math.isnan(peg):
                                pt = {"date": date.strftime("%b %Y"), "value": peg}
                                series_q.append(pt)

                    result_data["quarterly"] = series_q
                    result_data["annual"] = _annual_from_monthly(series_q)
                    if not series_q:
                        result_data["use_price"] = True
                        result_data["empty_reason"] = "all_points_rejected"
                        report("empty_chart", metric=metric, ticker=ticker, reason="all_points_rejected")

            except Exception:
                result_data["use_price"] = True
                result_data["empty_reason"] = "exception"
                report("empty_chart", metric=metric, ticker=ticker, reason="exception")
        elif metric in ("calc_forward_pe", "calc_pb", "calc_ps", "calc_ev_ebitda",
                        "forward_pe", "price_to_book", "price_to_sales", "ev_to_ebitda") \
                and not _tase_price_mismatch(ticker):
            # מחשב היסטוריה של מכפיל על-ידי: מחיר חודשי / נתון פיננסי רבעוני TTM
            try:
                import math as _math
                hist = stock.history(period=_HIST_PERIOD)
                info = stock.info or {}
                # NOTE: the share count is NOT read from info here. It comes from
                # _shares_lookup below, which also reads the statements — see the
                # docstring there for why relying on this field alone was wrong.

                income_q  = _get_quarterly_income(stock)
                income_a  = _get_annual_income(stock)
                balance_q = _get_quarterly_balance(stock)
                balance_a = _get_annual_balance(stock)

                def get_series(df, field_aliases):
                    """מחזיר pandas Series של שדה לפי aliases"""
                    if df is None or df.empty:
                        return None
                    for alias in field_aliases:
                        row = find_row(df, alias)
                        if row:
                            s = df.loc[row].sort_index().dropna()
                            if hasattr(s.index, "tz") and s.index.tz:
                                s.index = s.index.tz_localize(None)
                            return s.apply(float)
                    return None

                def ttm_at(series_q, series_a, date, periods=4):
                    """TTM: סכום 4 רבעונים אחרונים לפני date"""
                    if series_q is not None:
                        past = series_q[series_q.index <= date].tail(periods)
                        if len(past) == periods:
                            return float(past.sum())
                    if series_a is not None:
                        past = series_a[series_a.index <= date].tail(1)
                        if len(past) == 1:
                            return float(past.iloc[0])
                    return None

                def last_at(series_q, series_a, date):
                    """ערך אחרון לפני date"""
                    if series_q is not None:
                        past = series_q[series_q.index <= date].tail(1)
                        if len(past) == 1:
                            return float(past.iloc[0])
                    if series_a is not None:
                        past = series_a[series_a.index <= date].tail(1)
                        if len(past) == 1:
                            return float(past.iloc[0])
                    return None

                # Share count per date — see _shares_lookup for why this is not
                # read from info["sharesOutstanding"] alone.
                shares_at, have_shares = _shares_lookup(info, balance_q, balance_a,
                                                        income_q, income_a)

                if hist is None or hist.empty or not have_shares:
                    result_data["use_price"] = True
                    result_data["empty_reason"] = ("no_price_history" if (hist is None or hist.empty)
                                                   else "no_share_count")
                else:
                    price_monthly = hist["Close"].resample("ME").last().dropna()
                    if hasattr(price_monthly.index, "tz") and price_monthly.index.tz:
                        price_monthly.index = price_monthly.index.tz_localize(None)

                    # הכן series לפי מכפיל
                    rev_q = get_series(income_q,  ["Total Revenue", "Operating Revenue"])
                    rev_a = get_series(income_a,  ["Total Revenue", "Operating Revenue"])
                    bv_q  = get_series(balance_q, ["Stockholders Equity", "Common Stock Equity"])
                    bv_a  = get_series(balance_a, ["Stockholders Equity", "Common Stock Equity"])
                    ebitda_q = get_series(income_q, ["EBITDA", "Normalized EBITDA"])
                    ebitda_a = get_series(income_a, ["EBITDA", "Normalized EBITDA"])
                    debt_q = get_series(balance_q, ["Total Debt", "Long Term Debt And Capital Lease Obligation"])
                    debt_a = get_series(balance_a, ["Total Debt", "Long Term Debt And Capital Lease Obligation"])
                    cash_q = get_series(balance_q, ["Cash And Cash Equivalents", "Cash Cash Equivalents And Short Term Investments"])
                    cash_a = get_series(balance_a, ["Cash And Cash Equivalents", "Cash Cash Equivalents And Short Term Investments"])
                    eps_q  = get_series(income_q,  ["Diluted EPS", "Basic EPS"])
                    eps_a  = get_series(income_a,  ["Diluted EPS", "Basic EPS"])

                    series_q = []

                    for date, price in price_monthly.items():
                        price = float(price)
                        val = None
                        shares = shares_at(date)   # per-date, not one fixed count
                        if not shares or shares <= 0:
                            continue
                        try:
                            if metric == "forward_pe":
                                # Forward P/E: אין היסטוריה אמיתית — נשתמש ב-trailing P/E (EPS TTM)
                                ttm_eps = ttm_at(eps_q, eps_a, date)
                                if ttm_eps and ttm_eps > 0:
                                    val = round(price / ttm_eps, 2)
                                    if val <= 0 or val > 3000:
                                        val = None
                            elif metric == "price_to_book":
                                bv = last_at(bv_q, bv_a, date)
                                if bv and bv > 0 and shares > 0:
                                    bv_per_share = bv / shares
                                    val = round(price / bv_per_share, 2)
                                    if val <= 0 or val > 500:
                                        val = None
                            elif metric == "price_to_sales":
                                rev = ttm_at(rev_q, rev_a, date)
                                if rev and rev > 0 and shares > 0:
                                    rev_per_share = rev / shares
                                    val = round(price / rev_per_share, 2)
                                    if val <= 0 or val > 1000:
                                        val = None
                            elif metric == "ev_to_ebitda":
                                ebitda = ttm_at(ebitda_q, ebitda_a, date)
                                debt   = last_at(debt_q, debt_a, date) or 0
                                cash   = last_at(cash_q, cash_a, date) or 0
                                if ebitda and ebitda > 0 and shares > 0:
                                    market_cap = price * shares
                                    ev = market_cap + debt - cash
                                    val = round(ev / ebitda, 2)
                                    if val <= 0 or val > 2000:
                                        val = None
                        except Exception:
                            val = None

                        if val is None or _math.isnan(val) or _math.isinf(val):
                            continue

                        pt = {"date": date.strftime("%b %Y"), "value": val}
                        series_q.append(pt)

                    result_data["quarterly"] = series_q
                    result_data["annual"] = _annual_from_monthly(series_q)
                    if not series_q:
                        result_data["use_price"] = True
                        result_data["empty_reason"] = "all_points_rejected"
                        report("empty_chart", metric=metric, ticker=ticker, reason="all_points_rejected")

            except Exception:
                result_data["use_price"] = True
                result_data["empty_reason"] = "exception"
                report("empty_chart", metric=metric, ticker=ticker, reason="exception")

        elif metric in CALC_SPECIAL:
            # ── buyback / dividend — calculated from cashflow / dividend history ──
            try:
                import math as _math
                hist = stock.history(period=_HIST_PERIOD)
                info = stock.info or {}

                if metric == "buyback":
                    # Buyback yield = TTM repurchases / market cap * 100
                    # Calculated per month using price history + quarterly cashflow
                    #
                    # Same share-count trap as the multiples branch: reading only
                    # info["sharesOutstanding"] silently emptied this chart for
                    # every ticker Yahoo omits the field on, AMD included.
                    shares_at, have_shares = _shares_lookup(
                        info,
                        _get_quarterly_balance(stock), _get_annual_balance(stock),
                        _get_quarterly_income(stock),  _get_annual_income(stock),
                    )
                    cf_q = _get_quarterly_cashflow(stock)
                    cf_a = _get_annual_cashflow(stock)

                    repurchase_aliases = [
                        "Repurchase Of Capital Stock",
                        "Common Stock Repurchase",
                        "Repurchase Of Common Stock",
                        "Issuance Of Capital Stock",  # fallback — may appear as negative
                    ]

                    def _get_repurchase(df):
                        if df is None or df.empty:
                            return None
                        for alias in repurchase_aliases:
                            row = find_row(df, alias)
                            if row:
                                s = df.loc[row].sort_index().dropna()
                                if hasattr(s.index, "tz") and s.index.tz:
                                    s.index = s.index.tz_localize(None)
                                # repurchase entries are typically negative — take abs
                                return s.apply(lambda x: abs(float(x)))
                        return None

                    rep_q = _get_repurchase(cf_q)
                    rep_a = _get_repurchase(cf_a)

                    if hist is None or hist.empty or not have_shares or (rep_q is None and rep_a is None):
                        result_data["use_price"] = True
                        result_data["empty_reason"] = (
                            "no_price_history" if (hist is None or hist.empty)
                            else "no_share_count" if not have_shares
                            else "no_repurchase_rows")
                    else:
                        price_monthly = hist["Close"].resample("ME").last().dropna()
                        if hasattr(price_monthly.index, "tz") and price_monthly.index.tz:
                            price_monthly.index = price_monthly.index.tz_localize(None)

                        series_q = []
                        for date, price in price_monthly.items():
                            price = float(price)
                            try:
                                ttm_rep = None
                                if rep_q is not None:
                                    past = rep_q[rep_q.index <= date].tail(4)
                                    # Exactly 4 quarters, like every other TTM in
                                    # this file. ">= 2" let a SIX-MONTH total be
                                    # reported as a twelve-month buyback yield,
                                    # understating it by up to half. With fewer
                                    # than 4 we fall through to the annual figure
                                    # below, which is a real 12-month number.
                                    if len(past) == 4:
                                        ttm_rep = float(past.sum())
                                if (not ttm_rep) and rep_a is not None:
                                    past = rep_a[rep_a.index <= date].tail(1)
                                    if len(past) == 1:
                                        ttm_rep = float(past.iloc[0])
                                if not ttm_rep or ttm_rep <= 0:
                                    continue
                                shares_f = shares_at(date)   # per-date, not one fixed count
                                if not shares_f or shares_f <= 0:
                                    continue
                                market_cap = price * shares_f
                                if market_cap <= 0:
                                    continue
                                val = round(ttm_rep / market_cap * 100, 2)
                                if val <= 0 or val > 50 or _math.isnan(val) or _math.isinf(val):
                                    continue
                                pt = {"date": date.strftime("%b %Y"), "value": val}
                                series_q.append(pt)
                            except Exception:
                                continue

                        result_data["quarterly"] = series_q
                        result_data["annual"]    = _annual_from_monthly(series_q)
                        if not series_q:
                            result_data["use_price"] = True
                            result_data["empty_reason"] = "all_points_rejected"
                            report("empty_chart", metric=metric, ticker=ticker, reason="all_points_rejected")

                elif metric == "dividend":
                    # Dividend yield = trailing 12-month dividends / price * 100
                    try:
                        divs = stock.dividends
                        if divs is None or divs.empty or hist is None or hist.empty:
                            result_data["use_price"] = True
                            result_data["empty_reason"] = "no_dividend_history"
                            report("empty_chart", metric=metric, ticker=ticker, reason="no_dividend_history")
                        else:
                            if hasattr(divs.index, "tz") and divs.index.tz:
                                divs.index = divs.index.tz_localize(None)
                            divs_monthly = divs.resample("ME").sum()

                            price_monthly = hist["Close"].resample("ME").last().dropna()
                            if hasattr(price_monthly.index, "tz") and price_monthly.index.tz:
                                price_monthly.index = price_monthly.index.tz_localize(None)

                            series_q = []
                            for date, price in price_monthly.items():
                                price = float(price)
                                if price <= 0:
                                    continue
                                try:
                                    ttm_div = float(
                                        divs_monthly[divs_monthly.index <= date].tail(12).sum()
                                    )
                                    if ttm_div <= 0:
                                        continue
                                    val = round(ttm_div / price * 100, 2)
                                    if val <= 0 or val > 30 or _math.isnan(val) or _math.isinf(val):
                                        continue
                                    pt = {"date": date.strftime("%b %Y"), "value": val}
                                    series_q.append(pt)
                                except Exception:
                                    continue

                            result_data["quarterly"] = series_q
                            result_data["annual"]    = _annual_from_monthly(series_q)
                            if not series_q:
                                result_data["use_price"] = True
                                result_data["empty_reason"] = "all_points_rejected"
                                report("empty_chart", metric=metric, ticker=ticker, reason="all_points_rejected")
                    except Exception:
                        result_data["use_price"] = True
                        result_data["empty_reason"] = "exception"
                        report("empty_chart", metric=metric, ticker=ticker, reason="exception")

            except Exception:
                result_data["use_price"] = True
                result_data["empty_reason"] = "exception"
                report("empty_chart", metric=metric, ticker=ticker, reason="exception")

        else:
            source, field1, field2, calc = METRIC_MAP[metric]

            def extract_series(df, f1, f2, calc_type, period_type):
                if df is None or df.empty:
                    return []
                r1 = find_row(df, f1)
                r2 = find_row(df, f2) if f2 else None
                if not r1:
                    return []
                rows = []
                for col in df.columns:
                    try:
                        raw1 = df.loc[r1, col]
                        raw2 = df.loc[r2, col] if r2 else None

                        # דלג על nulls
                        import math
                        if raw1 is None or (isinstance(raw1, float) and math.isnan(raw1)):
                            continue
                        if r2 and (raw2 is None or (isinstance(raw2, float) and math.isnan(raw2))):
                            continue

                        v1 = float(raw1)
                        v2 = float(raw2) if raw2 is not None else None

                        if calc_type == "pct":
                            if v2 is None or v2 == 0:
                                continue
                            val = round(v1 / v2 * 100, 2)
                        elif calc_type == "ratio":
                            if v2 is None or v2 == 0:
                                continue
                            val = round(v1 / v2, 3)
                        else:
                            val = round(v1, 4)

                        # דלג על ערכים קיצוניים / לא הגיוניים
                        if math.isnan(val) or math.isinf(val):
                            continue

                        date_str = col.strftime("%b %Y") if hasattr(col, "strftime") else str(col)[:7]
                        rows.append({"date": date_str, "value": val})
                    except Exception:
                        continue
                return list(reversed(rows))

            try:
                if source == "income":
                    result_data["quarterly"] = extract_series(_get_quarterly_income(stock), field1, field2, calc, "Q")
                    result_data["annual"] = extract_series(_get_annual_income(stock), field1, field2, calc, "A")
                elif source == "balance":
                    result_data["quarterly"] = extract_series(_get_quarterly_balance(stock), field1, field2, calc, "Q")
                    result_data["annual"] = extract_series(_get_annual_balance(stock), field1, field2, calc, "A")
                elif source == "cashflow":
                    result_data["quarterly"] = extract_series(_get_quarterly_cashflow(stock), field1, field2, calc, "Q")
                    result_data["annual"] = extract_series(_get_annual_cashflow(stock), field1, field2, calc, "A")
            except Exception as _e:
                swallow("main:_metric_history_uncached", _e, notify=True)

            if not result_data["quarterly"] and not result_data["annual"]:
                result_data["use_price"] = True
                result_data["empty_reason"] = "no_statement_rows"
                report("empty_chart", metric=metric, ticker=ticker, reason="no_statement_rows")

        if result_data["use_price"]:
            hist = stock.history(period=_HIST_PERIOD)
            if hist is not None and not hist.empty:
                import math
                close = hist["Close"].resample("ME").last().dropna()
                _pts = [
                    {"date": d.strftime("%b %Y"), "value": round(float(v), 2)}
                    for d, v in zip(close.index, close.values)
                    if v is not None and not math.isnan(float(v))
                ]
                # Last 5 years is all the chart can meaningfully show; sending
                # more just inflates the payload and the client's memory.
                result_data["price_history"] = _pts[-60:]
            else:
                result_data["price_history"] = []

        _cache_set(cache_key, result_data, CACHE_TTL["stock"])
        return result_data

    except Exception as e:
        # Log internally; never hand the raw exception text to the caller.
        print(f"[endpoint] error: {e}")
        raise HTTPException(status_code=500, detail="Could not build this report.")


@app.get("/events/{ticker}")
@rate_limit("normal")
def ticker_events(request: Request, ticker: str):
    # Time-bounded: see _with_deadline. An unbounded upstream call here can
    # occupy uvicorn's single worker and take the whole service down.
    return _with_deadline(lambda: _events_uncached(ticker), 15, default={"events": []})


def _events_uncached(ticker: str):
    """דוחות כספיים קרובים, דיבידנדים וסיפלטים"""
    ticker = _clean_ticker(ticker)
    cache_key = f"events_{ticker.upper()}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        import yfinance as yf
        from datetime import datetime, timezone
        stock = _yf_ticker(ticker)
        info = stock.info or {}
        events = []

        # תאריך דוח רווחים הבא
        next_earnings = info.get("earningsTimestamp") or info.get("earningsTimestampStart")
        if next_earnings:
            try:
                dt = datetime.fromtimestamp(next_earnings, tz=timezone.utc)
                if dt > datetime.now(tz=timezone.utc):
                    events.append({
                        "type": "earnings",
                        "date": dt.strftime("%Y-%m-%d"),
                        "label": "Earnings Report",
                        "detail": f"Q{(dt.month-1)//3+1} {dt.year}"
                    })
            except Exception as _e:
                swallow("main:_events_uncached", _e, notify=True)

        # דיבידנד הבא
        ex_div = info.get("exDividendDate")
        div_rate = info.get("dividendRate")
        if ex_div and div_rate:
            try:
                dt = datetime.fromtimestamp(ex_div, tz=timezone.utc)
                if dt > datetime.now(tz=timezone.utc):
                    # Currency follows the listing (TASE quotes in shekel), and the
                    # wording is left to the client: this string used to be a
                    # hard-coded English "$X/share annually", which showed dollars
                    # for Israeli stocks and English text to Hebrew/Russian users.
                    #
                    # The sign now follows the SAME rule as the price tile
                    # instead of being a two-way ₪/$ guess: a euro payer used to
                    # be stamped with a dollar sign here while the header said €.
                    # dividendRate is quoted in the listing currency, so a London
                    # payer arrives in pence and needs the same /100 the price
                    # gets — otherwise a 104p dividend reads "£104.00".
                    _ccy_raw = (info.get("currency") or "").strip()
                    _ccy = _ccy_raw.upper()
                    _minor = _minor_unit_for(_ccy_raw)
                    if ticker.upper().endswith(".TA") or _ccy in ("ILA", "ILS"):
                        _code = "ILS"
                        if _ccy != "ILS":
                            div_rate = div_rate / 100.0
                    elif _minor:
                        _code = _minor[0]
                        div_rate = div_rate / _minor[1]
                    else:
                        _code = _ccy or "USD"
                    _sym = _ccy_symbol(_code)
                    events.append({
                        "type": "dividend",
                        "date": dt.strftime("%Y-%m-%d"),
                        "label": "Ex-Dividend Date",
                        "detail": f"{_sym}{div_rate:.2f}",
                        "detail_key": "div_per_share",   # client appends localised wording
                    })
            except Exception as _e:
                swallow("main:_events_uncached", _e, notify=True)

        # היסטוריית דוחות אחרונים
        try:
            cal = stock.calendar
            if cal is not None and not cal.empty:
                for col in cal.columns[:4]:
                    try:
                        date_val = cal[col].iloc[0] if hasattr(cal[col], 'iloc') else cal[col]
                        if hasattr(date_val, 'strftime'):
                            from datetime import datetime as dt2
                            if date_val > dt2.now().date():
                                events.append({
                                    "type": "calendar",
                                    "date": date_val.strftime("%Y-%m-%d"),
                                    "label": str(col),
                                    "detail": ""
                                })
                    except Exception as _e:
                        swallow("main:_events_uncached", _e, notify=True)
        except Exception as _e:
            swallow("main:_events_uncached", _e, notify=True)

        # דוחות כספיים אחרונים מהיסטוריה רבעונית
        try:
            fin = _get_quarterly_income(stock)
            if fin is not None and not fin.empty:
                # מיון עמודות לפי תאריך יורד (החדש ביותר ראשון) — yfinance לא מבטיח סדר
                sorted_cols = sorted(fin.columns, reverse=True)
                for col in sorted_cols[:4]:
                    try:
                        date_str = col.strftime("%Y-%m-%d") if hasattr(col, 'strftime') else str(col)[:10]
                        def _get_row(df, *names):
                            for n in names:
                                if n in df.index:
                                    v = df.loc[n, col]
                                    if v is not None:
                                        import math
                                        try:
                                            if not math.isnan(float(v)):
                                                return float(v)
                                        except Exception as _e:
                                            swallow("main:_get_row", _e)
                            return None
                        rev  = _get_row(fin, "Total Revenue", "Operating Revenue")
                        ni   = _get_row(fin, "Net Income", "Net Income Common Stockholders")
                        eps  = _get_row(fin, "Diluted EPS", "Basic EPS")
                        gp   = _get_row(fin, "Gross Profit")
                        detail_parts = []
                        if rev is not None: detail_parts.append(f"Rev: ${rev/1e9:.1f}B")
                        if ni  is not None: detail_parts.append(f"NI: ${ni/1e9:.1f}B")
                        if eps is not None: detail_parts.append(f"EPS: ${eps:.2f}")
                        if gp  is not None and rev and rev > 0:
                            detail_parts.append(f"GM: {round(gp/rev*100,1)}%")
                        events.append({
                            "type": "past_earnings",
                            "date": date_str,
                            "label": "Q Report",
                            "detail": " · ".join(detail_parts)
                        })
                    except Exception:
                        continue
        except Exception as _e:
            swallow("main:_events_uncached", _e, notify=True)

        # מיין לפי תאריך
        events.sort(key=lambda x: x["date"], reverse=True)

        result = {"ticker": ticker.upper(), "events": events}
        _cache_set(cache_key, result, CACHE_TTL["stock"])
        return result

    except Exception as e:
        # Log internally; never hand the raw exception text to the caller.
        print(f"[endpoint] error: {e}")
        raise HTTPException(status_code=500, detail="Could not build this report.")


@app.get("/financials/{ticker}")
@rate_limit("heavy")
def ticker_financials(request: Request, ticker: str):
    # Time-bounded: see _with_deadline. An unbounded upstream call here can
    # occupy uvicorn's single worker and take the whole service down.
    return _with_deadline(lambda: _financials_uncached(ticker), 20, default={"error": "timeout"})


def _financials_uncached(ticker: str):
    """דוחות כספיים מלאים - Income Statement, Balance Sheet, Cash Flow"""
    ticker = _clean_ticker(ticker)
    cache_key = f"financials_{ticker.upper()}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        import yfinance as yf
        import math
        stock = _yf_ticker(ticker)

        def df_to_table(df):
            if df is None or df.empty:
                return {"columns": [], "rows": []}
            cols = [c.strftime("%b %Y") if hasattr(c, "strftime") else str(c)[:7] for c in df.columns]
            rows = []
            for idx in df.index:
                try:
                    vals = []
                    for c in df.columns:
                        v = df.loc[idx, c]
                        if v is None or (isinstance(v, float) and math.isnan(v)):
                            vals.append(None)
                        else:
                            vals.append(float(v))
                    rows.append({"label": str(idx), "values": vals})
                except Exception:
                    continue
            return {"columns": cols, "rows": rows}

        result = {
            "ticker": ticker.upper(),
            "income_quarterly":  df_to_table(_get_quarterly_income(stock)),
            "income_annual":     df_to_table(_get_annual_income(stock)),
            "balance_quarterly": df_to_table(_get_quarterly_balance(stock)),
            "balance_annual":    df_to_table(_get_annual_balance(stock)),
            "cashflow_quarterly":df_to_table(_get_quarterly_cashflow(stock)),
            "cashflow_annual":   df_to_table(_get_annual_cashflow(stock)),
        }

        _cache_set(cache_key, result, CACHE_TTL["stock"])
        return result

    except Exception as e:
        # Log internally; never hand the raw exception text to the caller.
        print(f"[endpoint] error: {e}")
        raise HTTPException(status_code=500, detail="Could not build this report.")


@app.get("/etf-info/{ticker}")
@rate_limit("normal")
def etf_info(request: Request, ticker: str):
    # Time-bounded: see _with_deadline. An unbounded upstream call here can
    # occupy uvicorn's single worker and take the whole service down.
    return _with_deadline(lambda: _etf_uncached(ticker), 15, default={"is_etf": False})


def _etf_uncached(ticker: str):
    """נתונים ספציפיים ל-ETF"""
    ticker = _clean_ticker(ticker)
    cache_key = f"etf_{ticker.upper()}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        import yfinance as yf
        stock = _yf_ticker(ticker)
        info = stock.info or {}

        # בדוק שזה ETF
        quote_type = info.get("quoteType", "")
        if quote_type not in ("ETF", "MUTUALFUND"):
            return {"is_etf": False}

        # חישוב ytd_return מהיסטוריית מחירים — מדויק יותר מ-API
        ytd_return = info.get("ytdReturn")
        try:
            hist = stock.history(period="ytd")
            if hist is not None and not hist.empty and len(hist) >= 2:
                price_start = float(hist["Close"].iloc[0])
                price_end   = float(hist["Close"].iloc[-1])
                if price_start > 0:
                    ytd_calc = (price_end - price_start) / price_start
                    # אם הערך מה-API חריג מאוד (>10x שונה מהחישוב), השתמש בחישוב
                    if ytd_return is None or abs(ytd_return) > 10 or abs(ytd_return - ytd_calc) > 0.5:
                        ytd_return = round(ytd_calc, 4)
        except Exception as _e:
            swallow("main:_etf_uncached", _e, notify=True)

        result = {
            "is_etf": True,
            "quote_type": quote_type,
            "fund_family": info.get("fundFamily"),
            "category": info.get("category"),
            "inception_date": info.get("fundInceptionDate"),
            "total_assets": info.get("totalAssets"),
            "expense_ratio": info.get("expenseRatio") or info.get("annualReportExpenseRatio"),
            "nav": info.get("navPrice") or info.get("regularMarketPrice"),
            "yield": info.get("yield") or info.get("dividendYield"),
            "ytd_return": ytd_return,
            "one_year_return": info.get("oneYearReturn") or info.get("52WeekChange"),
            "three_year_return": info.get("threeYearAverageReturn"),
            "five_year_return": info.get("fiveYearAverageReturn"),
            "beta": info.get("beta3Year") or info.get("beta"),
            "trailing_pe": info.get("trailingPE"),
            "holdings_count": info.get("holdingsCount"),
        }

        # Top holdings
        try:
            holdings = stock.funds_data.top_holdings
            if holdings is not None and not holdings.empty:
                result["top_holdings"] = [
                    {"name": row.get("Name", idx), "pct": round(float(row.get("Holding Percent", 0)) * 100, 2)}
                    for idx, row in holdings.head(10).iterrows()
                ]
        except Exception:
            result["top_holdings"] = []

        _cache_set(cache_key, result, CACHE_TTL["stock"])
        return result

    except Exception as e:
        print(f"[etf-info] error: {e}")
        return {"is_etf": False}


@app.get("/price-history/{ticker}")
@rate_limit("heavy")
def price_history(request: Request, ticker: str):
    """היסטוריית מחיר חודשית מ-Tiingo — מורשה לשימוש מסחרי, key מאובטח בשרת"""
    ticker = _clean_ticker(ticker)  # also guards the outbound Tiingo URL path
    cache_key = f"price_history_{ticker.upper()}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    if not TIINGO_TOKEN:
        # No key configured — don't fire a request that can only fail.
        return {"ticker": ticker.upper(), "prices": []}

    try:
        # The token goes in a header, not the query string: a URL carrying the
        # secret can end up inside an httpx exception message (which we log) or
        # in any intermediate access log.
        url = (
            f"https://api.tiingo.com/tiingo/daily/{ticker}/prices"
            f"?startDate=2020-01-01&resampleFreq=monthly"
        )
        resp = httpx.get(url, headers={
            "Content-Type": "application/json",
            "Authorization": f"Token {TIINGO_TOKEN}",
        }, timeout=10)
        if not resp.is_success:
            return {"ticker": ticker.upper(), "prices": []}
        data = resp.json()
        if not isinstance(data, list):
            return {"ticker": ticker.upper(), "prices": []}
        prices = [
            {
                "date":  (p.get("date") or "")[:7],
                "value": round(float(p["adjClose"] if p.get("adjClose") is not None else p.get("close", 0)), 2),
            }
            for p in data
            if p.get("adjClose") is not None or p.get("close") is not None
        ]
        result = {"ticker": ticker.upper(), "prices": prices}
        _cache_set(cache_key, result, CACHE_TTL["stock"])
        return result
    except Exception as e:
        print(f"[price-history] error: {e}")
        return {"ticker": ticker.upper(), "prices": []}


@app.get("/exchange-rate")
@rate_limit("light")
def exchange_rate(request: Request, currency: str = "ILS"):
    # Whitelist: this value builds an outbound quote symbol ("{cur}=X") and a
    # cache key, so an arbitrary string must never reach either.
    currency = (currency or "").strip().upper()[:3]
    if currency not in ("ILS", "RUB", "EUR", "USD", "GBP", "JPY", "CHF", "CAD", "AUD"):
        currency = "ILS"
    cache_key = f"exchange_{currency}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached
    try:
        rate = None
        try:
            data = get_quote(f"{currency}=X")
            rate = data["info"].get("currentPrice") or data["info"].get("regularMarketPrice")
        except Exception as _e:
            swallow("main:exchange_rate", _e)
        if rate is None:  # Stooq fallback when Yahoo blocks quote requests
            sq = get_stooq_daily(f"usd{currency.lower()}", stooq_symbol=f"usd{currency.lower()}")
            if sq and sq.get("price") is not None:
                rate = sq["price"]
        result = {"currency": currency, "rate": rate, "usd_ils": rate if currency == "ILS" else None}
        if rate is not None:  # don't poison the cache with a failed lookup
            _cache_set(cache_key, result, CACHE_TTL["exchange"])
        return result
    except Exception:
        return {"currency": currency, "rate": None, "usd_ils": None}


def _get_base_news() -> list:
    """
    Gathers + resolves + filters the general news list ONCE (language-
    independent, cached). Language switches then only translate titles
    (~1-2s) instead of re-fetching and re-resolving everything (~15s).
    """
    cached = _cache_get("news_base")
    if cached is not None:
        return cached

    sources = ["^GSPC", "AAPL", "MSFT", "NVDA"]
    all_news = []
    seen_titles = set()

    for symbol in sources:
        try:
            items = get_news(symbol, limit=5)
            for item in items:
                if item["title"] not in seen_titles:
                    seen_titles.add(item["title"])
                    all_news.append(item)
        except Exception:
            continue

    # מיזוג עם Google News - מקור משלים, רחב יותר, בלי מפתח API
    try:
        google_items = get_google_news("stock market", limit=8)
        for item in google_items:
            if item["title"] not in seen_titles:
                seen_titles.add(item["title"])
                all_news.append(item)
    except Exception as _e:
        swallow("main:_get_base_news", _e)

    # מיון לפי תאריך פרסום (חדש ביותר ראשון) - אם קיים
    def sort_key(item):
        return item.get("published") or ""

    all_news.sort(key=sort_key, reverse=True)
    all_news = _resolve_gnews_articles(all_news)
    articles = _filter_articles(all_news)[:15]

    # If some Google News links failed to resolve (rate-limit at startup),
    # cache briefly so the next request retries instead of serving them for
    # the full TTL.
    unresolved = any('news.google.com' in (a.get("link") or "") for a in articles)
    _cache_set("news_base", articles, 180 if unresolved else CACHE_TTL["news"])
    return articles


@app.get("/news")
@rate_limit("normal")
def general_news(request: Request, lang: str = "en"):
    return _general_news_uncached(lang)


def _general_news_uncached(lang: str = "en"):
    """
    The body, callable from Python as well as over HTTP.

    Split out because the boot-time warm-up called `general_news(_lang)`
    directly and that broke twice over when rate limiting was added:

      1. slowapi's decorator rejects a call whose first argument is not a real
         starlette Request — "parameter `request` must be an instance of ...".
      2. Even without the decorator, `_lang` would have bound to `request` and
         `lang` would have stayed "en", so the warm-up would have warmed English
         four times and none of the other three languages at all.

    The failure was invisible: it sat inside `except Exception: pass` until that
    was replaced with `swallow()`, and the first user to open the news screen
    after every deploy paid for a cold fetch instead of a warmed cache.

    Same `_uncached` split every other heavy endpoint in this file already uses.
    """
    lang = _clean_lang(lang)   # whitelist: also keeps the cache key bounded
    cache_key = f"news_general_{lang}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    # Copy the shared base items before mutating titles
    articles = [dict(a) for a in _get_base_news()]

    # תרגום כותרות אם השפה אינה אנגלית
    if lang != "en" and articles:
        titles = [a.get("title", "") for a in articles]
        translated = _translate_batch(titles, lang)
        for i, a in enumerate(articles):
            if translated[i]:
                a["title"] = translated[i]

    result = {"articles": articles}
    _cache_set(cache_key, result, CACHE_TTL["news"])
    # Background: pre-translate top articles so opening them is instant
    _prewarm_articles([a.get("link") for a in articles[:6]], lang)
    return result


@app.get("/news/{ticker}")
@rate_limit("normal")
def ticker_news(request: Request, ticker: str, lang: str = "en"):
    """
    חדשות עבור מנייה ספציפית - ממוזג מ-Yahoo וגם מ-Google News (חינמי, בלי מפתח API),
    כך שמניות עם כיסוי דליל ב-Yahoo (חברות קטנות, לא-אמריקאיות) עדיין יקבלו כתבות.
    """
    ticker = _clean_ticker(ticker)
    lang = _clean_lang(lang)
    # Per-ticker base (fetch + resolve + filter) — language-independent, cached
    base_key = f"news_base_{ticker.upper()}"
    base = _cache_get(base_key)
    if base is None:
        seen_titles = set()
        all_articles = []

        try:
            for item in get_news(ticker, limit=8):
                if item["title"] not in seen_titles:
                    seen_titles.add(item["title"])
                    all_articles.append(item)
        except Exception as _e:
            # לא עוצרים כאן - אולי Google News עדיין ימצא משהו
            swallow("main:ticker_news", _e)

        try:
            for item in get_google_news(f"{ticker} stock", limit=6):
                if item["title"] not in seen_titles:
                    seen_titles.add(item["title"])
                    all_articles.append(item)
        except Exception as _e:
            swallow("main:ticker_news", _e)

        all_articles = _resolve_gnews_articles(all_articles)
        base = _filter_articles(all_articles)
        _cache_set(base_key, base, CACHE_TTL["news"])

    # Copy shared items before mutating titles
    articles = [dict(a) for a in base]

    # תרגום כותרות אם השפה אינה אנגלית
    if lang != "en" and articles:
        titles = [a.get("title", "") for a in articles]
        translated = _translate_batch(titles, lang)
        for i, a in enumerate(articles):
            if translated[i]:
                a["title"] = translated[i]

    return {"ticker": ticker.upper(), "articles": articles}


@app.get("/translate-article")
# "light" and not "normal": the server calls this endpoint on ITSELF during
# news pre-warm (127.0.0.1 -> /translate-article, up to 3 articles x 3
# languages). Those loopback calls share one rate-limit key, so a tight limit
# would throttle the app's own warm-up. 120/min leaves that far behind while
# still capping an outside caller.
@rate_limit("light")
async def translate_article_endpoint(request: Request, url: str, lang: str = "he"):
    """
    Fetches an article URL server-side, extracts text, translates it, and returns
    clean RTL HTML. Used by the mobile app's in-app reader to avoid WebView proxy issues.
    """
    import asyncio as _asyncio
    import json as _json
    from bs4 import BeautifulSoup

    url = _validate_public_url(url)   # SSRF guard — server fetches this URL
    lang = _clean_lang(lang)

    # Cache: same URL + lang for 1 hour
    cache_key = f"tarticle_{lang}_{url}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return HTMLResponse(content=cached)

    # Google News links: decode to the real article URL first (JS redirect)
    if 'news.google.com' in url:
        url = await _asyncio.get_event_loop().run_in_executor(
            None, _resolve_gnews_link, url
        )
        if 'news.google.com' in url:
            return HTMLResponse(content="error", status_code=500)
        cache_key = f"tarticle_{lang}_{url}"
        cached = _cache_get(cache_key)
        if cached is not None:
            return HTMLResponse(content=cached)

    # 1. Fetch the article
    # Strategy A: curl_cffi Chrome TLS impersonation (bypasses IP-based blocking)
    #   — wrapped in asyncio.wait_for so it ALWAYS exits within 8s regardless of C-level hangs
    # Strategy B: httpx plain HTTPS fallback (native async, respects timeout)
    # Strategy C: try canonical URL from <link rel=canonical> if original URL is blocked
    raw_html = None

    async def _fetch_url(fetch_url: str) -> str | None:
        """Try curl_cffi then httpx for a given URL. Returns HTML or None."""
        html = None
        # curl_cffi — hard 8s ceiling via asyncio.wait_for
        try:
            from curl_cffi import requests as _cffi
            loop = _asyncio.get_event_loop()
            def _cffi_get():
                r = _cffi.get(fetch_url, impersonate="chrome124",
                              headers={"Accept-Language": "en-US,en;q=0.9"},
                              timeout=8, allow_redirects=True)
                if _too_large(r):
                    return None
                return (r.text or "")[:_MAX_HTML_CHARS]   # bound the memory
            html = await _asyncio.wait_for(
                loop.run_in_executor(None, _cffi_get), timeout=8
            )
        except Exception as _e:
            swallow("main:_fetch_url", _e)
        if html:
            return html
        # httpx fallback — native async, 8s timeout
        try:
            async with httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
                resp = await client.get(fetch_url, headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                })
                if _too_large(resp):
                    return None
                html = resp.text[:_MAX_HTML_CHARS]
        except Exception as _e:
            swallow("main:_fetch_url", _e)
        return html[:_MAX_HTML_CHARS] if html else html

    # Try original URL
    raw_html = await _fetch_url(url)

    # Strategy C: if original URL failed, try canonical URL via httpx only (fast, 4s)
    # Worst case total: 8+8+6+4 = 26s < 28s app timeout
    if not raw_html:
        try:
            async with httpx.AsyncClient(timeout=6, follow_redirects=True) as client:
                head_resp = await client.get(url, headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                })
                if _too_large(head_resp):
                    raise Exception("oversized")
                head_html = head_resp.text[:4000]
                from bs4 import BeautifulSoup as _BS
                head_soup = _BS(head_html, "html.parser")
                canonical_tag = head_soup.find("link", rel="canonical")
                if canonical_tag:
                    canonical_url = canonical_tag.get("href", "")
                    # Second-order SSRF guard: the canonical URL comes from the
                    # fetched page, so a hostile page could point it at an
                    # internal address. Validate it exactly like the input URL.
                    if canonical_url and canonical_url != url:
                        canonical_url = _validate_public_url(canonical_url)
                    if canonical_url and canonical_url != url:
                        # httpx only for canonical — keeps worst-case under 28s
                        async with httpx.AsyncClient(timeout=4, follow_redirects=True) as c2:
                            cr = await c2.get(canonical_url, headers={
                                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                                "Accept-Language": "en-US,en;q=0.9",
                            })
                            if _too_large(cr):
                                raise Exception("oversized")
                            raw_html = cr.text[:_MAX_HTML_CHARS]
        except Exception as _e:
            swallow("main:translate_article_endpoint", _e)

    if not raw_html:
        return HTMLResponse(content="error", status_code=500)

    # If we followed redirects into Google's cookie-consent interstitial
    # (guce/consent.google.com) instead of the article, DON'T translate it —
    # return 500 so the app falls back to the WebView, which auto-accepts the
    # wall and then extracts + translates the real article from the DOM.
    _low = raw_html[:6000].lower()
    if ("consent.google.com" in _low or "guce.google" in _low
            or "before you continue to google" in _low
            or "בטרם תמשיך אל google" in _low or "לפני שתמשיך" in _low):
        return HTMLResponse(content="consent", status_code=500)

    # 2. Extract text
    # Strategy A: JSON-LD articleBody (always present in SSR, even on React SPAs)
    # Strategy B: <article> / itemprop=articleBody / body fallback via BeautifulSoup
    try:
        soup = BeautifulSoup(raw_html, "html.parser")

        items = []  # list of (tag_name, text)

        # Strategy A: JSON-LD
        for script in soup.find_all("script", type="application/ld+json"):
            try:
                data = _json.loads(script.string or "")
                if isinstance(data, list):
                    data = data[0] if data else {}
                body_text = data.get("articleBody", "")
                if len(body_text) > 200:
                    # Split into ~500-char chunks to preserve paragraph structure
                    sentences = body_text.replace(". ", ".\n").split("\n")
                    para = ""
                    for s in sentences:
                        para += s + " "
                        if len(para) > 300:
                            items.append(("p", para.strip()))
                            para = ""
                    if para.strip():
                        items.append(("p", para.strip()))
                    break
            except Exception as _e:
                swallow("main:translate_article_endpoint", _e)

        # Strategy B: HTML tags
        if not items:
            for bs_tag in soup(["script", "style", "nav", "header", "footer", "aside", "form", "iframe", "noscript"]):
                bs_tag.decompose()
            body = soup.find("article") or soup.find(attrs={"itemprop": "articleBody"}) or soup.body
            bs_tags = body.find_all(["h1", "h2", "h3", "p"]) if body else []
            for bs_tag in bs_tags:
                text = bs_tag.get_text(separator=" ", strip=True)
                if len(text) > 40:
                    items.append((bs_tag.name, text))
                if len(items) >= 20:
                    break

        if not items:
            raise ValueError("no content")

        # Quality check: if too little content, site blocked us (e.g. "enable JS" page)
        total_chars = sum(len(t) for _, t in items)
        if len(items) < 3 or total_chars < 300:
            return HTMLResponse(content="error", status_code=500)

        # Bot-wall check: don't translate an anti-bot / captcha page as if it
        # were the article (Reuters, WSJ etc. serve these to server IPs)
        joined = " ".join(t.lower() for _, t in items)[:3000]
        _BLOCK_MARKERS = (
            "access to this page has been denied", "are you a robot",
            "verify you are a human", "verify that you are not a robot",
            "unusual traffic", "enable javascript and cookies",
            "automation tools to browse", "please enable cookies",
            "checking your browser", "press and hold", "captcha",
            "reference id", "incident id",
        )
        if any(mk in joined for mk in _BLOCK_MARKERS):
            return HTMLResponse(content="error", status_code=500)

    except Exception as _e:
        # Was `except Exception as e:` with the exception discarded unused — the
        # article failed to extract, the user got a 500, and the reason was
        # thrown away at the moment it was caught.
        swallow("main:translate_article_endpoint.extract", _e, notify=True)
        return HTMLResponse(content="error", status_code=500)

    # 3. Translate — every paragraph in PARALLEL.
    #    deep_translator sends one HTTP request per text anyway, so sequential
    #    translation took 15-25s per article; 10 parallel workers -> ~2-4s.
    def _translate_all_parallel(texts):
        if lang == "en":
            return texts
        from concurrent.futures import ThreadPoolExecutor
        def _one(txt):
            try:
                return _translate_text(txt[:4500], lang)
            except Exception:
                return txt
        return list(translate_pool().map(_one, texts))

    raw_texts = [t for _, t in items]
    # Run in a thread so the (blocking) translation doesn't stall the event loop
    translated = await _asyncio.get_event_loop().run_in_executor(
        None, _translate_all_parallel, raw_texts
    )

    # 4. Build output HTML
    is_rtl = lang in {"he"}
    dir_attr = "rtl" if is_rtl else "ltr"
    html_parts = ["<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>body{font-family:-apple-system,Arial,sans-serif;padding:16px 18px;line-height:1.75;color:#111;background:#fff;direction:" + dir_attr + ";max-width:800px;margin:0 auto}h1{font-size:22px;margin:0 0 16px}h2{font-size:18px;margin:20px 0 8px}h3{font-size:16px;margin:16px 0 6px}p{font-size:16px;margin:0 0 14px}</style></head><body>"]

    for i, (tag_name, _) in enumerate(items):
        text = translated[i].strip() if i < len(translated) else ""
        if text:
            html_parts.append(f"<{tag_name}>{text}</{tag_name}>")

    html_parts.append("</body></html>")
    html_content = "".join(html_parts)

    _cache_set(cache_key, html_content, 3600)
    return HTMLResponse(content=html_content)


@app.get("/translate-batch")
async def translate_batch_get(q: str = "Hello world", lang: str = "he"):
    """Debug/self-test variant of the POST endpoint — same translation path,
    testable from a plain browser: /translate-batch?q=Some text&lang=he"""
    import asyncio as _asyncio
    lang = _clean_lang(lang)
    def _run():
        try:
            return _translate_text(q[:4500], lang)
        except Exception:
            return ""   # don't echo internal exception text back to the caller
    out = await _asyncio.get_event_loop().run_in_executor(None, _run)
    return {"texts": [out], "lang": lang}


@app.post("/translate-batch")
async def translate_batch_endpoint(request: Request):
    """
    Translates a list of raw text strings (extracted client-side from the
    article WebView). Used when the server itself can't fetch the article
    (bot-walls) but the phone's browser can.
    Body: {"texts": [...], "lang": "he"} -> {"texts": [...]}
    """
    import asyncio as _asyncio
    # Read the body with a hard size cap BEFORE parsing. Starlette has no
    # default limit, so an oversized payload was fully materialised in memory
    # on a small instance before the [:30] truncation could help.
    MAX_BODY = 256 * 1024  # 256 KB — far above 30 paragraphs of article text
    try:
        raw = await request.body()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid body")
    if len(raw) > MAX_BODY:
        raise HTTPException(status_code=413, detail="payload too large")
    try:
        payload = json.loads(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="invalid JSON body")

    texts = payload.get("texts") or []
    lang = _clean_lang(payload.get("lang"))   # whitelist — reaches an outbound URL
    if not isinstance(texts, list) or not texts:
        return {"texts": []}
    texts = [str(t)[:4500] for t in texts[:30]]

    def _run():
        from concurrent.futures import ThreadPoolExecutor
        def _one(txt):
            try:
                return _translate_text(txt, lang)
            except Exception:
                return txt
        # Shared 6-worker translation pool. This used to build a fresh 4-thread
        # pool per article open; several concurrent opens meant several pools.
        return list(translate_pool().map(_one, texts))

    translated = await _asyncio.get_event_loop().run_in_executor(None, _run)
    return {"texts": translated}


@app.get("/signals/{ticker}")
@rate_limit("normal")
def ticker_signals(request: Request, ticker: str, lang: str = "he"):
    # Time-bounded: see _with_deadline. An unbounded upstream call here can
    # occupy uvicorn's single worker and take the whole service down.
    return _with_deadline(lambda: _signals_uncached(ticker, lang), 15, default={"signals": []})


def _signals_uncached(ticker: str, lang: str = "he"):
    """
    'דברים שכדאי לעקוב אחריהם' - סינון כותרות חדשות לפי מילות מפתח.
    """
    ticker = _clean_ticker(ticker)
    lang = _clean_lang(lang)
    try:
        articles = get_news(ticker, limit=15)
    except Exception as e:
        print(f"[signals] news fetch failed for {ticker}: {e}")
        raise HTTPException(status_code=502, detail="Could not fetch news for this ticker.")

    result = analyze_signals(articles)
    result["ticker"] = ticker.upper()

    if lang != "he":
        for item in result["flagged"]:
            for cat in item["categories"]:
                cat["label"] = translate_signal_category(cat["key"], lang)

    flagged = result.get("flagged", [])
    if lang != "en" and flagged:
        titles = [item.get("title", "") for item in flagged]
        translated_titles = _translate_batch(titles, lang)
        for i, item in enumerate(flagged):
            if translated_titles[i]:
                item["title"] = translated_titles[i]

    return result


@app.get("/quotes")
@rate_limit("normal")
def quotes_endpoint(request: Request, symbols: str = ""):
    # Time-bounded: see _with_deadline. An unbounded upstream call here can
    # occupy uvicorn's single worker and take the whole service down.
    return _with_deadline(lambda: _quotes_uncached(symbols), 20, default={"quotes": []})


def _quotes_uncached(symbols: str = ""):
    """
    מחיר + אחוז שינוי יומי לרשימת סימולים (מופרדים בפסיק).
    משמש את פאנל ההתראות — תזוזות במניות רשימת המעקב.
    """
    # Each symbol reaches yfinance and a cache key — filter to valid ticker
    # characters (same rule as _clean_ticker) and drop anything else.
    syms = []
    for s in symbols.split(",")[:20]:
        s = "".join(c for c in s.strip()[:20] if c in _TICKER_OK).upper()
        if s:
            syms.append(s)
    if not syms:
        return {"quotes": []}

    def _one(sym):
        cache_key = f"quote_lite_{sym}"
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached
        price, change, name, ccy, ccy_raw = None, None, None, "", ""
        try:
            info = get_quote(sym)["info"]
            price = info.get("currentPrice") or info.get("regularMarketPrice")
            prev = info.get("previousClose")
            if price is not None and prev:
                change = round((price - prev) / prev * 100, 2)
            # longName FIRST — /analyze uses longName, and phase 2 of the
            # watchlist overwrites this value. Preferring shortName here made
            # the name visibly flip ("ALPHABET INC-CL A" -> "Alphabet Inc.")
            # a second after the row appeared, in every language.
            name = info.get("longName") or info.get("shortName")
            ccy_raw = (info.get("currency") or "").strip()
            ccy = ccy_raw.upper()
        except Exception as _e:
            swallow("main:_one", _e, notify=True)
        if price is None:  # Stooq fallback (Yahoo blocked / unknown symbol)
            try:
                sq = get_stooq_daily(sym)
                if sq and sq.get("price") is not None:
                    price = sq["price"]
                    if sq.get("prev_close"):
                        change = round((sq["price"] - sq["prev_close"]) / sq["prev_close"] * 100, 2)
            except Exception as _e:
                swallow("main:_one", _e, notify=True)

        # Tel Aviv stocks are quoted by Yahoo in agorot (1/100 ILS). /analyze
        # already converts; this endpoint must apply the SAME rule or the
        # watchlist's fast first paint would flash a 100x price (Delek showed
        # 8173 instead of 81.73) before the full analysis corrected it.
        # Same rule as /analyze: real trading currency, with minor units (agorot,
        # pence, SA cents) converted to the major unit.
        price_currency = ccy or "USD"
        if sym.endswith(".TA") or ccy in ("ILA", "ILS"):
            price_currency = "ILS"
            if ccy != "ILS" and price is not None:
                price = round(price / 100.0, 2)
        else:
            _minor = _minor_unit_for(ccy_raw)
            if _minor:
                price_currency = _minor[0]
                if price is not None:
                    price = round(price / _minor[1], 2)

        result = {
            "ticker": sym,
            "price": price,
            "change_pct": change,
            "company_name": name,
            "price_currency": price_currency,
        }
        if price is not None:
            _cache_set(cache_key, result, CACHE_TTL["quote"])
        return result

    results = list(io_pool().map(_one, syms))
    return {"quotes": results}


@app.get("/market-overview")
@rate_limit("normal")
def market_overview(request: Request):
    """
    Never hangs, never returns empty.

    This endpoint makes 19 upstream calls. It had no time limit of any kind, so
    when Yahoo stopped answering it stayed open indefinitely — measured still
    running after 180 seconds — and since uvicorn runs one worker, that single
    request took the whole service down with it.

    Two guarantees now:
      1. A hard 20s budget. Past that the caller gets an answer regardless.
      2. On timeout, the last good snapshot is returned instead of nulls, so the
         table shows slightly stale numbers rather than a screen of dashes.
    """
    fresh = _with_deadline(_market_overview_uncached, 20, default=None)
    if fresh is not None:
        return fresh
    stale = _cache_get_stale("market_overview")
    if stale is not None:
        stale = dict(stale)
        stale["stale"] = True
        return stale
    return {"movers": [], "usd_ils": None}


def _market_overview_uncached():
    """תמונת מצב שוק - מדדים מרכזיים, שער דולר-שקל, ורשימת מניות לייב"""
    cached = _cache_get("market_overview")
    if cached is not None:
        return cached

    indices = {
        "S&P 500": "^GSPC",
        "Nasdaq": "^IXIC",
        "VIX": "^VIX",
    }

    # S&P, Nasdaq, VIX and the USD/ILS rate were four more sequential fetches
    # before the 15-stock table even started. All four are independent, so they
    # run together — and together WITH the table, below.

    def _one_index(item):
        name, symbol = item
        try:
            data = get_quote(symbol)
            price = data["info"].get("currentPrice") or data["info"].get("regularMarketPrice")
            prev_close = data["info"].get("previousClose")
            change_pct = None
            if price is not None and prev_close:
                change_pct = round((price - prev_close) / prev_close * 100, 2)
            return name, {"value": price, "change_pct": change_pct}
        except Exception:
            return name, {"value": None, "change_pct": None}

    def _fx():
        try:
            d = get_quote("ILS=X")["info"]
            return d.get("currentPrice") or d.get("regularMarketPrice")
        except Exception:
            return None

    overview = {}
    # max_workers=3: a burst of 19 simultaneous requests is exactly what makes
    # Yahoo throttle a cloud IP — the "faster" version was measurably slower in
    # practice. Three at a time is still ~6x better than the original serial
    # loop without looking like a scraper.
    # Still three at a time — the limit is about not looking like a scraper to
    # Yahoo, not about saving threads. `.result()` is called explicitly because
    # there is no `with` block left to join on.
    _ip = index_pool()
    fx_future = _ip.submit(_fx)
    for name, val in _ip.map(_one_index, indices.items()):
        overview[name] = val
    usd_ils = fx_future.result()
    overview["usd_ils"] = usd_ils

    watchlist_symbols = [
        "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "TSLA", "META", "AMD",
        "JPM", "V", "JNJ", "WMT", "DIS", "NFLX", "KO",
    ]
    # These 15 used to be fetched one after another, in a plain for-loop: fifteen
    # sequential round trips to Yahoo before a single row could be sent. Each is
    # a few hundred milliseconds on a good day, so the table took several seconds
    # to appear and any one slow symbol held up all the rest — which is exactly
    # how it looked on the phone: a table that filled in late and incompletely.
    #
    # /quotes already fetched in parallel; this endpoint simply never got the
    # same treatment. Same worker count (8), same pattern.
    def _one_mover(symbol):
        try:
            data = get_quote(symbol)
            info = data["info"]
            price = info.get("currentPrice") or info.get("regularMarketPrice")
            prev_close = info.get("previousClose")
            change_pct = None
            if price is not None and prev_close:
                change_pct = round((price - prev_close) / prev_close * 100, 2)
            return {
                "ticker": symbol,
                # longName first, then shortName — the same order /quotes and
                # /analyze already used. This line alone read shortName, so when
                # the provider returned longName without shortName (which it
                # does; measured live) this table fell back to bare tickers
                # while every other screen showed "Apple Inc." from the same
                # response.
                "name": info.get("longName") or info.get("shortName") or symbol,
                "price": price,
                "change_pct": change_pct,
                "volume": info.get("volume") or info.get("regularMarketVolume"),
                "avg_volume": info.get("averageVolume"),
                "market_cap": info.get("marketCap"),
            }
        except Exception:
            return {"ticker": symbol, "name": symbol, "price": None, "change_pct": None,
                    "volume": None, "avg_volume": None, "market_cap": None}

    # map() preserves input order, so the table keeps its intended sequence.
    movers = list(movers_pool().map(_one_mover, watchlist_symbols))

    overview["movers"] = movers

    # ── Stooq fallback ──
    # Yahoo's quote API periodically blocks cloud IPs (all prices come back
    # null). Fill anything missing from Stooq so the table never shows empty.

    # Trigger the Stooq fallback when EITHER the price or the volume is missing.
    # Yahoo often returns a live price but a null volume when throttling cloud
    # IPs — previously that case skipped the fallback and the column showed "—".
    missing = [m for m in movers if m.get("price") is None or m.get("volume") is None]
    if missing:
        def _fill(m):
            sq = get_stooq_daily(m["ticker"])
            if not sq:
                return
            # Only backfill price if Yahoo gave us none — never overwrite a live price.
            if m.get("price") is None and sq.get("price") is not None:
                m["price"] = sq["price"]
                if sq.get("prev_close"):
                    m["change_pct"] = round(
                        (sq["price"] - sq["prev_close"]) / sq["prev_close"] * 100, 2)
            # Backfill volume from Stooq when Yahoo omitted it.
            if m.get("volume") is None and sq.get("volume") is not None:
                m["volume"] = sq.get("volume")
        # Same restraint as above: this only runs when Yahoo already failed, so
        # hammering the fallback with 8 parallel requests is the last thing a
        # throttled path needs.
        list(fallback_pool().map(_fill, missing))

    _STOOQ_INDEX = {"S&P 500": "^spx", "Nasdaq": "^ndq", "VIX": "^vix"}
    idx_missing = [(n, s) for n, s in _STOOQ_INDEX.items()
                   if (overview.get(n) or {}).get("value") is None]
    if idx_missing:
        def _fill_idx(pair):
            name, sym = pair
            sq = get_stooq_daily(name, stooq_symbol=sym)
            if sq and sq.get("price") is not None:
                change = None
                if sq.get("prev_close"):
                    change = round(
                        (sq["price"] - sq["prev_close"]) / sq["prev_close"] * 100, 2)
                overview[name] = {"value": sq["price"], "change_pct": change}
        list(fallback_pool().map(_fill_idx, idx_missing))

    if overview.get("usd_ils") is None:
        sq = get_stooq_daily("usdils", stooq_symbol="usdils")
        if sq and sq.get("price") is not None:
            overview["usd_ils"] = sq["price"]

    # ── Last-known-good backfill ──
    # Stooq has no *average* volume, and occasionally both sources omit a plain
    # volume. Reuse the most recent non-null value we've seen for each ticker so
    # the Volume / Avg Vol columns stay populated instead of flickering to "—".
    lkg = _cache_get("mover_lkg") or {}
    _LKG_FIELDS = ("volume", "avg_volume", "market_cap")
    for m in movers:
        prev = lkg.get(m["ticker"], {})
        for f in _LKG_FIELDS:
            if m.get(f) is None and prev.get(f) is not None:
                m[f] = prev[f]
        lkg[m["ticker"]] = {
            f: (m.get(f) if m.get(f) is not None else prev.get(f))
            for f in _LKG_FIELDS
        }
    _cache_set("mover_lkg", lkg, 86400)
    _lkg_mark_dirty()  # flushed by _lkg_flush_loop, off the request path

    # Don't poison the cache with an all-null snapshot (Yahoo+Stooq both down)
    has_data = any(m.get("price") is not None for m in movers)
    if has_data:
        _cache_set("market_overview", overview, CACHE_TTL["market"])
    return overview

"""
Copyright (c) 2026, the creator of this application. All rights reserved.
Part of the BuddhaVest personal stock-research application.
Unauthorized copying, distribution, or use of this code, in whole or in part,
without explicit written permission from the copyright holder is prohibited.
"""

"""
data_fetcher.py
מושך נתונים גולמיים על מניה מ-yfinance ומחזיר אותם בצורה נקייה
שאר המערכת (analyzer) תעבוד על הפלט הזה
"""

import yfinance as yf
import urllib.request
import urllib.parse
import urllib.error
import xml.etree.ElementTree as ET

# `swallow` records a failure we deliberately continue past. Before this,
# these sites were `except Exception: pass` — the failure left no trace at
# all, so an empty card gave no way to tell which one had fired.
from observability import report, swallow

# ── Hard time limit on every Yahoo call ──────────────────────────────────────
# There was none. yfinance's default session waits indefinitely, so when Yahoo
# stopped answering, /analyze simply never returned — the phone sat on
# "Analyzing AMD…" and a direct request to the endpoint was still open after
# three minutes.
#
# On this deployment that is worse than one slow screen. uvicorn runs a single
# worker, so a hung upstream call occupies it and never gives it back; a couple
# of those and the whole server stops answering ANY route. That is exactly what
# was observed: /status (which never touches Yahoo) replied instantly while
# /quotes and /analyze both hung.
#
# A session with an explicit timeout turns "hang forever" into "raise after N
# seconds", which every caller here already handles — each fetch is wrapped in
# its own try/except and degrades to Stooq or to partial data.
_YF_TIMEOUT = 12  # seconds per HTTP request to Yahoo


# ── REVERTED: do not pass a custom session to yf.Ticker ──────────────────────
# The first attempt at the timeout handed yfinance its own curl_cffi session.
# It did not raise — it silently degraded. `stock.info` came back empty for
# EVERY ticker while `fast_info` kept working, so the app still showed prices
# and looked fine, but company names, volume and average volume all went null:
#
#   before:  "name": "Apple Inc.",  "volume": 67778746,  "avg_volume": 56928358
#   after:   "name": "AAPL",        "volume": null,      "avg_volume": null
#
# yfinance manages its own authenticated session (cookie + crumb). Replacing it
# breaks the endpoints that need that auth while leaving the unauthenticated
# ones intact — which is the worst kind of failure, because nothing errors.
#
# The timeout now lives at the REQUEST level instead (see _with_deadline in
# main.py): yfinance keeps its own session, and the endpoint stops waiting.
def _ticker(symbol: str):
    return yf.Ticker(symbol)


def _enrich_with_fast_info(stock, info: dict) -> dict:
    """
    Yahoo Finance periodically breaks stock.info (cookie/API changes).
    When price fields are missing, fill them from fast_info which uses
    a different, more stable endpoint.
    """
    if info.get("currentPrice") or info.get("regularMarketPrice"):
        return info  # already have price — nothing to do
    try:
        fi = stock.fast_info
        price = getattr(fi, "last_price", None)
        prev = getattr(fi, "regular_market_previous_close", None) or getattr(fi, "previous_close", None)
        if price is not None:
            info = dict(info)
            info["currentPrice"] = float(price)
            info["regularMarketPrice"] = float(price)
            if prev is not None:
                info["previousClose"] = float(prev)
                info["regularMarketPreviousClose"] = float(prev)
                if prev != 0:
                    info["regularMarketChangePercent"] = (float(price) - float(prev)) / float(prev) * 100
            mc = getattr(fi, "market_cap", None)
            if mc is not None:
                info.setdefault("marketCap", float(mc))
            vol = getattr(fi, "volume", None)
            if vol is not None:
                info.setdefault("volume", int(vol))
                info.setdefault("regularMarketVolume", int(vol))
    except Exception as _e:
        swallow("data_fetcher:_enrich_with_fast_info", _e, notify=True)
    return info


# ── Second source for the fields that vanish together ────────────────────────
# `stock.info` comes from Yahoo's AUTHENTICATED quoteSummary endpoint (cookie +
# crumb). `fast_info` comes from an unauthenticated one. When Yahoo throttles
# this server's cloud IP it is specifically the authenticated endpoint that goes
# quiet, and the symptom is unmistakable and was seen repeatedly: prices keep
# working while the company name, volume, average volume and every valuation
# multiple disappear at the same instant.
#
# `_enrich_with_fast_info` above already covers price, market cap and volume.
# What it cannot supply is the NAME — fast_info has no such field — so a
# throttled response left the app showing "AAPL" where "Apple Inc." belongs.
#
# This is the same v8 chart endpoint the app's own MetricHistory screen already
# uses for its price fallback, so it is a path with a track record in this
# codebase rather than a new dependency taken on faith. It is unauthenticated,
# which is the entire point: it survives exactly the failure that kills
# quoteSummary.
#
# Two hard rules, enforced by _merge_chart_meta below:
#   1. It may only ADD. A value already present is never overwritten, so a
#      second provider can never contradict a good first-provider reading.
#   2. It may never raise. Every failure degrades to "no extra fields".
_CHART_META_URL = ("https://query1.finance.yahoo.com/v8/finance/chart/"
                   "{sym}?interval=1d&range=1d")
_CHART_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")


def _merge_chart_meta(info: dict, meta: dict) -> dict:
    """
    Fold a v8 chart `meta` block into `info`, filling ONLY what is missing.

    Split out from the fetch so it can be tested without a network: every
    branch here is exercised against recorded and adversarial payloads in
    test_chart_meta.py.
    """
    if not isinstance(meta, dict):
        return info

    def _num(v):
        # Yahoo sends numbers as int, float, or occasionally a numeric string.
        if isinstance(v, bool) or v is None:
            return None
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        return f if f == f and f not in (float("inf"), float("-inf")) else None

    out = dict(info)

    name = meta.get("longName") or meta.get("shortName")
    # A name equal to the symbol is not a name — that is the degraded state we
    # are trying to escape, so accepting it would defeat the purpose.
    if isinstance(name, str) and name.strip():
        sym = str(meta.get("symbol") or out.get("symbol") or "").strip().upper()
        if name.strip().upper() != sym:
            out.setdefault("longName", name.strip())
            out.setdefault("shortName", name.strip())

    for src, dst in (("regularMarketPrice", "currentPrice"),
                     ("regularMarketPrice", "regularMarketPrice"),
                     ("chartPreviousClose", "previousClose"),
                     ("previousClose", "previousClose")):
        v = _num(meta.get(src))
        if v is not None and out.get(dst) is None:
            out[dst] = v

    vol = _num(meta.get("regularMarketVolume"))
    if vol is not None and vol >= 0:
        if out.get("volume") is None:
            out["volume"] = int(vol)
        if out.get("regularMarketVolume") is None:
            out["regularMarketVolume"] = int(vol)

    # Currency matters more than it looks: "GBp" (pence) vs "GBP" (pounds) is a
    # 100x price error, and the case is significant. Copied verbatim, never
    # upper-cased, to match _MINOR_UNIT handling in main.py.
    ccy = meta.get("currency")
    if isinstance(ccy, str) and ccy.strip() and not out.get("currency"):
        out["currency"] = ccy.strip()

    exch = meta.get("fullExchangeName") or meta.get("exchangeName")
    if isinstance(exch, str) and exch.strip() and not out.get("exchange"):
        out["exchange"] = exch.strip()

    return out


def _fetch_chart_meta(ticker: str, timeout: int = 6):
    """Return the v8 chart `meta` dict, or None. Never raises."""
    import json
    try:
        req = urllib.request.Request(
            _CHART_META_URL.format(sym=urllib.parse.quote(ticker, safe="^.-=")),
            headers={"User-Agent": _CHART_UA, "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            # Bound the read: a wrong URL that returns HTML must not pull an
            # unbounded body into a 512MB instance.
            raw = resp.read(400_000)
        payload = json.loads(raw.decode("utf-8", "replace"))
        result = (((payload or {}).get("chart") or {}).get("result") or [])
        return (result[0] or {}).get("meta") if result else None
    except Exception as _e:
        swallow("data_fetcher:_fetch_chart_meta", _e, ticker=ticker)
        return None


def _enrich_from_chart_meta(ticker: str, info: dict) -> dict:
    """
    Only runs when the primary source came back degraded — a missing NAME is the
    signal, because that is the field nothing else can supply. On a healthy
    response this costs zero extra requests.
    """
    name = info.get("longName") or info.get("shortName")
    if isinstance(name, str) and name.strip() and name.strip().upper() != (ticker or "").strip().upper():
        return info
    # Guarded here as well as inside _fetch_chart_meta. Belt and braces on
    # purpose: this runs un-try'd inside get_stock_data, so if the fetch layer
    # ever stopped being total, the fallback for a degraded response would
    # itself turn that response into a 502 — the failure mode it exists to
    # prevent. Caught by the test that stubs the fetch with a raising function.
    try:
        meta = _fetch_chart_meta(ticker)
        if not meta:
            return info
        merged = _merge_chart_meta(info, meta)
    except Exception as _e:
        swallow("data_fetcher:_enrich_from_chart_meta", _e, ticker=ticker)
        return info
    gained = sorted(k for k in merged if merged.get(k) is not None and info.get(k) is None)
    if gained:
        # A success worth knowing about, not a swallowed failure: it fires only
        # when the primary source came back degraded, so it is the clearest
        # signal available that Yahoo is throttling this server's IP.
        report("provider_fallback_used", source="yahoo_v8_chart",
               ticker=ticker, recovered=",".join(gained[:8]))
    return merged


def get_quote(ticker: str) -> dict:
    """
    גרסה קלה ומהירה של get_stock_data - מביאה רק את ה-info (מחיר, שווי שוק, נפח וכו'),
    בלי financials/balance/cashflow/history/dividends.
    מתאימה לרשימות כמו market-overview ושערי חליפין, שלא צריכות ניתוח מלא
    ולכן לא צריכות את כל הקריאות הכבדות שיש ב-get_stock_data.
    """
    stock = _ticker(ticker)
    try:
        info = stock.info or {}
    except Exception as _e:
        swallow("data_fetcher:get_quote", _e, ticker=ticker, notify=True)
        info = {}
    info = _enrich_with_fast_info(stock, info)
    info = _enrich_from_chart_meta(ticker, info)
    return {"ticker": ticker.upper(), "info": info}


def get_stock_data(ticker: str) -> dict:
    """
    מחזיר dict עם כל הנתונים הגולמיים הדרושים לניתוח:
    - info: מידע כללי (מחיר, שווי שוק, מכפילים, דיבידנד וכו')
    - income: דוח רווח והפסד (DataFrame)
    - balance: מאזן (DataFrame)
    - cashflow: תזרים מזומנים (DataFrame)
    - history: היסטוריית מחיר לשנה אחרונה (DataFrame)
    - dividends: היסטוריית דיבידנדים (Series)
    """
    stock = _ticker(ticker)

    history = stock.history(period="1y")
    if history is None or history.empty:
        # מניות שהונפקו לאחרונה (פחות משנה במסחר) - "1y" יכול לחזור ריק.
        # "max" מחזיר את כל ההיסטוריה הקיימת, כמה שיש.
        try:
            history = stock.history(period="max")
        except Exception as _e:
            swallow("data_fetcher:get_stock_data", _e, notify=True)

    try:
        info = stock.info or {}
    except Exception as _e:
        swallow("data_fetcher:get_stock_data", _e, ticker=ticker, notify=True)
        info = {}
    info = _enrich_with_fast_info(stock, info)
    info = _enrich_from_chart_meta(ticker, info)

    # Each statement is fetched independently and may fail on its own (Yahoo
    # throttling, schema changes). Previously any single failure raised out of
    # here and turned the whole /analyze into a 502 — even when price + most
    # fundamentals were available. The analyzer already treats a missing
    # statement as "not enough data" for the affected metrics only, so degrade
    # per-section instead of failing the entire request.
    def _safe(getter):
        try:
            return getter()
        except Exception as _e:
            swallow("data_fetcher:get_stock_data.statement", _e, ticker=ticker)
            return None

    return {
        "ticker": ticker.upper(),
        "info": info,
        "income": _safe(lambda: stock.financials),
        "balance": _safe(lambda: stock.balance_sheet),
        "cashflow": _safe(lambda: stock.cashflow),
        "history": history,
        "dividends": _safe(lambda: stock.dividends),
    }


def get_news(ticker: str, limit: int = 10) -> list:
    """
    מושך כתבות חדשות עבור מנייה/סימול מ-yfinance (חינמי, ללא API נוסף).
    מחזיר רשימה נקייה של dicts: title, publisher, link, published, thumbnail.
    עמיד מול שינויי פורמט בין גרסאות yfinance (לפעמים השדות מקוננים תחת "content").
    """
    stock = _ticker(ticker)
    raw_items = stock.news or []

    cleaned = []
    for item in raw_items[:limit]:
        # בגרסאות חדשות של yfinance המידע מקונן תחת "content"
        content = item.get("content", item)

        title = content.get("title")
        if not title:
            continue

        # קישור - יכול להיות במקומות שונים בהתאם לגרסה
        link = (
            content.get("clickThroughUrl", {}).get("url")
            if isinstance(content.get("clickThroughUrl"), dict)
            else content.get("link") or content.get("url")
        )

        publisher = (
            content.get("provider", {}).get("displayName")
            if isinstance(content.get("provider"), dict)
            else content.get("publisher")
        )

        # תאריך פרסום
        published = content.get("pubDate") or content.get("providerPublishTime")

        # תמונה ממוזערת
        thumbnail = None
        thumb_data = content.get("thumbnail")
        if isinstance(thumb_data, dict):
            resolutions = thumb_data.get("resolutions") or []
            if resolutions:
                thumbnail = resolutions[0].get("url")
            else:
                thumbnail = thumb_data.get("originalUrl")

        cleaned.append({
            "title": title,
            "publisher": publisher or "Unknown",
            "link": link,
            "published": str(published) if published else None,
            "thumbnail": thumbnail,
            "related_ticker": ticker.upper(),
        })

    return cleaned


def get_google_news(query: str, limit: int = 10) -> list:
    """
    מקור חדשות משלים (בנוסף ל-Yahoo) - Google News RSS, חינמי וללא מפתח API.
    שימושי במיוחד לכיסוי רחב יותר (חברות קטנות, מניות לא-אמריקאיות) שלא
    תמיד יש להן הרבה כתבות ב-Yahoo. מחזיר את אותו פורמט נקי כמו get_news,
    כך שניתן למזג בין שני המקורות בלי שינוי בצד הצרכן (main.py).
    """
    encoded_query = urllib.parse.quote(query)
    url = f"https://news.google.com/rss/search?q={encoded_query}&hl=en-US&gl=US&ceid=US:en"

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            raw = resp.read()
    except (urllib.error.URLError, TimeoutError, OSError):
        return []

    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return []

    cleaned = []
    for item in root.findall("./channel/item")[:limit]:
        title = item.findtext("title")
        if not title:
            continue
        link = item.findtext("link")
        pub_date = item.findtext("pubDate")
        source_el = item.find("source")
        publisher = source_el.text if source_el is not None and source_el.text else "Google News"

        cleaned.append({
            "title": title,
            "publisher": publisher,
            "link": link,
            "published": pub_date,
            "thumbnail": None,
            "related_ticker": None,
        })

    return cleaned


if __name__ == "__main__":
    # בדיקה מהירה
    data = get_stock_data("AAPL")
    print("Company:", data["info"].get("longName"))
    print("Current price:", data["info"].get("currentPrice"))
    print("Has dividends:", len(data["dividends"]) > 0)
    print("Income statement rows:", len(data["income"]))

    print("\nNews:")
    for n in get_news("AAPL", limit=3):
        print(" -", n["title"], "|", n["publisher"])

    print("\nGoogle News:")
    for n in get_google_news("AAPL stock", limit=3):
        print(" -", n["title"], "|", n["publisher"])

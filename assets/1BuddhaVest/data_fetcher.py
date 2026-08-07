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
    except Exception:
        pass
    return info


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
    except Exception:
        info = {}
    info = _enrich_with_fast_info(stock, info)
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
        except Exception:
            pass

    try:
        info = stock.info or {}
    except Exception:
        info = {}
    info = _enrich_with_fast_info(stock, info)

    # Each statement is fetched independently and may fail on its own (Yahoo
    # throttling, schema changes). Previously any single failure raised out of
    # here and turned the whole /analyze into a 502 — even when price + most
    # fundamentals were available. The analyzer already treats a missing
    # statement as "not enough data" for the affected metrics only, so degrade
    # per-section instead of failing the entire request.
    def _safe(getter):
        try:
            return getter()
        except Exception:
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

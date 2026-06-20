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

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
import math
import os
import time
import threading

from data_fetcher import get_stock_data, get_quote, get_news, get_google_news
from analyzer import calculate_score
from news_signals import analyze_signals
from i18n_data import render_explanation, translate_signal_category
from ticker_search import search_tickers
from stooq_fallback import get_stooq_quote

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

def _cache_get(key: str):
    with _cache_lock:
        entry = _cache.get(key)
        if entry and time.time() < entry["expires"]:
            return entry["data"]
        return None

def _cache_set(key: str, data, ttl: int):
    with _cache_lock:
        _cache[key] = {"data": data, "expires": time.time() + ttl}

def _cache_clear_expired():
    """מנקה entries פגי תוקף כדי לא לצבור זיכרון"""
    with _cache_lock:
        now = time.time()
        expired = [k for k, v in _cache.items() if now >= v["expires"]]
        for k in expired:
            del _cache[k]

# ניקוי cache כל 10 דקות ברקע
def _cleanup_loop():
    while True:
        time.sleep(600)
        _cache_clear_expired()

threading.Thread(target=_cleanup_loop, daemon=True).start()
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(title="BuddhaVest API")

# מאפשר לאפליקציית הווב (frontend) לדבר עם השרת הזה גם אם הם "כתובות" שונות
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
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


@app.get("/")
def root():
    # אם index.html נמצא באותה תיקייה כמו main.py - מגישים אותו (האפליקציה עצמה).
    # אם לא - מחזירים הודעת סטטוס פשוטה (שימושי לבדיקה שהשרת בכלל רץ).
    index_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return {"status": "BuddhaVest API is running", "note": "index.html not found next to main.py"}


@app.get("/status")
def status():
    """
    בדיקת סטטוס שה-frontend קורא לה לפני שטוען כל דבר אחר. אם קובץ MAINTENANCE.flag
    קיים באותה תיקייה כמו main.py - מציגים מסך "תחת תחזוקה" באפליקציה במקום התוכן הרגיל.
    כדי להפעיל/לכבות מצב תחזוקה: ליצור/למחוק את הקובץ MAINTENANCE.flag בתיקייה.
    """
    flag_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "MAINTENANCE.flag")
    return {"maintenance": os.path.exists(flag_path)}


@app.get("/search")
def search(q: str):
    """
    חיפוש סימול לפי שם חברה (עברית/אנגלית) או חלק משם - לדוגמה "אינטל" -> INTC.
    אם q הוא כבר סימול מדויק וקיים, עדיף לקרוא ל-/analyze/{ticker} ישירות -
    זה ה-endpoint לכל מקרה שהקלט הוא שם ולא סימול.
    """
    if not q or not q.strip():
        return {"query": q, "results": []}
    results = search_tickers(q.strip())

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
def analyze(ticker: str, lang: str = "he"):
    """מחזיר ניתוח מלא למנייה בודדת. lang: he/en/ru/es - שולט בשפת הטקסטים ההסברתיים."""
    cache_key = f"analyze_{ticker.upper()}_{lang}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        data = get_stock_data(ticker)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not fetch data for '{ticker}': {e}")

    # אם yfinance מחזיר info ריק - הסימול כנראה לא קיים (או שזו בעיית סיומת בורסה)
    if not data.get("info") or data["info"].get("currentPrice") is None:
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
        "business_summary": info.get("longBusinessSummary"),
    }

    # שער דולר-שקל - כדי שה-frontend יוכל להציג מחיר גם בשקלים
    try:
        fx_data = get_quote("ILS=X")
        result["usd_ils"] = fx_data["info"].get("currentPrice") or fx_data["info"].get("regularMarketPrice")
    except Exception:
        result["usd_ils"] = None

    _cache_set(cache_key, result, CACHE_TTL["stock"])
    return result


@app.get("/exchange-rate")
def exchange_rate(currency: str = "ILS"):
    currency = currency.upper()
    cache_key = f"exchange_{currency}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached
    try:
        data = get_quote(f"{currency}=X")
        rate = data["info"].get("currentPrice") or data["info"].get("regularMarketPrice")
        result = {"currency": currency, "rate": rate, "usd_ils": rate if currency == "ILS" else None}
        _cache_set(cache_key, result, CACHE_TTL["exchange"])
        return result
    except Exception:
        return {"currency": currency, "rate": None, "usd_ils": None}


@app.get("/news")
def general_news():
    cached = _cache_get("news_general")
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
    except Exception:
        pass

    # מיון לפי תאריך פרסום (חדש ביותר ראשון) - אם קיים
    def sort_key(item):
        return item.get("published") or ""

    all_news.sort(key=sort_key, reverse=True)
    result = {"articles": all_news[:15]}
    _cache_set("news_general", result, CACHE_TTL["news"])
    return result


@app.get("/news/{ticker}")
def ticker_news(ticker: str):
    """
    חדשות עבור מנייה ספציפית - ממוזג מ-Yahoo וגם מ-Google News (חינמי, בלי מפתח API),
    כך שמניות עם כיסוי דליל ב-Yahoo (חברות קטנות, לא-אמריקאיות) עדיין יקבלו כתבות.
    """
    seen_titles = set()
    all_articles = []

    try:
        for item in get_news(ticker, limit=8):
            if item["title"] not in seen_titles:
                seen_titles.add(item["title"])
                all_articles.append(item)
    except Exception:
        # לא עוצרים כאן - אולי Google News עדיין ימצא משהו
        pass

    try:
        for item in get_google_news(f"{ticker} stock", limit=6):
            if item["title"] not in seen_titles:
                seen_titles.add(item["title"])
                all_articles.append(item)
    except Exception:
        pass

    return {"ticker": ticker.upper(), "articles": all_articles}


@app.get("/signals/{ticker}")
def ticker_signals(ticker: str, lang: str = "he"):
    """
    'דברים שכדאי לעקוב אחריהם' - סינון כותרות חדשות לפי מילות מפתח
    (שינויי הנהלה, רגולציה, מיזוגים, פעולות אנליסטים, אירועים מהותיים).

    זה נפרד לחלוטין מהציון הפיננסי - מידע איכותני/ספקולטיבי בלבד,
    מבוסס על כותרות בלבד (לא ניתוח תוכן מלא). lang שולט בשפת תוויות הקטגוריות.
    """
    try:
        articles = get_news(ticker, limit=15)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not fetch news for '{ticker}': {e}")

    result = analyze_signals(articles)
    result["ticker"] = ticker.upper()

    if lang != "he":
        for item in result["flagged"]:
            for cat in item["categories"]:
                cat["label"] = translate_signal_category(cat["key"], lang)

    return result


@app.get("/market-overview")
def market_overview():
    """תמונת מצב שוק - מדדים מרכזיים, שער דולר-שקל, ורשימת מניות לייב"""
    cached = _cache_get("market_overview")
    if cached is not None:
        return cached

    indices = {
        "S&P 500": "^GSPC",
        "Nasdaq": "^IXIC",
        "VIX": "^VIX",
    }

    overview = {}
    for name, symbol in indices.items():
        try:
            data = get_quote(symbol)
            price = data["info"].get("currentPrice") or data["info"].get("regularMarketPrice")
            prev_close = data["info"].get("previousClose")
            change_pct = None
            if price is not None and prev_close:
                change_pct = round((price - prev_close) / prev_close * 100, 2)

            overview[name] = {
                "value": price,
                "change_pct": change_pct,
            }
        except Exception:
            overview[name] = {"value": None, "change_pct": None}

    # שער דולר-שקל
    try:
        fx_data = get_quote("ILS=X")
        usd_ils = fx_data["info"].get("currentPrice") or fx_data["info"].get("regularMarketPrice")
    except Exception:
        usd_ils = None
    overview["usd_ils"] = usd_ils

    # רשימת מניות לייב לטבלת השוק - מגוון סקטורים (טכנולוגיה, פיננסים, צרכנות, תקשורת)
    watchlist_symbols = [
        "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "TSLA", "META", "AMD",
        "JPM", "V", "JNJ", "WMT", "DIS", "NFLX", "KO",
    ]
    movers = []
    for symbol in watchlist_symbols:
        try:
            data = get_quote(symbol)
            info = data["info"]
            price = info.get("currentPrice") or info.get("regularMarketPrice")
            prev_close = info.get("previousClose")
            change_pct = None
            if price is not None and prev_close:
                change_pct = round((price - prev_close) / prev_close * 100, 2)
            movers.append({
                "ticker": symbol,
                "name": info.get("shortName", symbol),
                "price": price,
                "change_pct": change_pct,
                "volume": info.get("volume") or info.get("regularMarketVolume"),
                "avg_volume": info.get("averageVolume"),
                "market_cap": info.get("marketCap"),
            })
        except Exception:
            movers.append({"ticker": symbol, "name": symbol, "price": None, "change_pct": None,
                            "volume": None, "avg_volume": None, "market_cap": None})

    overview["movers"] = movers

    _cache_set("market_overview", overview, CACHE_TTL["market"])
    return overview

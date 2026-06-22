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


@app.get("/metric-history/{ticker}/{metric}")
def metric_history(ticker: str, metric: str):
    """מחזיר היסטוריה של מדד פיננסי ספציפי ל-5 שנים רבעונית/שנתית"""
    cache_key = f"metric_history_{ticker.upper()}_{metric}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        import yfinance as yf
        import pandas as pd
        stock = yf.Ticker(ticker)

        # מיפוי מדדים לשדות ב-yfinance
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
        }

        result_data = {"ticker": ticker.upper(), "metric": metric, "quarterly": [], "annual": [], "use_price": False}

        if metric not in METRIC_MAP:
            # מדד ללא היסטוריה – החזר היסטוריית מחיר
            result_data["use_price"] = True
        else:
            source, field1, field2, calc = METRIC_MAP[metric]

            def extract_series(df, f1, f2, calc_type, period_type):
                if df is None or df.empty:
                    return []
                rows = []
                for col in df.columns:
                    try:
                        v1 = df.loc[f1, col] if f1 in df.index else None
                        v2 = df.loc[f2, col] if f2 and f2 in df.index else None
                        if v1 is None or (f2 and v2 is None):
                            continue
                        if calc_type == "pct":
                            val = round(float(v1) / float(v2) * 100, 2) if v2 and float(v2) != 0 else None
                        elif calc_type == "ratio":
                            val = round(float(v1) / float(v2), 3) if v2 and float(v2) != 0 else None
                        else:
                            val = float(v1)
                        if val is not None:
                            date_str = col.strftime("%b %Y") if hasattr(col, "strftime") else str(col)[:7]
                            rows.append({"date": date_str, "value": val})
                    except Exception:
                        continue
                return list(reversed(rows))

            try:
                if source == "income":
                    result_data["quarterly"] = extract_series(stock.quarterly_financials, field1, field2, calc, "Q")
                    result_data["annual"] = extract_series(stock.financials, field1, field2, calc, "A")
                elif source == "balance":
                    result_data["quarterly"] = extract_series(stock.quarterly_balance_sheet, field1, field2, calc, "Q")
                    result_data["annual"] = extract_series(stock.balance_sheet, field1, field2, calc, "A")
                elif source == "cashflow":
                    result_data["quarterly"] = extract_series(stock.quarterly_cashflow, field1, field2, calc, "Q")
                    result_data["annual"] = extract_series(stock.cashflow, field1, field2, calc, "A")
            except Exception:
                pass

            if not result_data["quarterly"] and not result_data["annual"]:
                result_data["use_price"] = True

        if result_data["use_price"]:
            hist = stock.history(period="max")
            if hist is not None and not hist.empty:
                close = hist["Close"].resample("ME").last().dropna()
                result_data["price_history"] = [
                    {"date": d.strftime("%b %Y"), "value": round(float(v), 2)}
                    for d, v in zip(close.index, close.values)
                ]
            else:
                result_data["price_history"] = []

        _cache_set(cache_key, result_data, CACHE_TTL["stock"])
        return result_data

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/events/{ticker}")
def ticker_events(ticker: str):
    """דוחות כספיים קרובים, דיבידנדים וסיפלטים"""
    cache_key = f"events_{ticker.upper()}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        import yfinance as yf
        from datetime import datetime, timezone
        stock = yf.Ticker(ticker)
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
            except Exception:
                pass

        # דיבידנד הבא
        ex_div = info.get("exDividendDate")
        div_rate = info.get("dividendRate")
        if ex_div and div_rate:
            try:
                dt = datetime.fromtimestamp(ex_div, tz=timezone.utc)
                if dt > datetime.now(tz=timezone.utc):
                    events.append({
                        "type": "dividend",
                        "date": dt.strftime("%Y-%m-%d"),
                        "label": "Ex-Dividend Date",
                        "detail": f"${div_rate:.2f}/share annually"
                    })
            except Exception:
                pass

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
                    except Exception:
                        pass
        except Exception:
            pass

        # דוחות כספיים אחרונים מהיסטוריה רבעונית
        try:
            fin = stock.quarterly_financials
            if fin is not None and not fin.empty:
                for col in fin.columns[:4]:
                    try:
                        date_str = col.strftime("%Y-%m-%d") if hasattr(col, 'strftime') else str(col)[:10]
                        rev = fin.loc["Total Revenue", col] if "Total Revenue" in fin.index else None
                        ni = fin.loc["Net Income", col] if "Net Income" in fin.index else None
                        detail_parts = []
                        if rev: detail_parts.append(f"Rev: ${rev/1e9:.1f}B")
                        if ni: detail_parts.append(f"NI: ${ni/1e9:.1f}B")
                        events.append({
                            "type": "past_earnings",
                            "date": date_str,
                            "label": f"Q Report",
                            "detail": " · ".join(detail_parts)
                        })
                    except Exception:
                        continue
        except Exception:
            pass

        # מיין לפי תאריך
        events.sort(key=lambda x: x["date"], reverse=True)

        result = {"ticker": ticker.upper(), "events": events}
        _cache_set(cache_key, result, CACHE_TTL["stock"])
        return result

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/financials/{ticker}")
def ticker_financials(ticker: str):
    """דוחות כספיים מלאים - Income Statement, Balance Sheet, Cash Flow"""
    cache_key = f"financials_{ticker.upper()}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        import yfinance as yf
        import math
        stock = yf.Ticker(ticker)

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
            "income_quarterly":  df_to_table(stock.quarterly_financials),
            "income_annual":     df_to_table(stock.financials),
            "balance_quarterly": df_to_table(stock.quarterly_balance_sheet),
            "balance_annual":    df_to_table(stock.balance_sheet),
            "cashflow_quarterly":df_to_table(stock.quarterly_cashflow),
            "cashflow_annual":   df_to_table(stock.cashflow),
        }

        _cache_set(cache_key, result, CACHE_TTL["stock"])
        return result

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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

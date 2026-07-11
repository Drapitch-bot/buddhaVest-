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
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
import math
import os
import time
import threading

import httpx

from data_fetcher import get_stock_data, get_quote, get_news, get_google_news
from analyzer import calculate_score
from news_signals import analyze_signals
from i18n_data import render_explanation, translate_signal_category
from ticker_search import search_tickers
from stooq_fallback import get_stooq_quote

# Tiingo API — key lives here on the server, never in the mobile bundle
TIINGO_TOKEN = os.environ.get("TIINGO_TOKEN", "a7a7fcb16721295ef8d1fe22fc0e5b797394f1a0")

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
        """Translate a single string. Returns original if lang is 'en' or on error."""
        if not text or lang == "en":
            return text
        target = _TRANSLATE_LANG.get(lang, lang)
        try:
            result = _GT(source="auto", target=target).translate(text) or text
            return _rtl_wrap(result, lang)
        except Exception:
            return text

    def _translate_batch(texts: list, lang: str) -> list:
        """Translate a list of strings. Returns originals on error."""
        if not texts or lang == "en":
            return texts
        target = _TRANSLATE_LANG.get(lang, lang)
        try:
            translated = _GT(source="auto", target=target).translate_batch(texts)
            return [_rtl_wrap(t or orig, lang) for t, orig in zip(translated, texts)]
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


# ─── Article domain blocklist ────────────────────────────────────────────────
# Sites that block or paywall WebView content — remove from news feed entirely
_NO_SHOW_DOMAINS = ['nytimes.com', 'nyti.ms']
_NO_SHOW_PUBLISHERS = ['New York Times', 'The New York Times']

def _filter_articles(articles: list) -> list:
    return [a for a in articles if not (
        any(d in (a.get('link') or '') for d in _NO_SHOW_DOMAINS) or
        any(p in (a.get('publisher') or '') for p in _NO_SHOW_PUBLISHERS)
    )]


def _resolve_gnews_link(url: str) -> str:
    """Follow Google News RSS redirect to get the real article URL."""
    if not url or 'news.google.com/rss/articles' not in url:
        return url
    try:
        resp = httpx.head(url, follow_redirects=True, timeout=4,
                          headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"})
        final = str(resp.url)
        if final and 'news.google.com' not in final and final.startswith('http'):
            return final
    except Exception:
        pass
    try:
        with httpx.stream("GET", url, follow_redirects=True, timeout=4,
                          headers={"User-Agent": "Mozilla/5.0"}) as r:
            final = str(r.url)
            if final and 'news.google.com' not in final and final.startswith('http'):
                return final
    except Exception:
        pass
    return url


def _resolve_gnews_articles(articles: list) -> list:
    """Resolve Google News redirect links in parallel (max 6s total)."""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    gnews = [(i, a) for i, a in enumerate(articles)
             if 'news.google.com/rss/articles' in (a.get('link') or '')]
    if not gnews:
        return articles
    result = list(articles)
    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(_resolve_gnews_link, a['link']): (i, a) for i, a in gnews}
        for fut in as_completed(futures, timeout=6):
            i, a = futures[fut]
            try:
                real_url = fut.result()
                if real_url != a['link']:
                    result[i] = dict(a, link=real_url)
            except Exception:
                pass
    return result

# ─── Cache pre-warming ────────────────────────────────────────────────────────
# כשהשרת מתעורר (cold start ב-Render) – מאחסן חדשות לכל השפות ברקע,
# כדי שהמשתמש הראשון יקבל תשובה מהירה מה-cache ולא יחכה לתרגום.
def _prewarm_news():
    time.sleep(5)  # wait for server to fully start
    for _lang in ["en", "he", "ru", "es"]:
        try:
            general_news(_lang)
        except Exception:
            pass

threading.Thread(target=_prewarm_news, daemon=True).start()
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/")
def root():
    return {"status": "ok"}


@app.get("/status")
def status():
    """
    בדיקת סטטוס שה-frontend קורא לה לפני שטוען כל דבר אחר. אם קובץ MAINTENANCE.flag
    קיים באותה תיקייה כמו main.py - מציגים מסך "תחת תחזוקה" באפליקציה במקום התוכן הרגיל.
    כדי להפעיל/לכבות מצב תחזוקה: ליצור/למחוק את הקובץ MAINTENANCE.flag בתיקייה.
    """
    flag_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "MAINTENANCE.flag")
    return {"maintenance": os.path.exists(flag_path)}


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
<p>The following data is stored <strong>locally on your device only</strong> (via AsyncStorage) and is never transmitted to our servers:</p>
<ul>
  <li>Your watchlist (ticker symbols you save)</li>
  <li>Your research journal entries</li>
  <li>App preferences: language, color theme, notification seen state</li>
</ul>

<h2>2. Data We Process on Our Servers</h2>
<p>When you use the app, our backend server processes the following to serve you data:</p>
<ul>
  <li><strong>Ticker symbols</strong> you search or view (e.g., "AAPL") — used to fetch market data and are not stored or linked to your identity.</li>
  <li><strong>Language preference</strong> — sent with analysis requests to translate content server-side. Not stored.</li>
</ul>
<p>We do not log IP addresses in any persistent way and do not build user profiles.</p>

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

    # Forward P/E ו-Sector comparison
    try:
        info = data.get("info", {})
        forward_pe = info.get("forwardPE")
        trailing_pe = info.get("trailingPE")
        sector = info.get("sector")
        industry_pe = None  # yfinance לא מחזיר ממוצע סקטור ישירות
        
        result["valuation_extra"] = {
            "forward_pe": round(float(forward_pe), 2) if forward_pe else None,
            "trailing_pe": round(float(trailing_pe), 2) if trailing_pe else None,
            "price_to_book": round(float(info.get("priceToBook", 0)), 2) if info.get("priceToBook") else None,
            "price_to_sales": round(float(info.get("priceToSalesTrailing12Months", 0)), 2) if info.get("priceToSalesTrailing12Months") else None,
            "ev_to_ebitda": round(float(info.get("enterpriseToEbitda", 0)), 2) if info.get("enterpriseToEbitda") else None,
            "sector": sector,
        }
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
        _stk = yf.Ticker(ticker)
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
                    except: continue
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

    _cache_set(cache_key, result, CACHE_TTL["stock"])
    return result


def _get_quarterly_income(stock):
    for attr in ["quarterly_income_stmt", "quarterly_financials", "quarterly_incomestmt"]:
        try:
            df = getattr(stock, attr)
            if df is not None and not df.empty: return df
        except: pass
    return None

def _get_annual_income(stock):
    for attr in ["income_stmt", "financials", "incomestmt"]:
        try:
            df = getattr(stock, attr)
            if df is not None and not df.empty: return df
        except: pass
    return None

def _get_quarterly_balance(stock):
    for attr in ["quarterly_balance_sheet", "quarterly_balancesheet"]:
        try:
            df = getattr(stock, attr)
            if df is not None and not df.empty: return df
        except: pass
    return None

def _get_annual_balance(stock):
    for attr in ["balance_sheet", "balancesheet"]:
        try:
            df = getattr(stock, attr)
            if df is not None and not df.empty: return df
        except: pass
    return None

def _get_quarterly_cashflow(stock):
    for attr in ["quarterly_cash_flow", "quarterly_cashflow"]:
        try:
            df = getattr(stock, attr)
            if df is not None and not df.empty: return df
        except: pass
    return None

def _get_annual_cashflow(stock):
    for attr in ["cash_flow", "cashflow"]:
        try:
            df = getattr(stock, attr)
            if df is not None and not df.empty: return df
        except: pass
    return None

@app.get("/debug-pe/{ticker}")
def debug_pe(ticker: str):
    """בדיקת חישוב PE היסטורי"""
    try:
        import yfinance as yf
        import pandas as pd
        stock = yf.Ticker(ticker)
        hist = stock.history(period="5y")
        eps_df = _get_quarterly_income(stock)
        
        result = {
            "hist_rows": len(hist) if hist is not None else 0,
            "eps_df_empty": eps_df is None or eps_df.empty,
            "eps_index": [],
            "eps_values": [],
            "sample_pe": []
        }
        
        if eps_df is not None and not eps_df.empty:
            eps_q = None
            for key in ["Diluted EPS", "Basic EPS"]:
                if key in eps_df.index:
                    eps_q = eps_df.loc[key].sort_index()
                    result["eps_key_used"] = key
                    break
            
            if eps_q is not None:
                if hasattr(eps_q.index, 'tz') and eps_q.index.tz is not None:
                    eps_q.index = eps_q.index.tz_localize(None)
                
                result["eps_index"] = [str(i)[:10] for i in eps_q.index[-8:]]
                result["eps_values"] = [round(float(v), 4) if v is not None else None for v in eps_q.values[-8:]]
                
                price_monthly = hist["Close"].resample("ME").last()
                if hasattr(price_monthly.index, 'tz') and price_monthly.index.tz is not None:
                    price_monthly.index = price_monthly.index.tz_localize(None)
                
                count = 0
                for date, price in list(price_monthly.items())[-12:]:
                    past_eps = eps_q[eps_q.index <= date].tail(4)
                    ttm = float(past_eps.sum()) if len(past_eps) == 4 else None
                    pe = round(float(price)/ttm, 2) if ttm and ttm != 0 else None
                    result["sample_pe"].append({
                        "date": date.strftime("%b %Y"),
                        "price": round(float(price), 2),
                        "ttm_eps": round(ttm, 4) if ttm else None,
                        "eps_count": len(past_eps),
                        "pe": pe
                    })
        
        return result
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc()}

@app.get("/debug-rows/{ticker}")
def debug_rows(ticker: str):
    """מחזיר את שמות השורות האמיתיים מ-yfinance"""
    try:
        import yfinance as yf
        stock = yf.Ticker(ticker)
        result = {}
        for attr in ["quarterly_income_stmt", "quarterly_financials", "income_stmt", "financials",
                     "quarterly_balance_sheet", "balance_sheet",
                     "quarterly_cash_flow", "quarterly_cashflow", "cash_flow", "cashflow"]:
            try:
                df = getattr(stock, attr)
                if df is not None and not df.empty:
                    result[attr] = list(df.index)
                else:
                    result[attr] = "empty"
            except Exception as e:
                result[attr] = f"error: {str(e)}"
        return result
    except Exception as e:
        return {"error": str(e)}

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
            "Cash And Cash Equivalents": ["Cash And Cash Equivalents", "Cash Cash Equivalents And Short Term Investments"],
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
        elif metric in ("pe_ratio", "peg_ratio"):
            try:
                import pandas as pd, math as _math
                hist = stock.history(period="max")
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
                else:
                    price_monthly = hist["Close"].resample("ME").last()
                    if hasattr(price_monthly.index, "tz") and price_monthly.index.tz:
                        price_monthly.index = price_monthly.index.tz_localize(None)

                    series_q = []
                    series_a = []
                    seen_years = set()

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
                            yr = pt["date"].split(" ")[-1]
                            if yr not in seen_years:
                                seen_years.add(yr)
                                series_a.append(pt)

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
                                yr = pt["date"].split(" ")[-1]
                                if yr not in seen_years:
                                    seen_years.add(yr)
                                    series_a.append(pt)

                    result_data["quarterly"] = series_q
                    result_data["annual"] = series_a
                    if not series_q:
                        result_data["use_price"] = True

            except Exception:
                result_data["use_price"] = True
        elif metric in ("calc_forward_pe", "calc_pb", "calc_ps", "calc_ev_ebitda",
                        "forward_pe", "price_to_book", "price_to_sales", "ev_to_ebitda"):
            # מחשב היסטוריה של מכפיל על-ידי: מחיר חודשי / נתון פיננסי רבעוני TTM
            try:
                import math as _math
                hist = stock.history(period="max")
                info = stock.info or {}
                shares = info.get("sharesOutstanding") or info.get("impliedSharesOutstanding")

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

                if hist is None or hist.empty or not shares:
                    result_data["use_price"] = True
                else:
                    shares = float(shares)
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

                    series_q, series_a = [], []
                    seen_years = set()

                    for date, price in price_monthly.items():
                        price = float(price)
                        val = None
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
                        yr = pt["date"].split(" ")[-1]
                        if yr not in seen_years:
                            seen_years.add(yr)
                            series_a.append(pt)

                    result_data["quarterly"] = series_q
                    result_data["annual"] = series_a
                    if not series_q:
                        result_data["use_price"] = True

            except Exception:
                result_data["use_price"] = True

        elif metric in CALC_SPECIAL:
            # ── buyback / dividend — calculated from cashflow / dividend history ──
            try:
                import math as _math
                hist = stock.history(period="max")
                info = stock.info or {}

                if metric == "buyback":
                    # Buyback yield = TTM repurchases / market cap * 100
                    # Calculated per month using price history + quarterly cashflow
                    shares = info.get("sharesOutstanding") or info.get("impliedSharesOutstanding")
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

                    if hist is None or hist.empty or not shares or (rep_q is None and rep_a is None):
                        result_data["use_price"] = True
                    else:
                        shares_f = float(shares)
                        price_monthly = hist["Close"].resample("ME").last().dropna()
                        if hasattr(price_monthly.index, "tz") and price_monthly.index.tz:
                            price_monthly.index = price_monthly.index.tz_localize(None)

                        series_q, series_a, seen_years = [], [], set()
                        for date, price in price_monthly.items():
                            price = float(price)
                            try:
                                ttm_rep = None
                                if rep_q is not None:
                                    past = rep_q[rep_q.index <= date].tail(4)
                                    if len(past) >= 2:
                                        ttm_rep = float(past.sum())
                                if (not ttm_rep) and rep_a is not None:
                                    past = rep_a[rep_a.index <= date].tail(1)
                                    if len(past) == 1:
                                        ttm_rep = float(past.iloc[0])
                                if not ttm_rep or ttm_rep <= 0:
                                    continue
                                market_cap = price * shares_f
                                if market_cap <= 0:
                                    continue
                                val = round(ttm_rep / market_cap * 100, 2)
                                if val <= 0 or val > 50 or _math.isnan(val) or _math.isinf(val):
                                    continue
                                pt = {"date": date.strftime("%b %Y"), "value": val}
                                series_q.append(pt)
                                yr = pt["date"].split(" ")[-1]
                                if yr not in seen_years:
                                    seen_years.add(yr)
                                    series_a.append(pt)
                            except Exception:
                                continue

                        result_data["quarterly"] = series_q
                        result_data["annual"]    = series_a
                        if not series_q:
                            result_data["use_price"] = True

                elif metric == "dividend":
                    # Dividend yield = trailing 12-month dividends / price * 100
                    try:
                        divs = stock.dividends
                        if divs is None or divs.empty or hist is None or hist.empty:
                            result_data["use_price"] = True
                        else:
                            if hasattr(divs.index, "tz") and divs.index.tz:
                                divs.index = divs.index.tz_localize(None)
                            divs_monthly = divs.resample("ME").sum()

                            price_monthly = hist["Close"].resample("ME").last().dropna()
                            if hasattr(price_monthly.index, "tz") and price_monthly.index.tz:
                                price_monthly.index = price_monthly.index.tz_localize(None)

                            series_q, series_a, seen_years = [], [], set()
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
                                    yr = pt["date"].split(" ")[-1]
                                    if yr not in seen_years:
                                        seen_years.add(yr)
                                        series_a.append(pt)
                                except Exception:
                                    continue

                            result_data["quarterly"] = series_q
                            result_data["annual"]    = series_a
                            if not series_q:
                                result_data["use_price"] = True
                    except Exception:
                        result_data["use_price"] = True

            except Exception:
                result_data["use_price"] = True

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
            except Exception:
                pass

            if not result_data["quarterly"] and not result_data["annual"]:
                result_data["use_price"] = True

        if result_data["use_price"]:
            hist = stock.history(period="max")
            if hist is not None and not hist.empty:
                import math
                close = hist["Close"].resample("ME").last().dropna()
                result_data["price_history"] = [
                    {"date": d.strftime("%b %Y"), "value": round(float(v), 2)}
                    for d, v in zip(close.index, close.values)
                    if v is not None and not math.isnan(float(v))
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
                                        except Exception:
                                            pass
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
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/etf-info/{ticker}")
def etf_info(ticker: str):
    """נתונים ספציפיים ל-ETF"""
    cache_key = f"etf_{ticker.upper()}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        import yfinance as yf
        stock = yf.Ticker(ticker)
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
        except Exception:
            pass

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
        return {"is_etf": False, "error": str(e)}


@app.get("/price-history/{ticker}")
def price_history(ticker: str):
    """היסטוריית מחיר חודשית מ-Tiingo — מורשה לשימוש מסחרי, key מאובטח בשרת"""
    cache_key = f"price_history_{ticker.upper()}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        url = (
            f"https://api.tiingo.com/tiingo/daily/{ticker}/prices"
            f"?startDate=2020-01-01&resampleFreq=monthly&token={TIINGO_TOKEN}"
        )
        resp = httpx.get(url, headers={"Content-Type": "application/json"}, timeout=10)
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
        return {"ticker": ticker.upper(), "prices": [], "error": str(e)}


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
def general_news(lang: str = "en"):
    cache_key = f"news_general_{lang}"
    cached = _cache_get(cache_key)
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
    all_news = _resolve_gnews_articles(all_news)
    articles = _filter_articles(all_news)[:15]

    # תרגום כותרות אם השפה אינה אנגלית
    if lang != "en" and articles:
        titles = [a.get("title", "") for a in articles]
        translated = _translate_batch(titles, lang)
        for i, a in enumerate(articles):
            if translated[i]:
                a["title"] = translated[i]

    result = {"articles": articles}
    _cache_set(cache_key, result, CACHE_TTL["news"])
    return result


@app.get("/news/{ticker}")
def ticker_news(ticker: str, lang: str = "en"):
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

    # תרגום כותרות אם השפה אינה אנגלית
    if lang != "en" and all_articles:
        titles = [a.get("title", "") for a in all_articles]
        translated = _translate_batch(titles, lang)
        for i, a in enumerate(all_articles):
            if translated[i]:
                a["title"] = translated[i]

    all_articles = _resolve_gnews_articles(all_articles)
    return {"ticker": ticker.upper(), "articles": _filter_articles(all_articles)}


@app.get("/translate-article")
async def translate_article_endpoint(url: str, lang: str = "he"):
    """
    Fetches an article URL server-side, extracts text, translates it, and returns
    clean RTL HTML. Used by the mobile app's in-app reader to avoid WebView proxy issues.
    """
    import asyncio as _asyncio
    import json as _json
    from bs4 import BeautifulSoup

    # Cache: same URL + lang for 1 hour
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
                return r.text
            html = await _asyncio.wait_for(
                loop.run_in_executor(None, _cffi_get), timeout=8
            )
        except Exception:
            pass
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
                html = resp.text
        except Exception:
            pass
        return html

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
                head_html = head_resp.text[:4000]
                from bs4 import BeautifulSoup as _BS
                head_soup = _BS(head_html, "html.parser")
                canonical_tag = head_soup.find("link", rel="canonical")
                if canonical_tag:
                    canonical_url = canonical_tag.get("href", "")
                    if canonical_url and canonical_url != url:
                        # httpx only for canonical — keeps worst-case under 28s
                        async with httpx.AsyncClient(timeout=4, follow_redirects=True) as c2:
                            cr = await c2.get(canonical_url, headers={
                                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                                "Accept-Language": "en-US,en;q=0.9",
                            })
                            raw_html = cr.text
        except Exception:
            pass

    if not raw_html:
        return HTMLResponse(content="error", status_code=500)

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
            except Exception:
                pass

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

    except Exception as e:
        return HTMLResponse(content="error", status_code=500)

    # 3. Translate in small batches (<= 3000 chars each)
    def _batch_translate(texts):
        if lang == "en":
            return texts
        results = []
        i = 0
        while i < len(texts):
            chunk, total = [], 0
            while i < len(texts) and total + len(texts[i]) < 3000:
                chunk.append(texts[i])
                total += len(texts[i])
                i += 1
            if not chunk:
                chunk = [texts[i][:3000]]
                i += 1
            try:
                translated = _translate_batch(chunk, lang)
                results.extend(translated)
            except Exception:
                results.extend(chunk)
        return results

    raw_texts = [t for _, t in items]
    translated = _batch_translate(raw_texts)

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


@app.get("/signals/{ticker}")
def ticker_signals(ticker: str, lang: str = "he"):
    """
    'דברים שכדאי לעקוב אחריהם' - סינון כותרות חדשות לפי מילות מפתח.
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

    flagged = result.get("flagged", [])
    if lang != "en" and flagged:
        titles = [item.get("title", "") for item in flagged]
        translated_titles = _translate_batch(titles, lang)
        for i, item in enumerate(flagged):
            if translated_titles[i]:
                item["title"] = translated_titles[i]

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
            overview[name] = {"value": price, "change_pct": change_pct}
        except Exception:
            overview[name] = {"value": None, "change_pct": None}

    try:
        fx_data = get_quote("ILS=X")
        usd_ils = fx_data["info"].get("currentPrice") or fx_data["info"].get("regularMarketPrice")
    except Exception:
        usd_ils = None
    overview["usd_ils"] = usd_ils

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

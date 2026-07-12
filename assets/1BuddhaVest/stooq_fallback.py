"""
Copyright (c) 2026, the creator of this application. All rights reserved.
Part of the BuddhaVest personal stock-research application.
Unauthorized copying, distribution, or use of this code, in whole or in part,
without explicit written permission from the copyright holder is prohibited.
"""

"""
stooq_fallback.py
מקור גיבוי חינמי (בלי מפתח API) לציטוט מחיר - Stooq.

חשוב להבין את המגבלה: Stooq נותן רק מחיר/נפח (OHLCV), לא נתונים פונדמנטליים
(P/E, מאזן, תזרים מזומנים וכו'). זה אומר שהוא יכול לעזור ב:
- מסך הבית / טבלת השוק (להראות מחיר במקום "—")
- חיפוש (לאשר שהסימול קיים ולהציע אותו)
אבל הוא לא יכול לתת ניתוח מלא (ציון BuddhaVest) למניה שאין לה נתונים
פונדמנטליים בשום מקום חינמי - זו מגבלת זמינות מידע, לא מגבלת קוד.

פורמט: https://stooq.com/q/l/?s={symbol}&f=sd2t2ohlcv&h&e=csv
מחזיר CSV עם שורת כותרת + שורת נתונים. אם הסימול לא קיים, השדות חוזרים כ-"N/D".
"""

import csv
import io
import urllib.request
import urllib.error

# סיומות בורסה נפוצות שStooq משתמש בהן - מנסים את הסימול הגולמי, ואז את אלו,
# כדי לתפוס מקרים שבהם הבעיה היחידה היא "סימול נכון, סיומת בורסה חסרה/שגויה"
COMMON_SUFFIXES = ["", ".us", ".uk", ".de", ".fr", ".pl", ".jp", ".hk"]

_TIMEOUT_SECONDS = 4

# Stooq blocks the default "Python-urllib" user agent — send a browser one
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def _http_get(url: str) -> str | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _UA})
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            return resp.read().decode("utf-8", errors="ignore")
    except (urllib.error.URLError, TimeoutError, OSError):
        return None


def _fetch_csv_row(symbol: str) -> dict | None:
    """מביא שורת CSV אחת מ-Stooq לסימול נתון. מחזיר None אם נכשל או "לא נמצא"."""
    url = f"https://stooq.com/q/l/?s={symbol}&f=sd2t2ohlcvn&h&e=csv"
    raw = _http_get(url)
    if raw is None:
        return None

    reader = csv.DictReader(io.StringIO(raw))
    try:
        row = next(reader)
    except StopIteration:
        return None

    # Stooq מחזיר "N/D" (No Data) בשדות כשהסימול לא קיים בכלל
    if row.get("Close") in (None, "", "N/D"):
        return None

    return row


def get_stooq_quote(ticker: str) -> dict | None:
    """
    מנסה למצוא ציטוט עבור הסימול, כולל ניסוי סיומות בורסה נפוצות.
    מחזיר dict בפורמט פשוט {symbol, price, prev_close, volume, name} או None.
    """
    base = ticker.strip().lower()
    if not base:
        return None

    for suffix in COMMON_SUFFIXES:
        candidate = base if suffix == "" or base.endswith(suffix) else base + suffix
        row = _fetch_csv_row(candidate)
        if row:
            try:
                close = float(row["Close"])
            except (ValueError, TypeError):
                continue
            return {
                "symbol": row.get("Symbol", candidate).upper(),
                "price": close,
                "volume": int(float(row["Volume"])) if row.get("Volume") not in (None, "", "N/D") else None,
                "source": "stooq",
            }
    return None


def get_stooq_daily(ticker: str, stooq_symbol: str | None = None) -> dict | None:
    """
    ציטוט + מחיר סגירה קודם מתוך היסטוריה יומית של Stooq.
    מאפשר לחשב אחוז שינוי יומי (מה ש-get_stooq_quote לא נותן).
    מחזיר {price, prev_close, volume} או None.
    """
    from datetime import date, timedelta

    end = date.today()
    start = end - timedelta(days=12)
    base = (stooq_symbol or ticker).strip().lower()
    if not base:
        return None

    candidates = [base] if stooq_symbol else [
        base if suffix == "" or base.endswith(suffix) else base + suffix
        for suffix in ["", ".us"]
    ]
    for candidate in candidates:
        url = (f"https://stooq.com/q/d/l/?s={candidate}"
               f"&d1={start:%Y%m%d}&d2={end:%Y%m%d}&i=d")
        raw = _http_get(url)
        if raw is None:
            continue
        rows = [r for r in csv.DictReader(io.StringIO(raw))
                if r.get("Close") not in (None, "", "N/D")]
        if rows:
            try:
                price = float(rows[-1]["Close"])
                prev = float(rows[-2]["Close"]) if len(rows) >= 2 else None
                vol_raw = rows[-1].get("Volume")
                volume = int(float(vol_raw)) if vol_raw not in (None, "", "N/D") else None
                return {"price": price, "prev_close": prev, "volume": volume}
            except (ValueError, TypeError):
                continue
    return None


if __name__ == "__main__":
    # בדיקה ידנית - דורשת רשת פתוחה ל-stooq.com (לא זמין בסביבת הבדיקה הזו)
    for t in ["AAPL", "totally_fake_ticker_xyz"]:
        print(t, "->", get_stooq_quote(t))

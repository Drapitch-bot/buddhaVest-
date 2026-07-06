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


def _fetch_csv_row(symbol: str) -> dict | None:
    """מביא שורת CSV אחת מ-Stooq לסימול נתון. מחזיר None אם נכשל או "לא נמצא"."""
    url = f"https://stooq.com/q/l/?s={symbol}&f=sd2t2ohlcvn&h&e=csv"
    try:
        with urllib.request.urlopen(url, timeout=_TIMEOUT_SECONDS) as resp:
            raw = resp.read().decode("utf-8", errors="ignore")
    except (urllib.error.URLError, TimeoutError, OSError):
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


if __name__ == "__main__":
    # בדיקה ידנית - דורשת רשת פתוחה ל-stooq.com (לא זמין בסביבת הבדיקה הזו)
    for t in ["AAPL", "totally_fake_ticker_xyz"]:
        print(t, "->", get_stooq_quote(t))

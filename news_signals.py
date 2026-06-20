"""
Copyright (c) 2026, the creator of this application. All rights reserved.
Part of the BuddhaVest personal stock-research application.
Unauthorized copying, distribution, or use of this code, in whole or in part,
without explicit written permission from the copyright holder is prohibited.
"""

"""
news_signals.py
מנתח כתבות חדשות ומסמן כותרות שעשויות להעיד על שינויים שכדאי "לקחת בחשבון" -
שינויי הנהלה, רגולציה/משפטים, מיזוגים ורכישות, פעולות אנליסטים, אירועים גדולים.

חשוב: זה מבוסס על מילות מפתח בכותרות בלבד - לא ניתוח סמנטי אמיתי, ולא ידע
על אנשים/היסטוריה ספציפיים (לדוגמה "מנכ"ל ששימש קודם באלביט" - מידע כזה
לא ניתן לזהות אוטומטית מכותרת חדשות; נדרש מחקר אנושי לזה).

המטרה: לתת "רדאר" ראשוני שמצביע על כתבות שכדאי לקרוא, לא ציון מדויק.
זה נשאר נפרד לחלוטין מהציון הפיננסי (Zero-Noise), בדיוק כמו שדיברנו על
הפרדת "מר שוק" מהעסק עצמו.
"""

# קטגוריות וזיהוי לפי מילות מפתח (אנגלית - כך מגיעות הכתבות מ-yfinance)
CATEGORIES = {
    "leadership": {
        "label": "שינוי הנהלה",
        "icon": "ti-user-star",
        "keywords": ["ceo", "cfo", "coo", "chairman", "executive", "resign", "appoint",
                      "steps down", "names new", "succession", "president"],
    },
    "legal_regulatory": {
        "label": "רגולציה / משפטי",
        "icon": "ti-gavel",
        "keywords": ["lawsuit", "investigation", "sec ", "probe", "fine", "regulator",
                      "antitrust", "fda", "recall", "settlement", "fraud", "subpoena"],
    },
    "mna": {
        "label": "מיזוג / רכישה",
        "icon": "ti-building-bank",
        "keywords": ["acquire", "acquisition", "merger", "buyout", "stake", "takeover", "spin-off", "spinoff"],
    },
    "analyst": {
        "label": "פעולת אנליסטים",
        "icon": "ti-chart-candle",
        "keywords": ["upgrade", "downgrade", "price target", "initiates", "rating", "outperform", "underperform"],
    },
    "major_event": {
        "label": "אירוע מהותי",
        "icon": "ti-alert-circle",
        "keywords": ["layoff", "strike", "guidance", "earnings beat", "earnings miss",
                      "bankruptcy", "partnership", "contract", "delay", "shortage", "breach"],
    },
}

# מילון טון בסיסי - רק לכיוון כללי, לא ניתוח רגשות מדויק
POSITIVE_WORDS = ["beat", "surge", "soar", "record", "growth", "upgrade", "outperform",
                  "wins", "approval", "partnership", "rally", "jumps"]
NEGATIVE_WORDS = ["miss", "plunge", "downgrade", "lawsuit", "investigation", "recall",
                  "decline", "warns", "cuts", "layoff", "bankruptcy", "probe", "fraud", "slump"]


def _detect_categories(title_lower):
    matched = []
    for key, cat in CATEGORIES.items():
        if any(kw in title_lower for kw in cat["keywords"]):
            matched.append(key)
    return matched


def _detect_tone(title_lower):
    pos = any(w in title_lower for w in POSITIVE_WORDS)
    neg = any(w in title_lower for w in NEGATIVE_WORDS)
    if pos and not neg:
        return "positive"
    if neg and not pos:
        return "negative"
    return "neutral"


def analyze_signals(articles: list) -> dict:
    """
    מקבל רשימת כתבות (כמו שמחזיר data_fetcher.get_news) ומחזיר:
    - flagged: כתבות שזוהו עם קטגוריה + טון
    - summary: ספירה לפי טון
    """
    flagged = []

    for article in articles:
        title = article.get("title", "")
        title_lower = title.lower()
        categories = _detect_categories(title_lower)

        if not categories:
            continue

        tone = _detect_tone(title_lower)
        flagged.append({
            **article,
            "categories": [
                {"key": c, "label": CATEGORIES[c]["label"], "icon": CATEGORIES[c]["icon"]}
                for c in categories
            ],
            "tone": tone,
        })

    summary = {
        "positive": sum(1 for f in flagged if f["tone"] == "positive"),
        "negative": sum(1 for f in flagged if f["tone"] == "negative"),
        "neutral": sum(1 for f in flagged if f["tone"] == "neutral"),
        "total_flagged": len(flagged),
        "total_articles": len(articles),
    }

    return {"flagged": flagged, "summary": summary}


if __name__ == "__main__":
    sample_articles = [
        {"title": "ICL Group appoints new CEO with background at Elbit Systems", "publisher": "Reuters", "link": "#", "published": None},
        {"title": "Analyst upgrades stock to Outperform after earnings beat", "publisher": "Bloomberg", "link": "#", "published": None},
        {"title": "Company faces SEC investigation over accounting practices", "publisher": "WSJ", "link": "#", "published": None},
        {"title": "Quarterly results in line with expectations", "publisher": "AP", "link": "#", "published": None},
        {"title": "Firm announces acquisition of smaller rival for $2B", "publisher": "CNBC", "link": "#", "published": None},
    ]

    result = analyze_signals(sample_articles)
    print("Summary:", result["summary"])
    for f in result["flagged"]:
        cats = ", ".join(c["label"] for c in f["categories"])
        print(f" - [{f['tone']}] ({cats}) {f['title']}")

"""
Copyright (c) 2026, the creator of this application. All rights reserved.
Part of the BuddhaVest personal stock-research application.
"""

"""
ticker_search.py
פותר שמות חברה לסימול מנייה.

שלוש שכבות:
1. ALIASES - כינויים ידועים (עברית + אנגלית נפוצה)
2. yfinance.Search - חיפוש חי ב-Yahoo Finance
3. Fuzzy fallback - מנסה וריאציות של השם אם החיפוש הרגיל נכשל
"""

import yfinance as yf

ALIASES = {
    # ── טכנולוגיה ──────────────────────────────────────────────
    "אינטל": "INTC", "intel": "INTC", "intel corp": "INTC",
    "גוגל": "GOOGL", "google": "GOOGL", "alphabet": "GOOGL", "alphabet inc": "GOOGL",
    "אפל": "AAPL", "apple": "AAPL", "apple inc": "AAPL",
    "מיקרוסופט": "MSFT", "microsoft": "MSFT", "microsoft corp": "MSFT",
    "אמזון": "AMZN", "amazon": "AMZN", "amazon.com": "AMZN",
    "מטא": "META", "פייסבוק": "META", "facebook": "META", "meta": "META", "meta platforms": "META",
    "נטפליקס": "NFLX", "netflix": "NFLX", "netflix inc": "NFLX",
    "טסלה": "TSLA", "tesla": "TSLA", "tesla inc": "TSLA", "tesla motors": "TSLA",
    "אנבידיה": "NVDA", "נוידיה": "NVDA", "nvidia": "NVDA", "nvidia corp": "NVDA",
    "אן.אם.די": "AMD", "amd": "AMD", "advanced micro devices": "AMD",
    "פייפאל": "PYPL", "paypal": "PYPL", "paypal holdings": "PYPL",
    "אדובי": "ADBE", "adobe": "ADBE", "adobe inc": "ADBE",
    "סיילספורס": "CRM", "salesforce": "CRM", "salesforce inc": "CRM",
    "אורקל": "ORCL", "oracle": "ORCL", "oracle corp": "ORCL",
    "סיסקו": "CSCO", "cisco": "CSCO", "cisco systems": "CSCO",
    "קואלקום": "QCOM", "qualcomm": "QCOM", "qualcomm inc": "QCOM",
    "אובר": "UBER", "uber": "UBER", "uber technologies": "UBER",
    "איירבנדבי": "ABNB", "airbnb": "ABNB", "airbnb inc": "ABNB",
    "שופיפיי": "SHOP", "shopify": "SHOP", "shopify inc": "SHOP",
    "פלנטיר": "PLTR", "palantir": "PLTR", "palantir technologies": "PLTR",
    "סנאפ": "SNAP", "snap": "SNAP", "snapchat": "SNAP", "snap inc": "SNAP",
    "טוויטר": "X", "twitter": "X", "x corp": "X",
    "ספוטיפיי": "SPOT", "spotify": "SPOT", "spotify technology": "SPOT",
    "זום": "ZM", "zoom": "ZM", "zoom video": "ZM", "zoom communications": "ZM",
    "סלאק": "CRM",
    "דרופבוקס": "DBX", "dropbox": "DBX", "dropbox inc": "DBX",
    "טוויליו": "TWLO", "twilio": "TWLO", "twilio inc": "TWLO",
    "דאטאדוג": "DDOG", "datadog": "DDOG", "datadog inc": "DDOG",
    "קלאודפלייר": "NET", "cloudflare": "NET", "cloudflare inc": "NET",
    "קראודסטרייק": "CRWD", "crowdstrike": "CRWD", "crowdstrike holdings": "CRWD",
    "פורטינט": "FTNT", "fortinet": "FTNT", "fortinet inc": "FTNT",
    "סרביס נאו": "NOW", "servicenow": "NOW", "service now": "NOW",
    "וורקדיי": "WDAY", "workday": "WDAY", "workday inc": "WDAY",
    "אינטואיט": "INTU", "intuit": "INTU", "intuit inc": "INTU",
    "אוטודסק": "ADSK", "autodesk": "ADSK", "autodesk inc": "ADSK",
    "רובלוקס": "RBLX", "roblox": "RBLX", "roblox corp": "RBLX",
    "יוניטי": "U", "unity": "U", "unity software": "U",
    "אפירם": "AFRM", "affirm": "AFRM", "affirm holdings": "AFRM",
    "קוינבייס": "COIN", "coinbase": "COIN", "coinbase global": "COIN",
    "רובינהוד": "HOOD", "robinhood": "HOOD", "robinhood markets": "HOOD",
    "סטרייפ": "STRP",
    "ספייסאקס": "SPCX", "spacex": "SPCX",
    "ARM": "ARM", "arm holdings": "ARM", "arm": "ARM",
    "אסמל": "ASML", "asml": "ASML", "asml holding": "ASML",
    # ── פיננסים ────────────────────────────────────────────────
    "ויזה": "V", "visa": "V", "visa inc": "V",
    "מאסטרקארד": "MA", "mastercard": "MA", "mastercard inc": "MA",
    "גולדמן": "GS", "גולדמן זאקס": "GS", "goldman": "GS",
    "goldman sachs": "GS", "goldman sachs group": "GS", "the goldman sachs group": "GS",
    "ג'יי פי מורגן": "JPM", "jpmorgan": "JPM", "jp morgan": "JPM",
    "jpm": "JPM", "jpmorgan chase": "JPM", "j.p. morgan": "JPM",
    "בנק אוף אמריקה": "BAC", "bank of america": "BAC", "bofa": "BAC",
    "וולס פארגו": "WFC", "wells fargo": "WFC", "wells fargo & company": "WFC",
    "סיטי": "C", "citigroup": "C", "citi": "C", "citibank": "C",
    "מורגן סטנלי": "MS", "morgan stanley": "MS",
    "בלאקרוק": "BLK", "blackrock": "BLK", "blackrock inc": "BLK",
    "ברקשייר": "BRK-B", "berkshire": "BRK-B", "berkshire hathaway": "BRK-B",
    "אמריקן אקספרס": "AXP", "american express": "AXP", "amex": "AXP",
    "שוואב": "SCHW", "charles schwab": "SCHW", "schwab": "SCHW",
    "פידליטי": "FNF",
    # ── בריאות ─────────────────────────────────────────────────
    "פייזר": "PFE", "pfizer": "PFE", "pfizer inc": "PFE",
    "ג'ונסון": "JNJ", "johnson & johnson": "JNJ", "johnson and johnson": "JNJ", "j&j": "JNJ",
    "אלי לילי": "LLY", "eli lilly": "LLY", "lilly": "LLY", "eli lilly and company": "LLY",
    "אבווי": "ABBV", "abbvie": "ABBV", "abbvie inc": "ABBV",
    "מרק": "MRK", "merck": "MRK", "merck & co": "MRK",
    "ברייסטול מאיירס": "BMY", "bristol myers": "BMY", "bristol-myers squibb": "BMY",
    "אמג'ן": "AMGN", "amgen": "AMGN", "amgen inc": "AMGN",
    "גילעד": "GILD", "gilead": "GILD", "gilead sciences": "GILD",
    "מודרנה": "MRNA", "moderna": "MRNA", "moderna inc": "MRNA",
    "ביונטק": "BNTX", "biontech": "BNTX", "biontech se": "BNTX",
    "נובו נורדיסק": "NVO", "novo nordisk": "NVO", "novo": "NVO",
    "יונייטד הלת'": "UNH", "unitedhealth": "UNH", "united health": "UNH", "unitedhealth group": "UNH",
    "CVS": "CVS", "cvs health": "CVS", "cvs": "CVS",
    "אינטואיטיב סרג'יקל": "ISRG", "intuitive surgical": "ISRG",
    "מדטרוניק": "MDT", "medtronic": "MDT", "medtronic plc": "MDT",
    "אבוט": "ABT", "abbott": "ABT", "abbott laboratories": "ABT",
    "תרמו פישר": "TMO", "thermo fisher": "TMO", "thermo fisher scientific": "TMO",
    # ── צריכה / קמעונאות ───────────────────────────────────────
    "וולמארט": "WMT", "walmart": "WMT", "walmart inc": "WMT",
    "קוסטקו": "COST", "costco": "COST", "costco wholesale": "COST",
    "טארגט": "TGT", "target": "TGT", "target corp": "TGT",
    "הום דיפו": "HD", "home depot": "HD", "the home depot": "HD",
    "לואוס": "LOW", "lowes": "LOW", "lowe's": "LOW",
    "דיסני": "DIS", "disney": "DIS", "the walt disney company": "DIS", "walt disney": "DIS",
    "קוקה קולה": "KO", "coca cola": "KO", "coca-cola": "KO", "coke": "KO",
    "פפסי": "PEP", "pepsi": "PEP", "pepsico": "PEP", "pepsi co": "PEP",
    "נייקי": "NKE", "nike": "NKE", "nike inc": "NKE",
    "מקדונלדס": "MCD", "mcdonalds": "MCD", "mcdonald's": "MCD", "mcdonalds corp": "MCD",
    "סטארבקס": "SBUX", "starbucks": "SBUX", "starbucks corp": "SBUX",
    "פרוקטר": "PG", "procter & gamble": "PG", "p&g": "PG", "procter and gamble": "PG",
    "יוניליוור": "UL", "unilever": "UL", "unilever plc": "UL",
    "נסטלה": "NSRGY", "nestle": "NSRGY", "nestlé": "NSRGY",
    "LVMH": "LVMUY", "lvmh": "LVMUY",
    "הרמס": "HESAY", "hermes": "HESAY",
    "פררי": "RACE", "ferrari": "RACE", "ferrari nv": "RACE",
    # ── תעשייה / אנרגיה ────────────────────────────────────────
    "בואינג": "BA", "boeing": "BA", "boeing company": "BA",
    "לוקהיד": "LMT", "lockheed martin": "LMT", "lockheed": "LMT",
    "ריית'יאון": "RTX", "raytheon": "RTX", "rtx": "RTX", "raytheon technologies": "RTX",
    "ג'נרל אלקטריק": "GE", "general electric": "GE", "ge": "GE",
    "קטרפילר": "CAT", "caterpillar": "CAT", "caterpillar inc": "CAT",
    "פורד": "F", "ford": "F", "ford motor": "F", "ford motor company": "F",
    "ג'נרל מוטורס": "GM", "general motors": "GM", "gm": "GM",
    "טויוטה": "TM", "toyota": "TM", "toyota motor": "TM",
    "פולקסווגן": "VWAGY", "volkswagen": "VWAGY", "vw": "VWAGY",
    "BMW": "BMWYY", "bmw": "BMWYY",
    "מרצדס": "MBGYY", "mercedes": "MBGYY", "mercedes-benz": "MBGYY",
    "ריביאן": "RIVN", "rivian": "RIVN", "rivian automotive": "RIVN",
    "לוסיד": "LCID", "lucid": "LCID", "lucid motors": "LCID", "lucid group": "LCID",
    "אקסון מוביל": "XOM", "exxon": "XOM", "exxon mobil": "XOM", "exxonmobil": "XOM",
    "שברון": "CVX", "chevron": "CVX", "chevron corp": "CVX",
    "של": "SHEL", "shell": "SHEL", "shell plc": "SHEL",
    "bp": "BP", "BP": "BP", "british petroleum": "BP",
    "ניקולה": "NKLA", "nikola": "NKLA", "nikola corp": "NKLA",
    # ── דלוורי / מזון ──────────────────────────────────────────
    "דלוורי הירו": "DHER.DE", "delivery hero": "DHER.DE", "delivery hero se": "DHER.DE",
    "דורדאש": "DASH", "doordash": "DASH", "doordash inc": "DASH",
    "אינסטקארט": "CART", "instacart": "CART", "maplebear": "CART",
    "גרובהאב": "GRUB",
    # ── נדל\"ן / תשתיות ─────────────────────────────────────────
    "אמריקן טאואר": "AMT", "american tower": "AMT", "american tower corp": "AMT",
    "פרולוג'יס": "PLD", "prologis": "PLD", "prologis inc": "PLD",
    "אקווינקס": "EQIX", "equinix": "EQIX", "equinix inc": "EQIX",
    # ── ETF מרכזיים ────────────────────────────────────────────
    "SPY": "SPY", "spy": "SPY", "s&p 500 etf": "SPY",
    "QQQ": "QQQ", "qqq": "QQQ", "nasdaq etf": "QQQ",
    "VTI": "VTI", "vti": "VTI",
    "VOO": "VOO", "voo": "VOO",
    "ARKK": "ARKK", "arkk": "ARKK", "ark innovation": "ARKK",
    # ── ישראליות ───────────────────────────────────────────────
    "טבע": "TEVA", "teva": "TEVA", "teva pharmaceutical": "TEVA",
    "צ'ק פוינט": "CHKP", "check point": "CHKP", "checkpoint": "CHKP", "check point software": "CHKP",
    "וויקס": "WIX", "wix": "WIX", "wix.com": "WIX",
    "מוביל איי": "MBLY", "mobileye": "MBLY", "mobileye global": "MBLY",
    "נובה": "NVMI", "nova": "NVMI", "nova ltd": "NVMI",
    "איי סי אל": "ICL", "icl": "ICL", "icl group": "ICL",
    "אל על": "ELAL.TA", "el al": "ELAL.TA",
    "פועלים": "POLI.TA", "בנק הפועלים": "POLI.TA",
    "לאומי": "LUMI.TA", "בנק לאומי": "LUMI.TA",
    "אינפיניה": "INFR.TA", "סלקום": "SCOM.TA", "פרטנר": "PTNR.TA",
    "נייס": "NICE", "nice": "NICE", "nice systems": "NICE", "nice ltd": "NICE",
    "אוורסייס": "OBDC",
    "גיוון": "GIVN", "given imaging": "GIVN",
    "אורבוטק": "ORBK",
}


def resolve_alias(query: str) -> str | None:
    """בודק כינוי ידוע. לא רגיש לרישיות/רווחים."""
    return ALIASES.get(query.strip().lower())


def search_tickers(query: str, max_results: int = 6) -> list:
    """
    מחזיר רשימת תוצאות: [{ticker, name, exchange}, ...]
    שכבה 1: כינוי מדויק
    שכבה 2: yfinance.Search חי
    שכבה 3: וריאציות של השם (הסרת מילים כמו "inc", "corp", ניסיון קיצורים)
    """
    query = query.strip()
    if not query:
        return []

    # שכבה 1 – כינוי מדויק
    alias_ticker = resolve_alias(query)
    if alias_ticker:
        try:
            info = yf.Ticker(alias_ticker).info
            return [{
                "ticker": alias_ticker,
                "name": info.get("longName") or info.get("shortName") or alias_ticker,
                "exchange": info.get("exchange", ""),
            }]
        except Exception:
            return [{"ticker": alias_ticker, "name": alias_ticker, "exchange": ""}]

    # שכבה 2 – חיפוש חי ב-Yahoo Finance
    results = _yahoo_search(query, max_results)
    if results:
        return results

    # שכבה 3 – ניסיון וריאציות אם החיפוש הרגיל לא החזיר כלום
    variants = _build_variants(query)
    for variant in variants:
        results = _yahoo_search(variant, max_results)
        if results:
            return results

    return []


def _yahoo_search(query: str, max_results: int) -> list:
    """חיפוש חי ב-Yahoo Finance."""
    try:
        search = yf.Search(query, max_results=max_results)
        quotes = search.quotes or []
        results = []
        for q in quotes:
            symbol = q.get("symbol")
            if not symbol:
                continue
            results.append({
                "ticker": symbol,
                "name": q.get("longname") or q.get("shortname") or symbol,
                "exchange": q.get("exchange", ""),
            })
        return results
    except Exception:
        return []


def _build_variants(query: str) -> list[str]:
    """
    בונה וריאציות מהשאילתה המקורית לניסיון נוסף:
    - מסיר מילות סיומת נפוצות (Inc, Corp, Ltd, SE, PLC, Group, Holdings, AG, SA)
    - מנסה את המילה הראשונה בלבד
    - מנסה ראשי תיבות אם יש מספר מילים
    """
    q = query.lower().strip()
    stop_words = {"inc", "inc.", "corp", "corp.", "ltd", "ltd.", "se", "plc",
                  "group", "holdings", "holding", "ag", "sa", "nv", "co",
                  "company", "the", "&", "and", "technologies", "technology",
                  "systems", "solutions", "international", "global"}
    words = q.split()
    # הסרת מילות סיומת
    filtered = [w for w in words if w not in stop_words]
    variants = []
    if filtered and filtered != words:
        variants.append(" ".join(filtered))
    # מילה ראשונה בלבד
    if words:
        variants.append(words[0])
    # ראשי תיבות (אם 2+ מילים)
    if len(filtered) >= 2:
        acronym = "".join(w[0].upper() for w in filtered if w)
        if len(acronym) >= 2:
            variants.append(acronym)
    return variants


if __name__ == "__main__":
    tests = ["אינטל", "Intel", "google", "טבע", "Goldman Sachs",
             "Eli Lilly", "Delivery Hero", "novo nordisk", "abcxyz_not_real"]
    for q in tests:
        print(f"{q} -> {search_tickers(q)}")

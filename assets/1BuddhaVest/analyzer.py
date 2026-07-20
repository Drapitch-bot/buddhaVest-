"""
Copyright (c) 2026, the creator of this application. All rights reserved.
Part of the BuddhaVest personal stock-research application.
Unauthorized copying, distribution, or use of this code, in whole or in part,
without explicit written permission from the copyright holder is prohibited.
"""

"""
analyzer.py
מנוע הניתוח של BuddhaVest.
מקבל את הנתונים הגולמיים (מ-data_fetcher או mock_data) ומחזיר:
- מדדים בודדים (P/E, יחס שוטף, שולי רווח, דיבידנד וכו') עם הסבר
- ציון משוקלל ל-3 קטגוריות: Quality, Valuation, Income (דיבידנד/תזרים)
- ציון סופי כולל + המלצה (Buy/Wait/Avoid)

כל פונקציה מחזירה None כשהמידע חסר, ואז הציון המשוקלל מתאים את עצמו
(לא "מעניש" על מידע שלא קיים, אלא מתעלם ממנו ומחלק את המשקל מחדש).
"""

import math
import pandas as pd


# -----------------------------------------------------------
# Helpers
# -----------------------------------------------------------

def _safe_get(df, row_name, col_index=0):
    """שולף ערך מ-DataFrame פיננסי בצורה בטוחה. מחזיר None אם לא קיים."""
    try:
        if df is None or df.empty:
            return None
        if row_name not in df.index:
            return None
        value = df.loc[row_name].iloc[col_index]
        if value is None or (isinstance(value, float) and math.isnan(value)):
            return None
        return value
    except Exception:
        return None


def _safe_info(info, key):
    """
    שולף ערך מ-info בצורה בטוחה. yfinance מחזיר לפעמים NaN (float) במקום None
    עבור שדות מספריים חסרים - מתייחסים לזה כ-None.
    """
    value = info.get(key)
    if isinstance(value, float) and math.isnan(value):
        return None
    return value


def _safe_series(df, row_name):
    """שולף שורה שלמה (כל השנים) מ-DataFrame. מחזיר None אם לא קיים."""
    try:
        if df is None or df.empty or row_name not in df.index:
            return None
        series = df.loc[row_name].dropna()
        if series.empty:
            return None
        return series
    except Exception:
        return None


# -----------------------------------------------------------
# מדדים בודדים - כל אחד מחזיר dict: {value, label, explanation, score_0_100 or None}
# -----------------------------------------------------------

def metric_current_ratio(balance):
    curr_assets = _safe_get(balance, "Current Assets")
    curr_liab = _safe_get(balance, "Current Liabilities")
    if curr_assets is None or curr_liab is None or curr_liab == 0:
        return {"value": None, "label": "Current Ratio", "explanation": "אין מספיק נתוני מאזן.",
                "explanation_parts": [("balance_no_data", {})], "score": None}

    ratio = curr_assets / curr_liab
    if ratio >= 1.5:
        score, note, key = 100, "נזילות חזקה - יש מרווח נוח לכיסוי התחייבויות קצרות טווח.", "cr_strong"
    elif ratio >= 1.0:
        score, note, key = 70, "בריא - הנכסים השוטפים מכסים את ההתחייבויות השוטפות.", "cr_healthy"
    elif ratio >= 0.8:
        score, note, key = 40, "קצת צמוד, אבל נפוץ בעסקים שלא דורשים הרבה נכסים.", "cr_tight_ok"
    else:
        score, note, key = 15, "נזילות צמודה - שווה לעקוב.", "cr_tight"

    return {"value": round(ratio, 2), "label": "Current Ratio", "explanation": note,
            "explanation_parts": [(key, {})], "score": score}


def metric_debt_to_equity(info):
    d2e = _safe_info(info, "debtToEquity")
    if d2e is None:
        return {"value": None, "label": "Debt / Equity", "explanation": "לא דווח.",
                "explanation_parts": [("d2e_not_reported", {})], "score": None}

    ratio = d2e / 100  # yfinance מחזיר באחוזים

    # יחס שלילי כאן פירושו הון עצמי שלילי (התחייבויות גבוהות מנכסים) - זה לא
    # "מינוף נמוך", זה דגל אדום חשוב. בלי הבדיקה הזו, "-0.3 <= 0.5" היה מסווג
    # את המקרה הזה (מהחמורים ביותר במאזן) כ"מאזן שמרני" עם ציון 100 - הפוך
    # לחלוטין מהמשמעות האמיתית.
    if ratio < 0:
        return {"value": round(ratio, 2), "label": "Debt / Equity",
                "explanation": "הון עצמי שלילי - ההתחייבויות גבוהות מהנכסים. דגל אדום משמעותי במאזן.",
                "explanation_parts": [("d2e_negative_equity", {})], "score": 10}

    if ratio <= 0.5:
        score, note, key = 100, "מינוף נמוך - מאזן שמרני.", "d2e_low"
    elif ratio <= 1.5:
        score, note, key = 70, "מינוף סביר - נורמלי לחברות גדולות רבות.", "d2e_moderate"
    elif ratio <= 2.5:
        score, note, key = 40, "מינוף גבוה - נטל החוב משמעותי.", "d2e_high"
    else:
        score, note, key = 15, "מינוף גבוה מאוד - החוב כבד יחסית להון העצמי.", "d2e_very_high"

    return {"value": round(ratio, 2), "label": "Debt / Equity", "explanation": note,
            "explanation_parts": [(key, {})], "score": score}


def metric_operating_margin(info, income):
    margin = _safe_info(info, "operatingMargins")
    if margin is None:
        op_income = _safe_get(income, "Operating Income")
        revenue = _safe_get(income, "Total Revenue")
        if op_income is not None and revenue:
            margin = op_income / revenue
        else:
            return {"value": None, "label": "Operating Margin", "explanation": "אין מספיק נתונים.",
                    "explanation_parts": [("metric_no_data", {})], "score": None}

    pct = margin * 100
    if pct >= 20:
        score, note, key = 100, "יעילות תפעולית מצוינת וכוח תמחור גבוה.", "opm_excellent"
    elif pct >= 10:
        score, note, key = 70, "שולי תפעול סבירים, מעל סף ה-10%.", "opm_solid"
    elif pct >= 0:
        score, note, key = 40, "שולי רווח דחוקים - העסק פועל קרוב לאיזון תפעולי.", "opm_thin"
    else:
        score, note, key = 10, "הפסדים תפעוליים - העסק הליבה שורף מזומן.", "opm_loss"

    return {"value": round(pct, 1), "label": "Operating Margin", "explanation": note,
            "explanation_parts": [(key, {})], "score": score}


def metric_gross_margin(info, income):
    margin = _safe_info(info, "grossMargins")
    if margin is None:
        gross_profit = _safe_get(income, "Gross Profit")
        revenue = _safe_get(income, "Total Revenue")
        if gross_profit is not None and revenue:
            margin = gross_profit / revenue
        else:
            return {"value": None, "label": "Gross Margin", "explanation": "אין מספיק נתונים.",
                    "explanation_parts": [("metric_no_data", {})], "score": None}

    pct = margin * 100
    if pct >= 40:
        score, note, key = 100, "שולי רווח גולמי גבוהים - סימן ליתרון תחרותי וכוח תמחור.", "gm_high"
    elif pct >= 20:
        score, note, key = 70, "שולי רווח גולמי סבירים.", "gm_ok"
    elif pct >= 0:
        score, note, key = 40, "שולי רווח גולמי נמוכים - מתאים לעסקים מבוססי נפח.", "gm_low"
    else:
        score, note, key = 10, "שולי רווח גולמי שליליים - עלות המכר גבוהה מההכנסות.", "gm_negative"

    return {"value": round(pct, 1), "label": "Gross Margin", "explanation": note,
            "explanation_parts": [(key, {})], "score": score}


def metric_net_margin(info, income):
    margin = _safe_info(info, "profitMargins")
    if margin is None:
        net_income = _safe_get(income, "Net Income")
        revenue = _safe_get(income, "Total Revenue")
        if net_income is not None and revenue:
            margin = net_income / revenue
        else:
            return {"value": None, "label": "Net Margin", "explanation": "אין מספיק נתונים.",
                    "explanation_parts": [("metric_no_data", {})], "score": None}

    pct = margin * 100
    if pct >= 15:
        score, note, key = 100, "שולי רווח נקי גבוהים - העסק שומר חלק גדול מההכנסות כרווח.", "nm_high"
    elif pct >= 5:
        score, note, key = 70, "שולי רווח נקי סבירים.", "nm_ok"
    elif pct >= 0:
        score, note, key = 40, "שולי רווח נקי דחוקים.", "nm_thin"
    else:
        score, note, key = 10, "שולי רווח נקי שליליים - העסק מפסיד כסף בשורה התחתונה.", "nm_negative"

    return {"value": round(pct, 1), "label": "Net Margin", "explanation": note,
            "explanation_parts": [(key, {})], "score": score}


def metric_cost_of_revenue(income):
    """עלות המכר - מדד אינפורמטיבי (לא נכלל בציון) שמראה את היקף עלות המוצרים/שירותים שנמכרו."""
    cost = _safe_get(income, "Cost Of Revenue")
    revenue = _safe_get(income, "Total Revenue")
    if cost is None:
        return {"value": None, "label": "Cost of Revenue", "explanation": "אין מספיק נתונים.",
                "explanation_parts": [("metric_no_data", {})], "score": None}

    note = "עלות המכר - הסכום שהחברה משקיעה בייצור/רכישת המוצרים שמכרה."
    parts = [("cor_base", {})]
    if revenue:
        pct_of_revenue = cost / revenue * 100
        note += f" מהווה כ-{round(pct_of_revenue)}% מההכנסות."
        parts.append(("cor_pct", {"pct": round(pct_of_revenue)}))

    return {"value": round(float(cost), 0), "label": "Cost of Revenue", "explanation": note,
            "explanation_parts": parts, "score": None}


def metric_operating_cash_flow(cashflow):
    """תזרים מזומנים מפעולות שוטפות - מדד אינפורמטיבי."""
    ocf = _safe_get(cashflow, "Operating Cash Flow")
    if ocf is None:
        return {"value": None, "label": "Operating Cash Flow", "explanation": "אין מספיק נתונים.",
                "explanation_parts": [("metric_no_data", {})], "score": None}

    if ocf > 0:
        note, key = "תזרים חיובי מהפעילות השוטפת - העסק עצמו (בלי השקעות) מייצר מזומן.", "ocf_positive"
    else:
        note, key = "תזרים שלילי מהפעילות השוטפת - העסק עצמו צורך מזומן.", "ocf_negative"

    return {"value": round(float(ocf), 0), "label": "Operating Cash Flow", "explanation": note,
            "explanation_parts": [(key, {})], "score": None}


def metric_cash_position(info, balance):
    """קופת מזומנים - מדד אינפורמטיבי שמראה כמה "כריות ביטחון" יש לחברה."""
    cash = _safe_info(info, "totalCash")
    if cash is None:
        cash = _safe_get(balance, "Cash And Cash Equivalents")
    if cash is None:
        return {"value": None, "label": "Cash Position", "explanation": "אין מספיק נתונים.",
                "explanation_parts": [("metric_no_data", {})], "score": None}

    total_liab = _safe_get(balance, "Total Liabilities Net Minority Interest")
    note = "סך המזומנים והשווי מזומן שבידי החברה - \"כריות הביטחון\" שלה למצבי חירום או הזדמנויות."
    parts = [("cash_pos_base", {})]
    if total_liab:
        ratio = cash / total_liab
        if ratio >= 0.5:
            note += " זה מכסה חלק נכבד מההתחייבויות הכוללות - מצב נוח."
            parts.append(("cash_pos_covers", {}))
        elif ratio < 0.1:
            note += " זה נמוך יחסית להתחייבויות הכוללות."
            parts.append(("cash_pos_low", {}))

    return {"value": round(float(cash), 0), "label": "Cash Position", "explanation": note,
            "explanation_parts": parts, "score": None}


def metric_liabilities_to_equity(balance):
    """
    יחס התחייבויות כולל להון עצמי - שונה מ-Debt/Equity (שמתייחס רק לחוב הנושא ריבית).
    כלל אצבע פופולרי: יחס מתחת ל-1 נחשב שמרני.
    """
    total_liab = _safe_get(balance, "Total Liabilities Net Minority Interest")
    equity = _safe_get(balance, "Stockholders Equity")
    if total_liab is None or equity is None or equity == 0:
        return {"value": None, "label": "Liabilities / Equity", "explanation": "אין מספיק נתוני מאזן.",
                "explanation_parts": [("balance_no_data", {})], "score": None}

    ratio = total_liab / equity
    # אותה בעיה כמו ב-Debt/Equity: הון עצמי שלילי הופך את היחס לשלילי, וזה
    # ביותר מ"ratio < 1" - אבל המשמעות האמיתית היא הון עצמי שלילי (מצב חמור),
    # לא "מאזן שמרני". צריך לתפוס את זה לפני שאר התנאים.
    if equity < 0:
        return {"value": round(ratio, 2), "label": "Liabilities / Equity",
                "explanation": "הון עצמי שלילי - ההתחייבויות גבוהות מהנכסים. דגל אדום משמעותי במאזן.",
                "explanation_parts": [("l2e_negative_equity", {})], "score": 10}

    if ratio < 1:
        score, note, key = 100, "ההתחייבויות הכוללות נמוכות מההון העצמי - מאזן שמרני (יחס מתחת ל-1).", "l2e_conservative"
    elif ratio < 2:
        score, note, key = 60, "ההתחייבויות הכוללות גבוהות מההון העצמי אך בטווח סביר.", "l2e_elevated"
    else:
        score, note, key = 25, "ההתחייבויות הכוללות גבוהות משמעותית מההון העצמי - מאזן ממונף.", "l2e_high"

    return {"value": round(ratio, 2), "label": "Liabilities / Equity", "explanation": note,
            "explanation_parts": [(key, {})], "score": score}


def metric_net_income_trend(income):
    series = _safe_series(income, "Net Income")
    if series is None or len(series) < 2:
        return {"value": None, "label": "Net Income (latest)", "explanation": "אין מספיק היסטוריה.",
                "explanation_parts": [("nit_no_history", {})], "score": None}

    latest, previous = series.iloc[0], series.iloc[1]
    if latest > 0 and latest > previous:
        score, note, key = 100, "הרווחים חיוביים וצומחים משנה לשנה.", "nit_growing"
    elif latest > 0:
        score, note, key = 65, "רווחי, אבל הרווח ירד בהשוואה לשנה שעברה.", "nit_profit_declining"
    elif latest > previous:
        score, note, key = 35, "עדיין לא רווחי, אבל ההפסדים מצטמצמים.", "nit_losses_shrinking"
    else:
        score, note, key = 10, "לא רווחי וההפסדים מתרחבים.", "nit_losses_growing"

    return {"value": round(float(latest), 0), "label": "Net Income (latest)", "explanation": note,
            "explanation_parts": [(key, {})], "score": score}


def metric_pe_ratio(info):
    pe = _safe_info(info, "trailingPE")
    # P/E שלילי (yfinance מחזיר ערך שלילי ולא None כשהרווח התפעולי שלילי) פירושו
    # שהחברה לא רווחית - בדיוק כמו מקרה ה-None. בלי הבדיקה הזו, "-15.2 <= 15" היה
    # מסווג חברה לא רווחית כ"זולה" עם ציון 90 - הפוך לחלוטין מהמשמעות האמיתית.
    if pe is None or pe <= 0:
        return {"value": None, "label": "P/E Ratio", "explanation": "אין מכפיל רווח - החברה עדיין לא רווחית.",
                "explanation_parts": [("pe_not_profitable", {})], "score": None}

    if pe <= 15:
        score, note, key = 90, "זול יחסית לרווחים.", "pe_cheap"
    elif pe <= 25:
        score, note, key = 70, "תמחור סביר.", "pe_reasonable"
    elif pe <= 35:
        score, note, key = 45, "בצד היקר - השוק מצפה לצמיחה חזקה.", "pe_expensive_growth"
    else:
        score, note, key = 20, "יקר - הרבה צמיחה עתידית כבר מתומחרת במחיר.", "pe_expensive"

    return {"value": round(pe, 1), "label": "P/E Ratio", "explanation": note,
            "explanation_parts": [(key, {})], "score": score}


def metric_peg_ratio(info):
    pe = _safe_info(info, "trailingPE")
    growth = _safe_info(info, "earningsGrowth")
    # אותה בעיה כמו ב-P/E: pe שלילי חייב להיפסל כאן גם, אחרת peg שלילי (pe שלילי
    # חלקי growth חיובי) היה מסתכל כמו "peg <= 1" ומקבל ציון 90 ("תמחור הוגן"),
    # כשבפועל זו חברה לא רווחית שאין לה PEG משמעותי כלל.
    if pe is None or pe <= 0 or growth is None or growth <= 0:
        return {"value": None, "label": "PEG Ratio", "explanation": "אין מספיק נתוני צמיחה לחישוב.",
                "explanation_parts": [("peg_no_growth_data", {})], "score": None}

    peg = pe / (growth * 100)
    if peg <= 1:
        score, note, key = 90, "הצמיחה מצדיקה את המחיר - סימן קלאסי לתמחור הוגן.", "peg_fair"
    elif peg <= 2:
        score, note, key = 55, "המחיר רץ קצת לפני הצמיחה.", "peg_ahead"
    else:
        score, note, key = 25, "המחיר רץ הרבה לפני הצמיחה - יקר יחסית למה שמקבלים.", "peg_well_ahead"

    return {"value": round(peg, 2), "label": "PEG Ratio", "explanation": note,
            "explanation_parts": [(key, {})], "score": score}


def metric_free_cash_flow(cashflow):
    # נסה לשלוף Free Cash Flow ישירות — yfinance מחשב אותו ולרוב כולל שורה ישירה,
    # מדויקת יותר מחישוב ידני (OCF - Capex) שתלוי בזיהוי נכון של שם שורת ה-capex.
    fcf = _safe_get(cashflow, "Free Cash Flow")
    if fcf is None:
        # fallback: חשב ידנית OCF פחות הוצאות הון
        ocf = _safe_get(cashflow, "Operating Cash Flow")
        if ocf is None:
            return {"value": None, "label": "Free Cash Flow", "explanation": "אין מספיק נתונים.",
                    "explanation_parts": [("metric_no_data", {})], "score": None}
        # yfinance משתמש בשמות שונים להוצאות הון — ננסה כמה אפשרויות
        capex = None
        for cap_name in [
            "Capital Expenditure",
            "Capital Expenditures",
            "Purchase Of Property Plant And Equipment",
            "Capital Expenditure Reported",
        ]:
            capex = _safe_get(cashflow, cap_name)
            if capex is not None:
                break
        capex = capex or 0
        fcf = ocf + capex  # capex כבר שלילי ב-yfinance

    if fcf > 0:
        score, note, key = 90, "תזרים מזומנים חופשי חיובי - העסק מייצר מזומן פנוי אמיתי.", "fcf_positive"
    else:
        score, note, key = 20, "תזרים מזומנים חופשי שלילי - העסק שורף מזומן.", "fcf_negative"

    return {"value": round(float(fcf), 0), "label": "Free Cash Flow", "explanation": note,
            "explanation_parts": [(key, {})], "score": score}


def metric_cash_runway(info, cashflow):
    """לחברות ששורפות מזומן - כמה זמן (בחודשים) נשאר להן לפי קצב השריפה"""
    ocf = _safe_get(cashflow, "Operating Cash Flow")
    cash = _safe_info(info, "totalCash")

    if ocf is None or cash is None or ocf >= 0:
        return {"value": None, "label": "Cash Runway", "explanation": "לא רלוונטי - החברה לא שורפת מזומן.",
                "explanation_parts": [("runway_not_applicable", {})], "score": None}

    monthly_burn = abs(ocf) / 12
    if monthly_burn == 0:
        return {"value": None, "label": "Cash Runway", "explanation": "אין מספיק נתונים.",
                "explanation_parts": [("metric_no_data", {})], "score": None}

    months = cash / monthly_burn

    if months >= 36:
        years = round(months / 12, 1)
        score, note = 70, f"כ-{years} שנות \"מסלול\" בקצב השריפה הנוכחי - מצב נוח."
        parts = [("runway_years", {"years": years})]
    elif months >= 18:
        m = round(months)
        score, note = 45, f"כ-{m} חודשי \"מסלול\" - בר ניהול אך שווה לעקוב."
        parts = [("runway_months_manageable", {"months": m})]
    else:
        m = round(months)
        score, note = 15, f"כ-{m} חודשי \"מסלול\" - ייתכן שיהיה צורך בגיוס הון נוסף בקרוב."
        parts = [("runway_months_risky", {"months": m})]

    return {"value": round(months, 0), "label": "Cash Runway (months)", "explanation": note,
            "explanation_parts": parts, "score": score}


def metric_dividend(info, dividends):
    """
    מחזיר את כל המידע על דיבידנד - האם קיים, תשואה, יציבות.
    זה הוקדם במיוחד עבור התקציר המהיר (ההמלצה).

    חשוב: אי אפשר להסתמך רק על info["dividendYield"] - יש לשדה הזה בעיית
    איכות נתונים ידועה ב-yfinance עבור חברות מסוימות (קורה במיוחד בחברות
    זרות/דואליות-listed) - הוא יכול לחזור ריק/None אפילו כשהחברה משלמת
    דיבידנד בעקביות. ה-historical dividends series (שמגיע מ-endpoint אחר
    ביאהו, ונשלף ישירות מהיסטוריית התשלומים בפועל) הוא מקור אמין יותר.
    לכן: בודקים את שני המקורות - אם יש תשלום דיבידנד אמיתי ועדכני בהיסטוריה
    (פחות מ-400 יום, כדי לאפשר גם איחור קל בתשלום רבעוני), מתייחסים לחברה
    כמשלמת דיבידנד גם אם info["dividendYield"] חסר.
    """
    yield_ = _safe_info(info, "dividendYield")
    info_says_pays = bool(yield_ and yield_ > 0)

    recent_dividend_paid = False
    if dividends is not None and not dividends.empty:
        try:
            last_payment_date = dividends.index[-1]
            now = pd.Timestamp.now(tz=last_payment_date.tz) if last_payment_date.tzinfo else pd.Timestamp.now()
            recent_dividend_paid = (now - last_payment_date).days <= 400
        except Exception:
            recent_dividend_paid = False

    pays_dividend = info_says_pays or recent_dividend_paid

    if not pays_dividend:
        return {
            "pays_dividend": False,
            "value": None,
            "label": "Dividend Yield",
            "explanation": "החברה לא מחלקת דיבידנד - כל הרווחים מושקעים מחדש או נשארים כמזומן.",
            "explanation_parts": [("div_metric_none", {})],
            "score": None,  # נייטרלי - לא נכלל בציון הכולל
        }

    # yfinance שינה פורמט בין גרסאות: בגרסאות ישנות dividendYield הוא עשרון (0.0045 = 0.45%),
    # בגרסאות חדשות הוא כבר אחוז (0.45 = 0.45%).
    # היוריסטיקה: תשואת דיבידנד ריאלית לרוב בין 0% ל-15%. אם הערך קטן מ-0.15,
    # זה כנראה עשרון וצריך להכפיל ב-100. אחרת זה כבר אחוז.
    if info_says_pays:
        yield_pct = yield_ * 100 if yield_ < 0.15 else yield_
    else:
        # info["dividendYield"] חסר/לא אמין, אבל יש תשלומים אמיתיים בהיסטוריה -
        # מחשבים תשואה מקורבת: סכום 4 התשלומים האחרונים חלקי המחיר הנוכחי.
        current_price = _safe_info(info, "currentPrice") or _safe_info(info, "regularMarketPrice")
        if current_price and current_price > 0:
            annual_div_estimate = float(dividends.tail(4).sum())
            yield_pct = annual_div_estimate / current_price * 100
        else:
            yield_pct = None

    years_paying = None
    if dividends is not None and not dividends.empty:
        years_paying = round((dividends.index[-1] - dividends.index[0]).days / 365, 1)

    # אם בכל זאת לא הצלחנו לחשב תשואה מספרית (מקרה קצה נדיר - אין גם info
    # וגם אין מחיר נוכחי לחישוב מקורב) - עדיין מודיעים שיש דיבידנד, בלי מספר.
    if yield_pct is None:
        return {
            "pays_dividend": True,
            "value": None,
            "label": "Dividend Yield",
            "explanation": "החברה משלמת דיבידנד (לפי היסטוריית תשלומים), אך לא ניתן לחשב תשואה מדויקת כרגע.",
            "explanation_parts": [("div_yield_unknown", {})],
            "score": 60,
        }

    consistency_note = ""
    rounded_yield = round(yield_pct, 2)
    parts = [("div_yield", {"pct": rounded_yield})]
    score = 60  # בסיס - "כן יש דיבידנד" כבר נחשב חיובי ליציבות
    if years_paying is not None:
        if years_paying >= 5:
            score = 85
            consistency_note = f" משולם בעקביות כ-{years_paying} שנים - סימן לתזרים מזומנים יציב."
            parts.append(("div_consistent", {"years": years_paying}))
        else:
            score = 60
            consistency_note = f" ההיסטוריה קצרה (כ-{years_paying} שנים) - מסלול ההוכחה עדיין נבנה."
            parts.append(("div_building", {"years": years_paying}))

    return {
        "pays_dividend": True,
        "value": rounded_yield,
        "label": "Dividend Yield",
        "explanation": f"תשואה של {rounded_yield}%.{consistency_note}",
        "explanation_parts": parts,
        "score": score,
    }


def metric_buyback(info, cashflow):
    """
    בודק אם החברה רוכשת בחזרה מניות (Buyback) - דרך נוספת (לצד דיבידנד) שבה
    חברה "מחזירה" כסף לבעלי המניות. רכישה חזרה מקטינה את מספר המניות במחזור,
    כך שכל מניה קיימת מייצגת חלק גדול יותר מהחברה.
    """
    repurchase = _safe_get(cashflow, "Repurchase Of Capital Stock")

    # ב-yfinance, רכישה חזרה מוצגת כתזרים שלילי (כסף שיוצא מהחברה)
    if repurchase is None or repurchase >= 0:
        return {
            "does_buyback": False,
            "value": None,
            "label": "Buyback Yield",
            "explanation": "החברה לא רכשה בחזרה מניות בשנה האחרונה.",
            "explanation_parts": [("bb_metric_none", {})],
            "score": None,  # נייטרלי - לא נכלל בציון הכולל
        }

    amount = abs(repurchase)
    market_cap = _safe_info(info, "marketCap")

    yield_pct = None
    score = 55
    note = "החברה רכשה בחזרה מניות - מקטין את מספר המניות במחזור ומגדיל את הבעלות היחסית של כל משקיע קיים."
    parts = [("bb_reduces_shares", {})]

    if market_cap:
        yield_pct = amount / market_cap * 100
        rounded_pct = round(yield_pct, 1)
        if yield_pct >= 3:
            score = 85
            note += f" כ-{rounded_pct}% משווי השוק - תוכנית רכישה משמעותית."
            parts.append(("bb_significant", {"pct": rounded_pct}))
        elif yield_pct >= 1:
            score = 65
            note += f" כ-{rounded_pct}% משווי השוק."
            parts.append(("bb_moderate_pct", {"pct": rounded_pct}))
        else:
            score = 50
            note += f" כ-{rounded_pct}% משווי השוק - היקף מתון."
            parts.append(("bb_modest", {"pct": rounded_pct}))

    display_value = round(yield_pct, 2) if yield_pct is not None else round(amount, 0)

    return {
        "does_buyback": True,
        "value": display_value,
        "label": "Buyback Yield",
        "explanation": note,
        "explanation_parts": parts,
        "score": score,
    }


def metric_moat(info, income):
    """
    פרוקסי כמותי ל"יתרון תחרותי" (Moat) - עיקרון מרכזי בגישת מאנגר/באפט.
    אי אפשר למדוד moat ישירות (זה דורש שיקול דעת איכותי על מותג, רישוי,
    אפקט רשת וכו'), אבל יש איתות כמותי סביר: חברה עם moat אמיתי שומרת על
    שולי רווח גולמי גבוהים ויציבים לאורך שנים - מתחרים בלי יתרון נשחקים
    מתחרות מחירים, אבל חברה עם moat מצליחה לשמור על כוח התמחור שלה.

    בודקים שני דברים: (1) רמת שולי הרווח הגולמי הממוצעת על פני כל השנים
    הזמינות, (2) עד כמה היא יציבה (סטיית התקן בין השנים) - יציבות גבוהה
    + רמה גבוהה = איתות moat חזק.
    """
    margins_series = _safe_series(income, "Gross Profit")
    revenue_series = _safe_series(income, "Total Revenue")

    if margins_series is None or revenue_series is None or len(margins_series) < 3:
        return {"value": None, "label": "Moat Signal", "explanation": "אין מספיק היסטוריה (נדרשות לפחות 3 שנים) להעריך יציבות יתרון תחרותי.",
                "explanation_parts": [("moat_no_history", {})], "score": None}

    # מיישרים את שתי הסדרות לפי שנים משותפות, מחשבים % שולי רווח גולמי לכל שנה
    common_years = margins_series.index.intersection(revenue_series.index)
    yearly_margins = []
    for year in common_years:
        rev = revenue_series.get(year)
        gp = margins_series.get(year)
        if rev and rev != 0 and gp is not None:
            yearly_margins.append(gp / rev * 100)

    if len(yearly_margins) < 3:
        return {"value": None, "label": "Moat Signal", "explanation": "אין מספיק היסטוריה (נדרשות לפחות 3 שנים) להעריך יציבות יתרון תחרותי.",
                "explanation_parts": [("moat_no_history", {})], "score": None}

    avg_margin = sum(yearly_margins) / len(yearly_margins)
    variance = sum((m - avg_margin) ** 2 for m in yearly_margins) / len(yearly_margins)
    std_dev = variance ** 0.5

    # רמה גבוהה + יציבות גבוהה (סטיית תקן נמוכה) = איתות moat חזק
    if avg_margin >= 40 and std_dev <= 4:
        score, note, key = 95, "שולי רווח גולמי גבוהים ויציבים על פני זמן - איתות חזק ליתרון תחרותי מתמשך.", "moat_strong"
    elif avg_margin >= 40 and std_dev > 4:
        score, note, key = 65, "שולי רווח גולמי גבוהים אך משתנים בין השנים - יתרון תחרותי אפשרי, אבל לא בהכרח עקבי.", "moat_high_volatile"
    elif avg_margin >= 20 and std_dev <= 4:
        score, note, key = 60, "שולי רווח גולמי מתונים אך יציבים - אולי לא moat חזק, אבל לפחות עקביות תחרותית.", "moat_moderate_stable"
    elif avg_margin >= 20:
        score, note, key = 40, "שולי רווח גולמי מתונים ולא עקביים - לא נראה איתות חזק ליתרון תחרותי.", "moat_moderate_volatile"
    else:
        score, note, key = 20, "שולי רווח גולמי נמוכים - בעסקים כאלה קשה יותר לבודד יתרון תחרותי אמיתי לעומת תחרות מחירים.", "moat_weak"

    return {"value": round(avg_margin, 1), "label": "Moat Signal", "explanation": note,
            "explanation_parts": [(key, {})], "score": score}


# -----------------------------------------------------------
# הציון המשוקלל
# -----------------------------------------------------------

def _weighted_average(items):
    """
    items: list of (score, weight). מתעלם מ-score=None ומחלק את המשקלים מחדש
    בין מה שכן יש לו ערך, כדי שמדד חסר לא "יעניש" את החברה.
    """
    valid = [(s, w) for s, w in items if s is not None]
    if not valid:
        return None
    total_weight = sum(w for _, w in valid)
    return sum(s * w for s, w in valid) / total_weight


def calculate_score(data: dict) -> dict:
    """
    הפונקציה הראשית - מקבלת dict בפורמט שמחזיר data_fetcher.get_stock_data()
    (או mock_data) ומחזירה ניתוח מלא.
    """
    info = data.get("info", {})
    income = data.get("income")
    balance = data.get("balance")
    cashflow = data.get("cashflow")
    dividends = data.get("dividends")

    metrics = {
        "current_ratio": metric_current_ratio(balance),
        "debt_to_equity": metric_debt_to_equity(info),
        "liabilities_to_equity": metric_liabilities_to_equity(balance),
        "operating_margin": metric_operating_margin(info, income),
        "gross_margin": metric_gross_margin(info, income),
        "net_margin": metric_net_margin(info, income),
        "net_income_trend": metric_net_income_trend(income),
        "moat": metric_moat(info, income),
        "pe_ratio": metric_pe_ratio(info),
        "peg_ratio": metric_peg_ratio(info),
        "free_cash_flow": metric_free_cash_flow(cashflow),
        "operating_cash_flow": metric_operating_cash_flow(cashflow),
        "cash_position": metric_cash_position(info, balance),
        "cost_of_revenue": metric_cost_of_revenue(income),
        "cash_runway": metric_cash_runway(info, cashflow),
        "dividend": metric_dividend(info, dividends),
        "buyback": metric_buyback(info, cashflow),
    }

    # --- Quality score (40%) ---
    # 8 מדדים: נזילות, מינוף (שני סוגים), שלושת השוליים, מגמת רווח, ו-Moat (יתרון תחרותי).
    # ל-Moat משקל קצת נמוך יותר (0.5) כי זה proxy עקיף, לא מדידה ישירה כמו שאר המדדים.
    quality_score = _weighted_average([
        (metrics["current_ratio"]["score"], 1),
        (metrics["debt_to_equity"]["score"], 1),
        (metrics["liabilities_to_equity"]["score"], 1),
        (metrics["operating_margin"]["score"], 1),
        (metrics["gross_margin"]["score"], 1),
        (metrics["net_margin"]["score"], 1),
        (metrics["net_income_trend"]["score"], 1),
        (metrics["moat"]["score"], 0.5),
    ])

    # --- Valuation score (35%) ---
    valuation_score = _weighted_average([
        (metrics["pe_ratio"]["score"], 0.6),
        (metrics["peg_ratio"]["score"], 0.4),
    ])

    # --- Income score (25%) - תזרים + תשואה לבעלי מניות (דיבידנד/buyback) ---
    # דיבידנד/buyback שלא קיימים הם נייטרליים (None) ולא פוגעים בציון - רק "מוסיפים" אם קיימים
    income_components = [(metrics["free_cash_flow"]["score"], 0.6)]
    if metrics["dividend"]["score"] is not None:
        income_components.append((metrics["dividend"]["score"], 0.2))
    if metrics["buyback"]["score"] is not None:
        income_components.append((metrics["buyback"]["score"], 0.2))
    income_score = _weighted_average(income_components)

    # --- ציון כולל ---
    category_scores = [
        (quality_score, 0.40),
        (valuation_score, 0.35),
        (income_score, 0.25),
    ]
    final_score = _weighted_average(category_scores)

    if final_score is None:
        recommendation = "insufficient"
        rec_color = "gray"
        rec_explanation = "לא נמצא מספיק מידע פיננסי כדי לנקד את החברה הזו."
        rec_parts = [("rec_insufficient", {})]
        final_score = 0
    elif final_score >= 75:
        recommendation = "buy"
        rec_color = "green"
        rec_explanation = "פונדמנטלס חזקים ומחיר סביר - החברה הזו עומדת ברוב הקריטריונים."
        rec_parts = [("rec_buy", {})]
    elif final_score >= 50:
        recommendation = "hold"
        rec_color = "amber"
        rec_explanation = "עסק לא רע, אבל התזמון או המחיר עדיין לא אידיאליים."
        rec_parts = [("rec_hold", {})]
    else:
        recommendation = "avoid"
        rec_color = "red"
        rec_explanation = "כמה דגלים אדומים - זה לא עומד בסטנדרט כרגע."
        rec_parts = [("rec_avoid", {})]

    # תוספת ייחודית: ציטוט הדיבידנד בסיכום ה"תאכלס" (כמו שביקשת)
    if metrics["dividend"]["pays_dividend"]:
        dividend_summary = f"מחלקת דיבידנד (תשואה של כ-{metrics['dividend']['value']}%)."
        dividend_parts = [("div_pays", {"pct": metrics["dividend"]["value"]})]
    else:
        dividend_summary = "לא מחלקת דיבידנד."
        dividend_parts = [("div_none", {})]

    # אותו עיקרון לרכישה חזרה של מניות (Buyback)
    if metrics["buyback"]["does_buyback"]:
        bb_value = metrics["buyback"]["value"]
        if metrics["buyback"]["value"] is not None and bb_value < 100:
            buyback_summary = f"רוכשת בחזרה מניות (כ-{bb_value}% משווי השוק בשנה האחרונה)."
            buyback_parts = [("bb_with_pct", {"pct": bb_value})]
        else:
            buyback_summary = "רוכשת בחזרה מניות."
            buyback_parts = [("bb_plain", {})]
    else:
        buyback_summary = "לא רוכשת בחזרה מניות."
        buyback_parts = [("bb_none", {})]

    return {
        "ticker": data.get("ticker"),
        "company_name": info.get("longName", data.get("ticker")),
        "current_price": (
            _safe_info(info, "currentPrice") or
            _safe_info(info, "navPrice") or
            _safe_info(info, "regularMarketPrice")
        ),
        "final_score": round(final_score),
        "recommendation": recommendation,
        "recommendation_color": rec_color,
        "recommendation_explanation": rec_explanation,
        "recommendation_parts": rec_parts,
        "dividend_summary": dividend_summary,
        "dividend_summary_parts": dividend_parts,
        "buyback_summary": buyback_summary,
        "buyback_summary_parts": buyback_parts,
        "category_scores": {
            "quality": round(quality_score) if quality_score is not None else None,
            "valuation": round(valuation_score) if valuation_score is not None else None,
            "income": round(income_score) if income_score is not None else None,
        },
        "metrics": metrics,
    }


if __name__ == "__main__":
    from mock_data import ALL_MOCKS
    import json

    for name, mock in ALL_MOCKS.items():
        print(f"\n{'='*60}\n{name}\n{'='*60}")
        result = calculate_score(mock)
        print(f"Company: {result['company_name']}")
        print(f"Final Score: {result['final_score']}% -> {result['recommendation']}")
        print(f"Category scores: {result['category_scores']}")
        print(f"Dividend: {result['dividend_summary']}")
        print("\nMetrics:")
        for key, m in result["metrics"].items():
            print(f"  - {m['label']}: value={m['value']}, score={m['score']} | {m['explanation']}")

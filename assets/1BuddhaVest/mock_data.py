"""
Copyright (c) 2026, the creator of this application. All rights reserved.
Part of the BuddhaVest personal stock-research application.
Unauthorized copying, distribution, or use of this code, in whole or in part,
without explicit written permission from the copyright holder is prohibited.
"""

"""
mock_data.py
נתונים מדומים בפורמט המדויק שמחזיר yfinance.
משמש לבדיקת analyzer.py בלי תלות ברשת.
כולל 3 מקרים: חברה "טובה" עם דיבידנד (AAPL-like), חברת צמיחה ששורפת מזומן (IONQ-like),
וחברה עם נתונים חסרים (כדי לבדוק עמידות בפני שגיאות).
"""

import pandas as pd


def _make_financials(revenue, op_income, net_income_series, gross_profit=None):
    """יוצר DataFrame בסגנון income statement של yfinance (עמודות = שנים, יורד מהחדש לישן)"""
    dates = pd.to_datetime(["2025-09-30", "2024-09-30", "2023-09-30", "2022-09-30"])
    data = {
        "Total Revenue": revenue,
        "Operating Income": op_income,
        "Net Income": net_income_series,
    }
    if gross_profit is not None:
        data["Gross Profit"] = gross_profit
    df = pd.DataFrame(data, index=dates).T
    return df


def _make_balance(curr_assets, curr_liab, total_liab, total_equity):
    dates = pd.to_datetime(["2025-09-30", "2024-09-30", "2023-09-30", "2022-09-30"])
    data = {
        "Current Assets": curr_assets,
        "Current Liabilities": curr_liab,
        "Total Liabilities Net Minority Interest": total_liab,
        "Stockholders Equity": total_equity,
    }
    df = pd.DataFrame(data, index=dates).T
    return df


def _make_cashflow(operating_cf, capex, repurchase=None):
    dates = pd.to_datetime(["2025-09-30", "2024-09-30", "2023-09-30", "2022-09-30"])
    data = {
        "Operating Cash Flow": operating_cf,
        "Capital Expenditure": capex,  # ב-yfinance זה בדרך כלל שלילי
    }
    if repurchase is not None:
        data["Repurchase Of Capital Stock"] = repurchase  # שלילי = כסף שיצא לרכישה חזרה
    df = pd.DataFrame(data, index=dates).T
    return df


# ===========================================================
# מקרה 1: חברה "איכותית" עם דיבידנד - בסגנון AAPL
# ===========================================================
GOOD_DIVIDEND_STOCK = {
    "ticker": "GOODCO",
    "info": {
        "longName": "GoodCo Inc.",
        "shortName": "GoodCo",
        "currentPrice": 214.30,
        "previousClose": 212.10,
        "marketCap": 3_300_000_000_000,
        "trailingPE": 29.4,
        "forwardPE": 27.1,
        "trailingEps": 7.29,
        "earningsGrowth": 0.08,
        "debtToEquity": 145.0,  # yfinance מחזיר את זה כאחוז (1.45 -> 145)
        "dividendYield": 0.0045,  # 0.45%
        "dividendRate": 0.96,
        "payoutRatio": 0.15,
        "fiveYearAvgDividendYield": 0.6,
        "profitMargins": 0.243,
        "operatingMargins": 0.315,
        "fiftyTwoWeekLow": 169.21,
        "fiftyTwoWeekHigh": 237.49,
        "volume": 48_500_000,
        "averageVolume": 52_000_000,
        "sector": "Technology",
        "industry": "Consumer Electronics",
    },
    "income": _make_financials(
        revenue=[391_000_000_000, 383_000_000_000, 375_000_000_000, 394_000_000_000],
        op_income=[123_000_000_000, 114_000_000_000, 110_000_000_000, 119_000_000_000],
        net_income_series=[112_010_000_000, 93_736_000_000, 96_995_000_000, 99_803_000_000],
        gross_profit=[181_000_000_000, 176_500_000_000, 172_000_000_000, 180_500_000_000],
    ),
    "balance": _make_balance(
        curr_assets=[152_000_000_000, 143_000_000_000, 135_000_000_000, 140_000_000_000],
        curr_liab=[176_000_000_000, 134_000_000_000, 145_000_000_000, 153_000_000_000],
        total_liab=[265_000_000_000, 244_000_000_000, 250_000_000_000, 260_000_000_000],
        total_equity=[182_000_000_000, 175_000_000_000, 160_000_000_000, 150_000_000_000],
    ),
    "cashflow": _make_cashflow(
        operating_cf=[122_000_000_000, 118_000_000_000, 110_000_000_000, 105_000_000_000],
        capex=[-10_900_000_000, -10_500_000_000, -10_200_000_000, -9_800_000_000],
        repurchase=[-95_000_000_000, -90_000_000_000, -85_000_000_000, -80_000_000_000],
    ),
    # היסטוריית דיבידנדים - לאורך כמה שנים, רבעוני, יציב/עולה
    "dividends": pd.Series(
        data=[0.22, 0.23, 0.23, 0.24, 0.24, 0.24, 0.24, 0.25],
        index=pd.to_datetime([
            "2024-02-15", "2024-05-15", "2024-08-15", "2024-11-15",
            "2025-02-15", "2025-05-15", "2025-08-15", "2025-11-15",
        ]),
    ),
    "history": pd.DataFrame({
        "Close": [170 + i * 0.4 for i in range(252)],
    }, index=pd.bdate_range(end="2026-06-12", periods=252)),
}


# ===========================================================
# מקרה 2: חברת צמיחה ששורפת מזומן, בלי דיבידנד - בסגנון IONQ
# ===========================================================
GROWTH_BURN_STOCK = {
    "ticker": "BURNCO",
    "info": {
        "longName": "BurnCo Quantum Inc.",
        "currentPrice": 38.10,
        "marketCap": 15_000_000_000,
        "trailingPE": None,  # אין רווח -> אין מכפיל
        "forwardPE": None,
        "trailingEps": -0.85,
        "earningsGrowth": None,
        "debtToEquity": 12.0,
        "dividendYield": None,  # אין דיבידנד בכלל
        "dividendRate": None,
        "payoutRatio": None,
        "fiveYearAvgDividendYield": None,
        "profitMargins": -1.8,
        "operatingMargins": -2.1,
        "totalCash": 2_000_000_000,
    },
    "income": _make_financials(
        revenue=[55_000_000, 28_000_000, 12_000_000, 4_000_000],
        op_income=[-380_000_000, -290_000_000, -210_000_000, -150_000_000],
        net_income_series=[-400_000_000, -300_000_000, -220_000_000, -155_000_000],
        gross_profit=[22_000_000, 14_000_000, 1_500_000, -800_000],
    ),
    "balance": _make_balance(
        curr_assets=[2_100_000_000, 1_400_000_000, 900_000_000, 600_000_000],
        curr_liab=[80_000_000, 60_000_000, 40_000_000, 25_000_000],
        total_liab=[150_000_000, 110_000_000, 80_000_000, 50_000_000],
        total_equity=[1_950_000_000, 1_290_000_000, 820_000_000, 550_000_000],
    ),
    "cashflow": _make_cashflow(
        operating_cf=[-380_000_000, -280_000_000, -200_000_000, -140_000_000],
        capex=[-20_000_000, -15_000_000, -10_000_000, -8_000_000],
    ),
    # אין דיבידנדים בכלל - Series ריקה, כמו שyfinance מחזיר לחברות כאלה
    "dividends": pd.Series(dtype=float),
    "history": pd.DataFrame({
        "Close": [45 - i * 0.03 for i in range(252)],
    }, index=pd.bdate_range(end="2026-06-12", periods=252)),
}


# ===========================================================
# מקרה 3: חברה עם נתונים חסרים/לא שלמים - לבדיקת עמידות
# ===========================================================
INCOMPLETE_DATA_STOCK = {
    "ticker": "WEIRDCO",
    "info": {
        "longName": "WeirdCo Holdings",
        "currentPrice": 12.50,
        "marketCap": 800_000_000,
        "trailingPE": None,
        "forwardPE": None,
        "trailingEps": None,
        "earningsGrowth": None,
        "debtToEquity": None,
        "dividendYield": None,
        "dividendRate": None,
        "payoutRatio": None,
        "fiveYearAvgDividendYield": None,
        "profitMargins": None,
        "operatingMargins": None,
    },
    # דוחות כספיים ריקים לחלוטין (DataFrame ריק) - מצב שקורה בפועל ב-yfinance
    "income": pd.DataFrame(),
    "balance": pd.DataFrame(),
    "cashflow": pd.DataFrame(),
    "dividends": pd.Series(dtype=float),
    "history": pd.DataFrame({
        "Close": [12.5] * 30,
    }, index=pd.bdate_range(end="2026-06-12", periods=30)),
}


ALL_MOCKS = {
    "GOODCO": GOOD_DIVIDEND_STOCK,
    "BURNCO": GROWTH_BURN_STOCK,
    "WEIRDCO": INCOMPLETE_DATA_STOCK,
}


# ===========================================================
# מוקים לדשבורד שוק - מדדים, שער מטבע, ורשימת מניות
# ===========================================================
def _index_mock(name, price, prev_close):
    return {
        "ticker": name,
        "info": {"longName": name, "currentPrice": price, "previousClose": prev_close},
        "income": pd.DataFrame(), "balance": pd.DataFrame(), "cashflow": pd.DataFrame(),
        "dividends": pd.Series(dtype=float), "history": pd.DataFrame(),
    }


def _stock_mock(ticker, name, price, prev_close, volume=None, avg_volume=None, market_cap=None):
    return {
        "ticker": ticker,
        "info": {"shortName": name, "longName": name, "currentPrice": price, "previousClose": prev_close,
                 "volume": volume, "averageVolume": avg_volume, "marketCap": market_cap},
        "income": pd.DataFrame(), "balance": pd.DataFrame(), "cashflow": pd.DataFrame(),
        "dividends": pd.Series(dtype=float), "history": pd.DataFrame(),
    }


MARKET_MOCKS = {
    "^GSPC": _index_mock("S&P 500", 6142.15, 6105.26),
    "^IXIC": _index_mock("Nasdaq", 19870.32, 19930.10),
    "^VIX": _index_mock("VIX", 14.2, 14.5),
    "ILS=X": _index_mock("USD/ILS", 3.62, 3.61),
    "EUR=X": _index_mock("USD/EUR", 0.93, 0.92),
    "RUB=X": _index_mock("USD/RUB", 79.5, 79.1),
    "AAPL": _stock_mock("AAPL", "Apple Inc.", 214.30, 212.10, 48_500_000, 52_000_000, 3_300_000_000_000),
    "MSFT": _stock_mock("MSFT", "Microsoft Corp.", 441.20, 438.50, 22_100_000, 25_000_000, 3_280_000_000_000),
    "NVDA": _stock_mock("NVDA", "NVIDIA Corp.", 138.50, 134.00, 165_000_000, 200_000_000, 3_400_000_000_000),
    "GOOGL": _stock_mock("GOOGL", "Alphabet Inc.", 178.40, 179.10, 28_000_000, 30_000_000, 2_200_000_000_000),
    "AMZN": _stock_mock("AMZN", "Amazon.com Inc.", 205.60, 203.90, 35_000_000, 40_000_000, 2_150_000_000_000),
    "TSLA": _stock_mock("TSLA", "Tesla Inc.", 318.20, 325.00, 95_000_000, 110_000_000, 1_020_000_000_000),
    "META": _stock_mock("META", "Meta Platforms", 612.30, 605.10, 14_000_000, 16_000_000, 1_550_000_000_000),
    "AMD": _stock_mock("AMD", "Advanced Micro Devices", 124.80, 122.60, 45_000_000, 50_000_000, 202_000_000_000),
    "JPM": _stock_mock("JPM", "JPMorgan Chase & Co.", 232.40, 230.10, 8_500_000, 9_200_000, 660_000_000_000),
    "V": _stock_mock("V", "Visa Inc.", 345.60, 348.20, 6_200_000, 6_800_000, 670_000_000_000),
    "JNJ": _stock_mock("JNJ", "Johnson & Johnson", 152.10, 151.40, 5_800_000, 6_500_000, 365_000_000_000),
    "WMT": _stock_mock("WMT", "Walmart Inc.", 92.30, 91.80, 16_000_000, 17_500_000, 745_000_000_000),
    "DIS": _stock_mock("DIS", "The Walt Disney Company", 112.40, 113.90, 9_800_000, 11_000_000, 205_000_000_000),
    "NFLX": _stock_mock("NFLX", "Netflix Inc.", 1180.50, 1165.00, 3_100_000, 3_400_000, 505_000_000_000),
    "KO": _stock_mock("KO", "The Coca-Cola Company", 71.20, 70.95, 12_500_000, 14_000_000, 308_000_000_000),
}

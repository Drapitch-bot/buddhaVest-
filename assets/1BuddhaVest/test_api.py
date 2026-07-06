"""
test_api.py
בדיקה ש-main.py בנוי נכון, בלי תלות ברשת.
מחליף את get_stock_data ב-mock data ובודק את ה-endpoints.
"""

import sys
from unittest.mock import patch
from fastapi.testclient import TestClient
from mock_data import ALL_MOCKS


def fake_get_stock_data(ticker):
    ticker = ticker.upper()
    if ticker in ALL_MOCKS:
        return ALL_MOCKS[ticker]
    # סימול לא קיים
    return {"ticker": ticker, "info": {}, "income": None, "balance": None, "cashflow": None, "dividends": None, "history": None}


with patch("main.get_stock_data", side_effect=fake_get_stock_data):
    import main
    client = TestClient(main.app)

    print("Testing GET /")
    r = client.get("/")
    print(" ->", r.status_code, r.json())

    print("\nTesting GET /analyze/GOODCO")
    r = client.get("/analyze/GOODCO")
    print(" -> status:", r.status_code)
    body = r.json()
    print(" -> score:", body["final_score"], "| rec:", body["recommendation"], "| dividend:", body["dividend_summary"])

    print("\nTesting GET /analyze/BURNCO")
    r = client.get("/analyze/BURNCO")
    body = r.json()
    print(" -> score:", body["final_score"], "| rec:", body["recommendation"], "| dividend:", body["dividend_summary"])

    print("\nTesting GET /analyze/NOTREAL (should 404)")
    r = client.get("/analyze/NOTREAL")
    print(" -> status:", r.status_code, "| detail:", r.json().get("detail"))

print("\nAll API structure tests completed.")

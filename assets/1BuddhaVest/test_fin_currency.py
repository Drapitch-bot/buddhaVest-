"""
Tests for _infer_financial_currency.

The problem it solves: Yahoo often omits financialCurrency for Tel Aviv
listings, and the two possibilities are three-fold apart. Ormat trades in
shekels and reports in dollars; Bank Hapoalim trades and reports in shekels.
Defaulting to the trading currency for both is what put "ILS 989.5M" on Ormat
revenue of USD 989.5M on 2026-08-12.

The test is arithmetic, not a vibe: market cap is in the trading currency and
net income is in the reporting currency, so market cap / net income is a real
P/E when they agree and a P/E times the exchange rate when they do not.

What these tests are really guarding is the FAILURE mode. This function is
allowed to be unsure — the caller then shows the figure with no currency sign,
which is what happens today anyway. It is not allowed to be confidently wrong,
because that is the original bug wearing a better argument. So most of what
follows checks that it returns None.

Run:  python test_fin_currency.py
"""

import sys
import types

src = open("main.py", encoding="utf-8").read()


def extract(name):
    start = src.index("def %s(" % name)
    lines = src[start:].split("\n")
    body = [lines[0]]
    for line in lines[1:]:
        if line and not line[0].isspace():
            break
        body.append(line)
    return "\n".join(body)


mod = types.ModuleType("fc")
reports = []
mod.__dict__["report"] = lambda kind, **f: reports.append((kind, f))
mod.__dict__["swallow"] = lambda where, exc=None, **f: reports.append(("swallowed", f))
# The band is a module-level constant the function reads.
exec(src[src.index("_PLAUSIBLE_PE = ("):src.index("\n", src.index("_PLAUSIBLE_PE = ("))],
     mod.__dict__)
exec(extract("_infer_financial_currency"), mod.__dict__)
infer = mod._infer_financial_currency

FAILURES = []


def check(name, got, want):
    ok = got == want
    print("  %-4s %-58s %s" % ("ok" if ok else "FAIL", name,
                               "" if ok else "got %r want %r" % (got, want)))
    if not ok:
        FAILURES.append(name)


def payload(ticker, market_cap, net_income, fx=2.9866, ccy="ILS"):
    return {
        "ticker": ticker,
        "price_currency": ccy,
        "usd_ils": fx,
        "overview": {"market_cap": market_cap},
        "inline_history": {"net_income": {"annual": [
            {"date": "Dec 2024", "value": net_income * 0.9},
            {"date": "Dec 2025", "value": net_income},
        ]}},
    }


print("\n── the two tickers measured live on 2026-08-13 ──")
# ORA.TA: 20.93B / 123.9M = 169 raw, 56.6 once divided by the rate. Only the
# second is a plausible multiple, and Ormat does report in dollars.
check("ORA.TA  -> USD", infer(payload("ORA.TA", 20933558716.4, 123898000.0, 2.9856)), "USD")
# POLI.TA: 101.62B / 9.80B = 10.4 raw, 3.5 divided. Only the first is
# plausible, and Bank Hapoalim does report in shekels.
check("POLI.TA -> ILS", infer(payload("POLI.TA", 101623155719.4, 9802000000.0, 2.9866)), "ILS")

print("\n── ambiguous must mean unknown, never a coin flip ──")
# A P/E of 30 raw and 10 divided: both are ordinary multiples. There is no
# evidence here, so there must be no answer.
reports.clear()
check("both plausible -> None", infer(payload("X.TA", 30e9, 1e9, 3.0)), None)
check("reported as ambiguous", reports[-1][0], "fin_currency_ambiguous")
# Neither plausible: raw 300, divided 100.
reports.clear()
check("neither plausible -> None", infer(payload("X.TA", 300e9, 1e9, 3.0)), None)
check("reported as ambiguous", reports[-1][0], "fin_currency_ambiguous")

print("\n── only runs where the rate is known and meaningful ──")
check("GBP listing -> None",
      infer(payload("SHEL.L", 20.9e9, 123.9e6, 2.9856, ccy="GBP")), None)
check("USD listing -> None",
      infer(payload("AAPL", 20.9e9, 123.9e6, 2.9856, ccy="USD")), None)
check("no fx rate -> None", infer(payload("X.TA", 20.9e9, 123.9e6, None)), None)
check("fx of 1.0 -> None", infer(payload("X.TA", 20.9e9, 123.9e6, 1.0)), None)
check("absurd fx -> None", infer(payload("X.TA", 20.9e9, 123.9e6, 5000.0)), None)
check("fx is a bool -> None", infer(payload("X.TA", 20.9e9, 123.9e6, True)), None)

print("\n── a loss-making year carries no signal ──")
# The ratio is negative and tells us nothing about units.
check("negative net income -> None", infer(payload("X.TA", 20.9e9, -50e6)), None)
check("zero net income -> None", infer(payload("X.TA", 20.9e9, 0.0)), None)

print("\n── missing inputs -> None, never an exception ──")
JUNK = [
    ("no market cap",     payload("X.TA", None, 1e9)),
    ("zero market cap",   payload("X.TA", 0.0, 1e9)),
    ("no overview",       {"ticker": "X.TA", "price_currency": "ILS", "usd_ils": 3.0,
                           "inline_history": {}}),
    ("no inline_history", {"ticker": "X.TA", "price_currency": "ILS", "usd_ils": 3.0,
                           "overview": {"market_cap": 20e9}}),
    ("empty net income",  {"ticker": "X.TA", "price_currency": "ILS", "usd_ils": 3.0,
                           "overview": {"market_cap": 20e9},
                           "inline_history": {"net_income": {"annual": []}}}),
    ("net income is text", {"ticker": "X.TA", "price_currency": "ILS", "usd_ils": 3.0,
                            "overview": {"market_cap": 20e9},
                            "inline_history": {"net_income": {"annual": [{"value": "lots"}]}}}),
    ("empty dict",        {}),
]
for name, r in JUNK:
    try:
        check(name, infer(r), None)
    except Exception as e:
        check(name + " -> no exception", "raised %r" % (e,), "no exception")

print("\n── the band edges, stated explicitly ──")
lo, hi = mod._PLAUSIBLE_PE
check("band is (5, 60)", (lo, hi), (5.0, 60.0))
# raw just inside, divided far below -> ILS
check("raw at the low edge -> ILS", infer(payload("X.TA", 5.1e9, 1e9, 3.0)), "ILS")
# raw far above, divided just inside -> USD
check("divided at the high edge -> USD", infer(payload("X.TA", 179e9, 1e9, 3.0)), "USD")

print("\n── it must never be reached when the provider DID say ──")
# Guarded at the call site, so this is a reminder in test form: the function is
# only ever invoked after financialCurrency came back empty. If that call-site
# guard is ever removed, this comment is where to look.
call_site = src[src.index("_fin_known = bool(_fin_ccy)"):]
call_site = call_site[:call_site.index("result[\"financial_currency\"]")]
check("only called when _fin_known is false",
      "if not _fin_known:" in call_site, True)

print("\n" + ("PASS — all checks green" if not FAILURES
              else "FAIL — %d: %s" % (len(FAILURES), ", ".join(FAILURES))))
sys.exit(1 if FAILURES else 0)

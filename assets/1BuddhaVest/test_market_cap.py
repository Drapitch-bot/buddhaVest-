"""
Tests for _reconcile_market_cap.

Measured on 2026-08-12, on the live server, for two Tel Aviv listings:

    ORA.TA   reported  ILS  2,106.27B    shares x price  ILS  21.01B    x100.3
    POLI.TA  reported  ILS 10,048.53B    shares x price  ILS 101.49B    x99.0

The app was presenting Bank Hapoalim, a ~ILS 100B bank, as a ILS 10 trillion
company — on the stock screen and in the sortable market table, where it also
distorted the ordering. One of the two reports in dollars and one in shekels,
so this is the quote unit reaching market cap, not a reporting-currency effect.

The code had a docstring asserting the opposite ("marketCap is in shekel while
the quote is in agorot"), which is why nothing caught it. The fix therefore
does not replace one assumption with another: it reconstructs market cap from
shares x price and acts on the ratio. These tests pin that behaviour, including
the branch where it refuses to publish anything.

Run:  python test_market_cap.py
"""

import importlib.util
import sys
import types

# main.py pulls in FastAPI, yfinance and the rest at import time, which is far
# too heavy for a unit test and needs the network. The two functions under test
# depend only on the standard library, so lift them out and give them the two
# names they reference.
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


mod = types.ModuleType("mc")
reports = []
mod.__dict__["report"] = lambda kind, **f: reports.append((kind, f))
mod.__dict__["swallow"] = lambda where, exc=None, **f: reports.append(("swallowed", f))
exec(extract("_shares_outstanding"), mod.__dict__)
exec(extract("_reconcile_market_cap"), mod.__dict__)

reconcile = mod._reconcile_market_cap

FAILURES = []


def check(name, got, want):
    ok = got == want
    print("  %-4s %-58s %s" % ("ok" if ok else "FAIL", name,
                               "" if ok else "got %r want %r" % (got, want)))
    if not ok:
        FAILURES.append(name)


def payload(ticker, market_cap, price, net_income=None, eps=None):
    r = {"ticker": ticker, "current_price": price,
         "overview": {"market_cap": market_cap}, "inline_history": {}}
    if net_income is not None and eps is not None:
        r["inline_history"] = {
            "net_income": {"annual": [{"date": "Dec 2025", "value": net_income}]},
            "eps":        {"annual": [{"date": "Dec 2025", "value": eps}]},
        }
    return r


def cap(r):
    return r["overview"]["market_cap"]


print("\n── the two tickers measured live ──")
# Note what the corrected value IS: the provider's own market cap divided by
# the unit, NOT the shares x price reconstruction. The reconstruction is a
# yardstick for deciding WHETHER the value is in the wrong unit; it is not a
# better number. Yahoo's figure accounts for multiple share classes and
# treasury stock, which net income / EPS cannot see. The two land ~1% apart,
# which is exactly the agreement the tolerance bands are built around.
reports.clear()
# Ormat: reports in USD, trades in shekels. Shares come from net income / EPS,
# which is unit-free, so the check works despite the currency split.
r = payload("ORA.TA", 2106270229250.0, 342.5, 123898000.0, 2.02)
reconcile(r, {}, 100.0)
check("ORA.TA corrected to ~ILS 21B", round(cap(r) / 1e9, 2), 21.06)
check("ORA.TA rescale was reported", reports[0][0], "market_cap_rescaled")
check("ORA.TA is no longer a trillion-shekel company", cap(r) < 1e12, True)

reports.clear()
r = payload("POLI.TA", 10048529026926.0, 76.83, 9802000000.0, 7.42)
reconcile(r, {}, 100.0)
check("POLI.TA corrected to ~ILS 100B", round(cap(r) / 1e9, 2), 100.49)
check("POLI.TA rescale was reported", reports[0][0], "market_cap_rescaled")
check("POLI.TA within 2% of shares x price",
      abs(cap(r) - 9802000000.0 / 7.42 * 76.83) / cap(r) < 0.02, True)

print("\n── sharesOutstanding is preferred when the provider sends it ──")
reports.clear()
r = payload("ORA.TA", 2106270229250.0, 342.5)          # no income statement
reconcile(r, {"sharesOutstanding": 61340000}, 100.0)
check("corrected from sharesOutstanding alone", round(cap(r) / 1e9, 2), 21.06)

print("\n── a value that is ALREADY correct must not be touched ──")
# This is the case the old docstring described. If it ever occurs, dividing
# would create the mirror-image bug — a ILS 100B bank shown as ILS 1B.
reports.clear()
r = payload("XXXX.TA", 101_490_000_000.0, 76.83, 9802000000.0, 7.42)
reconcile(r, {}, 100.0)
check("left alone", cap(r), 101_490_000_000.0)
check("nothing reported", reports, [])

print("\n── London pence and Johannesburg cents use the same path ──")
reports.clear()
# 2B shares at GBP 26.00 = GBP 52B. Quoted in pence, market cap arrives as
# 5,200B and must come back as 52B.
r = payload("SHEL.L", 5_200_000_000_000.0, 26.0, 2_000_000_000.0, 1.0)
reconcile(r, {}, 100.0)
check("GBP corrected", round(cap(r) / 1e9, 1), 52.0)
check("reported", reports[0][0], "market_cap_rescaled")

print("\n── no share count -> publish nothing, do not guess ──")
# Both tickers measured were in the minor unit, so guessing "divide by 100"
# would be right more often than not. It is still a guess, and an unverified
# guess is exactly what produced this bug.
reports.clear()
r = payload("ORA.TA", 2106270229250.0, 342.5)
reconcile(r, {}, 100.0)
check("suppressed", cap(r), None)
check("reported as unverifiable", reports[0][0], "market_cap_unverifiable")

print("\n── a ratio that fits neither story -> publish nothing ──")
reports.clear()
r = payload("ORA.TA", 5_000_000_000_000_000.0, 342.5, 123898000.0, 2.02)
reconcile(r, {}, 100.0)
check("suppressed", cap(r), None)
check("reported as unexplained", reports[0][0], "market_cap_unexplained")

print("\n── tolerance: buybacks and stale share counts must not trip it ──")
# Shares outstanding drift between the last statement and today. The bands are
# wide (0.5x-2x) so ordinary drift never flips a correct value into a wrong one.
for label, mc in [("30% above", 101_490_000_000.0 * 1.3),
                  ("30% below", 101_490_000_000.0 * 0.7)]:
    r = payload("XXXX.TA", mc, 76.83, 9802000000.0, 7.42)
    reconcile(r, {}, 100.0)
    check("%s -> untouched" % label, cap(r), mc)

print("\n── junk must not raise, and must not corrupt a good value ──")
JUNK = [
    ("market_cap None",   payload("X.TA", None, 100.0, 1e9, 1.0)),
    ("price None",        payload("X.TA", 1e12, None, 1e9, 1.0)),
    ("price zero",        payload("X.TA", 1e12, 0.0, 1e9, 1.0)),
    ("price negative",    payload("X.TA", 1e12, -5.0, 1e9, 1.0)),
    ("eps zero",          payload("X.TA", 1e12, 100.0, 1e9, 0.0)),
    ("eps negative",      payload("X.TA", 1e12, 100.0, 1e9, -1.0)),
    ("no overview",       {"ticker": "X.TA", "current_price": 100.0}),
    ("overview is None",  {"ticker": "X.TA", "current_price": 100.0, "overview": None}),
]
for name, r in JUNK:
    try:
        reconcile(r, {}, 100.0)
        check(name + " -> no exception", True, True)
    except Exception as e:
        check(name + " -> no exception", "raised %r" % (e,), "no exception")

for name, info in [("info None", None), ("info a list", [1]), ("info a string", "x")]:
    try:
        r = payload("X.TA", 1e12, 100.0, 1e9, 1.0)
        reconcile(r, info, 100.0)
        check(name + " -> no exception", True, True)
    except Exception as e:
        check(name + " -> no exception", "raised %r" % (e,), "no exception")

print("\n── _shares_outstanding on its own ──")
sh = mod._shares_outstanding
check("prefers sharesOutstanding",
      sh(payload("X", 1, 1, 1e9, 1.0), {"sharesOutstanding": 500}), 500.0)
check("falls back to net income / EPS",
      sh(payload("X", 1, 1, 1e9, 2.0), {}), 5e8)
check("ignores a zero share count",
      sh(payload("X", 1, 1, 1e9, 2.0), {"sharesOutstanding": 0}), 5e8)
# float(True) is 1.0. A boolean here would have become a share count of ONE,
# and every market cap would then be "reconciled" against the share price.
check("rejects True as a share count",
      sh(payload("X", 1, 1, 1e9, 2.0), {"sharesOutstanding": True}), 5e8)
for junk in ("many", "", None, [1], {"a": 1}, float("nan"), float("inf"), -5):
    check("rejects %r" % (junk,),
          sh(payload("X", 1, 1, 1e9, 2.0), {"sharesOutstanding": junk}), 5e8)
check("None when neither source works", sh(payload("X", 1, 1), {}), None)
check("None on a loss-making year", sh(payload("X", 1, 1, -1e9, -2.0), {}), None)

print("\n" + ("PASS — all checks green" if not FAILURES
              else "FAIL — %d: %s" % (len(FAILURES), ", ".join(FAILURES))))
sys.exit(1 if FAILURES else 0)

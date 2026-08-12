"""
Tests for the unit guard on the COMPUTED P/E multiple.

Why this file exists: on 2026-08-12 the app displayed a P/E of 16955.4 for
ORA.TA. The number was produced by a fallback added the day before, which
computes price / EPS whenever the provider omits trailingPE. The fallback was
correct arithmetic on two values that were not comparable — Ormat is quoted in
Tel Aviv in agorot and reports its statements in dollars.

The failure is worth a permanent test for three reasons:

  1. It is invisible in the healthy path. trailingPE is normally present, so
     the computed branch only runs on degraded responses — the ones nobody is
     watching.
  2. The output looks like data. "16955.4" renders in the same tile, with the
     same styling, as a real multiple, and the app confidently scored it 20 and
     labelled the stock "יקר".
  3. main.py had ALREADY solved this for its own endpoints
     (_tase_price_mismatch) and left a comment asserting that ratios are
     unit-free. The new code broke a documented invariant in a different file.

Run:  python test_pe_units.py
"""

import importlib.util
import sys

import pandas as pd

spec = importlib.util.spec_from_file_location("analyzer", "analyzer.py")
az = importlib.util.module_from_spec(spec)
sys.modules["analyzer"] = az
spec.loader.exec_module(az)

FAILURES = []


def check(name, got, want):
    ok = got == want
    print("  %-4s %-62s %s" % ("ok" if ok else "FAIL", name,
                               "" if ok else "got %r want %r" % (got, want)))
    if not ok:
        FAILURES.append(name)


def income_with_eps(eps):
    """Minimal income statement carrying a Diluted EPS row, newest first."""
    return pd.DataFrame({"2025": [eps], "2024": [eps]}, index=["Diluted EPS"])


def key_of(result):
    parts = result.get("explanation_parts") or []
    return parts[0][0] if parts else None


# ── the exact live payload that produced the screenshot ──────────────────────
# Values read from https://buddhavest.onrender.com/analyze/ORA.TA on
# 2026-08-12: price 342.5 ILS (34250 agorot as Yahoo reports it), Diluted EPS
# 2.02 USD, USD/ILS 2.9948. 34250 / 2.02 = 16955.4 — the figure on screen.
ORA_TA = {
    "symbol": "ORA.TA",
    "currency": "ILA",
    "currentPrice": 34250.0,
    # financialCurrency was ABSENT in the live response — the degradation that
    # drops trailingPE dropped this too. The guard must not depend on it.
}

print("\n── the reported bug: ORA.TA must not print 16955.4 ──")
res = az.metric_pe_ratio(ORA_TA, income_with_eps(2.02))
check("value is not the 299x number", res["value"], None)
check("says 'not reported', not 'not profitable'", key_of(res), "pe_not_reported")
check("no score is contributed", res["score"], None)

print("\n── every minor-unit listing, by suffix AND by currency code ──")
# Two independent signals, because Yahoo reports them inconsistently: some TASE
# symbols come back "ILA", others "ILS". Either alone must be enough.
for sym, ccy in [("ESLT.TA", "ILA"), ("DLEKG.TA", "ILS"), ("TEVA.TA", "ILA"),
                 ("SHEL.L", "GBp"), ("BP.L", "GBX"), ("NPN.JO", "ZAc")]:
    info = {"symbol": sym, "currency": ccy, "currentPrice": 5000.0}
    check("%-9s blocked" % sym, key_of(az.metric_pe_ratio(info, income_with_eps(2.0))),
          "pe_not_reported")

print("\n── currency code alone is enough, even without a known suffix ──")
check("bare ILA quote blocked",
      key_of(az.metric_pe_ratio({"symbol": "X", "currency": "ILA", "currentPrice": 5000.0},
                                income_with_eps(2.0))), "pe_not_reported")
check("GBp with no .L suffix blocked",
      key_of(az.metric_pe_ratio({"symbol": "X", "currency": "GBp", "currentPrice": 5000.0},
                                income_with_eps(2.0))), "pe_not_reported")

print("\n── trades in one currency, reports in another ──")
# Elbit is the case named in main.py: shekel quote, dollar statements.
check("EUR quote vs USD statements blocked",
      key_of(az.metric_pe_ratio(
          {"symbol": "DHER.DE", "currency": "EUR", "financialCurrency": "USD",
           "currentPrice": 38.0}, income_with_eps(2.0))), "pe_not_reported")
check("matching currencies allowed",
      az.metric_pe_ratio(
          {"symbol": "DHER.DE", "currency": "EUR", "financialCurrency": "EUR",
           "currentPrice": 38.0}, income_with_eps(2.0))["value"], 19.0)

print("\n── the sanity ceiling catches what the rules above do not ──")
# A hypothetical unit error on a listing with no suffix and no currency hint.
check("absurd multiple refused",
      key_of(az.metric_pe_ratio({"symbol": "AAA", "currency": "USD", "currentPrice": 100000.0},
                                income_with_eps(2.0))), "pe_not_reported")
check("just under the ceiling still allowed",
      az.metric_pe_ratio({"symbol": "AAA", "currency": "USD", "currentPrice": 998.0},
                         income_with_eps(2.0))["value"], 499.0)

print("\n── the case the fallback was BUILT for still works ──")
# 2026-08-08: a degraded response omitted trailingPE and the app told users
# Apple "isn't profitable yet" beside 26.9% net margin. That must stay fixed.
AAPL = {"symbol": "AAPL", "currency": "USD", "financialCurrency": "USD",
        "currentPrice": 227.52}
res = az.metric_pe_ratio(AAPL, income_with_eps(6.08))
# 227.52 / 6.08 = 37.421..., reported to one decimal like every other multiple.
check("computes a real multiple", res["value"], 37.4)
check("marked as computed, not provider-supplied",
      [k for k, _ in res["explanation_parts"]][-1], "pe_computed")
check("does NOT claim the company is unprofitable",
      "pe_not_profitable" in [k for k, _ in res["explanation_parts"]], False)

print("\n── financialCurrency absent is not fatal for a plain US listing ──")
# It WAS absent for ORA.TA, so the guard cannot demand it — otherwise the
# degraded-Apple fix becomes dead code and the 2026-08-08 lie returns.
check("USD quote, no financialCurrency -> still computes",
      az.metric_pe_ratio({"symbol": "AAPL", "currency": "USD", "currentPrice": 227.52},
                         income_with_eps(6.08))["value"], 37.4)

print("\n── the other two verdicts are unchanged ──")
check("genuinely unprofitable",
      key_of(az.metric_pe_ratio({"symbol": "X", "currency": "USD", "currentPrice": 10.0},
                                income_with_eps(-1.5))), "pe_not_profitable")
check("no EPS at all -> not reported",
      key_of(az.metric_pe_ratio({"symbol": "X", "currency": "USD", "currentPrice": 10.0},
                                None)), "pe_not_reported")
check("provider trailingPE is passed straight through (a ratio has no units)",
      az.metric_pe_ratio({"symbol": "ORA.TA", "currency": "ILA", "trailingPE": 56.6},
                         income_with_eps(2.02))["value"], 56.6)

print("\n── junk info must not raise ──")
for name, info in [("None", None), ("a list", [1, 2]), ("a string", "info"),
                   ("empty dict", {}), ("currency is a number", {"currency": 840})]:
    try:
        az._price_eps_units_agree(info)
        check("%s -> no exception" % name, True, True)
    except Exception as e:
        check("%s -> no exception" % name, "raised %r" % (e,), "no exception")

print("\n" + ("PASS — all checks green" if not FAILURES
              else "FAIL — %d: %s" % (len(FAILURES), ", ".join(FAILURES))))
sys.exit(1 if FAILURES else 0)

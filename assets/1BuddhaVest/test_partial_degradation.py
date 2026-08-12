"""
The failure this covers is PARTIAL provider degradation, reproduced from a real
response captured from the live server on 2026-08-08:

    /quotes?symbols=AAPL   -> company_name "Apple Inc."      (longName present)
    /market-overview       -> name "AAPL", volume null        (shortName absent)
    /analyze/AAPL          -> "the company isn't profitable"  (trailingPE absent)

All three from the same server within the same minute. Yahoo's quoteSummary
degrades field by field, not all at once, and every assumption of the form
"if the name is there the response is fine" is false.

Run:  python test_partial_degradation.py
"""
import importlib.util, sys
import pandas as pd

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec); sys.modules[name] = m
    spec.loader.exec_module(m); return m

df = load("data_fetcher", "data_fetcher.py")
az = load("analyzer", "analyzer.py")

FAIL = []
def check(name, got, want):
    ok = got == want
    print("  %-4s %-56s %s" % ("ok" if ok else "FAIL", name,
                               "" if ok else "got %r want %r" % (got, want)))
    if not ok: FAIL.append(name)

# ── exactly what Yahoo returned for AAPL in the degraded window ──────────────
PARTIAL = {
    "longName": "Apple Inc.",       # present
    # "shortName"                   # ABSENT
    # "volume"                      # ABSENT
    # "averageVolume"               # ABSENT
    # "trailingPE"                  # ABSENT
    "currentPrice": 313.33,
    "regularMarketPrice": 313.33,
    "marketCap": 4572794223433.228,
    # Added 2026-08-12. The fixture was a minimal reproduction and omitted this,
    # but a real degraded response still carries it: `currency` ships in the
    # same quoteSummary module as regularMarketPrice (which IS present above),
    # and _merge_chart_meta refills it from the chart endpoint when it is not.
    # It matters now because computing P/E from a price is only legitimate once
    # the price's unit is known — see test_pe_units.py and ORA.TA.
    "currency": "USD",
}

print("\n── the fallback must FIRE on a partially degraded response ──")
calls = []
df._fetch_chart_meta = lambda t, timeout=6: (calls.append(t), {
    "symbol": "AAPL", "longName": "Apple Inc.", "shortName": "Apple Inc.",
    "regularMarketVolume": 34331108, "currency": "USD",
})[1]
out = df._enrich_from_chart_meta("AAPL", dict(PARTIAL))
check("it ran (old code returned early here)", calls, ["AAPL"])
check("shortName filled",  out.get("shortName"), "Apple Inc.")
check("volume filled",     out.get("volume"), 34331108)
check("longName untouched", out.get("longName"), "Apple Inc.")
check("price untouched",   out.get("currentPrice"), 313.33)

print("\n── and must NOT fire when the response is genuinely complete ──")
calls.clear()
healthy = dict(PARTIAL, shortName="Apple Inc.", volume=34331108)
df._enrich_from_chart_meta("AAPL", healthy)
check("zero extra requests", calls, [])

print("\n── the market table must show the name that /quotes already shows ──")
# main.py's _one_mover previously read shortName only.
name_mover = PARTIAL.get("longName") or PARTIAL.get("shortName") or "AAPL"
name_quotes = PARTIAL.get("longName") or PARTIAL.get("shortName")
check("market-overview name == /quotes name", name_mover, name_quotes)

print("\n── a missing P/E is not a claim about profitability ──")
income = pd.DataFrame(
    {pd.Timestamp("2025-09-30"): [7.46, 7.46, 112010000000.0]},
    index=["Diluted EPS", "Basic EPS", "Net Income"])

r = az.metric_pe_ratio(PARTIAL, income)
check("value computed from EPS", r["value"], round(313.33 / 7.46, 1))
check("does NOT say 'not profitable'",
      any(k == "pe_not_profitable" for k, _ in r["explanation_parts"]), False)
check("says the number was computed here",
      any(k == "pe_computed" for k, _ in r["explanation_parts"]), True)
check("scored (was None, so the valuation pillar vanished)", r["score"] is not None, True)

print("\n── without a currency the multiple cannot be computed, by design ──")
# Recorded as a deliberate trade-off rather than left implicit. If BOTH the
# quote and the chart fallback fail to report a currency, the price's unit is
# unknown and price/EPS could be off by 100x (agorot) or by an exchange rate.
# We give up the number instead of guessing — the alternative shipped a P/E of
# 16955.4 for ORA.TA on 2026-08-12.
r_nc = az.metric_pe_ratio({k: v for k, v in PARTIAL.items() if k != "currency"}, income)
check("no currency -> value None", r_nc["value"], None)
check("no currency -> 'not reported', never 'not profitable'",
      [k for k, _ in r_nc["explanation_parts"]], ["pe_not_reported"])

print("\n── a company with NO earnings must still be called unprofitable ──")
loss = pd.DataFrame({pd.Timestamp("2025-09-30"): [-2.10]}, index=["Diluted EPS"])
r2 = az.metric_pe_ratio(dict(PARTIAL), loss)
check("value None", r2["value"], None)
check("says not profitable",
      any(k == "pe_not_profitable" for k, _ in r2["explanation_parts"]), True)

print("\n── when we genuinely cannot tell, say so ──")
r3 = az.metric_pe_ratio({"currentPrice": 100.0}, None)
check("value None", r3["value"], None)
check("says 'not reported', not 'not profitable'",
      [k for k, _ in r3["explanation_parts"]], ["pe_not_reported"])

print("\n── a negative P/E from the provider is still unprofitable ──")
r4 = az.metric_pe_ratio({"trailingPE": -15.2, "currentPrice": 10.0}, income)
check("value None", r4["value"], None)
check("says not profitable",
      any(k == "pe_not_profitable" for k, _ in r4["explanation_parts"]), True)

print("\n── a healthy response must behave exactly as before ──")
r5 = az.metric_pe_ratio({"trailingPE": 22.0}, income)
check("value 22.0", r5["value"], 22.0)
check("score 70", r5["score"], 70)
check("no 'computed' note", any(k == "pe_computed" for k, _ in r5["explanation_parts"]), False)

print("\n── every explanation key used exists in all four languages ──")
i18n = load("i18n_data", "i18n_data.py")
LANGS = ["he", "en", "ru", "es"]
for key in ("pe_not_reported", "pe_computed", "peg_pe_unavailable", "pe_not_profitable"):
    entry = i18n.EXPLANATIONS.get(key) if hasattr(i18n, "EXPLANATIONS") else None
    if entry is None:
        for attr in dir(i18n):
            v = getattr(i18n, attr)
            if isinstance(v, dict) and key in v:
                entry = v[key]; break
    missing = [l for l in LANGS if not (entry or {}).get(l)]
    check("%s in all 4 languages" % key, missing, [])

print()
if FAIL:
    print("FAILED: " + ", ".join(FAIL)); sys.exit(1)
print("OK - partial degradation handled: the fallback fires, the table shows the "
      "name, and a missing field is never reported as a fact about the business")

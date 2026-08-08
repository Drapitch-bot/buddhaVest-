"""
Tests for the second data provider (_merge_chart_meta / _enrich_from_chart_meta).

Why these exist in this shape: the merge runs ONLY when the primary source has
already failed, so it executes exactly when nobody is watching and its output is
whatever the user then sees. It is also the piece most likely to be wrong in a
way that looks right — a second provider that quietly overwrites a correct value
with a stale one is worse than no second provider at all.

The fetch is not tested against the live endpoint here on purpose: this suite
must pass offline and in CI. The merge — every branch of it — is.

Run:  python test_chart_meta.py
"""

import importlib.util
import sys

spec = importlib.util.spec_from_file_location("data_fetcher", "data_fetcher.py")
df = importlib.util.module_from_spec(spec)
sys.modules["data_fetcher"] = df
spec.loader.exec_module(df)

merge = df._merge_chart_meta

FAILURES = []


def check(name, got, want):
    ok = got == want
    print("  %-4s %-58s %s" % ("ok" if ok else "FAIL", name,
                               "" if ok else "got %r want %r" % (got, want)))
    if not ok:
        FAILURES.append(name)


# A meta block in the shape the v8 chart endpoint returns. The app's own
# MetricHistoryScreen already consumes chart.result[0] from this endpoint, so
# the envelope is one this codebase relies on in production.
HEALTHY = {
    "currency": "USD",
    "symbol": "AAPL",
    "exchangeName": "NMS",
    "fullExchangeName": "NasdaqGS",
    "longName": "Apple Inc.",
    "shortName": "Apple Inc.",
    "regularMarketPrice": 227.52,
    "chartPreviousClose": 225.77,
    "regularMarketVolume": 42217700,
}

print("\n── rule 1: it may only ADD, never overwrite ──")
# This is the whole safety argument for a second provider. If it can overwrite,
# a stale or wrong reading replaces a correct one and nothing signals it.
good = {
    "longName": "Apple Inc. (primary)",
    "shortName": "AAPL Primary",
    "currentPrice": 999.99,
    "previousClose": 998.0,
    "volume": 123,
    "regularMarketVolume": 123,
    "currency": "USD",
    "exchange": "PrimaryExchange",
}
out = merge(good, HEALTHY)
for k, v in good.items():
    check("keeps primary %s" % k, out[k], v)

print("\n── rule 2: it fills what is genuinely missing ──")
out = merge({}, HEALTHY)
check("longName",            out.get("longName"), "Apple Inc.")
check("shortName",           out.get("shortName"), "Apple Inc.")
check("currentPrice",        out.get("currentPrice"), 227.52)
check("regularMarketPrice",  out.get("regularMarketPrice"), 227.52)
check("previousClose",       out.get("previousClose"), 225.77)
check("volume is int",       out.get("volume"), 42217700)
check("currency",            out.get("currency"), "USD")
check("exchange (prefers fullExchangeName)", out.get("exchange"), "NasdaqGS")

print("\n── the degraded case this exists for: price survives, name does not ──")
# Exactly what a throttled quoteSummary looks like — fast_info filled the price,
# nothing filled the name.
throttled = {"currentPrice": 227.52, "regularMarketPrice": 227.52}
out = merge(throttled, HEALTHY)
check("name recovered",      out.get("longName"), "Apple Inc.")
check("price NOT touched",   out.get("currentPrice"), 227.52)
check("volume recovered",    out.get("volume"), 42217700)

print("\n── a name that is just the symbol is not a name ──")
# Accepting it would write "AAPL" into longName and permanently mask the very
# degradation this is meant to repair.
check("longName == symbol rejected",
      merge({}, dict(HEALTHY, longName="AAPL", shortName="AAPL")).get("longName"), None)
check("lower-case symbol match rejected",
      merge({}, dict(HEALTHY, longName="aapl", shortName="aapl")).get("longName"), None)
check("whitespace-padded symbol rejected",
      merge({}, dict(HEALTHY, longName="  AAPL  ", shortName="  AAPL  ")).get("longName"), None)
check("a real name is accepted",
      merge({}, dict(HEALTHY, longName="Apple Inc.")).get("longName"), "Apple Inc.")

print("\n── currency case is significant: GBp (pence) != GBP (pounds) ──")
# Upper-casing here would turn a London price into a 100x error, which is a bug
# this app has already shipped once.
check("GBp preserved verbatim", merge({}, dict(HEALTHY, currency="GBp")).get("currency"), "GBp")
check("ILA preserved verbatim", merge({}, dict(HEALTHY, currency="ILA")).get("currency"), "ILA")
check("ZAc preserved verbatim", merge({}, dict(HEALTHY, currency="ZAc")).get("currency"), "ZAc")

print("\n── junk must be rejected, not stored ──")
JUNK = [
    ("meta is None",            None,                                   {}),
    ("meta is a list",          [1, 2, 3],                              {}),
    ("meta is a string",        "not a dict",                           {}),
    ("meta is empty",           {},                                     {}),
    ("price is None",           {"regularMarketPrice": None},           {}),
    ("price is a string",       {"regularMarketPrice": "not a number"}, {}),
    ("price is a bool",         {"regularMarketPrice": True},           {}),
    ("price is NaN",            {"regularMarketPrice": float("nan")},   {}),
    ("price is inf",            {"regularMarketPrice": float("inf")},   {}),
    ("volume is negative",      {"regularMarketVolume": -5},            {}),
    ("name is a number",        {"longName": 12345},                    {}),
    ("name is blank",           {"longName": "   ", "shortName": ""},   {}),
    ("currency is blank",       {"currency": "   "},                    {}),
    ("currency is a number",    {"currency": 840},                      {}),
]
for name, meta, base in JUNK:
    try:
        out = merge(dict(base), meta)
        polluted = {k: v for k, v in out.items() if k not in base}
        check(name + " -> nothing stored", polluted, {})
    except Exception as e:
        check(name + " -> no exception", "raised %r" % (e,), "no exception")

print("\n── numeric strings are accepted (Yahoo does send them) ──")
check("price '227.52'", merge({}, {"regularMarketPrice": "227.52"}).get("currentPrice"), 227.52)
check("volume '42217700'", merge({}, {"regularMarketVolume": "42217700"}).get("volume"), 42217700)

print("\n── the input dict is never mutated ──")
# A merge that edits its argument would let a rejected payload leak into the
# caller's info even when the merge result is discarded.
original = {"currentPrice": 100.0}
snapshot = dict(original)
merge(original, HEALTHY)
check("caller's dict unchanged", original, snapshot)

print("\n── _enrich_from_chart_meta skips the fetch entirely when healthy ──")
# "Healthy" means every field the callers actually read is present: BOTH name
# fields (main.py's _one_mover reads shortName, /quotes reads longName) and a
# volume. This fixture used to be {longName, currentPrice} only and was called
# healthy — which is precisely the partially degraded shape measured live on
# 2026-08-08, and precisely why the fallback never fired when it was needed.
COMPLETE = {"longName": "Apple Inc.", "shortName": "Apple Inc.",
            "currentPrice": 227.52, "volume": 42217700}
calls = []
real_fetch = df._fetch_chart_meta
df._fetch_chart_meta = lambda t, timeout=6: (calls.append(t), HEALTHY)[1]
try:
    df._enrich_from_chart_meta("AAPL", dict(COMPLETE))
    check("complete info -> zero extra requests", calls, [])
    df._enrich_from_chart_meta("AAPL", dict(COMPLETE, longName=None, shortName=None))
    check("no name -> one request", calls, ["AAPL"])
    calls.clear()
    df._enrich_from_chart_meta("AAPL", dict(COMPLETE, shortName=None))
    check("longName but no shortName -> one request", calls, ["AAPL"])
    calls.clear()
    df._enrich_from_chart_meta("AAPL", dict(COMPLETE, volume=None))
    check("names but no volume -> one request", calls, ["AAPL"])
    calls.clear()
    df._enrich_from_chart_meta("AAPL", {})
    check("empty info -> one request", calls, ["AAPL"])
    calls.clear()
    df._fetch_chart_meta = lambda t, timeout=6: None
    got = df._enrich_from_chart_meta("AAPL", {"currentPrice": 1.0})
    check("fetch returns None -> info unchanged", got, {"currentPrice": 1.0})
    # If the fetch layer ever stopped being total, the fallback for a DEGRADED
    # response would turn it into a 502 — the exact failure it exists to
    # prevent. _enrich_from_chart_meta guards it a second time.
    def boom(t, timeout=6):
        raise RuntimeError("network on fire")
    df._fetch_chart_meta = boom
    try:
        got = df._enrich_from_chart_meta("AAPL", {"currentPrice": 1.0})
        check("fetch raises -> info returned unchanged", got, {"currentPrice": 1.0})
    except Exception as e:
        check("fetch raises -> no exception escapes", "raised %r" % (e,), "info unchanged")
finally:
    df._fetch_chart_meta = real_fetch

print("\n── _fetch_chart_meta itself never raises, whatever the network does ──")
import urllib.request
real_urlopen = urllib.request.urlopen
for name, exc in [("connection refused", OSError("refused")),
                  ("timeout", TimeoutError("timed out")),
                  ("weird error", RuntimeError("???"))]:
    def _raise(*a, **k):
        raise exc
    urllib.request.urlopen = _raise
    try:
        check("%s -> returns None" % name, df._fetch_chart_meta("AAPL"), None)
    except Exception as e:
        check("%s -> no exception" % name, "raised %r" % (e,), "returns None")
urllib.request.urlopen = real_urlopen

print()
if FAILURES:
    print("FAILED: %d\n  %s" % (len(FAILURES), "\n  ".join(FAILURES)))
    sys.exit(1)
print("OK - second provider: adds only, rejects junk, never raises, costs nothing when healthy")

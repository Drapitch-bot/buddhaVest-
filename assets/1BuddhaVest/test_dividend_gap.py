"""
A long payment span is not the same as an unbroken one.

Reproduces the Disney case measured on 2026-08-08: the app reported
"payment history spanning about 64.3 years" and scored it 85, while the
dividend had actually been suspended in May 2020 and only reinstated in
December 2023 — a three-year hole that ended barely two years earlier.
The span was arithmetically correct; the impression it left was not.

Run:  python test_dividend_gap.py
"""
import importlib.util, sys
import pandas as pd

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec); sys.modules[name] = m
    spec.loader.exec_module(m); return m

az = load("analyzer", "analyzer.py")
i18n = load("i18n_data", "i18n_data.py")

FAIL = []
def check(name, ok, detail=""):
    print("  %-4s %-54s %s" % ("ok" if ok else "FAIL", name, detail))
    if not ok: FAIL.append(name)

def series(dates):
    return pd.Series([0.5]*len(dates), index=pd.to_datetime(dates))

INFO = {"dividendYield": 1.43, "currentPrice": 104.91}

print("\n── Disney: 64-year span with a three-year suspension ──")
# quarterly from 1962, stops after May 2020, resumes Dec 2023, continues
dates = list(pd.date_range("1962-04-01", "2020-05-01", freq="QE")) \
      + list(pd.date_range("2023-12-01", "2026-08-01", freq="QE"))
r = az.metric_dividend(INFO, series(dates))
keys = [k for k, _ in r["explanation_parts"]]
span = next((v["years"] for k, v in r["explanation_parts"] if k == "div_consistent"), None)
gap  = next((v for k, v in r["explanation_parts"] if k == "div_gap"), None)
check("still reports the long span", span is not None and span > 60, "span=%s" % span)
check("NOW also reports the interruption", gap is not None, str(gap))
check("gap length is about 3.5 years", gap and 3.0 <= gap["years"] <= 4.0, gap and gap["years"])
check("says when it resumed", gap and gap["resumed"].endswith("2023"), gap and gap["resumed"])
check("score reduced from 85", r["score"] < 85, "score=%d" % r["score"])
check("but still positive — it does pay", r["score"] >= 50, "score=%d" % r["score"])

print("\n── an unbroken 60-year payer must be unaffected ──")
clean = list(pd.date_range("1962-04-01", "2026-08-01", freq="QE"))
r2 = az.metric_dividend(INFO, series(clean))
k2 = [k for k, _ in r2["explanation_parts"]]
check("no interruption reported", "div_gap" not in k2, ",".join(k2))
check("keeps the full score", r2["score"] == 85, "score=%d" % r2["score"])

print("\n── an ANNUAL payer is not an interruption ──")
annual = list(pd.date_range("2000-06-01", "2026-06-01", freq="YE"))
r3 = az.metric_dividend(INFO, series(annual))
check("12-month cadence not flagged",
      "div_gap" not in [k for k, _ in r3["explanation_parts"]])

print("\n── an OLD interruption counts less than a recent one ──")
old_gap = list(pd.date_range("1970-01-01", "1980-01-01", freq="QE")) \
        + list(pd.date_range("1985-01-01", "2026-08-01", freq="QE"))
r4 = az.metric_dividend(INFO, series(old_gap))
recent = next((v for k, v in r["explanation_parts"] if k == "div_gap"), None)
check("old gap scores higher than a recent one", r4["score"] > r["score"],
      "old=%d recent=%d" % (r4["score"], r["score"]))

print("\n── edge cases must not raise ──")
for name, s in [("empty", pd.Series(dtype=float)),
                ("single payment", series(["2026-01-01"])),
                ("None", None)]:
    try:
        az.metric_dividend(INFO, s)
        check("%s -> no exception" % name, True)
    except Exception as e:
        check("%s -> no exception" % name, False, repr(e))

print("\n── div_gap exists in all four languages, with both placeholders ──")
entry = None
for attr in dir(i18n):
    v = getattr(i18n, attr)
    if isinstance(v, dict) and "div_gap" in v:
        entry = v["div_gap"]; break
for lang in ("he", "en", "ru", "es"):
    txt = (entry or {}).get(lang, "")
    check("%s" % lang, bool(txt) and "{years}" in txt and "{resumed}" in txt, txt[:52])

print()
if FAIL:
    print("FAILED: " + ", ".join(FAIL)); sys.exit(1)
print("OK - a long span with a hole in it no longer reads, or scores, like an unbroken one")

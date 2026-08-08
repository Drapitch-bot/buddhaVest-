"""
One event per problem, not one per occurrence.

On 2026-08-08 Sentry went live and immediately caught a real Yahoo 401 on
/market-overview. Good — that is what it is for. But it also showed the shape
of the risk: /market-overview fetches 15 tickers and refreshes every 60s, so a
sustained Yahoo outage produces ~900 identical reports an hour. Sentry's free
tier allows 5,000 errors a MONTH, so six hours of one repeated fact would burn
the whole quota and the next genuinely new bug would be silently dropped.

Run:  python test_sentry_throttle.py
"""
import importlib.util, sys, os, io, contextlib

os.environ.pop("SENTRY_DSN", None)
spec = importlib.util.spec_from_file_location("observability", "observability.py")
ob = importlib.util.module_from_spec(spec)
sys.modules["observability"] = ob
spec.loader.exec_module(ob)

FAIL = []
def check(name, ok, detail=""):
    print("  %-4s %-56s %s" % ("ok" if ok else "FAIL", name, detail))
    if not ok: FAIL.append(name)

# stand in for the network call, keeping the real throttling decision
ob._SENTRY = True
sent = []
def fake_to_sentry(kind, line, fields, level):
    send, held = ob._should_send((kind, fields.get("at") or fields.get("ticker") or ""))
    if send:
        sent.append({"kind": kind, "at": fields.get("at"), "held": held})
ob._to_sentry = fake_to_sentry

def quiet(fn, *a, **k):
    with contextlib.redirect_stdout(io.StringIO()) as buf:
        fn(*a, **k)
    return buf.getvalue()

print("\n── an hour of Yahoo refusing every request ──")
logged = 0
for _ in range(900):
    logged += len(quiet(ob.swallow, "data_fetcher:get_quote",
                        ValueError("401 Unauthorized"), notify=True, ticker="AAPL").strip().split("\n"))
check("900 identical failures -> 1 Sentry event", len(sent) == 1, "%d event(s)" % len(sent))
check("every one still written to the log", logged == 900, "%d log lines" % logged)

print("\n── 15 tickers failing from the SAME cause is one problem ──")
before = len(sent)
for t in ("MSFT", "NVDA", "GOOGL", "AMZN", "TSLA"):
    quiet(ob.swallow, "data_fetcher:get_quote", ValueError("401"), notify=True, ticker=t)
check("grouped, not one per ticker", len(sent) == before, "%d new" % (len(sent) - before))

print("\n── a DIFFERENT problem is never suppressed by a noisy one ──")
before = len(sent)
quiet(ob.swallow, "analyzer:metric_dividend", ValueError("boom"), notify=True)
quiet(ob.report, "empty_chart", ticker="AMD", metric="pe_ratio", reason="no_eps_series")
check("both got through", len(sent) - before == 2, "%d new" % (len(sent) - before))

print("\n── after the window, it reports again AND says how many it held ──")
ob._SENTRY_THROTTLE_SECONDS = 0
quiet(ob.swallow, "data_fetcher:get_quote", ValueError("401"), notify=True, ticker="AAPL")
last = sent[-1]
check("sent again", last["at"] == "data_fetcher:get_quote")
check("carries the suppressed count", last["held"] >= 900,
      "held=%s — a throttled event must not look like a one-off" % last["held"])

print("\n── the throttle table cannot grow without bound ──")
ob._SENTRY_THROTTLE_SECONDS = 300
for i in range(2000):
    quiet(ob.swallow, "site_%d" % i, ValueError("x"), notify=True)
check("bounded", len(ob._last_sent) <= 600, "%d entries" % len(ob._last_sent))

print("\n── throttling must never raise ──")
try:
    quiet(ob.swallow, "t", None, notify=True)
    quiet(ob.report, "k")
    check("no exception", True)
except Exception as e:
    check("no exception", False, repr(e))

print()
if FAIL:
    print("FAILED: " + ", ".join(FAIL)); sys.exit(1)
print("OK - a repeated failure costs one event; a new failure is never crowded out")

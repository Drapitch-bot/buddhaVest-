"""Exercise all three LKG backends, including a real HTTP server standing in for Upstash."""
import os
import importlib.util, sys, json, threading, warnings, http.server, socketserver, io, contextlib
sys.path.insert(0, os.getcwd())
warnings.filterwarnings("ignore")
for _p in ("ALL_PROXY","all_proxy","HTTP_PROXY","http_proxy","HTTPS_PROXY","https_proxy"):
    os.environ.pop(_p, None)

STORE = {}
CALLS = []

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        cmd = json.loads(self.rfile.read(n).decode())
        CALLS.append((cmd[0], self.headers.get('Authorization')))
        if cmd[0] == 'SET':
            STORE[cmd[1]] = cmd[2]; result = 'OK'
        elif cmd[0] == 'GET':
            result = STORE.get(cmd[1])
        else:
            result = None
        body = json.dumps({"result": result}).encode()
        self.send_response(200); self.send_header('Content-Type','application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass

srv = socketserver.TCPServer(("127.0.0.1", 0), Handler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

def load(env):
    for k in ("UPSTASH_REDIS_REST_URL","UPSTASH_REDIS_REST_TOKEN","LKG_DIR","RENDER_DISK_PATH"):
        os.environ.pop(k, None)
    os.environ.update(env)
    for m in list(sys.modules):
        if m in ("bvmain",): del sys.modules[m]
    spec = importlib.util.spec_from_file_location("bvmain", "main.py")
    m = importlib.util.module_from_spec(spec); sys.modules["bvmain"] = m
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        spec.loader.exec_module(m)
    return m, buf.getvalue()

FAIL = []
def check(name, ok, detail=""):
    print("  %-4s %-52s %s" % ("ok" if ok else "FAIL", name, detail))
    if not ok: FAIL.append(name)

print("\n── backend 3: /tmp (no config) — must say EPHEMERAL ──")
m, log = load({})
check("startup log is honest", "EPHEMERAL" in log, [l for l in log.split('\n') if 'LKG store' in l][0])
check("_LKG_PERSISTENT is False", m._LKG_PERSISTENT is False)

print("\n── backend 2: mounted disk — must say persistent ──")
os.makedirs("/var/tmp/fake_disk", exist_ok=True)
m, log = load({"LKG_DIR": "/var/tmp/fake_disk"})
check("startup log says persistent", "persistent" in log and "EPHEMERAL" not in log,
      [l for l in log.split('\n') if 'LKG store' in l][0])
check("_LKG_PERSISTENT is True", m._LKG_PERSISTENT is True)

print("\n── backend 1: Upstash Redis ──")
env = {"UPSTASH_REDIS_REST_URL": "http://127.0.0.1:%d/" % port,
       "UPSTASH_REDIS_REST_TOKEN": "tok_secret"}
m, log = load(env)
check("startup log says Redis + persistent", "Upstash Redis" in log and "persistent" in log,
      [l for l in log.split('\n') if 'LKG store' in l][0])
check("_LKG_PERSISTENT is True", m._LKG_PERSISTENT is True)
check("boot issued a GET", any(c[0]=='GET' for c in CALLS))
check("bearer token sent", any(c[1]=='Bearer tok_secret' for c in CALLS))
check("empty Redis -> clean message", "first run against this Redis" in log)

print("\n── round trip: save then reload in a FRESH process-equivalent ──")
m._cache_set("mover_lkg", {"AAPL": {"volume": 42217700, "market_cap": 3.4e12}}, 86400)
m._cache_set("analyze_overview_lkg", {"SHEL.L": {"avg_volume": 8123456}}, 86400)
m._lkg_file_save()
check("SET reached Redis", any(c[0]=='SET' for c in CALLS))
check("value stored under the right key", "buddhavest:lkg" in STORE)

m2, log2 = load(env)                       # simulates a deploy: brand new process
check("restored after 'deploy'", "LKG restored: 2 entries" in log2, log2.strip().split('\n')[-1])
got = m2._cache_get("mover_lkg")
check("values survived intact", got == {"AAPL": {"volume": 42217700, "market_cap": 3.4e12}}, str(got))

print("\n── Redis unreachable must NOT stop the server booting ──")
srv.shutdown()
m3, log3 = load({"UPSTASH_REDIS_REST_URL": "http://127.0.0.1:%d/" % port,
                 "UPSTASH_REDIS_REST_TOKEN": "tok_secret"})
check("server still booted", hasattr(m3, "app"))
check("said so in the log", "starting empty" in log3, log3.strip().split('\n')[-1][:80])
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    m3._lkg_file_save()                    # must not raise
check("save with dead Redis does not raise", True, buf.getvalue().strip()[:70])

print("\n── writes are coalesced, not one per request ──")
# The whole reason this matters: at the rate limit's ceiling an immediate write
# would be ~28,800 Redis commands/day, past Upstash's free tier.
m4, _ = load(env)
writes = []
m4._lkg_file_save = lambda: writes.append(1)
m4._LKG_FLUSH_SECONDS = 0.25
threading.Thread(target=m4._lkg_flush_loop, daemon=True).start()
import time as _t
for _ in range(500):
    m4._lkg_mark_dirty()          # 500 "requests"
_t.sleep(0.6)
check("500 marks -> at most 2 flushes", len(writes) <= 2, "%d flush(es)" % len(writes))
check("but it DID flush", len(writes) >= 1)
before = len(writes)
_t.sleep(0.6)
check("idle period writes nothing", len(writes) == before, "%d -> %d" % (before, len(writes)))

print()
if FAIL:
    print("FAILED: " + ", ".join(FAIL)); sys.exit(1)
print("OK - all three LKG backends behave, and the startup log always tells the truth")

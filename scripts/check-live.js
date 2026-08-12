/**
 * check-live.js — answers "is what I was told actually true?" without asking anyone.
 *
 * Why this exists: over one session the same question came up four times —
 * is the fix deployed, is Upstash connected, is Sentry reporting, did the push
 * land — and every answer depended on trusting a report instead of reading a
 * fact. Twice the report was wrong: a deploy was called "failing" when it had
 * succeeded, and persistence was called "done" while the server was still
 * wiping it on every release.
 *
 * This reads the facts directly:
 *   - git: is everything committed and pushed
 *   - /status: which commit is actually running, and what is really switched on
 *   - the two compared: is the running code the code on this machine
 *
 * No arguments, no setup, no Python. Run it any time:  .\check.bat
 */

const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const URL = 'https://buddhavest.onrender.com/status';

// Must stay identical to _SOURCE_FILES in main.py, including the framing below,
// or the two digests will differ for identical code.
const SOURCE_FILES = [
  'main.py', 'analyzer.py', 'data_fetcher.py', 'observability.py',
  'i18n_data.py', 'news_signals.py', 'stooq_fallback.py', 'ticker_search.py',
];

/**
 * The same digest main.py computes, over the files in this working copy.
 * Carriage returns are stripped first: git checks these out CRLF on Windows
 * and LF on Render's Linux builders, so raw bytes would differ for identical
 * code and this check would fail every single time.
 */
function localDigest() {
  try {
    const root = execSync('git rev-parse --show-toplevel',
                          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dir = path.join(root, 'assets', '1BuddhaVest');
    const h = crypto.createHash('sha256');
    const NUL = Buffer.from([0]);
    for (const name of [...SOURCE_FILES].sort()) {
      let bytes;
      try {
        bytes = fs.readFileSync(path.join(dir, name));
      } catch {
        bytes = Buffer.alloc(0);      // absence is part of the fingerprint
      }
      h.update(Buffer.from(name, 'utf8'));
      h.update(NUL);
      h.update(Buffer.from(bytes.toString('binary').split('\r\n').join('\n'), 'binary'));
      h.update(NUL);
    }
    return h.digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}
const RESET = '\x1b[0m', RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', DIM = '\x1b[2m';

function git(args) {
  try {
    return execSync('git ' + args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function row(label, state, detail) {
  const mark = state === 'ok' ? GREEN + '  OK  ' + RESET
             : state === 'warn' ? YELLOW + ' WARN ' + RESET
             : state === 'bad' ? RED + ' FAIL ' + RESET
             : DIM + '  ??  ' + RESET;
  console.log(mark + label.padEnd(34) + (detail || ''));
}

(async () => {
  console.log('\nBuddhaVest — what is actually true right now\n');

  // ── 1. this machine ───────────────────────────────────────────────────────
  const dirty = git('status --porcelain');
  const head = git('rev-parse --short HEAD');
  const headFull = git('rev-parse HEAD');
  const remote = git('rev-parse @{u}') || git('rev-parse origin/main');

  const realDirty = (dirty || '').split('\n')
    .filter(l => l.trim() && !/story\.txt$/.test(l));   // CRLF churn, not a real change

  row('everything committed', realDirty.length ? 'bad' : 'ok',
      realDirty.length ? realDirty.length + ' uncommitted file(s): '
                         + realDirty.map(l => l.slice(3)).join(', ').slice(0, 70)
                       : 'working tree clean');

  row('pushed to GitHub',
      remote == null ? 'unknown' : (remote === headFull ? 'ok' : 'bad'),
      remote == null ? 'could not read the remote ref — run: git fetch'
                     : (remote === headFull ? 'local == origin (' + head + ')'
                                            : 'local ' + head + ' is AHEAD of origin — run: .\\push.bat'));

  // ── 2. the live server ────────────────────────────────────────────────────
  let body = null, err = null;
  try {
    const res = await fetch(URL + '?cb=' + Date.now(), { cache: 'no-store' });
    body = await res.json();
  } catch (e) {
    err = e.message;
  }

  if (!body) {
    row('server reachable', 'bad', err || 'no response');
    console.log('\n' + DIM + '(a free Render instance sleeps after 15 min — the first call can take ~50s)' + RESET + '\n');
    process.exit(1);
  }
  row('server reachable', 'ok', URL);

  // ── 3. is the running code the code on this machine ───────────────────────
  // Three separate delivery paths, and conflating them cries wolf:
  //   assets/1BuddhaVest/**  -> Render          (git push, ~3-6 min)
  //   screens|components|constants|utils|App.js -> EAS OTA (force-close the app)
  //   scripts, .github, docs -> neither; they never reach a server or a phone
  // A commit that only adds a script is not a stale deployment, and saying so
  // would train you to ignore this line — which is the whole point of it.
  const SERVER = /^assets\/1BuddhaVest\//;
  const CLIENT = /^(screens|components|constants|utils)\/|^App\.js$|^index\.js$|^app\.json$/;

  // The authoritative check is the source digest, NOT the commit.
  //
  // On 2026-08-12 Render deployed a fix, the live endpoint provably ran it
  // (ORA.TA stopped printing a P/E of 16955.4), and /status still reported a
  // commit from two pushes earlier. RENDER_GIT_COMMIT is an environment
  // variable: it says what Render was told, not what is running. This script
  // trusted it, so it would have reported a successful deploy as a failure —
  // the same cry-wolf failure it was written to avoid.
  //
  // A digest of the server source files cannot drift, because it is computed
  // from the bytes the process actually loaded.
  let serverStale = false;
  const localCode = localDigest();

  if (typeof body.code === 'string' && body.code !== 'unknown' && localCode) {
    if (body.code === localCode) {
      row('deployed server code', 'ok',
          'digest ' + localCode + ' — byte-for-byte the code in this folder');
    } else {
      serverStale = true;
      const names = SOURCE_FILES.join(', ');
      row('deployed server code', 'bad',
          'digest server=' + body.code + ' local=' + localCode
          + ' — the server is NOT running this code (' + names.slice(0, 48) + '…)');
    }
    row('commit reported by Render', body.build === head ? 'ok' : 'warn',
        body.build === head
          ? body.build + ' — matches HEAD'
          : 'build=' + body.build + ' vs HEAD=' + head
            + ' — advisory only; RENDER_GIT_COMMIT can be stale, the digest above is the truth');
  } else if (!('build' in body)) {
    serverStale = true;
    row('deployed commit', 'bad',
        'the running server predates the /status build field — it is NOT running your latest code');
  } else if (!head) {
    row('deployed commit', 'unknown', 'build=' + body.build);
  } else if (body.build === head) {
    row('deployed commit', 'ok', body.build + ' — the server is running THIS code');
  } else {
    const changed = (git(`diff --name-only ${body.build}..${headFull}`) || '').split('\n').filter(Boolean);
    const serverChanged = changed.filter(f => SERVER.test(f));
    const clientChanged = changed.filter(f => CLIENT.test(f));
    if (changed.length === 0) {
      row('deployed commit', 'unknown',
          'server=' + body.build + ' is not in this clone — run: git fetch');
    } else if (serverChanged.length === 0) {
      row('deployed commit', 'ok',
          'server=' + body.build + ' — behind by ' + changed.length + ' file(s), but NONE of them '
          + 'are server code, so the server is effectively up to date');
    } else {
      serverStale = true;
      row('deployed commit', 'bad',
          'server=' + body.build + ' local=' + head + ' — ' + serverChanged.length
          + ' server file(s) not deployed: ' + serverChanged.map(f => f.split('/').pop()).join(', ').slice(0, 60));
    }
    if (clientChanged.length) {
      row('app bundle (OTA)', 'warn',
          clientChanged.length + ' client file(s) changed — force-close the app on the phone and reopen it');
    }
  }

  // ── 4. things that are easy to configure and easy to leave off ────────────
  const lkg = body.lkg;
  row('last-known-good store',
      lkg === 'redis' ? 'ok' : (lkg === 'ephemeral' ? 'warn' : 'bad'),
      lkg === 'redis'          ? 'Upstash Redis, verified by a real call — survives deploys'
    : lkg === 'disk'           ? 'mounted disk — survives deploys'
    : lkg === 'ephemeral'      ? 'local /tmp — WIPED on every deploy (set UPSTASH_REDIS_REST_URL/TOKEN)'
    : lkg === 'redis-rejected' ? 'Upstash configured but REFUSING the token — check UPSTASH_REDIS_REST_TOKEN'
    : lkg === 'redis-failing'  ? 'Upstash configured but calls are failing right now'
    : lkg === 'redis-untested' ? 'Upstash configured, no call made yet'
    : String(lkg));

  row('error monitoring',
      body.sentry === 'on' ? 'ok' : 'warn',
      body.sentry === 'on' ? 'Sentry active — failures reach you without a screenshot'
                           : 'NO DSN set — the code runs but reports nowhere (set SENTRY_DSN in Render)');

  row('maintenance mode', body.maintenance ? 'warn' : 'ok',
      body.maintenance ? 'ON — users see the maintenance screen' : 'off');

  // ── 4b. is CI actually running, or is the file just sitting there ─────────
  // The workflow was pushed and called "done" without anyone confirming a
  // single run. GitHub's status badge is the cheapest way to know: it says
  // "no status" when Actions has never run the workflow.
  try {
    const repo = (git('config --get remote.origin.url') || '')
      .replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '');
    if (!repo) {
      row('CI (GitHub Actions)', 'unknown', 'could not read the repo from the git remote');
    } else {
      const badge = await fetch(
        `https://github.com/${repo}/actions/workflows/ci.yml/badge.svg?cb=` + Date.now(),
        { cache: 'no-store' });
      const svg = (await badge.text()).toLowerCase();
      if (svg.includes('passing')) {
        row('CI (GitHub Actions)', 'ok', 'last run PASSED');
      } else if (svg.includes('failing')) {
        row('CI (GitHub Actions)', 'bad',
            'last run FAILED — open the Actions tab; broken code can reach users');
      } else if (svg.includes('no status')) {
        row('CI (GitHub Actions)', 'warn',
            'never run — the checks exist but nothing is running them (enable the Actions tab)');
      } else {
        row('CI (GitHub Actions)', 'unknown', 'badge unreadable (private repo?)');
      }
    }
  } catch (e) {
    row('CI (GitHub Actions)', 'unknown', 'could not reach GitHub: ' + e.message);
  }

  // ── 5. verdict ────────────────────────────────────────────────────────────
  // Blocking = the SERVER is not running your server code. A client-only or
  // tooling-only difference is reported above but does not fail the check.
  const blocking = (realDirty.length > 0)
                || (remote != null && remote !== headFull)
                || serverStale;

  console.log();
  if (blocking) {
    console.log(RED + 'The server is NOT running the code on this machine.' + RESET);
    console.log('Anything you were told was "fixed" cannot be confirmed until this line is green.\n');
    process.exit(1);
  }
  console.log(GREEN + 'The server is running exactly the code on this machine.' + RESET);
  const warn = [];
  if (lkg !== 'redis' && lkg !== 'disk') warn.push('the last-known-good store does not survive deploys');
  if (body.sentry !== 'on') warn.push('errors are not being reported anywhere');
  if (warn.length) {
    console.log(YELLOW + 'Still worth fixing: ' + RESET + warn.join('; ') + '.');
  }
  console.log();
})();

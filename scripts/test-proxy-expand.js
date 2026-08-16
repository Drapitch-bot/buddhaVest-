/**
 * PROXY_EXPAND_JS — run against a page that behaves like Yahoo's, not read.
 *
 * The bug it exists for: Google Translate walks the DOM once, at load, and
 * translates what it finds. Yahoo keeps most of a long article behind a
 * "Story Continues" button and inserts that text only when the button is
 * pressed — after Google has already passed. On a 46-minute earnings-call
 * transcript that is nearly the whole article, so the reader gets a translated
 * opening and nothing below it.
 *
 * These cases pin the two things that make the fix work and the two that stop
 * it doing damage: it must fire before the button exists (the script runs
 * before the page renders), it must fire more than once, it must never click a
 * link (that navigates the WebView off the article), and it must not run away
 * clicking every button on the page.
 *
 * Run:  node scripts/test-proxy-expand.js
 */
const fs = require('fs');
const { parseHTML } = require('linkedom');

const src = fs.readFileSync('screens/ArticleScreen.js', 'utf8');
const _open = src.indexOf('const PROXY_EXPAND_JS = `') + 'const PROXY_EXPAND_JS = '.length;
if (_open < 'const PROXY_EXPAND_JS = '.length) { console.error('PROXY_EXPAND_JS not found'); process.exit(1); }
const _close = src.indexOf('`;', _open) + 1;
const PROXY_EXPAND_JS = new Function('return ' + src.slice(_open, _close))();

let bad = 0;
const t = (name, got, want) => {
  const ok = got === want;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(56) +
    (ok ? '' : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
  if (!ok) bad++;
};

// A harness that mimics the real sequence: the script is injected into a page
// that has not rendered yet, the button appears some time later, and pressing
// it reveals the rest of the article.
function run(bodyHtml, opts) {
  opts = opts || {};
  const { document } = parseHTML('<html><body></body></html>');
  // linkedom hands back the SAME window object for every parseHTML call, so the
  // script's own re-entry guard (window.__bvExpand) would survive from one case
  // into the next and every run after the first would bail out silently. Give
  // each run a window of its own; the script touches nothing else on it.
  const window = {};
  const timers = [];
  window.setInterval = (fn, ms) => { const id = timers.length; timers.push({ fn, ms, id, live: true }); return id; };
  window.clearInterval = (id) => { if (timers[id]) timers[id].live = false; };
  const clicks = [];

  // Every element records its own clicks, so "did it click a link" is a fact
  // about the run rather than something inferred from the outcome.
  const origCreate = document.createElement.bind(document);
  document.createElement = (tag) => origCreate(tag);

  const g = { document, window, setInterval: window.setInterval, clearInterval: window.clearInterval };
  new Function('window', 'document', 'setInterval', 'clearInterval', PROXY_EXPAND_JS)
    (g.window, g.document, g.setInterval, g.clearInterval);

  // The page renders only now — after injection, as it does in the WebView.
  document.body.innerHTML = bodyHtml;
  for (const el of document.querySelectorAll('*')) {
    el.click = function () {
      clicks.push({ tag: this.tagName, text: (this.textContent || '').trim().slice(0, 40) });
      if (this.getAttribute('data-reveals')) {
        const extra = document.createElement('div');
        extra.innerHTML = this.getAttribute('data-reveals');
        document.body.appendChild(extra);
      }
    };
  }

  // Advance the clock.
  const ticks = opts.ticks == null ? 3 : opts.ticks;
  for (let n = 0; n < ticks; n++) {
    for (const tm of timers) if (tm.live) tm.fn();
  }
  return { clicks, document, timers };
}

const HIDDEN = '<p>The revealed remainder of the transcript, several thousand words in the real thing.</p>';

// 1 · The core case. The button does not exist when the script runs.
{
  const r = run(`<article><p>Opening remarks.</p>
    <button class="readmore">Story Continues</button></article>`);
  t('clicks Story Continues that appeared after injection', r.clicks.length, 1);
  t('  and it was the button', r.clicks[0] && r.clicks[0].tag, 'BUTTON');
}

// 2 · The reveal actually lands in the DOM, which is the whole point.
{
  const r = run(`<article><p>Opening remarks.</p>
    <button data-reveals="${HIDDEN.replace(/"/g, '&quot;')}">Story Continues</button></article>`);
  t('revealed text is in the document afterwards',
    /revealed remainder/.test(r.document.body.textContent), true);
}

// 3 · A link must never be clicked — that navigates away from the article.
{
  const r = run(`<article><p>Opening.</p>
    <a href="/more" class="read-more">Read more articles</a>
    <a href="/x">Continue reading our coverage</a></article>`);
  t('never clicks an <a>, whatever its label', r.clicks.length, 0);
}

// 4 · A button wrapping a link is a link in disguise.
{
  const r = run(`<article><button class="readmore"><a href="/n">Story Continues</a></button></article>`);
  t('skips a button that contains a link', r.clicks.length, 0);
}

// 5 · Unrelated buttons stay untouched.
{
  const r = run(`<article><button>Subscribe</button><button>Share</button>
    <button aria-label="Close">×</button><p>Body.</p></article>`);
  t('leaves Subscribe / Share / Close alone', r.clicks.length, 0);
}

// 6 · Each button is pressed once, not once per tick.
{
  const r = run(`<article><button>Story Continues</button></article>`, { ticks: 12 });
  t('presses the same button once across 12 ticks', r.clicks.length, 1);
}

// 7 · A page that keeps producing buttons must not be clicked forever.
{
  const reveals = '<button>Story Continues</button>';
  const r = run(`<article><button data-reveals="${reveals}">Story Continues</button></article>`, { ticks: 40 });
  t('stops at the 8-click ceiling', r.clicks.length <= 8, true);
}

// 8 · The poll must stop; it cannot run for the life of the screen.
{
  const r = run('<article><p>Nothing to expand.</p></article>', { ticks: 60 });
  t('interval clears itself', r.timers.every(x => !x.live), true);
}

// 9 · Every language the app ships, since the proxy serves he/ru/es too.
for (const [lang, label] of [['he', 'המשך לקרוא'], ['ru', 'Читать далее'], ['es', 'Leer más'], ['en', 'Keep reading']]) {
  const r = run(`<article><button>${label}</button></article>`);
  t(`clicks the ${lang} label "${label}"`, r.clicks.length, 1);
}

// 10 · Injecting twice (WebView reload) must not double-arm the poll.
{
  const { document } = parseHTML('<html><body></body></html>');
  const window = {};
  let intervals = 0;
  window.setInterval = () => { intervals++; return intervals; };
  window.clearInterval = () => {};
  const f = new Function('window', 'document', 'setInterval', 'clearInterval', PROXY_EXPAND_JS);
  f(window, document, window.setInterval, window.clearInterval);
  f(window, document, window.setInterval, window.clearInterval);
  t('second injection is a no-op', intervals, 1);
}

console.log(bad ? `\n  ${bad} failing` : '\n  all passing');
process.exit(bad ? 1 : 0);

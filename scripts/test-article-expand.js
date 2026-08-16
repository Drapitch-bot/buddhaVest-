/**
 * The click-to-expand page — run for real, not read.
 *
 * Yahoo Finance and most of its syndication partners render the first few
 * paragraphs and hide the rest behind a "Story continues" button. The rest is
 * NOT in the DOM until that button is pressed. Every limit raised before this
 * therefore changed nothing: both readers were extracting all of what was
 * there, and all of what was there was a third of the article.
 *
 * The reader found the cause by noticing the button. This file runs the
 * extractor against a page that behaves that way, so the fix is demonstrated
 * rather than asserted — the previous three attempts were asserted.
 *
 * Run:  node scripts/test-article-expand.js
 */
const fs = require('fs');
const { parseHTML } = require('linkedom');

const src = fs.readFileSync('screens/ArticleScreen.js', 'utf8');
// EXTRACT_JS is a template literal, so the file holds "\\s+" where the runtime
// string holds "\s+". Slicing the raw text and evaluating it produces an
// invalid regex. Let JS process the literal instead of unescaping by hand.
const _open = src.indexOf('const EXTRACT_JS = `') + 'const EXTRACT_JS = '.length;
const _close = src.indexOf('`;', _open) + 1;
const EXTRACT_JS = new Function('return ' + src.slice(_open, _close))();

let bad = 0;
const t = (name, got, want) => {
  const ok = got === want;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(58) + (ok ? '' : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
  if (!ok) bad++;
};

function para(n, prefix) {
  return Array.from({ length: n }, (_, i) =>
    `<p>${prefix} paragraph number ${i + 1}, long enough to clear the forty character floor easily.</p>`).join('');
}

// A page that hides two thirds of itself behind a button, exactly as described.
function buildPage() {
  const html = `<html><head><title>Markets today</title></head><body><article>
    <h1>Small-cap ETFs are having a moment</h1>
    ${para(4, 'Visible')}
    <button class="readmore-button">Story continues</button>
    <a href="/other">Read more articles like this</a>
    <button class="share-btn">Share</button>
  </article></body></html>`;
  const { window, document } = parseHTML(html);
  const article = document.querySelector('article');
  const btn = document.querySelector('button.readmore-button');
  let expanded = false;
  let clicks = { readmore: 0, share: 0, link: 0 };
  btn.click = function () {
    clicks.readmore++;
    if (expanded) return;
    expanded = true;
    // The rest of the story arrives a moment after the click, as it does live.
    setTimeout(() => { article.innerHTML += para(20, 'Hidden'); }, 250);
  };
  document.querySelector('button.share-btn').click = function () { clicks.share++; };
  document.querySelector('a').click = function () { clicks.link++; };
  window.location = { hostname: 'finance.yahoo.com', href: 'https://finance.yahoo.com/news/a.html' };
  return { window, document, clicks, get expanded() { return expanded; } };
}

function run(page, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const posted = [];
    const sandbox = {
      document: page.document,
      location: page.window.location,
      window: { __bvExtracted: false, ReactNativeWebView: { postMessage: (m) => { posted.push(JSON.parse(m)); resolve(posted[0]); } } },
      setInterval, clearInterval, setTimeout, JSON,
    };
    sandbox.window.document = page.document;
    sandbox.window.location = page.window.location;
    const fn = new Function('document', 'location', 'window', 'setInterval', 'clearInterval', 'setTimeout', 'JSON', EXTRACT_JS);
    fn(sandbox.document, sandbox.location, sandbox.window, setInterval, clearInterval, setTimeout, JSON);
    setTimeout(() => resolve(posted[0] || null), timeoutMs);
  });
}

(async () => {
  console.log('\n-- a page that hides two thirds behind a button --');
  const page = buildPage();
  const out = await run(page);

  t('something was extracted', !!out, true);
  if (out) {
    const texts = out.items.filter(i => i.tag !== 'img').map(i => i.text);
    const visible = texts.filter(x => x.startsWith('Visible')).length;
    const hidden  = texts.filter(x => x.startsWith('Hidden')).length;
    console.log(`        (${visible} visible + ${hidden} previously hidden = ${texts.length})`);
    t('the four visible paragraphs are there', visible, 4);
    t('the twenty hidden ones are there too', hidden, 20);
    t('the title survived', out.title, 'Small-cap ETFs are having a moment');
    t('the source host is reported', out.source, 'finance.yahoo.com');
  }

  console.log('\n-- what it clicked, and what it did not --');
  t('the expander was clicked', page.clicks.readmore > 0, true);
  t('it was not clicked in a loop', page.clicks.readmore <= 6, true);
  t('the share button was left alone', page.clicks.share, 0);
  t('the LINK was left alone — clicking it navigates away', page.clicks.link, 0);

  console.log('\n-- a page with no expander must still work --');
  const plain = (() => {
    const { window, document } = parseHTML(
      `<html><head><title>Plain</title></head><body><article><h1>A plain article</h1>${para(6, 'Only')}</article></body></html>`);
    window.location = { hostname: 'example.com', href: 'https://example.com/a' };
    return { window, document, clicks: {} };
  })();
  const out2 = await run(plain);
  t('extracted without any button', !!out2 && out2.items.length >= 6, true);

  console.log('\n-- which labels may be clicked at all --');
  // This regex decides what gets clicked inside somebody else's page. A bare
  // "continue" was in it at first, which matches "Continue to site" and
  // "Continue without accepting" - buttons that navigate or dismiss rather
  // than expand. Every alternative has to be a phrase that can only mean
  // "reveal the rest of the article".
  const _m = /var EXPAND_RE = (\/[^\n]+\/i);/.exec(src);
  const EXPAND_RE = eval(_m[1]);
  for (const label of ['Story continues', 'Continue reading', 'Read more',
                       'Read the rest', 'Show more', 'Keep reading',
                       'המשך לקרוא', 'קרא עוד', 'Читать далее', 'Leer más'])
    t('matches: ' + label, EXPAND_RE.test(label), true);
  for (const label of ['Continue', 'Continue to site', 'Continue without accepting',
                       'Continue shopping', 'Sign in to continue', 'Next',
                       'Submit', 'Share', 'Subscribe', 'Accept all'])
    t('ignores: ' + label, EXPAND_RE.test(label), false);

  console.log(bad ? `\n  FAIL ${bad}` : '\n  OK the expander works on a real click-to-expand page');
  process.exit(bad ? 1 : 0);
})();

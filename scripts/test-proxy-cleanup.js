/**
 * PROXY_CLEAN_JS — run against a DOM, not read.
 *
 * The job is to make the pictures LOAD, not to hide the holes where they
 * should be. Yahoo lazy-loads: the <img> carries a placeholder and the real
 * file sits in data-src or srcset, swapped in by an observer when the image
 * scrolls into view. Through translate.goog that observer often never fires.
 * Hiding the gap was my first answer and it was backwards — the picture is
 * part of the article.
 *
 * The proxy serves the real page, which is the point, and the real page is
 * mostly advertising scaffolding. Those slots reserve their height in CSS and
 * never fill, because ad networks do not serve through translate.goog. The
 * article arrives whole and full of tall white gaps. Reported from the phone.
 *
 * The danger here is over-removal: a selector that also matches article
 * content deletes the thing the reader came for, and it does it silently. So
 * every check below comes in pairs — what must go, and what must survive.
 *
 * Run:  node scripts/test-proxy-cleanup.js
 */
const fs = require('fs');
const { parseHTML } = require('linkedom');

const src = fs.readFileSync('screens/ArticleScreen.js', 'utf8');
const _o = src.indexOf('const PROXY_CLEAN_JS = `') + 'const PROXY_CLEAN_JS = '.length;
const _c = src.indexOf('`;', _o) + 1;
const CLEAN_JS = new Function('return ' + src.slice(_o, _c))();

let bad = 0;
const t = (name, got, want) => {
  const ok = got === want;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(56) + (ok ? '' : ` got ${got}`));
  if (!ok) bad++;
};

const PAGE = `<html><body>
  <div class="skiptranslate">Google translate bar</div>
  <article>
    <h1>Disney's CEO says he isn't happy</h1>
    <p id="p1">The chief executive said on Friday that the parks result was a big surprise.</p>
    <ins class="adsbygoogle" style="height:250px"></ins>
    <div id="ad-slot-top" style="height:280px"></div>
    <div class="ad-container" style="height:250px"></div>
    <div class="advertisement" style="height:90px"></div>
    <iframe src="https://doubleclick.net/x"></iframe>
    <div class="empty-reserved" style="height:300px"></div>
    <p id="p2">He also said he is not considering the kind of moves reshaping the industry.</p>
    <figure id="fig"><img id="good" src="https://cdn/x.jpg"><figcaption>Chart</figcaption></figure>
    <img id="broken" src="https://cdn/gone.jpg">
    <div id="header-wrap" style="height:80px"><p id="p3">Headline area with real words in it.</p></div>
    <div id="download-box" style="height:120px"><img id="dl" src="https://cdn/y.jpg"></div>
    <div id="video-holder" style="height:200px"><video></video></div>
    <div id="small-empty" style="height:20px"></div>

    <!-- lazy-loaded, in the three shapes real pages use -->
    <img id="lazy1" src="data:image/gif;base64,R0lGOD" data-src="https://cdn/real1.jpg">
    <img id="lazy2" src="" data-lazy-src="https://cdn/real2.jpg" loading="lazy">
    <img id="lazy3" data-srcset="https://cdn/s.jpg 400w, https://cdn/l.jpg 1600w">
    <picture id="pic"><source id="psrc" data-srcset="https://cdn/p.jpg 800w"><img id="pimg" src=""></picture>
    <img id="already" src="https://cdn/loaded.jpg" data-src="https://cdn/other.jpg">
  </article></body></html>`;

const { window, document } = parseHTML(PAGE);
// linkedom has no layout, so offsetHeight is supplied from the inline style —
// which is exactly what the real page uses to reserve the space.
for (const el of document.querySelectorAll('*')) {
  const m = /height:\s*(\d+)px/.exec(el.getAttribute('style') || '');
  Object.defineProperty(el, 'offsetHeight', { value: m ? parseInt(m[1]) : 0 });
}
Object.defineProperty(document.getElementById('good'),   'complete', { value: true });
Object.defineProperty(document.getElementById('good'),   'naturalWidth', { value: 800 });
Object.defineProperty(document.getElementById('dl'),     'complete', { value: true });
Object.defineProperty(document.getElementById('dl'),     'naturalWidth', { value: 600 });
Object.defineProperty(document.getElementById('broken'), 'complete', { value: true });
Object.defineProperty(document.getElementById('broken'), 'naturalWidth', { value: 0 });

// Drive the interval by hand instead of stubbing it away. The first version
// of this test passed `() => 0` as setInterval, so the delayed sweep never ran
// and eight assertions about it were being reported as failures for the wrong
// reason entirely.
let tick = null;
const fakeSetInterval = (cb) => { tick = cb; return 1; };
let stopped = false;
const fakeClearInterval = () => { stopped = true; };
const fn = new Function('document', 'window', 'setInterval', 'clearInterval', 'Event', CLEAN_JS);
fn(document, window, fakeSetInterval, fakeClearInterval, window.Event || function () {});
// 15 passes: wakeImages every time, sweep from the fifth.
for (let i = 0; i < 15 && !stopped && tick; i++) tick();

const gone = (sel) => {
  const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  return !el || (el.style && el.style.display === 'none');
};

console.log('-- the pictures are made to load --');
const attr = (id, a) => { const el = document.getElementById(id); return el && el.getAttribute(a); };
t('data-src copied into src',        attr('lazy1', 'src'), 'https://cdn/real1.jpg');
t('data-lazy-src copied into src',   attr('lazy2', 'src'), 'https://cdn/real2.jpg');
t('native lazy switched to eager',   document.getElementById('lazy2').loading, 'eager');
t('data-srcset -> widest candidate', attr('lazy3', 'src'), 'https://cdn/l.jpg');
t('<picture> source gets its srcset', attr('psrc', 'srcset'), 'https://cdn/p.jpg 800w');
// An image that already has a real src must not be swapped for something else.
t('an already-loaded image is left alone', attr('already', 'src'), 'https://cdn/loaded.jpg');

console.log('\n-- the scaffolding that never filled --');
t('adsbygoogle slot',            gone('ins.adsbygoogle'), true);
t('#ad-slot-top',                gone('#ad-slot-top'), true);
t('.ad-container',               gone('.ad-container'), true);
t('.advertisement',              gone('.advertisement'), true);
t('doubleclick iframe',          gone('iframe[src*="doubleclick"]'), true);
t('a tall container with nothing in it', gone('.empty-reserved'), true);
t('the image that never arrived', gone('#broken'), true);
t('Google\'s translation bar',    gone('.skiptranslate'), true);

console.log('\n-- and what must survive it --');
// This half is the point. A selector matching "ad" as a substring takes out
// "header", "download", "read" and "loading" — and the reader sees an article
// with holes instead of gaps.
t('the headline',                !gone('h1'), true);
t('first paragraph',             !gone('#p1'), true);
t('second paragraph',            !gone('#p2'), true);
t('the image that loaded',       !gone('#good'), true);
t('its figure and caption',      !gone('#fig'), true);
t('#header-wrap — "ad" is inside "header"',   !gone('#header-wrap'), true);
t('its text',                    !gone('#p3'), true);
t('#download-box — "ad" is inside "download"', !gone('#download-box'), true);
t('a block holding a video',     !gone('#video-holder'), true);
t('a short empty block is left alone', !gone('#small-empty'), true);
// The order matters more than any single selector: an image still downloading
// must never be judged broken. The sweep only runs after several passes.
t('loading happens before any hiding',
  CLEAN_JS.indexOf('wakeImages()') < CLEAN_JS.indexOf('function sweep'), true);
t('the sweep is delayed, not immediate', CLEAN_JS.includes('if (n >= 5) sweep()'), true);

console.log(bad ? `\n  FAIL ${bad}` : '\n  OK the gaps go and the article stays');
process.exit(bad ? 1 : 0);

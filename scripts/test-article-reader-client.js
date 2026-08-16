/**
 * The CLIENT-side article reader.
 *
 * There are two paths to a translated article and they are easy to forget
 * about separately. The server fetches the page and translates it; if that is
 * slow or blocked, the WebView extracts the DOM itself and the app builds the
 * reader page locally. Whichever finishes first wins.
 *
 * On 2026-08-15 the server path was rewritten to keep images, lists and the
 * source link. The client path was not, so an article that happened to be
 * rendered locally still arrived as a wall of grey text - and it looked
 * exactly like the bug that had just been fixed. Reported from the phone.
 *
 * This path also has one advantage the server can never have: it runs after
 * the page's own JavaScript, so the images really are in the DOM, already
 * loaded and already resolved by the browser. Yahoo never sends them in HTML.
 *
 * Both halves handle data from a third-party page, so the checks that matter
 * are the ones asserting a hostile field cannot reach the output.
 *
 * Run:  node scripts/test-article-reader-client.js
 */
// Both halves handle data from a THIRD-PARTY page, so the checks that matter
// are the ones asserting a hostile field cannot reach the output.
const fs = require('fs');
const src = fs.readFileSync('screens/ArticleScreen.js', 'utf8');
let bad = 0;
const t = (name, got, want) => {
  const ok = got === want;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(56) + (ok ? '' : ` got ${got}`));
  if (!ok) bad++;
};

console.log('\n-- EXTRACT_JS gathers what the article actually contains --');
const ex = src.slice(src.indexOf('const EXTRACT_JS'), src.indexOf('function grab', src.indexOf('const EXTRACT_JS')) + 3000);
t('the paragraph-only selector is gone', /querySelectorAll\('p, h2, h3'\)/.test(ex), false);
for (const tag of ['h4', 'li', 'blockquote', 'figcaption', 'img'])
  t('collects ' + tag, ex.includes(tag), true);
t('no 25-item cut-off', /out\.length < 25\b/.test(ex), false);
t('bounded by characters too', ex.includes('chars < 24000'), true);
t('uses currentSrc, so srcset and lazy loading are already resolved',
  ex.includes('el.currentSrc'), true);
t('rejects images by REAL width, not the declared one',
  ex.includes('el.naturalWidth'), true);
t('skips logos and tracking pixels', ex.includes('IMG_JUNK.test(src)'), true);
t('skips data: URLs', ex.includes("src.indexOf('data:') === 0"), true);
t('de-duplicates images', ex.includes('seenImg[src]'), true);
t('reports the source host', ex.includes('source: location.hostname'), true);

console.log('\n-- handleMessage treats every field as hostile --');
const hm = src.slice(src.indexOf('var handleMessage'), src.indexOf('var html =', src.indexOf('var handleMessage')));
t('tags are whitelisted, never interpolated raw', hm.includes('ALLOWED_TAGS['), true);
t('img is in the whitelist', /ALLOWED_TAGS = \{[^}]*img: 'img'/.test(hm), true);
t('an image src must be http(s)', hm.includes("/^https?:\\/\\//i.test(src)"), true);
t('a non-http src is demoted, not rendered', hm.includes("{ tag = 'p'; src = ''; }"), true);
t('image src is length-capped', hm.includes('src.slice(0, 600)'), true);
t('images with no src are dropped', hm.includes("it.tag !== 'img' || it.src"), true);
t('image slots are not sent to the translator',
  hm.includes("it.tag === 'img' ? '' : it.text"), true);
t('the item cap rose with the tag list', hm.includes('slice(0, 150)'), true);

console.log('\n-- the rendered HTML --');

t('image src is escaped into the attribute',
  src.includes("'<img src=\"' + escapeHtml(items[i].src)"), true);
t('the source link is emitted', src.includes('SRC_LABEL[lang]'), true);
t('the source link exists in four languages',
  ['en:', 'he:', 'ru:', 'es:'].every(k => src.slice(src.indexOf('var SRC_LABEL'), src.indexOf('var SRC_LABEL') + 300).includes(k)), true);
t('the source href must be http(s)',
  src.includes("/^https?:\\/\\//i.test(String(data.href || ''))"), true);
t('captions render as captions', src.includes("'<p class=\"cap\">'"), true);
t('images get styling', src.includes('img{max-width:100%'), true);
t('the stylesheet matches the server (blockquote rule)',
  src.includes('border-inline-start:3px solid #d97706'), true);

console.log('\n-- the race between the two paths --');
// They differ in QUALITY, not just speed: the server fetches raw HTML and on
// Yahoo never sees an <img>, while this path runs after the page's own
// JavaScript and gets the real pictures. First-past-the-post handed the reader
// the poorer version whenever the server was quicker, which is most of the
// time.
// The wait has to cover what the WebView path actually costs: page load
// (1-3s), a poll (0.7s), the expander click, the revealed text (0.25s), two
// stable passes (1.4s), then its own translation. Four to eight seconds. The
// server answers from a one-hour cache in ~300ms, so a 1.6s grace - the first
// number I used - lost every race, and the server is the path that cannot
// press "Story continues".
t('the server result waits long enough to actually lose', src.includes('setTimeout(apply, 7000)'), true);
t('a late but fuller client result still takes over',
  src.includes('html.length > prev.length * 1.3'), true);
t('the wait is skipped once the extraction has arrived',
  src.includes('if (domSentRef.current) { apply(); return; }'), true);
// domSentRef must be raised when the extraction ARRIVES, before its
// translation round trip starts - otherwise the server's timer fires during
// that round trip and the poorer version wins anyway. Checked inside
// handleMessage, where the ordering actually matters; my first version of this
// compared positions in the FILE, which proves nothing about execution.
const hmBlock = src.slice(src.indexOf('var handleMessage'),
                          src.indexOf('.catch(function() {', src.indexOf('var handleMessage')));
t('the extraction flag is raised before the translation request',
  hmBlock.indexOf('domSentRef.current = true') <
  hmBlock.indexOf("fetch(API_BASE + '/translate-batch'"), true);
t('the WebView path cancels the pending timer when it wins',
  src.includes('if (graceRef.current) { clearTimeout(graceRef.current); graceRef.current = null; }'), true);
// A timer left armed from the previous article paints over the new one.
t('the timer is cleared in three places (win, cleanup, reset)',
  (src.match(/clearTimeout\(graceRef\.current\)/g) || []).length >= 3, true);

console.log(bad ? `\n  FAIL ${bad}` : '\n  OK the client reader matches the server reader');
process.exit(bad ? 1 : 0);

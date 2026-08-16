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

console.log(bad ? `\n  FAIL ${bad}` : '\n  OK the client reader matches the server reader');
process.exit(bad ? 1 : 0);

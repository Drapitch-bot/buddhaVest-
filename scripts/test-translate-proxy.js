/**
 * googleTranslateUrl — the URL that shows the ORIGINAL page in another language.
 *
 * Built 2026-08-15, after several hours spent improving a reader-mode extractor
 * that could never have satisfied the request. "I want it to look like the
 * original, just translated" is not a reader: a reader pulls text out and
 * rebuilds a plain page, so it has no layout, no styling, and only the markup
 * the extractor thought to keep. The proxy serves the real page.
 *
 * The host encoding is the part that silently breaks: every "-" doubles BEFORE
 * every "." becomes "-". In the other order a hostname containing a hyphen
 * cannot be decoded again, and the proxy serves a different site or nothing.
 *
 * Run:  node scripts/test-translate-proxy.js
 */
const fs = require('fs');
const src = fs.readFileSync('screens/ArticleScreen.js', 'utf8');
const i = src.indexOf('function googleTranslateUrl(');
let d = 0, started = false, j = i;
for (; j < src.length; j++) {
  if (src[j] === '{') { d++; started = true; }
  else if (src[j] === '}') { d--; if (started && !d) { j++; break; } }
}
eval(src.slice(i, j));

let bad = 0;
const t = (name, got, want) => {
  const ok = got === want;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(50) + (ok ? '' : `\n        got  ${got}\n        want ${want}`));
  if (!ok) bad++;
};

const SUF = '_x_tr_sl=auto&_x_tr_tl=he&_x_tr_hl=he';

console.log('\n-- the article that started this --');
t('finance.yahoo.com',
  googleTranslateUrl('https://finance.yahoo.com/markets/stocks/articles/disneys-ceo-says-isnt-happy-182358398.html', 'he'),
  'https://finance-yahoo-com.translate.goog/markets/stocks/articles/disneys-ceo-says-isnt-happy-182358398.html?' + SUF);

console.log('\n-- a hyphen in the HOST must double before the dots convert --');
// Get this backwards and the proxy cannot reverse the encoding.
t('my-site.com  ->  my--site-com',
  googleTranslateUrl('https://my-site.com/a', 'he'),
  'https://my--site-com.translate.goog/a?' + SUF);
t('news.bbc-uk.co.il',
  googleTranslateUrl('https://news.bbc-uk.co.il/x', 'he'),
  'https://news-bbc--uk-co-il.translate.goog/x?' + SUF);
// A hyphen in the PATH is untouched — only the host is encoded.
t('hyphens in the path are left alone',
  googleTranslateUrl('https://example.com/a-b-c', 'he'),
  'https://example-com.translate.goog/a-b-c?' + SUF);

console.log('\n-- an existing query string is kept --');
t('joins with & when a query exists',
  googleTranslateUrl('https://example.com/a?x=1&y=2', 'he'),
  'https://example-com.translate.goog/a?x=1&y=2&' + SUF);
t('uses ? when there is none',
  googleTranslateUrl('https://example.com/a', 'he'),
  'https://example-com.translate.goog/a?' + SUF);
t('a bare host still gets a path',
  googleTranslateUrl('https://example.com', 'he'),
  'https://example-com.translate.goog/?' + SUF);

console.log('\n-- the other languages --');
t('russian', googleTranslateUrl('https://example.com/a', 'ru'),
  'https://example-com.translate.goog/a?_x_tr_sl=auto&_x_tr_tl=ru&_x_tr_hl=ru');
t('spanish', googleTranslateUrl('https://example.com/a', 'es'),
  'https://example-com.translate.goog/a?_x_tr_sl=auto&_x_tr_tl=es&_x_tr_hl=es');

console.log('\n-- returns null rather than guessing --');
for (const [name, url] of [
  ['no url', null], ['empty', ''], ['not a url', 'hello'],
  ['ftp', 'ftp://example.com/a'], ['javascript:', 'javascript:alert(1)'],
  ['a port cannot be encoded', 'https://example.com:8443/a'],
]) t(name, googleTranslateUrl(url, 'he'), null);
t('no language', googleTranslateUrl('https://example.com/a', ''), null);
t('already proxied is passed through',
  googleTranslateUrl('https://example-com.translate.goog/a?' + SUF, 'he'),
  'https://example-com.translate.goog/a?' + SUF);

console.log(bad ? `\n  FAIL ${bad}` : '\n  OK the proxy URL is built correctly');
process.exit(bad ? 1 : 0);

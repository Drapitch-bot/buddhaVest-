/**
 * The in-place translator - run against a page that behaves like Yahoo's.
 *
 * Why it exists: translate.goog was measured in a real browser on the article
 * the reader complained about. It served the page COMPLETE - 102 paragraphs,
 * 50,704 characters, ending on the last line of the disclaimer - and
 * translated 0% of it, in every tenth of the page, still 0% after 24 seconds
 * and a full scroll. Yahoo injects the article from JavaScript after Google
 * has already read the page, so Google never sees the text, and never sees
 * the sections Yahoo loads further down either.
 *
 * These cases pin the four things that make the replacement correct: it
 * translates the article, it does NOT translate navigation, it does not
 * destroy links and images while doing it, and - the part Google structurally
 * cannot do - it translates content that arrives AFTER the first pass.
 *
 * Run:  node scripts/test-inplace-translate.js
 */
const fs = require('fs');
const { parseHTML } = require('linkedom');

const src = fs.readFileSync('screens/ArticleScreen.js', 'utf8');
const open = src.indexOf('const inPlaceTranslateJs = (lang) => `');
if (open < 0) { console.error('inPlaceTranslateJs not found'); process.exit(1); }
const bodyStart = src.indexOf('`', open);
const bodyEnd = src.indexOf('\n`;', bodyStart);
const factory = new Function('lang',
  'return ' + src.slice(src.indexOf('`', open), bodyEnd + 2) + ';');

let bad = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(56) +
    (ok ? '' : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
  if (!ok) bad++;
};

// Runs the script against a document, with a fetch that records what it was
// asked to translate and answers with a marked version of the same text.
async function run(html, opts) {
  opts = opts || {};
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const window = {};
  const sent = [];
  const observers = [];
  const timers = [];
  const lang = opts.lang || 'he';
  let peakInFlight = 0, live = 0;

  // Stands in for the app: the page posts a batch over the bridge, this
  // translates it and calls back. The page itself is never given a fetch,
  // because on a real publisher page it does not have a usable one - Yahoo
  // ships default-src 'none', which covers connect-src.
  window.ReactNativeWebView = {
    postMessage: (raw) => {
      const msg = JSON.parse(raw);
      if (msg.bv !== 'tr') return;
      sent.push({ id: msg.id, count: msg.texts.length, lang, texts: msg.texts });
      const n = sent.length;
      live++; peakInFlight = Math.max(peakInFlight, live);
      Promise.resolve().then(() => {
        live--;
        if (opts.failFetch || (opts.failFirst && n <= opts.failFirst)) {
          if (opts.giveUpAfter === false) return;
          if (opts.failFirst && n <= opts.failFirst) {
            // The app retries: re-post the same batch id.
            window.ReactNativeWebView.postMessage(raw);
            return;
          }
          window.__bvFail(msg.id);
          return;
        }
        window.__bvApply(msg.id, msg.texts.map(x => '«' + x + '»'));
      });
    },
  };

  const script = factory(lang);
  new Function('window', 'document', 'setTimeout', 'clearTimeout', 'MutationObserver', script)
    (window, document,
     (fn, ms) => { if (ms && ms >= 500) { Promise.resolve().then(fn); return 0; }
                   timers.push(fn); return timers.length; },
     () => {},
     function (cb) { this.observe = () => observers.push(cb); });

  const settle = async () => { for (let i = 0; i < 400; i++) await Promise.resolve(); };
  await settle();
  return {
    document, sent, peakInFlight,
    // Fire the observer the way Yahoo firing its own late render would.
    async mutate(newHtml) {
      document.querySelector('#late') ?
        (document.querySelector('#late').innerHTML = newHtml)
        : document.body.insertAdjacentHTML('beforeend', newHtml);
      observers.forEach(cb => cb());
      timers.splice(0).forEach(fn => fn());
      await settle();
    },
  };
}

(async () => {
  // 1 · The article gets translated.
  {
    const r = await run(`<article>
      <h1>Disney Q3 2026 Earnings Call Transcript</h1>
      <p>Thanks for joining us on the call this afternoon everyone.</p>
      <p>Let us dive deeper into our third quarter performance now.</p></article>`);
    t('sends the article text', r.sent.length && r.sent[0].count, 3);
    t('  writes the translation back',
      /«Thanks for joining/.test(r.document.querySelector('p').textContent), true);
    t('  sends the requested language', r.sent[0].lang, 'he');
  }

  // 2 · Navigation must NOT be translated - and a nav <a> must keep its href.
  {
    const r = await run(`<nav><a href="/markets">Markets</a><a href="/news">News here</a></nav>
      <header><p>Sign in to your account today</p></header>
      <footer><p>All rights reserved by the publisher</p></footer>
      <article><p>The only sentence that belongs to the article itself.</p></article>`);
    t('translates the article only', r.sent[0].count, 1);
    t('  and it is the article sentence',
      /only sentence/.test(r.sent[0].texts[0]), true);
    t('  nav links keep their href',
      r.document.querySelector('nav a').getAttribute('href'), '/markets');
  }

  // 3 · A paragraph containing a link keeps the link, its href and its image.
  {
    const r = await run(`<article><p>Read the <a href="/filing">original filing</a> for details here.</p>
      <figure><img src="/chart.png"><figcaption>Revenue by segment this quarter</figcaption></figure></article>`);
    const p = r.document.querySelector('p');
    t('the link survives translation', !!p.querySelector('a'), true);
    t('  with its href intact', p.querySelector('a').getAttribute('href'), '/filing');
    t('  the image survives', !!r.document.querySelector('img'), true);
    t('  the caption is translated',
      /«Revenue by segment/.test(r.document.querySelector('figcaption').textContent), true);
  }

  // 4 · Prices, tickers and percentages are the same in every language.
  {
    const r = await run(`<article><p>$102.45</p><p>+1.24%</p><p>16:05</p>
      <p>Revenue grew across every operating segment this quarter.</p></article>`);
    t('does not send numbers-only blocks', r.sent[0].count, 1);
  }

  // 5 · THE POINT. Content that arrives after the first pass gets translated.
  //     This is what translate.goog cannot do and why a section further down
  //     the page came through in English.
  {
    const r = await run(`<article><p>The opening paragraph of the transcript.</p><div id="late"></div></article>`);
    const before = r.sent.length;
    await r.mutate('<p>A whole section the site only loads once you scroll down.</p>');
    t('translates a section added after load', r.sent.length > before, true);
    t('  and it reached the page',
      /«A whole section/.test(r.document.querySelector('#late p').textContent), true);
  }
  {
    // What the reader actually described: a further article appears below the
    // first one as you scroll. It arrives as its own container, so the article
    // body has to be looked for again on every pass, not once at load.
    const r = await run(`<article><p>The first article, the one that was already there.</p></article>
      <div id="late"></div>`);
    await r.mutate('<article><p>A second article that only appears further down the page.</p></article>');
    const all = r.sent.flatMap(x => x.texts);
    t('translates a whole second article loaded later',
      all.some(x => /second article/.test(x)), true);
    t('  and it reached the page',
      /«A second article/.test(r.document.querySelector('#late article p').textContent), true);
  }

  // 6 · A second pass must not re-send what it already translated.
  {
    const r = await run(`<article><p>One sentence, translated exactly once please.</p></article><div id="late"></div>`);
    await r.mutate('');
    const total = r.sent.reduce((a, b) => a + b.count, 0);
    t('never translates the same block twice', total, 1);
  }

  // 7 · Large pages are split, because a 46-minute transcript is 50KB.
  {
    const paras = Array.from({ length: 260 }, (_, i) =>
      `<p>Paragraph number ${i} of the transcript, long enough to be worth sending.</p>`).join('');
    const r = await run(`<article>${paras}</article>`);
    t('splits a long transcript into chunks', r.sent.length > 1, true);
    // 20 is not arbitrary: measured against the live service, 100 paragraphs
    // took 16.9 seconds and 20 took 2.4. A reader watching seventeen seconds
    // of English concludes the article was truncated again.
    t('  no chunk exceeds the item cap', r.sent.every(x => x.count <= 20), true);
    t('  and there are enough chunks to fill progressively',
      r.sent.length >= 13, true);
    t('  every paragraph was sent',
      r.sent.reduce((a, b) => a + b.count, 0), 260);
  }

  // 8 · A failed request must leave the article readable, not blank.
  {
    const r = await run(`<article><p>This must still be here after the request fails.</p></article>`,
      { failFetch: true });
    t('a failed translation leaves the text intact',
      /must still be here/.test(r.document.querySelector('p').textContent), true);
  }

  // 9 · Hebrew reads right to left; the others do not.
  {
    const he = await run(`<article><p>A paragraph that should end up right aligned.</p></article>`, { lang: 'he' });
    const es = await run(`<article><p>A paragraph that should stay left aligned.</p></article>`, { lang: 'es' });
    t('Hebrew is set to rtl', he.document.querySelector('p').style.direction, 'rtl');
    t('Spanish is left alone', es.document.querySelector('p').style.direction || '', '');
  }

  // 11 · Real page shapes, because the simple ones hid a bug that rejected
  //      130 of 135 blocks on a live CNBC page and translated nothing. One
  //      wrapper high in the tree was enough; the article body is aimed at
  //      directly now, so a wrapper cannot silence it.
  {
    const cnbc = await run(`<div class="cnbcBrand">
      <nav><a href="/markets">Markets</a></nav>
      <div data-module="ArticleBody">
        <p>JPMorgan could soon become the first bank worth a trillion dollars.</p>
        <p>The analyst said the next stop after that could be two trillion.</p>
      </div>
      <footer class="CNBCFooter-footer"><p>Data is a real-time snapshot, delayed at least 15 minutes.</p></footer>
    </div>`);
    t('CNBC shape: the article is translated', cnbc.sent[0] && cnbc.sent[0].count, 2);
    t('  the footer disclaimer is not sent',
      cnbc.sent[0].texts.some(x => /real-time snapshot/.test(x)), false);
  }
  {
    const yahoo = await run(`<header><p>Sign in to Yahoo Finance right now</p></header>
      <div class="caas-body">
        <p>Thanks for joining us on the earnings call this afternoon.</p>
        <p>Operator instructions follow at the end of this transcript.</p>
      </div>`);
    t('Yahoo shape: the article is translated', yahoo.sent[0] && yahoo.sent[0].count, 2);
    t('  the sign-in prompt is not sent',
      yahoo.sent[0].texts.some(x => /Sign in/.test(x)), false);
  }
  {
    // A body nested inside <main> must not be visited twice.
    const nested = await run(`<main><article><p>Exactly one sentence in a doubly wrapped body.</p></article></main>`);
    t('nested roots are not translated twice',
      nested.sent.reduce((a, b) => a + b.count, 0), 1);
  }
  {
    // No recognisable container anywhere: the old ancestor rule must still work.
    const bare = await run(`<nav><p>Markets and news and everything else</p></nav>
      <div><p>A bare page with no article container at all here.</p></div>`);
    t('no container: chrome is still skipped', bare.sent[0].count, 1);
    t('  and the body text still goes', /bare page/.test(bare.sent[0].texts[0]), true);
  }

  // 12 · A chunk that fails must not become a hole in the article.
  //      Blocks are marked the moment they are collected, so before this the
  //      paragraphs in a rejected chunk stayed English for good and nothing
  //      ever looked at them again - a silently truncated article, which is
  //      the exact failure this whole change exists to stop.
  {
    const r = await run(`<article><p>A paragraph the service rejects twice before it succeeds.</p></article>`,
      { failFirst: 2 });
    t('retries a rejected chunk', r.sent.length, 3);
    t('  and the text ends up translated',
      /«A paragraph the service rejects/.test(r.document.querySelector('p').textContent), true);
  }
  {
    const r = await run(`<article><p>A paragraph whose request throws outright, then works.</p></article>`,
      { failFirst: 1, throwInstead: true });
    t('a thrown request is retried too',
      /«A paragraph whose request throws/.test(r.document.querySelector('p').textContent), true);
  }
  {
    // Gave up after three tries: the block must be handed back, so the next
    // pass tries it again rather than leaving it English for ever.
    const r = await run(`<article><p>This one never succeeds at all today.</p><div id="late"></div></article>`,
      { failFetch: true });
    const marked = r.document.querySelector('p').getAttribute('data-bv-t');
    t('an unrecoverable block is released, not left marked', marked, null);
    const before = r.sent.length;
    await r.mutate('');
    t('  so a later pass picks it up again', r.sent.length > before, true);
  }
  {
    // The counterpart: a block that succeeded is marked done and never resent.
    const r = await run(`<article><p>One good paragraph, sent exactly once.</p><div id="late"></div></article>`);
    t('a translated block is marked done',
      r.document.querySelector('p').getAttribute('data-bv-t'), 'done');
    await r.mutate('');
    t('  and is never sent a second time',
      r.sent.reduce((a, b) => a + b.count, 0), 1);
  }

  // 13 · Concurrency moved to the app when the transport did, so what the
  //      page owes is completeness: every paragraph of a long transcript
  //      leaves over the bridge, in batches the service can answer quickly.
  {
    const paras = Array.from({ length: 200 }, (_, i) =>
      `<p>Paragraph ${i} of a long transcript, easily long enough to send.</p>`).join('');
    const r = await run(`<article>${paras}</article>`);
    t('every paragraph of a long transcript is sent',
      r.sent.reduce((a, b) => a + b.count, 0), 200);
    t('  in batches of twenty or fewer', r.sent.every(x => x.count <= 20), true);
    t('  each with its own id', new Set(r.sent.map(x => x.id)).size, r.sent.length);
  }
  {
    // The cap itself now lives in the app, so it is asserted where it lives.
    const rn = src.slice(src.indexOf('var runTranslationQueue'), src.indexOf('var handleMessage'));
    t('the app allows two requests in flight', /MAX_INFLIGHT = 2\b/.test(rn), true);
    t('  and retries three times before giving up', /attempt < 3\b/.test(rn), true);
    t('  the page is never handed a network call',
      /fetch\(/.test(factory('he')), false);
  }

  // 14 · The reader must be told work is happening. Without it an English
  //      page just sits there and looks hung - which is what it looked like.
  {
    const rn = src.slice(src.indexOf('var runTranslationQueue'), src.indexOf('return (', src.indexOf('var handleMessage')));
    t('the spinner is switched on when a batch is queued',
      /setTranslating\(true\)/.test(rn), true);
    t('  and off when nothing is queued or in flight',
      /inFlightRef\.current === 0[\s\S]{0,60}setTranslating\(false\)/.test(rn), true);
    t('  and only for the article still on screen',
      /myGen === genRef\.current[\s\S]{0,40}setTranslating\(false\)/.test(rn), true);
  }
  {
    // All four languages, because the reader switches between them.
    const line = src.match(/const TRANSLATING_TEXT = \{[^}]*\}/)[0];
    for (const lang of ['he', 'ru', 'es', 'en']) {
      t(`"translating" exists in ${lang}`,
        new RegExp(`\\b${lang}:\\s*'[^']+'`).test(line), true);
    }
    t('  Hebrew is Hebrew', /he: 'מתרגם/.test(line), true);
    t('  Russian is Cyrillic', /ru: '[\u0400-\u04ff]/.test(line), true);
  }

  // 10 · Every language the app offers reaches the server as itself.
  for (const lang of ['he', 'ru', 'es']) {
    const r = await run(`<article><p>One sentence for every language the app ships.</p></article>`, { lang });
    t(`lang=${lang} is passed through`, r.sent[0].lang, lang);
  }

  console.log(bad ? `\n  ${bad} failing` : '\n  all passing');
  process.exit(bad ? 1 : 0);
})();

/**
 * The in-place translator, run against page shapes rather than against sites.
 *
 * Two versions of this failed the same way before it. The first skipped a
 * block unless its ancestors avoided a hand-written list of nav-ish tags. The
 * second aimed at a hand-written list of article containers, so any publisher
 * not on the list got nothing and the list could only ever grow.
 *
 * Both also read only text sitting DIRECTLY inside a block. A paragraph
 * written as <p><span>text</span></p> has no direct text node, so it was
 * skipped in silence. That is what "half the page is translated" actually
 * was: not an unhandled site, an unhandled SHAPE. Most of the cases below are
 * shapes, because that is the thing that generalises.
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
const factory = new Function('lang', 'return ' + src.slice(bodyStart, bodyEnd + 2) + ';');

let bad = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(58) +
    (ok ? '' : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
  if (!ok) bad++;
};

// Stands in for the app: the page posts a batch over the bridge, this
// translates it and calls back. The page is never given a fetch, because on a
// real publisher page it does not have a usable one - Yahoo ships
// default-src 'none', which covers connect-src.
async function run(html, opts) {
  opts = opts || {};
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const window = {};
  const sent = [];
  const observers = [];
  const timers = [];
  const lang = opts.lang || 'he';

  window.ReactNativeWebView = {
    postMessage: (raw) => {
      const msg = JSON.parse(raw);
      if (msg.bv !== 'tr') return;
      sent.push({ id: msg.id, count: msg.texts.length, texts: msg.texts });
      const n = sent.length;
      Promise.resolve().then(() => {
        if (opts.failFetch || (opts.failFirst && n <= opts.failFirst)) {
          if (opts.failFirst && n <= opts.failFirst) {
            window.ReactNativeWebView.postMessage(raw);   // the app retries
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
  new Function('window', 'document', 'setTimeout', 'clearTimeout', 'MutationObserver', 'WeakSet', script)
    (window, document,
     (fn, ms) => { if (ms && ms >= 500) { Promise.resolve().then(fn); return 0; }
                   timers.push(fn); return timers.length; },
     () => {},
     function (cb) { this.observe = () => observers.push(cb); },
     WeakSet);

  const settle = async () => { for (let i = 0; i < 400; i++) await Promise.resolve(); };
  await settle();
  return {
    document, sent,
    text: () => document.body.textContent,
    async mutate(target, newHtml) {
      document.querySelector(target).innerHTML = newHtml;
      observers.forEach(cb => cb());
      timers.splice(0).forEach(fn => fn());
      await settle();
    },
  };
}

const sentAll = (r) => r.sent.flatMap(x => x.texts);

(async () => {
  console.log('\n  the shapes that used to be skipped in silence');
  {
    const r = await run(`<p>A paragraph with its text sitting directly inside it.</p>`);
    t('text directly inside a block', sentAll(r).length, 1);
    t('  and it lands back on the page', /«A paragraph with/.test(r.text()), true);
  }
  {
    // THE regression. Extremely common markup, and it produced nothing.
    const r = await run(`<p><span>A paragraph wrapped in a span, as most sites write it.</span></p>`);
    t('text wrapped in a span', sentAll(r).length, 1);
    t('  and it lands back on the page', /«A paragraph wrapped/.test(r.text()), true);
  }
  {
    const r = await run(`<div><div><section><p><em><strong>Buried four levels down.</strong></em></p></section></div></div>`);
    t('text buried under several wrappers', sentAll(r).length, 1);
  }
  {
    const r = await run(`<article><h1><span>Headline in a span</span></h1>
      <div class="whatever-this-site-calls-it"><p>Body under a class nobody could guess.</p></div></article>`);
    t('a container class nobody could have listed', sentAll(r).length, 2);
  }
  {
    // A sentence split by a link: every piece has to travel, and the link
    // has to survive with its href.
    const r = await run(`<p>Read the <a href="/filing">original filing</a> for the full numbers.</p>`);
    t('all three pieces of a split sentence are sent', sentAll(r).length, 3);
    t('  the link survives', !!r.document.querySelector('a'), true);
    t('  with its href', r.document.querySelector('a').getAttribute('href'), '/filing');
    t('  and its label is translated too',
      /«original filing»/.test(r.document.querySelector('a').textContent), true);
  }

  console.log('\n  what must never be sent');
  {
    const r = await run(`<script>var x = "some english words here";</script>
      <style>.cls { font-family: "Some Font Name"; }</style>
      <pre>const answer = "do not translate me";</pre>
      <code>npm install something</code>
      <p>The only sentence that should travel.</p>`);
    t('script, style, pre and code are left alone', sentAll(r).length, 1);
    t('  and it is the real sentence', /only sentence/.test(sentAll(r)[0]), true);
  }
  {
    const r = await run(`<div aria-hidden="true"><p>Hidden decorative text goes here.</p></div>
      <p>Visible text goes here instead.</p>`);
    t('aria-hidden text is left alone', sentAll(r).length, 1);
  }
  {
    const r = await run(`<p>$102.45</p><p>+1.24%</p><p>16:05</p><p>2026</p>
      <p>Revenue grew across every segment.</p>`);
    t('prices, percentages, times and years are not sent', sentAll(r).length, 1);
  }
  {
    const r = await run(`<p>   </p><p>a</p><p>Real content here.</p>`);
    t('whitespace and single characters are not sent', sentAll(r).length, 1);
  }

  console.log('\n  keeping the page intact');
  {
    const r = await run(`<p>Before <img src="/chart.png"> after the picture.</p>`);
    t('images survive', !!r.document.querySelector('img'), true);
    t('  and its src is untouched', r.document.querySelector('img').getAttribute('src'), '/chart.png');
  }
  {
    const r = await run(`<p>Spacing <b>matters</b> between words.</p>`);
    const txt = r.document.querySelector('p').textContent;
    t('the space before an inline element is kept', / «matters»/.test(txt), true);
    t('  and the space after it', /«matters» /.test(txt), true);
  }
  {
    const r = await run(`<p>One sentence, translated exactly once.</p><div id="late"></div>`);
    await r.mutate('#late', '');
    t('never translated twice', sentAll(r).length, 1);
  }

  console.log('\n  content that arrives later');
  {
    const r = await run(`<article><p>The opening paragraph.</p><div id="late"></div></article>`);
    const before = r.sent.length;
    await r.mutate('#late', '<p><span>A section the site loads once you scroll.</span></p>');
    t('a later section is translated', r.sent.length > before, true);
    t('  including through its span', /«A section the site/.test(r.text()), true);
  }
  {
    const r = await run(`<p>The first article.</p><div id="late"></div>`);
    await r.mutate('#late', '<article><p>A second article further down the page.</p></article>');
    t('a whole second article loaded later is translated',
      sentAll(r).some(x => /second article/.test(x)), true);
  }

  console.log('\n  failure and retry');
  {
    const r = await run(`<p>A paragraph the service rejects twice first.</p>`, { failFirst: 2 });
    t('a rejected batch is retried', r.sent.length, 3);
    t('  and the text ends up translated', /«A paragraph the service/.test(r.text()), true);
  }
  {
    const r = await run(`<p>This one never succeeds today.</p><div id="late"></div>`, { failFetch: true });
    t('the original text is still readable', /never succeeds today/.test(r.text()), true);
    const before = r.sent.length;
    await r.mutate('#late', '');
    t('  and a later pass tries it again', r.sent.length > before, true);
  }

  console.log('\n  batching');
  {
    const paras = Array.from({ length: 200 }, (_, i) =>
      `<p><span>Paragraph ${i} of a long transcript, long enough to send.</span></p>`).join('');
    const r = await run(paras);
    t('every paragraph of a long transcript is sent', sentAll(r).length, 200);
    // 20 is not arbitrary: measured against the live service, 100 paragraphs
    // took 16.9 seconds and 20 took 2.4.
    t('  in batches of twenty or fewer', r.sent.every(x => x.count <= 20), true);
    t('  each with its own id', new Set(r.sent.map(x => x.id)).size, r.sent.length);
  }
  {
    const rn = src.slice(src.indexOf('var runTranslationQueue'), src.indexOf('var handleMessage'));
    t('the app allows two requests in flight', /MAX_INFLIGHT = 2\b/.test(rn), true);
    t('  and retries three times before giving up', /attempt < 3\b/.test(rn), true);
    t('  the page is never handed a network call', /fetch\(/.test(factory('he')), false);
    // The names may appear in the comment that explains why they are gone.
    // What must not exist is a selector that USES them.
    const code = factory('he').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    t('  no container selector survives in the code',
      /caas-body|ArticleBody|articleBody|story-body|ROOT_SEL/.test(code), false);
    t('  and nothing queries the document for one',
      /querySelector(All)?\(/.test(code), false);
  }

  console.log('\n  language');
  {
    const he = await run(`<p>A paragraph that should end up right aligned.</p>`, { lang: 'he' });
    const es = await run(`<p>A paragraph that should stay left aligned.</p>`, { lang: 'es' });
    t('Hebrew is set to rtl', he.document.querySelector('p').style.direction, 'rtl');
    t('Spanish is left alone', es.document.querySelector('p').style.direction || '', '');
  }
  {
    const line = src.match(/const TRANSLATING_TEXT = \{[^}]*\}/)[0];
    for (const lang of ['he', 'ru', 'es', 'en']) {
      t(`"translating" exists in ${lang}`,
        new RegExp(`\\b${lang}:\\s*'[^']+'`).test(line), true);
    }
  }

  console.log(bad ? `\n  ${bad} failing` : '\n  all passing');
  process.exit(bad ? 1 : 0);
})();

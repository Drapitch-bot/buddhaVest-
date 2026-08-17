import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, StatusBar, Linking,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../constants/AppContext';
import { API_BASE } from '../constants/api';
import { ERR, httpError, classifyError, errorText } from '../utils/errors';

const TRANSLATE_LANGS = new Set(['he', 'ru', 'es']);
const TRANSLATE_TIMEOUT_MS = 30000;

// UI strings in the USER'S language (not the phone's system language)
const BADGE_TEXT = { he: 'מתורגם', ru: 'Переведено', es: 'Traducido', en: 'Translated' };
const TRANSLATING_TEXT = { he: 'מתרגם...', ru: 'Перевод...', es: 'Traduciendo...', en: 'Translating...' };

// Google News RSS links redirect via JavaScript (not HTTP), so the server
// can't resolve them. The WebView runs the JS redirect for us — we just catch
// the real article URL it lands on.
function isGnewsUrl(u) {
  return /news\.google\.com\/rss\/articles/.test(u || '');
}

// Google's cookie-consent interstitial (shown before some articles). We must
// never treat it as the article — skip translating it and keep waiting for the
// real URL; the injected CONSENT_JS accepts the wall to move things forward.
function isConsentUrl(u) {
  return /consent\.google\.|guce\.google\.|\/\/consent\.|guce\./i.test(u || '');
}

// Injected into the loaded article page: extracts title + paragraphs from the
// RENDERED DOM and posts them to the app. This works even on sites that block
// server-side fetching (Reuters, WSJ...) because the phone's browser is a
// real browser that the site already served the article to.
const EXTRACT_JS = `
(function() {
  try {
    if (window.__bvExtracted) return;
    if (location.hostname.indexOf('google') !== -1) return;
    window.__bvExtracted = true;
    // Runs INSIDE the page, after its own JavaScript has finished. That is the
    // one advantage this path has over the server: the images are really in
    // the DOM here, already loaded and already resolved. The server fetches
    // raw HTML and, on Yahoo, never sees a single <img>.
    var IMG_JUNK = /logo|icon|avatar|sprite|pixel|spacer|1x1|blank\\.|placeholder|advert|\\/ads\\/|doubleclick/i;
    function grab() {
      var out = [];
      var h1 = document.querySelector('h1');
      var title = ((h1 && h1.innerText) || document.title || '').trim();
      var scope = document.querySelector('article') || document.body;
      if (!scope) return { title: title, items: out };
      // Same tag list the server keeps. The old one was p/h2/h3 only, which is
      // why every article opened through this path arrived as a wall of text.
      var nodes = scope.querySelectorAll('p, h2, h3, h4, li, blockquote, figcaption, img');
      var chars = 0;
      var seenImg = {};
      for (var i = 0; i < nodes.length && out.length < 150 && chars < 24000; i++) {
        var el = nodes[i];
        var tag = el.tagName.toLowerCase();
        if (tag === 'img') {
          // currentSrc is what the browser actually chose out of srcset, so
          // lazy loading and responsive images are already resolved for us.
          var src = el.currentSrc || el.src || '';
          if (!src || src.indexOf('data:') === 0) continue;
          if (src.indexOf('http') !== 0) continue;
          if (IMG_JUNK.test(src)) continue;
          // Real dimensions, not declared ones: the picture is loaded.
          if ((el.naturalWidth || el.width || 0) < 200) continue;
          if (seenImg[src]) continue;
          seenImg[src] = 1;
          out.push({ tag: 'img', text: '', src: src.slice(0, 600) });
          continue;
        }
        var t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        var floor = tag === 'p' ? 40 : (tag === 'figcaption' ? 12 : (tag === 'li' ? 18 : 15));
        var ceiling = (tag === 'h2' || tag === 'h3' || tag === 'h4') ? 200 : 100000;
        if (t.length > floor && t.length < ceiling) {
          out.push({ tag: tag, text: t.slice(0, 3000) });
          chars += t.length;
        }
      }
      return { title: title, items: out, source: location.hostname, href: location.href };
    }
    // ── Expand the article before reading it ──
    //
    // This is why every limit raised so far changed nothing. Yahoo Finance and
    // most of its syndication partners render only the first few paragraphs and
    // hide the rest behind a "Story continues" / "Continue reading" button.
    // The remaining text is NOT in the DOM until that button is pressed, so
    // both readers were extracting the whole of what was there and the whole
    // of what was there was a third of the article.
    //
    // Only <button> and role=button are clicked, never <a>: a link would
    // navigate the WebView away from the page mid-extraction. Each element is
    // clicked once, and only while the text is still growing, so a button that
    // does nothing cannot spin.
    // A bare "continue" used to be in this list, and it should never have been:
    // it matches "Continue", "Continue to site", "Continue without accepting"
    // and any other button a page happens to label that way. This runs inside
    // somebody else's page — every alternative here has to be a phrase that
    // can only mean "reveal the rest of the article".
    var EXPAND_RE = /story continues|continue reading|read (?:more|the rest)|show more|keep reading|קרא עוד|המשך לקרוא|המשך קריאה|читать далее|leer más|ver más/i;
    var clicked = 0;
    var seenBtn = [];
    function expand() {
      if (clicked >= 6) return false;
      var cands = document.querySelectorAll(
        'button, [role="button"], [class*="readmore" i], [class*="read-more" i], ' +
        '[data-testid*="readmore" i], [class*="continues" i], [class*="expand" i]');
      var did = false;
      for (var i = 0; i < cands.length && clicked < 6; i++) {
        var el = cands[i];
        if (seenBtn.indexOf(el) !== -1) continue;
        // A link navigates. Anything that is or contains one is left alone.
        if (el.tagName === 'A' || el.querySelector('a')) continue;
        var label = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '') +
                     ' ' + (el.className || '') + ' ' +
                     (el.getAttribute('data-testid') || '')).slice(0, 300);
        if (!EXPAND_RE.test(label)) continue;
        seenBtn.push(el);
        try { el.click(); clicked++; did = true; } catch (e) {}
      }
      return did;
    }

    var attempt = 0;
    var lastLen = 0;
    var stable = 0;
    var timer = setInterval(function() {
      attempt++;
      expand();
      var d = grab();
      // Wait for the text to STOP growing, not merely to exist. Clicking the
      // expander adds paragraphs a moment later, and the old rule - three
      // blocks and a title - fired before any of them arrived, which is
      // precisely how a click-to-expand page yields a truncated article even
      // after the button has been pressed.
      var len = 0;
      for (var k = 0; k < d.items.length; k++) len += (d.items[k].text || '').length;
      if (len > lastLen) { lastLen = len; stable = 0; } else { stable++; }

      var enough = d.items.length >= 3 && d.title;
      if ((enough && stable >= 2) || attempt > 20) {
        clearInterval(timer);
        if (d.items.length >= 2 && window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify(d));
        }
      }
    }, 700);
  } catch (e) {}
})();
true;
`;

// Translated IN PLACE, on the real page, instead of through translate.goog.
//
// Measured, in a real browser, on the page the reader complained about:
// translate.goog served the article complete - 102 paragraphs, 50,704
// characters, ending on the last line of the disclaimer - and translated
// exactly none of it. Zero Hebrew, in every tenth of the page, still zero
// after twenty-four seconds and a full scroll. The same on a short article.
//
// The reason is structural, so no amount of waiting would have fixed it.
// translate.goog translates what Yahoo's SERVER sends; Yahoo's server sends a
// shell and injects the article from JavaScript in the browser afterwards.
// Google never sees the text. Anything Yahoo loads later - the sections
// further down the page - it never sees either.
//
// So the proxy is gone. The WebView opens the real Yahoo URL, which is the
// page the reader is comparing against, and the text is translated where it
// sits: images, layout, links and everything Yahoo loads on scroll stay
// exactly as they are. A MutationObserver keeps translating whatever arrives
// after the first pass, which is the part Google structurally cannot do.
const inPlaceTranslateJs = (lang) => `
(function() {
  if (window.__bvT) return; window.__bvT = 1;
  var LANG = ${JSON.stringify(lang)};
  var RTL = LANG === 'he';
  var SKIP = /^(script|style|noscript|svg|code|pre|iframe|button|select|textarea)$/i;
  // Sized by measurement against the live service, not by guesswork:
  // 100 paragraphs came back in 16.9 seconds, 30 in 3.5, 20 in 2.4.
  // In one big chunk the reader stares at seventeen seconds of English and
  // reasonably concludes the article was cut off again. In twenties the text
  // turns over from the top within about two seconds and fills downward.
  var MAX_ITEMS = 20, MAX_BYTES = 8000;
  var queue = [], batches = {}, nextId = 1;

  // Aim at the article, rather than guessing at everything that is not one.
  //
  // The first version only walked UP from each block and skipped it if any
  // ancestor was nav/header/footer/aside. Run against a real CNBC page that
  // rejected 130 of 135 blocks and translated nothing: one wrapper high up the
  // tree is enough to silence the whole article. Publishers nest their pages
  // differently and there is no reason that wrapper has to be a tag we guessed.
  //
  // So the article body is located first, by the containers publishers actually
  // use, and everything inside it is fair game. The ancestor test survives only
  // for pages where no such container exists, where guessing is all there is.
  var ROOT_SEL = 'article, [itemprop="articleBody"], [data-module="ArticleBody"], ' +
    '.ArticleBody-articleBody, .caas-body, #caas-content, .article-body, ' +
    '.articleBody, .story-body, .post-content, .entry-content, [role="article"], main';

  function roots() {
    var found = [];
    var nodes = document.querySelectorAll(ROOT_SEL);
    for (var i = 0; i < nodes.length; i++) {
      // A root inside another root would visit the same blocks twice.
      var nested = false;
      for (var j = 0; j < nodes.length; j++) {
        if (j !== i && nodes[j].contains(nodes[i])) { nested = true; break; }
      }
      if (!nested && nodes[i].textContent.trim().length > 0) found.push(nodes[i]);
    }
    return found;
  }

  function inArticle(el, hasRoot) {
    // Inside a located article body, everything belongs to the article.
    if (hasRoot) return true;
    // No container to aim at: fall back to skipping the obvious chrome. A
    // translated nav is worse than an untranslated one, and rewriting an <a>
    // label can change what the reader thinks they are about to open.
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      var t = n.tagName;
      if (t === 'NAV' || t === 'HEADER' || t === 'FOOTER' || t === 'ASIDE') return false;
      if (n.getAttribute && n.getAttribute('role') === 'navigation') return false;
    }
    return true;
  }

  function worthTranslating(s) {
    if (!s) return false;
    var t = s.trim();
    if (t.length < 2) return false;
    // Prices, tickers, timestamps and "+1.24%" are the same in every language,
    // and sending them back changes them for the worse.
    if (!/[A-Za-z]{3}/.test(t)) return false;
    return true;
  }

  // A block whose children are all inline is translated whole, so the sentence
  // reaches the translator intact. A block that contains other blocks is left
  // alone and its children are visited instead - replacing its text would
  // delete every link, image and heading inside it.
  var BLOCK_SEL = 'p,h1,h2,h3,h4,li,blockquote,figcaption,dd,dt,td,th';

  function collect() {
    var out = [];
    var found = roots();
    var hasRoot = found.length > 0;
    var blocks = [];
    if (hasRoot) {
      for (var r = 0; r < found.length; r++) {
        var inside = found[r].querySelectorAll(BLOCK_SEL);
        for (var q = 0; q < inside.length; q++) blocks.push(inside[q]);
      }
    } else {
      blocks = document.querySelectorAll(BLOCK_SEL);
    }
    for (var i = 0; i < blocks.length; i++) {
      var el = blocks[i];
      if (el.getAttribute('data-bv-t')) continue;
      if (SKIP.test(el.tagName)) continue;
      if (!inArticle(el, hasRoot)) continue;
      if (el.querySelector('p,h1,h2,h3,h4,li,blockquote,div,table')) continue;
      if (el.children.length === 0) {
        if (!worthTranslating(el.textContent)) { el.setAttribute('data-bv-t', 'skip'); continue; }
        out.push({ el: el, node: null, text: el.textContent.trim() });
      } else {
        // Mixed inline content: each text node on its own, so <a> and <strong>
        // survive with their attributes and their targets untouched.
        for (var j = 0; j < el.childNodes.length; j++) {
          var n = el.childNodes[j];
          if (n.nodeType !== 3) continue;
          if (!worthTranslating(n.nodeValue)) continue;
          out.push({ el: el, node: n, text: n.nodeValue.trim() });
        }
      }
      el.setAttribute('data-bv-t', 'sent');
    }
    return out;
  }

  function applyRtl(el) {
    if (!RTL) return;
    try { el.style.direction = 'rtl'; el.style.textAlign = 'right'; } catch (e) {}
  }

  // The page NEVER calls the network. Yahoo ships
  //     default-src 'none'; script-src 'none'; ...
  // as a meta CSP, and default-src covers connect-src, so every fetch from
  // inside the page is refused before it leaves. That is why the first
  // version showed the untranslated original: the text was collected
  // correctly and the request died silently.
  //
  // So the text goes out over the WebView bridge instead, the app - which no
  // page policy applies to - does the request, and the answer comes back
  // through __bvApply. Injected script still runs despite script-src 'none'
  // because it is evaluated through the bridge, not fetched as a page script.
  function send() {
    if (!window.ReactNativeWebView) return;
    while (queue.length) {
      var chunk = [], bytes = 0;
      while (queue.length && chunk.length < MAX_ITEMS && bytes < MAX_BYTES) {
        bytes += queue[0].text.length; chunk.push(queue.shift());
      }
      var id = nextId++;
      batches[id] = chunk;
      window.ReactNativeWebView.postMessage(JSON.stringify({
        bv: 'tr', id: id, texts: chunk.map(function(c) { return c.text; })
      }));
    }
  }

  // Called by the app with the finished translation. Text only - it is written
  // through textContent and nodeValue, never as markup.
  window.__bvApply = function(id, texts) {
    var chunk = batches[id]; if (!chunk) return; delete batches[id];
    for (var k = 0; k < chunk.length; k++) {
      var t = texts && texts[k];
      if (!t || typeof t !== 'string') continue;   // untranslated stays readable
      try {
        if (chunk[k].node) chunk[k].node.nodeValue = ' ' + t + ' ';
        else chunk[k].el.textContent = t;
        applyRtl(chunk[k].el);
        chunk[k].el.setAttribute('data-bv-t', 'done');
      } catch (e) {}
    }
  };

  // Gave up on this batch. Hand the blocks back so the next pass tries again,
  // rather than leaving a hole in the middle of the article.
  window.__bvFail = function(id) {
    var chunk = batches[id]; if (!chunk) return; delete batches[id];
    for (var i = 0; i < chunk.length; i++) {
      if (chunk[i].el.getAttribute('data-bv-t') !== 'done') {
        chunk[i].el.removeAttribute('data-bv-t');
      }
    }
  };

  function pass() {
    var found = collect();
    if (!found.length) return;
    queue = queue.concat(found);
    send();
  }

  pass();
  // Yahoo fills the article in after load and keeps adding to it on scroll.
  // This is precisely what translate.goog cannot follow, and the reason a
  // section further down the page arrived untranslated.
  var pending = null;
  new MutationObserver(function() {
    clearTimeout(pending);
    pending = setTimeout(pass, 600);
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('scroll', function() {
    clearTimeout(pending); pending = setTimeout(pass, 600);
  }, { passive: true });
})();
true;
`;

// Injected into the publisher's page, after it loads.
//
// The proxy serves the real page, and the real page lazy-loads its pictures:
// the <img> carries a placeholder and the true file sits in data-src or
// srcset, swapped in by an IntersectionObserver when the image scrolls into
// view. Through translate.goog that observer frequently never fires, so the
// images never load and the space reserved for them stays blank. Reported
// from the phone as "a lot of empty space".
//
// The first instinct was to hide the gaps. That is backwards — the pictures
// are part of the article, and the ask was for the page to look like the
// original. So this makes them LOAD: the real URL is copied into src, native
// lazy loading is switched to eager, and a scroll event is dispatched to wake
// any observer that is listening for one.
//
// Only after the pictures have had several seconds to arrive does anything get
// hidden, and then only two things: an image the browser has finished with and
// failed to fetch, and an ad slot that reserved height and never filled
// because ad networks do not serve through the proxy.
const PAGE_CLEAN_JS = `
(function() {
  try {
    // Word-bounded on purpose. A bare "ad" substring matches "read", "header",
    // "download", "loading" and "shadow" — it would take out half the article.
    var AD_SEL = [
      'ins.adsbygoogle',
      'iframe[src*="doubleclick"]',
      'iframe[src*="googlesyndication"]',
      'iframe[src*="amazon-adsystem"]',
      'iframe[id*="google_ads"]',
      '[id^="ad-"]', '[id$="-ad"]', '[id*="-ad-"]',
      '[class^="ad-"]', '[class*=" ad-"]', '[class*="-ad-"]', '[class*="ad-slot"]',
      '[class*="ad-container"]', '[class*="advertisement"]', '[class*="adWrapper"]',
      '[data-testid*="-ad"]', '[data-google-query-id]',
      '[aria-label="Advertisement"]', '[aria-label="advertisement"]'
    ].join(',');

    // ── 1. Make the pictures load ──
    function wakeImages() {
      var imgs = document.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) {
        var el = imgs[i];
        // Native lazy loading also holds images back off-screen.
        // Both forms: the IDL property is what browsers act on, the attribute
        // is what survives a page that re-reads its own markup.
        if (el.getAttribute('loading') === 'lazy' || el.loading === 'lazy') {
          el.loading = 'eager';
          el.setAttribute('loading', 'eager');
        }
        if (el.getAttribute('decoding') === 'async') el.setAttribute('decoding', 'sync');

        var real = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') ||
                   el.getAttribute('data-original') || el.getAttribute('data-srcset');
        var cur = el.getAttribute('src') || '';
        // Swap the placeholder for the real file. A 1x1 gif or an inline data:
        // URI is the placeholder; anything else is already the picture.
        if (real && (!cur || cur.indexOf('data:') === 0)) {
          if (real.indexOf(' ') !== -1) {
            // A srcset value: take the last (widest) candidate.
            var parts = real.split(',');
            var last = parts[parts.length - 1].trim().split(' ')[0];
            if (last) el.setAttribute('src', last);
          } else {
            el.setAttribute('src', real);
          }
        }
        // <picture> keeps its candidates on <source>, not on the <img>.
        var pic = el.parentNode;
        if (pic && pic.tagName === 'PICTURE') {
          var srcs = pic.querySelectorAll('source[data-srcset]');
          for (var k = 0; k < srcs.length; k++) {
            srcs[k].setAttribute('srcset', srcs[k].getAttribute('data-srcset'));
          }
        }
      }
      // Some lazy loaders listen for scroll rather than using an observer.
      try {
        window.dispatchEvent(new Event('scroll'));
        window.dispatchEvent(new Event('resize'));
      } catch (e) {}
    }

    // ── 2. Only what is left over, and only later ──
    function sweep() {
      var i, el;
      var ads = document.querySelectorAll(AD_SEL);
      for (i = 0; i < ads.length; i++) {
        el = ads[i];
        if (el.dataset && el.dataset.bvGone) continue;
        if (el.dataset) el.dataset.bvGone = '1';
        el.style.display = 'none';
      }
      // complete && naturalWidth === 0 is the browser saying "I finished, and
      // there is nothing" — checked only now, so an image still downloading is
      // never mistaken for a broken one.
      var imgs = document.querySelectorAll('img');
      for (i = 0; i < imgs.length; i++) {
        el = imgs[i];
        if (el.complete && el.naturalWidth === 0) el.style.display = 'none';
      }
      var blocks = document.querySelectorAll('div,section,aside,figure');
      for (i = 0; i < blocks.length; i++) {
        el = blocks[i];
        if (el.dataset && el.dataset.bvChecked) continue;
        if (el.offsetHeight < 60) continue;
        if ((el.innerText || '').trim().length > 0) continue;
        if (el.querySelector('img,svg,video,canvas,picture,input,button')) continue;
        if (el.dataset) el.dataset.bvChecked = '1';
        el.style.display = 'none';
      }
      // Google's own translation toolbar floats over the article and is not
      // part of it; the app already shows which language is selected.
      var bars = document.querySelectorAll(
        '.skiptranslate, #gt-nvframe, iframe.skiptranslate, .goog-te-banner-frame');
      for (i = 0; i < bars.length; i++) bars[i].style.display = 'none';
      if (document.body && document.body.style.top) document.body.style.top = '0px';
    }

    wakeImages();
    var n = 0;
    var t = setInterval(function() {
      n++;
      wakeImages();                 // the page keeps inserting images as it goes
      if (n >= 5) sweep();          // ~4s in: whatever has not arrived is not coming
      if (n > 14) clearInterval(t);
    }, 800);
  } catch (e) {}
})();
true;
`;

// Runs BEFORE each page's own scripts. When the WebView lands on Google's
// cookie-consent wall (shown in the device language, e.g. Hebrew, the first
// time an article routes through Google News / translate.goog), this sets the
// consent cookies and auto-clicks "Accept all" so the user never sees it.
const CONSENT_JS = `
(function() {
  try {
    var h = location.hostname || '';
    if (h.indexOf('google') === -1) return;
    // Pre-seed consent cookies so future loads skip the wall entirely.
    var exp = new Date(Date.now() + 3153600000000).toUTCString(); // ~100y
    document.cookie = 'CONSENT=YES+; domain=.google.com; path=/; expires=' + exp;
    document.cookie = 'SOCS=CAI; domain=.google.com; path=/; expires=' + exp;
    // Auto-click the accept/agree button if a consent form is present.
    var click = function() {
      var els = document.querySelectorAll('button, [role="button"], input[type="submit"]');
      for (var i = 0; i < els.length; i++) {
        var tx = ((els[i].innerText || els[i].value || '') + '').toLowerCase();
        // Google renders this wall in the DEVICE language, not the app's.
        // Only English and Hebrew were matched here, so a phone set to Russian
        // or Spanish never got the wall auto-accepted and the reader sat on
        // Google's consent page instead of the article. All four supported
        // languages are covered now (tx is already lower-cased above).
        if (tx.indexOf('accept all') !== -1 || tx.indexOf('agree') !== -1 ||
            tx.indexOf('קבל') !== -1 || tx.indexOf('אישור') !== -1 || tx.indexOf('הסכמה') !== -1 ||
            tx.indexOf('принять') !== -1 || tx.indexOf('согласен') !== -1 ||
            tx.indexOf('соглашаюсь') !== -1 || tx.indexOf('принимаю') !== -1 ||
            tx.indexOf('aceptar') !== -1 || tx.indexOf('acepto') !== -1 ||
            tx.indexOf('de acuerdo') !== -1) {
          els[i].click();
          return true;
        }
      }
      return false;
    };
    var n = 0;
    var iv = setInterval(function() { if (click() || ++n > 10) clearInterval(iv); }, 300);
  } catch (e) {}
})();
true;
`;

// Parameter named `v`, not `s`: `s` is this file's StyleSheet, and shadowing it
// here is the same footgun that turned `return s` in FinancialsCard into
// "return the entire StyleSheet".
function escapeHtml(v) {
  return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default function ArticleScreen({ route, navigation }) {
  const { url, lang } = route.params || {};
  const { colors, t, translateArticles } = useApp();
  const insets = useSafeAreaInsets();
  const [error, setError] = useState(false);
  const [translatedHtml, setTranslatedHtml] = useState(null);
  const [translating, setTranslating] = useState(false);
  // Real article URL: known immediately for direct links, resolved by the
  // WebView's navigation for Google News links.
  const [resolvedUrl, setResolvedUrl] = useState(isGnewsUrl(url) ? null : url);
  const abortRef = useRef(null);
  const domSentRef = useRef(false);
  // Holds the pending 'show the server version' timer so the WebView path
  // can cancel it the moment its own result is ready.
  const graceRef = useRef(null);
  // Kept so the two versions can be compared by length when the WebView
  // result arrives after the server's is already on screen.
  const serverHtmlRef = useRef(null);
  // Needed to hand a finished translation back to the page. The page cannot
  // fetch it itself: publishers ship a meta CSP - Yahoo's is
  // default-src 'none'; script-src 'none' - and default-src covers connect-src,
  // so any request from inside the page is refused before it leaves.
  const webRef = useRef(null);
  // Requests in flight for the in-place path. Two, because the service allows
  // 120 a minute and one long transcript should not spend that budget at once.
  const inFlightRef = useRef(0);
  const trQueueRef = useRef([]);
  // Set when the publisher's own page will not load at all. The rebuilt
  // reader below survives only for that case — it is the thing that does not
  // look like the original, so it is not what anyone should see first.
  const [livePageFailed, setLivePageFailed] = useState(false);
  // Generation counter for the DOM-extraction translation path. The server fast
  // path is cancelled by its effect cleanup (AbortController), but this one is
  // fired from a WebView message and was never cancelled: switching article or
  // language mid-translation let the PREVIOUS article's translated text land on
  // the new screen, because the reset had just set translatedHtml back to null.
  const genRef = useRef(0);
  const needsTranslation = translateArticles && lang && TRANSLATE_LANGS.has(lang);
  // The real Yahoo URL, translated where it sits. Verified in a browser:
  // translate.goog returned this article complete and translated 0% of it,
  // because Yahoo injects the body from JavaScript after Google has already
  // read the page. Translating in place is the only way the later sections -
  // the ones Yahoo loads on scroll - get translated at all.
  const canTranslateInPlace = needsTranslation && !isGnewsUrl(url) && !!resolvedUrl;
  const translatingInPlace = canTranslateInPlace && !livePageFailed;
  const inPlaceJs = translatingInPlace ? inPlaceTranslateJs(lang) : undefined;

  useEffect(function() {
    genRef.current++;            // invalidate any in-flight DOM translation
    trQueueRef.current = [];     // and anything queued for the article we are leaving
    setResolvedUrl(isGnewsUrl(url) ? null : url);
    setTranslatedHtml(null);
    setLivePageFailed(false);
    if (graceRef.current) { clearTimeout(graceRef.current); graceRef.current = null; }
    setError(false);
    setTranslating(false);
    domSentRef.current = false;
  }, [url, lang]);

  useEffect(function() {
    if (!resolvedUrl) return;
    if (isConsentUrl(resolvedUrl)) return; // never translate a consent page

    if (!needsTranslation) return;
    // The proxy is serving the real page; the reader would only replace it
    // with a worse-looking one.
    if (translatingInPlace) return;

    // Try server-side clean translation in background.
    // Meanwhile the WebView shows the article via the translate.goog proxy.
    // If the server succeeds -> replace WebView with clean translated HTML.
    if (abortRef.current) abortRef.current.abort();
    var controller = new AbortController();
    abortRef.current = controller;

    setTranslating(true);
    var myGen = genRef.current;
    var timer = setTimeout(function() { controller.abort(); }, TRANSLATE_TIMEOUT_MS);

    fetch(API_BASE + '/translate-article?url=' + encodeURIComponent(resolvedUrl) + '&lang=' + lang, {
      signal: controller.signal,
    })
      .then(function(r) {
        if (!r.ok) throw new Error('err');
        return r.text();
      })
      .then(function(html) {
        clearTimeout(timer);
        if (myGen !== genRef.current) return;   // article/language changed
        // Give the WebView path a head start before showing this one.
        //
        // The two produce different quality, not just different timing. This
        // one fetches raw HTML, so on Yahoo — where most of these articles
        // come from — it never sees a single <img>, because the pictures are
        // inserted by the page's own JavaScript. The WebView path runs INSIDE
        // the page after that JavaScript, so it gets the real images with
        // srcset and lazy loading already resolved.
        //
        // First-past-the-post therefore meant the reader got the poorer
        // version whenever the server happened to be quicker, which is most of
        // the time. This waits ~1.6s: if the WebView delivers in that window
        // it wins, and if it does not — a bot-walled page, a page that never
        // finishes loading — this one is shown and nothing is lost but a
        // second and a half.
        //
        // domSentRef is checked, not just translatedHtml: it is set the moment
        // the extraction ARRIVES, before its translation round trip finishes,
        // so a WebView result that is already in flight is not overtaken here.
        var apply = function() {
          if (myGen !== genRef.current) return;
          setTranslatedHtml(function(prev) { return prev || html; });
          setTranslating(false);
        };
        serverHtmlRef.current = html;
        if (domSentRef.current) { apply(); return; }
        // 1600ms was arithmetic I never did. The WebView path needs the page to
        // load (1-3s), one poll (0.7s), the click, the revealed text (0.25s),
        // two stable passes (1.4s) and then its own translation round trip -
        // four to eight seconds. The server answers from a one-hour cache in
        // about 300ms. So the server won every single race, and the server is
        // the one that CANNOT press "Story continues", which is why the
        // article stayed truncated no matter what was fixed upstream.
        var grace = setTimeout(apply, 7000);
        graceRef.current = grace;
      })
      .catch(function() {
        clearTimeout(timer);
        // An abort from the cleanup lands AFTER the next effect already turned
        // the spinner on — without this it cleared the new request's spinner.
        if (myGen !== genRef.current) return;
        setTranslating(false);
      });

    return function() {
      clearTimeout(timer);
      // Without this a grace timer from the PREVIOUS article stays armed and
      // paints its HTML over the one the reader just opened.
      if (graceRef.current) { clearTimeout(graceRef.current); graceRef.current = null; }
      controller.abort();
    };
  }, [resolvedUrl, lang, needsTranslation]);

  var handleClose = function() { if (navigation.canGoBack()) navigation.goBack(); };

  var handleNavChange = function(nav) {
    if (resolvedUrl || !nav || !nav.url) return;
    var u = nav.url;
    if (/^https?:\/\//.test(u) && u.indexOf('google.com') === -1) {
      setResolvedUrl(u);
    }
  };

  // DOM extraction arrived from the WebView -> translate the raw texts and
  // build a clean reader page. Runs in parallel with the server fast path;
  // whichever finishes first wins (the other is ignored).
  // Runs one queued batch: translate on this side, inject the result back.
  // Everything here treats the page as hostile - it chose the batch id and the
  // strings - so ids are numbers only and the answer goes back as JSON that is
  // read with textContent on the other side, never as markup.
  var runTranslationQueue = React.useCallback(function() {
    var MAX_INFLIGHT = 2;
    var inject = function(fn, id, texts) {
      var w = webRef.current; if (!w) return;
      // </script> and the two line separators are the only sequences that can
      // break out of an injected JSON literal.
      var payload = JSON.stringify(texts === undefined ? [] : texts)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
      w.injectJavaScript('window.' + fn + ' && window.' + fn + '(' + id + ',' + payload + '); true;');
    };
    var pump = function() {
      while (inFlightRef.current < MAX_INFLIGHT && trQueueRef.current.length) {
        (function(job) {
          inFlightRef.current++;
          var myGen = genRef.current;
          var attempt = 0;
          var go = function() {
            fetch(API_BASE + '/translate-batch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ texts: job.texts, lang: job.lang }),
            })
              .then(function(r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
              })
              .then(function(d) {
                if (myGen !== genRef.current) return;   // article or language changed
                inject('__bvApply', job.id, (d && d.texts) || []);
              })
              .catch(function() {
                if (myGen !== genRef.current) return;
                attempt++;
                // Three tries. A batch that is dropped in silence leaves a hole
                // in the middle of the article and nothing ever retries it,
                // which is the failure this whole path exists to prevent.
                if (attempt < 3) { setTimeout(go, 700 * attempt); return; }
                inject('__bvFail', job.id);
              })
              .then(function() {
                inFlightRef.current--;
                if (trQueueRef.current.length) pump();
              });
          };
          go();
        })(trQueueRef.current.shift());
      }
    };
    pump();
  }, []);

  var handleMessage = function(e) {
    // The in-place path speaks first: the page has collected a batch and
    // cannot send it anywhere itself.
    if (translatingInPlace) {
      var msg;
      try { msg = JSON.parse(e.nativeEvent.data); } catch (err) { return; }
      if (!msg || msg.bv !== 'tr') return;
      if (typeof msg.id !== 'number' || !isFinite(msg.id)) return;
      if (!Array.isArray(msg.texts) || !msg.texts.length) return;
      // Caps mirror the server's own: 151 strings, 4500 characters each.
      var texts = msg.texts.slice(0, 151)
        .map(function(t) { return String(t == null ? '' : t).slice(0, 4500); });
      trQueueRef.current.push({ id: msg.id, texts: texts, lang: lang });
      runTranslationQueue();
      return;
    }
    if (!needsTranslation || translatedHtml || domSentRef.current) return;
    var data;
    try { data = JSON.parse(e.nativeEvent.data); } catch (err) { return; }
    // Array.isArray, not just .length — a hostile page could post
    // {items:"aaa"}, which passes a length check and then crashes on .map().
    if (!data || !Array.isArray(data.items) || data.items.length < 2) return;
    domSentRef.current = true;
    setTranslating(true);
    var myGen = genRef.current;

    // The message comes from a third-party page loaded in the WebView, so treat
    // every field as untrusted: cap the item count and keep only the fields we
    // actually use (text is escaped below; the TAG is whitelisted, never
    // interpolated raw — otherwise a hostile page could send tag:"script").
    var ALLOWED_TAGS = { p: 'p', h2: 'h2', h3: 'h3', h4: 'h4', li: 'li',
                         blockquote: 'blockquote', figcaption: 'figcaption', img: 'img' };
    var items = data.items.slice(0, 150).map(function(it) {
      var tag = ALLOWED_TAGS[String(it && it.tag).toLowerCase()] || 'p';
      // An image URL is interpolated into an attribute, so it gets a stricter
      // check than the text does: http(s) only, no javascript: or data:, and a
      // hard length cap. Everything else about the message is already treated
      // as hostile; this field has to be too.
      var src = '';
      if (tag === 'img') {
        src = String((it && it.src) || '');
        if (!/^https?:\/\//i.test(src)) { tag = 'p'; src = ''; }
        else src = src.slice(0, 600);
      }
      return {
        tag: tag,
        src: src,
        text: String((it && it.text) || '').slice(0, 4500),
      };
    }).filter(function(it) { return it.tag !== 'img' || it.src; });
    var sourceHost = String(data.source || '').replace(/^www\./, '').slice(0, 120);
    // Images carry no words. Sending their empty text to the translator would
    // burn a slot each and shift every following translation by one.
    var texts = [String(data.title || '').slice(0, 500)]
      .concat(items.map(function(it) { return it.tag === 'img' ? '' : it.text; }));
    fetch(API_BASE + '/translate-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: texts, lang: lang }),
    })
      .then(function(r) { if (!r.ok) throw new Error('err'); return r.json(); })
      .then(function(res) {
        if (myGen !== genRef.current) return;   // different article/language now
        var tr = res.texts || [];
        // Used to `return` here and leave the spinner running forever.
        if (tr.length < 3) { setTranslating(false); return; }
        var isRtl = lang === 'he';
        var body = '';
        if (tr[0]) body += '<h1>' + escapeHtml(tr[0]) + '</h1>';
        // A translated article with no way back to the original is a dead end,
        // and attribution is the decent thing regardless. Same line the server
        // emits, in the same four languages.
        var SRC_LABEL = { en: 'Read the original', he: 'לקריאת המקור',
                          ru: 'Читать оригинал', es: 'Leer el original' };
        if (sourceHost && /^https?:\/\//i.test(String(data.href || ''))) {
          body += '<p class="src">' + escapeHtml(sourceHost) + ' · <a href="' +
                  escapeHtml(String(data.href).slice(0, 800)) +
                  '" target="_blank" rel="noopener noreferrer">' +
                  escapeHtml(SRC_LABEL[lang] || SRC_LABEL.en) + '</a></p>';
        }
        for (var i = 0; i < items.length; i++) {
          var tag = items[i].tag;   // whitelisted above, never interpolated raw
          if (tag === 'img') {
            // src passed the http(s) test above and is escaped as an attribute
            // value here, so it cannot break out of the quotes.
            body += '<img src="' + escapeHtml(items[i].src) + '" loading="lazy" alt="">';
            continue;
          }
          var t = tr[i + 1] || '';
          if (!t) continue;
          if (tag === 'figcaption') body += '<p class="cap">' + escapeHtml(t) + '</p>';
          else body += '<' + tag + '>' + escapeHtml(t) + '</' + tag + '>';
        }
        // Kept deliberately identical to the stylesheet the server sends, so an
        // article does not change appearance depending on which of the two
        // paths happened to win the race.
        var html = '<!DOCTYPE html><html dir="' + (isRtl ? 'rtl' : 'ltr') + '"><head><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<style>body{font-family:-apple-system,Arial,sans-serif;padding:16px 18px;' +
          'line-height:1.75;color:#111;background:#fff;direction:' + (isRtl ? 'rtl' : 'ltr') + ';' +
          'max-width:800px;margin:0 auto;overflow-wrap:break-word}' +
          'h1{font-size:23px;margin:0 0 6px;line-height:1.35}' +
          'h2{font-size:19px;margin:22px 0 8px}h3{font-size:17px;margin:18px 0 6px}' +
          'h4{font-size:15px;margin:14px 0 6px}' +
          'p{font-size:16px;margin:0 0 14px}' +
          'li{font-size:16px;margin:0 0 8px}ul,ol{padding-inline-start:22px;margin:0 0 14px}' +
          'img{max-width:100%;height:auto;display:block;margin:16px auto;border-radius:10px}' +
          'blockquote{margin:14px 0;padding-inline-start:14px;' +
          'border-inline-start:3px solid #d97706;color:#333;font-style:italic}' +
          'a{color:#b45309;text-decoration:none}' +
          '.src{font-size:13px;color:#6b7280;margin:0 0 18px}' +
          '.src a{color:#b45309;text-decoration:underline}' +
          '.cap{font-size:13px;color:#666;text-align:center;margin:-8px 0 16px}' +
          '</style></head><body>' + body + '</body></html>';
        // This is the better version, so cancel the server's pending timer
        // rather than letting it fire and lose the race by a hair.
        if (graceRef.current) { clearTimeout(graceRef.current); graceRef.current = null; }
        setTranslatedHtml(function(prev) {
          // A grace period is a guess about timing, and a slow page will always
          // beat any guess. So this one is also allowed to arrive LATE and take
          // over — but only when it is clearly the fuller article, not merely
          // different. Below that bar the reader keeps what they are reading.
          if (!prev) return html;
          if (html.length > prev.length * 1.3) return html;
          return prev;
        });
        setTranslating(false);
      })
      .catch(function() {
        if (myGen !== genRef.current) return;   // stale — the new article owns the spinner
        domSentRef.current = false;
        setTranslating(false);
      });
  };

  return (
    <View style={[s.container, { backgroundColor: colors.bg }]}>
      <StatusBar barStyle={colors.statusBar || 'dark-content'} />
      <View style={[s.header, {
        paddingTop: insets.top + 6,
        backgroundColor: colors.card,
        borderBottomColor: colors.cardBorder,
      }]}>
        <TouchableOpacity onPress={handleClose} style={s.closeBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={[s.closeText, { color: colors.primary || '#f59e0b' }]}>
            {'✕  ' + (t.back || 'Back')}
          </Text>
        </TouchableOpacity>
        {translatedHtml ? (
          <View style={s.badge}><Text style={s.badgeText}>{BADGE_TEXT[lang] || BADGE_TEXT.en}</Text></View>
        ) : translating ? (
          <View style={s.translatingWrap}>
            <ActivityIndicator size="small" color={colors.primary || '#f59e0b'} />
            <Text style={[s.translatingText, { color: colors.textDim || '#6b7280' }]}>
              {TRANSLATING_TEXT[lang] || TRANSLATING_TEXT.en}
            </Text>
          </View>
        ) : null}
        <TouchableOpacity onPress={function() { if (url) Linking.openURL(url); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={{ color: colors.textDim || '#6b7280', fontSize: 20 }}>{'⧉'}</Text>
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={s.errorWrap}>
          <Text style={[s.errorText, { color: colors.text, fontWeight: '600', marginBottom: 6 }]}>
            {t.could_not_load || 'Could not load article'}
          </Text>
          <Text style={[s.errorText, { color: colors.textDim }]}>
            {errorText(error, t).msg}
          </Text>
          <TouchableOpacity onPress={handleClose} style={[s.retryBtn, { borderColor: colors.cardBorder }]}>
            <Text style={{ color: colors.primary || '#f59e0b' }}>{t.back || 'Back'}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <WebView
          ref={webRef}
          key={translatingInPlace ? 'inplace' : (translatedHtml ? 'clean' : 'orig')}
          source={translatingInPlace ? { uri: resolvedUrl || url }
                 : (translatedHtml ? { html: translatedHtml } : { uri: url })}
          onNavigationStateChange={handleNavChange}
          onMessage={handleMessage}
          // The page itself failing is the ONLY reason to fall back to the
          // rebuilt reader. Without this the reader would sit on an error page
          // while a working fallback existed one state flag away — and that
          // fallback fetches and translates on the server, so it does not
          // depend on the page that just failed to load.
          onError={function() { if (translatingInPlace) setLivePageFailed(true); }}
          onHttpError={function(e) {
            var code = e && e.nativeEvent && e.nativeEvent.statusCode;
            if (translatingInPlace && code >= 400) setLivePageFailed(true);
          }}
          injectedJavaScript={translatingInPlace ? (PAGE_CLEAN_JS + '\n' + inPlaceJs)
            : (needsTranslation && !translatedHtml ? EXTRACT_JS : undefined)}
          // The page is now the publisher's own, so the consent wall is back in
          // play and CONSENT_JS runs on every path again.
          injectedJavaScriptBeforeContentLoaded={translatedHtml ? undefined : CONSENT_JS}
          style={s.webview}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          // Third-party and shared cookies are OFF. They were on, which let news
          // sites set and read tracking cookies inside the app and share the
          // device's system cookie jar with them. Nothing here needs that — the
          // WebView only renders an article — and it was declared in neither the
          // Data Safety form nor the privacy policy, so the app was doing
          // something it had told nobody about.
          thirdPartyCookiesEnabled={false}
          sharedCookiesEnabled={false}
          startInLoadingState={true}
          allowsInlineMediaPlayback={true}
          userAgent="Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
          renderLoading={function() {
            return (
              <View style={[s.loadWrap, { backgroundColor: colors.bg }]}>
                <ActivityIndicator size="large" color={colors.primary || '#f59e0b'} />
              </View>
            );
          }}
          // The WebView already knows whether it never reached the network or
          // reached it and got a 5xx back. Both used to collapse into a single
          // "Could not load article".
          onError={function() { setError(ERR.OFFLINE); }}
          onHttpError={function(e) {
            const code = e && e.nativeEvent && e.nativeEvent.statusCode;
            if (code >= 500) setError(classifyError(httpError(code)));
          }}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container:  { flex: 1 },
  header:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: 0.5 },
  closeBtn:   { flexDirection: 'row', alignItems: 'center' },
  closeText:  { fontSize: 15, fontWeight: '600' },
  badge:      { backgroundColor: '#4285f4', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText:  { color: '#fff', fontSize: 11, fontWeight: '600' },
  translatingWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  translatingText: { fontSize: 12 },
  webview:    { flex: 1 },
  loadWrap:   { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                justifyContent: 'center', alignItems: 'center' },
  errorWrap:  { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16 },
  errorText:  { fontSize: 15 },
  retryBtn:   { paddingHorizontal: 20, paddingVertical: 10, borderWidth: 1, borderRadius: 8 },
});

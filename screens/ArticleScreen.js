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
    var EXPAND_RE = /story continues|continue reading|read more|read the rest|show more|keep reading|continue|קרא עוד|המשך לקרוא|המשך קריאה|читать далее|leer más|ver más/i;
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
  // Generation counter for the DOM-extraction translation path. The server fast
  // path is cancelled by its effect cleanup (AbortController), but this one is
  // fired from a WebView message and was never cancelled: switching article or
  // language mid-translation let the PREVIOUS article's translated text land on
  // the new screen, because the reset had just set translatedHtml back to null.
  const genRef = useRef(0);
  const needsTranslation = translateArticles && lang && TRANSLATE_LANGS.has(lang);

  useEffect(function() {
    genRef.current++;            // invalidate any in-flight DOM translation
    setResolvedUrl(isGnewsUrl(url) ? null : url);
    setTranslatedHtml(null);
    if (graceRef.current) { clearTimeout(graceRef.current); graceRef.current = null; }
    setError(false);
    setTranslating(false);
    domSentRef.current = false;
  }, [url, lang]);

  useEffect(function() {
    if (!resolvedUrl) return;
    if (isConsentUrl(resolvedUrl)) return; // never translate a consent page

    if (!needsTranslation) return;

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
        if (domSentRef.current) { apply(); return; }
        var grace = setTimeout(apply, 1600);
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
  var handleMessage = function(e) {
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
        setTranslatedHtml(function(prev) { return prev || html; });
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
          key={translatedHtml ? 'clean' : 'orig'}
          source={translatedHtml ? { html: translatedHtml } : { uri: url }}
          onNavigationStateChange={handleNavChange}
          onMessage={handleMessage}
          injectedJavaScript={needsTranslation && !translatedHtml ? EXTRACT_JS : undefined}
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

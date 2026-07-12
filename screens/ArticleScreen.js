import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, StatusBar, Linking,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../constants/AppContext';
import { API_BASE } from '../constants/api';

const TRANSLATE_LANGS = new Set(['he', 'ru', 'es']);
const TRANSLATE_TIMEOUT_MS = 30000;

// Google News RSS links redirect via JavaScript (not HTTP), so the server
// can't resolve them. The WebView runs the JS redirect for us — we just catch
// the real article URL it lands on.
function isGnewsUrl(u) {
  return /news\.google\.com\/rss\/articles/.test(u || '');
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
    function grab() {
      var out = [];
      var h1 = document.querySelector('h1');
      var title = ((h1 && h1.innerText) || document.title || '').trim();
      var scope = document.querySelector('article') || document.body;
      if (!scope) return { title: title, items: out };
      var nodes = scope.querySelectorAll('p, h2, h3');
      for (var i = 0; i < nodes.length && out.length < 25; i++) {
        var tag = nodes[i].tagName.toLowerCase();
        var t = (nodes[i].innerText || '').replace(/\\s+/g, ' ').trim();
        if ((tag === 'p' && t.length > 60) || (tag !== 'p' && t.length > 15 && t.length < 200)) {
          out.push({ tag: tag, text: t.slice(0, 3000) });
        }
      }
      return { title: title, items: out };
    }
    var attempt = 0;
    var timer = setInterval(function() {
      attempt++;
      var d = grab();
      if ((d.items.length >= 3 && d.title) || attempt > 8) {
        clearInterval(timer);
        if (d.items.length >= 3 && window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify(d));
        }
      }
    }, 900);
  } catch (e) {}
})();
true;
`;

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  const needsTranslation = translateArticles && lang && TRANSLATE_LANGS.has(lang);

  useEffect(function() {
    setResolvedUrl(isGnewsUrl(url) ? null : url);
    setTranslatedHtml(null);
    setError(false);
    domSentRef.current = false;
  }, [url, lang]);

  useEffect(function() {
    if (!resolvedUrl) return;

    if (!needsTranslation) return;

    // Try server-side clean translation in background.
    // Meanwhile the WebView shows the article via the translate.goog proxy.
    // If the server succeeds -> replace WebView with clean translated HTML.
    if (abortRef.current) abortRef.current.abort();
    var controller = new AbortController();
    abortRef.current = controller;

    setTranslating(true);
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
        setTranslatedHtml(function(prev) { return prev || html; });
        setTranslating(false);
      })
      .catch(function() {
        clearTimeout(timer);
        setTranslating(false);
      });

    return function() {
      clearTimeout(timer);
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
    if (!data || !data.items || data.items.length < 3) return;
    domSentRef.current = true;

    var texts = [data.title || ''].concat(data.items.map(function(it) { return it.text; }));
    fetch(API_BASE + '/translate-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: texts, lang: lang }),
    })
      .then(function(r) { if (!r.ok) throw new Error('err'); return r.json(); })
      .then(function(res) {
        var tr = res.texts || [];
        if (tr.length < 4) return;
        var isRtl = lang === 'he';
        var body = '';
        if (tr[0]) body += '<h1>' + escapeHtml(tr[0]) + '</h1>';
        for (var i = 0; i < data.items.length; i++) {
          var t = tr[i + 1] || '';
          if (t) {
            var tag = data.items[i].tag === 'p' ? 'p' : data.items[i].tag;
            body += '<' + tag + '>' + escapeHtml(t) + '</' + tag + '>';
          }
        }
        var html = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<style>body{font-family:-apple-system,Arial,sans-serif;padding:16px 18px;' +
          'line-height:1.75;color:#111;background:#fff;direction:' + (isRtl ? 'rtl' : 'ltr') + ';' +
          'max-width:800px;margin:0 auto}h1{font-size:22px;margin:0 0 16px}' +
          'h2{font-size:18px;margin:20px 0 8px}h3{font-size:16px;margin:16px 0 6px}' +
          'p{font-size:16px;margin:0 0 14px}</style></head><body>' + body + '</body></html>';
        setTranslatedHtml(function(prev) { return prev || html; });
      })
      .catch(function() { domSentRef.current = false; });
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
          <View style={s.badge}><Text style={s.badgeText}>{'מתורגם'}</Text></View>
        ) : translating ? (
          <ActivityIndicator size="small" color={colors.primary || '#f59e0b'} />
        ) : null}
        <TouchableOpacity onPress={function() { if (url) Linking.openURL(url); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={{ color: colors.textDim || '#6b7280', fontSize: 20 }}>{'⧉'}</Text>
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={s.errorWrap}>
          <Text style={[s.errorText, { color: colors.textDim }]}>
            {t.could_not_load || 'Could not load article'}
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
          style={s.webview}
          javaScriptEnabled={true}
          domStorageEnabled={true}
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
          onError={function() { setError(true); }}
          onHttpError={function(e) { if (e.nativeEvent.statusCode >= 500) setError(true); }}
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
  webview:    { flex: 1 },
  loadWrap:   { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                justifyContent: 'center', alignItems: 'center' },
  errorWrap:  { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16 },
  errorText:  { fontSize: 15 },
  retryBtn:   { paddingHorizontal: 20, paddingVertical: 10, borderWidth: 1, borderRadius: 8 },
});

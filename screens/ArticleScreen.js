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

// Google Translate uses legacy language codes (Hebrew = 'iw', not 'he')
const GT_LANG_MAP = { he: 'iw', ru: 'ru', es: 'es' };

// Google Translate site proxy (translate.goog) — loads the article ALREADY
// translated as a full-page navigation. Not blocked by the site's CSP or
// X-Frame-Options (unlike widget injection / iframes).
// finance.yahoo.com -> finance-yahoo-com.translate.goog
function toProxyUrl(url, lang) {
  var gt = GT_LANG_MAP[lang] || lang;
  var m = (url || '').match(/^https?:\/\/([^\/?#]+)([^?#]*)(\?[^#]*)?/);
  if (!m) return url;
  var host = m[1].replace(/-/g, '--').replace(/\./g, '-');
  var path = m[2] || '/';
  var search = m[3] || '';
  var sep = search ? '&' : '?';
  return 'https://' + host + '.translate.goog' + path + search + sep +
    '_x_tr_sl=auto&_x_tr_tl=' + gt + '&_x_tr_hl=' + gt;
}

// Google News RSS links redirect via JavaScript (not HTTP), so the server
// can't resolve them. The WebView runs the JS redirect for us — we just catch
// the real article URL it lands on.
function isGnewsUrl(u) {
  return /news\.google\.com\/rss\/articles/.test(u || '');
}

export default function ArticleScreen({ route, navigation }) {
  const { url, lang } = route.params || {};
  const { colors, t, translateArticles } = useApp();
  const insets = useSafeAreaInsets();
  const [error, setError] = useState(false);
  const [translatedHtml, setTranslatedHtml] = useState(null);
  const [translating, setTranslating] = useState(false);
  const [proxyFailed, setProxyFailed] = useState(false);
  // Real article URL: known immediately for direct links, resolved by the
  // WebView's navigation for Google News links.
  const [resolvedUrl, setResolvedUrl] = useState(isGnewsUrl(url) ? null : url);
  const abortRef = useRef(null);
  const needsTranslation = translateArticles && lang && TRANSLATE_LANGS.has(lang);

  useEffect(function() {
    setResolvedUrl(isGnewsUrl(url) ? null : url);
  }, [url]);

  useEffect(function() {
    if (!resolvedUrl) return;
    setTranslatedHtml(null);
    setError(false);
    setProxyFailed(false);

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
        setTranslatedHtml(html);
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
  // While waiting for the clean server translation, show the article through
  // Google's translate.goog proxy (already translated). If the proxy fails,
  // fall back to the original page. Google News links first load as-is so the
  // WebView can run their JS redirect and reveal the real article URL.
  var viaProxy = needsTranslation && !proxyFailed && !translatedHtml && !!resolvedUrl;
  var webUri = viaProxy ? toProxyUrl(resolvedUrl, lang) : url;

  var handleNavChange = function(nav) {
    if (resolvedUrl || !nav || !nav.url) return;
    var u = nav.url;
    if (/^https?:\/\//.test(u) && u.indexOf('google.com') === -1 && u.indexOf('translate.goog') === -1) {
      setResolvedUrl(u);
    }
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
          key={translatedHtml ? 'clean' : viaProxy ? 'proxy' : 'orig'}
          source={translatedHtml ? { html: translatedHtml } : { uri: webUri }}
          onNavigationStateChange={handleNavChange}
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
          onError={function() {
            if (viaProxy) setProxyFailed(true);
            else setError(true);
          }}
          onHttpError={function(e) {
            var code = e.nativeEvent.statusCode;
            if (viaProxy && code >= 400) setProxyFailed(true);
            else if (code >= 500) setError(true);
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
  webview:    { flex: 1 },
  loadWrap:   { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                justifyContent: 'center', alignItems: 'center' },
  errorWrap:  { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16 },
  errorText:  { fontSize: 15 },
  retryBtn:   { paddingHorizontal: 20, paddingVertical: 10, borderWidth: 1, borderRadius: 8 },
});

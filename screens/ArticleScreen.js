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
const TRANSLATE_TIMEOUT_MS = 12000;

// Google Translate widget uses legacy language codes (Hebrew = 'iw', not 'he')
const GT_LANG_MAP = { he: 'iw', ru: 'ru', es: 'es' };

// Injected into the WebView DOM to add Google Translate widget.
// Works regardless of X-Frame-Options because we inject INTO the page, not iframe it.
// Sets the googtrans cookie so translation starts automatically (no manual pick needed).
function makeGtScript(lang) {
  var gt = GT_LANG_MAP[lang] || lang;
  return `
(function() {
  try {
    if (window.__gtDone) return;
    window.__gtDone = true;
    var target = '${gt}';

    // Pre-set googtrans cookie -> widget auto-translates on init
    function setCookie(domain) {
      var c = 'googtrans=/auto/' + target + '; path=/';
      if (domain) c += '; domain=' + domain;
      document.cookie = c;
    }
    setCookie();
    setCookie(location.hostname);
    var parts = location.hostname.split('.');
    if (parts.length > 2) setCookie('.' + parts.slice(-2).join('.'));

    var div = document.createElement('div');
    div.id = 'google_translate_element';
    div.style.cssText = 'height:0;overflow:hidden;';
    document.body.insertBefore(div, document.body.firstChild);

    window.googleTranslateElementInit = function() {
      new google.translate.TranslateElement({
        pageLanguage: 'en',
        includedLanguages: target,
        autoDisplay: true,
        multilanguagePage: false
      }, 'google_translate_element');

      // Fallback: force-select the language in the (hidden) combo
      var tries = 0;
      var iv = setInterval(function() {
        tries++;
        if (document.documentElement.classList.contains('translated-rtl') ||
            document.documentElement.classList.contains('translated-ltr')) {
          clearInterval(iv);
          return;
        }
        var combo = document.querySelector('.goog-te-combo');
        if (combo && combo.options.length > 1) {
          combo.value = target;
          combo.dispatchEvent(new Event('change'));
        }
        if (tries > 20) clearInterval(iv);
      }, 500);
    };
    var s = document.createElement('script');
    s.src = 'https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
    document.head.appendChild(s);
  } catch(e) {}
})();
true;
`;
}

export default function ArticleScreen({ route, navigation }) {
  const { url, lang } = route.params || {};
  const { colors, t, translateArticles } = useApp();
  const insets = useSafeAreaInsets();
  const [error, setError] = useState(false);
  const [translatedHtml, setTranslatedHtml] = useState(null);
  const [translating, setTranslating] = useState(false);
  const abortRef = useRef(null);
  const needsTranslation = translateArticles && lang && TRANSLATE_LANGS.has(lang);

  useEffect(function() {
    if (!url) return;
    setTranslatedHtml(null);
    setError(false);

    if (!needsTranslation) return;

    // Try server-side clean translation in background.
    // WebView already loads the page with Google Translate widget injected.
    // If server succeeds -> replace WebView with clean translated HTML.
    if (abortRef.current) abortRef.current.abort();
    var controller = new AbortController();
    abortRef.current = controller;

    setTranslating(true);
    var timer = setTimeout(function() { controller.abort(); }, TRANSLATE_TIMEOUT_MS);

    fetch(API_BASE + '/translate-article?url=' + encodeURIComponent(url) + '&lang=' + lang, {
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
  }, [url, lang, needsTranslation]);

  var handleClose = function() { if (navigation.canGoBack()) navigation.goBack(); };
  var gtScript = needsTranslation && lang && !translatedHtml ? makeGtScript(lang) : undefined;

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
          source={translatedHtml ? { html: translatedHtml } : { uri: url }}
          style={s.webview}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          startInLoadingState={true}
          allowsInlineMediaPlayback={true}
          injectedJavaScript={gtScript}
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

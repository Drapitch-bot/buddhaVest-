import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, StatusBar,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../constants/AppContext';

const TRANSLATE_LANG = { he: 'iw', ru: 'ru', es: 'es' };

function makeTranslateScript(tl) {
  if (!tl) return '';
  return `
(function() {
  try {
    var bar = document.createElement('div');
    bar.id = '__gt_bar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#fff;' +
      'border-bottom:1px solid #ddd;padding:6px 10px;font-family:sans-serif;font-size:13px;' +
      'display:flex;align-items:center;gap:8px;';
    bar.innerHTML = '<span style="color:#4285f4;font-weight:600;">G</span>' +
      '<span id="__gt_status" style="color:#444;">Translating…</span>';
    document.body.insertBefore(bar, document.body.firstChild);
    document.body.style.marginTop = '36px';

    var _done = false;
    function setStatus(msg) {
      if (_done) return;
      var el = document.getElementById('__gt_status');
      if (el) el.textContent = msg;
    }

    // Global fallback: if nothing happens in 8s, give up gracefully
    var _fallback = setTimeout(function() {
      if (!_done) setStatus('Translation unavailable');
    }, 8000);

    window.googleTranslateElementInit = function() {
      try {
        new google.translate.TranslateElement({
          pageLanguage: 'auto',
          includedLanguages: '${tl}',
          autoDisplay: false,
        }, '__gt_hidden');

        // Poll every 500ms (up to 12 attempts = 6s) for the combo dropdown
        var _attempts = 0;
        var _poll = setInterval(function() {
          _attempts++;
          var sel = document.querySelector('.goog-te-combo');
          if (sel) {
            clearInterval(_poll);
            clearTimeout(_fallback);
            _done = true;
            sel.value = '${tl}';
            var ev = document.createEvent('HTMLEvents');
            ev.initEvent('change', true, true);
            sel.dispatchEvent(ev);
            setTimeout(function() { setStatus('Translated ✓'); }, 600);
          } else if (_attempts >= 12) {
            clearInterval(_poll);
            clearTimeout(_fallback);
            setStatus('Translation unavailable');
          }
        }, 500);
      } catch(e) {
        clearTimeout(_fallback);
        setStatus('Translation unavailable');
      }
    };

    var hidden = document.createElement('div');
    hidden.id = '__gt_hidden';
    hidden.style.display = 'none';
    document.body.appendChild(hidden);

    var s = document.createElement('script');
    // If script fails to load (CSP block, network error) → clear fallback + show message
    s.onerror = function() {
      clearTimeout(_fallback);
      setStatus('Translation unavailable');
    };
    s.src = 'https://translate.googleapis.com/translate_a/element.js?cb=googleTranslateElementInit';
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
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(false);
  const tl = translateArticles ? TRANSLATE_LANG[lang] : null;

  const handleClose = () => {
    if (navigation.canGoBack()) navigation.goBack();
  };

  return (
    <View style={[s.container, { backgroundColor: colors.bg }]}>
      <StatusBar barStyle={colors.statusBar || 'dark-content'} />

      {/* Header bar */}
      <View style={[s.header, {
        paddingTop: insets.top + 6,
        backgroundColor: colors.card,
        borderBottomColor: colors.cardBorder,
      }]}>
        <TouchableOpacity onPress={handleClose} style={s.closeBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={[s.closeText, { color: colors.primary || '#f59e0b' }]}>✕  {t.back || 'Back'}</Text>
        </TouchableOpacity>
        {tl && (
          <View style={s.badge}>
            <Text style={s.badgeText}>G Translate</Text>
          </View>
        )}
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
          source={{ uri: url }}
          style={{ flex: 1 }}
          injectedJavaScript={makeTranslateScript(tl)}
          injectedJavaScriptBeforeContentLoaded={''}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          startInLoadingState={true}
          allowsInlineMediaPlayback={true}
          renderLoading={() => (
            <View style={[s.loadWrap, { backgroundColor: colors.bg }]}>
              <ActivityIndicator size="large" color={colors.primary || '#f59e0b'} />
            </View>
          )}
          onLoadEnd={() => setLoading(false)}
          onError={() => setError(true)}
          onHttpError={(e) => { if (e.nativeEvent.statusCode >= 500) setError(true); }}
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
  loadWrap:   { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                justifyContent: 'center', alignItems: 'center' },
  errorWrap:  { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16 },
  errorText:  { fontSize: 15 },
  retryBtn:   { paddingHorizontal: 20, paddingVertical: 10, borderWidth: 1, borderRadius: 8 },
});

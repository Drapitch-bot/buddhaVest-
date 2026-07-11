import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, StatusBar, Linking,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../constants/AppContext';
import { API_BASE } from '../constants/api';

const TRANSLATE_LANGS = new Set(['he', 'ru', 'es']);

export default function ArticleScreen({ route, navigation }) {
  const { url, lang } = route.params || {};
  const { colors, t, translateArticles } = useApp();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(false);
  const needsTranslation = translateArticles && lang && TRANSLATE_LANGS.has(lang);

  // Backend fetches the article, translates it server-side, returns clean HTML.
  // No Google Translate proxy/iframe issues.
  const displayUrl = needsTranslation && url
    ? `${API_BASE}/translate-article?url=${encodeURIComponent(url)}&lang=${lang}`
    : url;

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
        {needsTranslation && (
          <View style={s.badge}>
            <Text style={s.badgeText}>מתורגם</Text>
          </View>
        )}
        <TouchableOpacity onPress={() => url && Linking.openURL(url)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={{ color: colors.textDim || '#6b7280', fontSize: 20 }}>⧉</Text>
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
          source={{ uri: displayUrl }}
          style={{ flex: 1 }}
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

import React, { useState, useEffect } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, Linking, RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../constants/AppContext';
import { ENDPOINTS } from '../constants/api';
import BrandHeader from '../components/BrandHeader';

const _TRANSLATE_LANG = { he: 'iw', ru: 'ru', es: 'es' };
function openArticle(url, lang) {
  if (!url) return;
  if (lang === 'en') { Linking.openURL(url); return; }
  const tl = _TRANSLATE_LANG[lang] || lang;
  Linking.openURL(`https://translate.google.com/translate?hl=${tl}&sl=auto&u=${encodeURIComponent(url)}`);
}

export default function NewsScreen() {
  const { colors, t, lang } = useApp();
  const insets = useSafeAreaInsets();
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => { loadNews(); }, [lang]);

  async function loadNews() {
    try {
      const res  = await fetch(ENDPOINTS.news(lang));
      const data = await res.json();
      // HTML uses data.articles
      setNews(data.articles || data.news || []);
    } catch {}
    setLoading(false);
  }

  function timeAgo(published) {
    if (!published) return '';
    try {
      const h = Math.floor((Date.now() - new Date(published)) / 3600000);
      if (h < 1)  return t.time_less_hour || 'less than an hour ago';
      if (h < 24) return (t.time_hours || '{n}h ago').replace('{n}', h);
      return (t.time_days || '{n}d ago').replace('{n}', Math.floor(h / 24));
    } catch { return ''; }
  }

  const s = makeStyles(colors);

  return (
    <View style={[s.container, { backgroundColor: colors.bg }]}>
      {/* Brand Header — greeting per screen like HTML */}
      <BrandHeader greeting={t.greeting_news || 'Market News'} />

      {loading ? (
        <ActivityIndicator size="large" color={colors.accent} style={{ margin: 30 }} />
      ) : (
        <FlatList
          data={news}
          keyExtractor={(item, i) => item.link || String(i)}
          contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 10, paddingBottom: insets.bottom + 20 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => { setRefreshing(true); await loadNews(); setRefreshing(false); }}
              tintColor={colors.accent}
            />
          }
          ListEmptyComponent={
            <Text style={[s.empty, { color: colors.textDimmer }]}>{t.noNews || 'No articles to show right now.'}</Text>
          }
          ListFooterComponent={
            news.length > 0 ? (
              <Text style={[s.sourceNote, { color: colors.textDimmer }]}>
                {t.source_news || 'Articles source: Yahoo Finance and Google News'}
              </Text>
            ) : null
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[s.card, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}
              onPress={() => openArticle(item.link, lang)}
              activeOpacity={0.75}>
              <Text style={[s.newsTitle, { color: colors.text }]} numberOfLines={3}>{item.title}</Text>
              <Text style={[s.newsMeta, { color: colors.textDimmer }]}>
                {[item.publisher, timeAgo(item.published)].filter(Boolean).join(' · ')}
              </Text>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const makeStyles = (c) => StyleSheet.create({
  container:  { flex: 1 },
  header:     { paddingBottom: 12, paddingHorizontal: 16, borderBottomWidth: 0.5 },
  title:      { fontSize: 18, fontWeight: '700', textAlign: 'right' },

  card:       { borderRadius: 10, borderWidth: 0.5, padding: 12, marginBottom: 8 },
  newsTitle:  { fontSize: 13, fontWeight: '500', lineHeight: 19, marginBottom: 4 },
  newsMeta:   { fontSize: 11 },

  empty:      { textAlign: 'center', padding: 30, fontSize: 14 },
  sourceNote: { textAlign: 'center', fontSize: 11, marginVertical: 12 },
});

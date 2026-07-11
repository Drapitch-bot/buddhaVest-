import React, { useState, useEffect } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { openArticle } from '../utils/linkUtils';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../constants/AppContext';
import { ENDPOINTS } from '../constants/api';
import { translateNewsItems } from '../utils/translate';
import BrandHeader from '../components/BrandHeader';

export default function NewsScreen({ navigation }) {
  const { colors, t, lang, langReady } = useApp();
  const insets = useSafeAreaInsets();
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => { if (langReady) loadNews(); }, [lang, langReady]);

  async function loadNews() {
    try {
      const res   = await fetch(ENDPOINTS.news(lang));
      const data  = await res.json();
      const raw   = data.articles || data.news || [];
      const items = await translateNewsItems(raw, lang);
      setNews(items);
    } catch (e) {}
    setLoading(false);
  }

  function timeAgo(published) {
    if (!published) return '';
    try {
      const h = Math.floor((Date.now() - new Date(published)) / 3600000);
      if (h < 1)  return t.time_less_hour || 'less than an hour ago';
      if (h < 24) return (t.time_hours || '{n}h ago').replace('{n}', h);
      return (t.time_days || '{n}d ago').replace('{n}', Math.floor(h / 24));
    } catch(e) { return ''; }
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
              onPress={() => openArticle(item.link, lang, navigation)}
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

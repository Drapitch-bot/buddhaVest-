import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Linking, Image } from 'react-native';
import { ENDPOINTS } from '../constants/api';

export default function NewsCard({ ticker, colors, t, lang = 'en' }) {
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadNews(); }, [ticker, lang]);

  async function loadNews() {
    setLoading(true);
    try {
      const res = await fetch(ENDPOINTS.stockNews(ticker, lang));
      const data = await res.json();
      setNews(data.articles || data.news || []);
    } catch (e) { setNews([]); }
    setLoading(false);
  }

  function formatTime(published) {
    if (!published) return '';
    try {
      const d = new Date(published);
      const diffH = Math.floor((Date.now() - d.getTime()) / 3600000);
      if (diffH < 1) return t.time_less_hour || 'less than an hour ago';
      if (diffH < 24) return (t.time_hours || '{n}h ago').replace('{n}', diffH);
      return (t.time_days || '{n}d ago').replace('{n}', Math.floor(diffH / 24));
    } catch { return ''; }
  }

  return (
    <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
      <Text style={[s.title, { color: colors.text }]}>📰 {t.latestNews}</Text>
      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ margin: 16 }} />
      ) : news.length === 0 ? (
        <Text style={[s.empty, { color: colors.textDimmer }]}>{t.noNews}</Text>
      ) : (
        news.slice(0, 6).map((item, i) => (
          <TouchableOpacity
            key={i}
            style={[s.newsItem, { borderBottomColor: colors.cardBorder }]}
            onPress={() => item.link && Linking.openURL(item.link)}>
            {item.thumbnail && <Image source={{ uri: item.thumbnail }} style={s.thumb} resizeMode="cover" />}
            <View style={{ flex: 1 }}>
              <Text style={[s.newsTitle, { color: colors.text }]} numberOfLines={3}>{item.title}</Text>
              <View style={s.metaRow}>
                <Text style={[s.publisher, { color: colors.accent }]}>{item.publisher}</Text>
                <Text style={[s.time, { color: colors.textDimmer }]}>{formatTime(item.published)}</Text>
              </View>
            </View>
          </TouchableOpacity>
        ))
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card: { marginHorizontal: 12, marginBottom: 14, borderRadius: 14, padding: 16, borderWidth: 0.5 },
  title: { fontSize: 13, fontWeight: '600', marginBottom: 12 },
  newsItem: { flexDirection: 'row', paddingVertical: 12, borderBottomWidth: 0.5, gap: 10 },
  thumb: { width: 70, height: 60, borderRadius: 8 },
  newsTitle: { fontSize: 13, lineHeight: 18, textAlign: 'right', marginBottom: 6 },
  metaRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  publisher: { fontSize: 11, fontWeight: '600' },
  time: { fontSize: 11 },
  empty: { textAlign: 'center', padding: 16, fontSize: 13 },
});

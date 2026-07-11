import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Image } from 'react-native';
import { ENDPOINTS } from '../constants/api';
import { openArticle } from '../utils/linkUtils';
import { translateNewsItems } from '../utils/translate';

export default function NewsCard({ ticker, colors, t, lang = 'en', navigation }) {
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(true);

  const isRTL = lang === 'he';
  const align = isRTL ? 'right' : 'left';
  const rowDir = isRTL ? 'flex-end' : 'flex-start';

  useEffect(() => { loadNews(); }, [ticker, lang]);

  async function loadNews() {
    setLoading(true);
    try {
      const res   = await fetch(ENDPOINTS.stockNews(ticker, lang));
      const data  = await res.json();
      const raw   = data.articles || data.news || [];
      const items = await translateNewsItems(raw, lang);
      setNews(items);
    } catch (e) { setNews([]); }
    setLoading(false);
  }

  function formatTime(published) {
    if (!published) return '';
    try {
      const diffH = Math.floor((Date.now() - new Date(published).getTime()) / 3600000);
      if (diffH < 1) return t.time_less_hour || 'less than an hour ago';
      if (diffH < 24) return (t.time_hours || '{n}h ago').replace('{n}', diffH);
      return (t.time_days || '{n}d ago').replace('{n}', Math.floor(diffH / 24));
    } catch(e) { return ''; }
  }

  return (
    <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
      <Text style={[s.title, { color: colors.text }]}>📰 {t.latestNews || 'Recent News'}</Text>
      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ margin: 16 }} />
      ) : news.length === 0 ? (
        <Text style={[s.empty, { color: colors.textDimmer }]}>{t.noNews || 'No articles to show.'}</Text>
      ) : (
        news.slice(0, 6).map(function(item, i) {
          // Support both 'link' and 'url' field names from the API
          const url = item.link || item.url || '';
          const hasLink = !!url.trim();
          return (
            <TouchableOpacity
              key={i}
              style={[s.newsItem, { borderBottomColor: colors.cardBorder }]}
              onPress={function() { openArticle(url, lang, navigation); }}
              activeOpacity={hasLink ? 0.75 : 1}>
              {item.thumbnail ? (
                <Image source={{ uri: item.thumbnail }} style={s.thumb} resizeMode="cover" />
              ) : null}
              <View style={{ flex: 1 }}>
                <Text style={[s.newsTitle, { color: colors.text, textAlign: align }]} numberOfLines={3}>
                  {item.title}
                </Text>
                <View style={[s.metaRow, { justifyContent: rowDir }]}>
                  {item.publisher ? (
                    <Text style={[s.publisher, { color: colors.accent }]}>{item.publisher}</Text>
                  ) : null}
                  <Text style={[s.time, { color: colors.textDimmer }]}>{formatTime(item.published)}</Text>
                  {!hasLink ? (
                    <Text style={[s.noLink, { color: colors.textDimmer }]}>
                      {t.no_link_available || 'no link'}
                    </Text>
                  ) : null}
                </View>
              </View>
            </TouchableOpacity>
          );
        })
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card:      { marginHorizontal: 12, marginBottom: 14, borderRadius: 14, padding: 16, borderWidth: 0.5 },
  title:     { fontSize: 13, fontWeight: '600', marginBottom: 12 },
  newsItem:  { flexDirection: 'row', paddingVertical: 12, borderBottomWidth: 0.5, gap: 10 },
  thumb:     { width: 70, height: 60, borderRadius: 8 },
  newsTitle: { fontSize: 13, lineHeight: 18, marginBottom: 6 },
  metaRow:   { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  publisher: { fontSize: 11, fontWeight: '600' },
  time:      { fontSize: 11 },
  noLink:    { fontSize: 11, fontStyle: 'italic' },
  empty:     { textAlign: 'center', padding: 16, fontSize: 13 },
});

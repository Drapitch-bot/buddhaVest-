import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  FlatList, StyleSheet, ActivityIndicator, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../constants/AppContext';
import { ENDPOINTS } from '../constants/api';
import BrandHeader from '../components/BrandHeader';

const SHORTCUTS = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'TSLA'];

export default function SearchScreen({ navigation }) {
  const { colors, t } = useApp();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  async function doSearch(q) {
    setQuery(q);
    if (q.length < 1) { setResults([]); return; }
    setLoading(true);
    try {
      const res = await fetch(ENDPOINTS.search(q));
      const data = await res.json();
      setResults(data.results || []);
    } catch { setResults([]); }
    setLoading(false);
  }

  function openTicker(ticker) {
    navigation.navigate('Stock', { ticker, name: ticker });
  }

  const s = makeStyles(colors);

  return (
    <View style={[s.root, { backgroundColor: colors.bg }]}>
      {/* Brand Header — greeting per screen like HTML */}
      <BrandHeader greeting={t.greeting_search || 'Stock Research'} />

      {/* Search box */}
      <View style={[s.searchBox, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
        <Text style={{ fontSize: 16, color: colors.textDimmer }}>🔍</Text>
        <TextInput
          style={[s.input, { color: colors.text }]}
          placeholder={t.searchPlaceholder}
          placeholderTextColor={colors.textDimmer}
          value={query}
          onChangeText={doSearch}
          autoCapitalize="characters"
          autoCorrect={false}
          textAlign="right"
        />
        {loading && <ActivityIndicator size="small" color={colors.accent} />}
      </View>

      {/* Ticker shortcut pills — AAPL MSFT NVDA GOOGL AMZN TSLA */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={s.pillScroll}
        contentContainerStyle={s.pillRow}>
        {SHORTCUTS.map(ticker => (
          <TouchableOpacity
            key={ticker}
            style={[s.pill, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}
            onPress={() => openTicker(ticker)}
            activeOpacity={0.7}>
            <Text style={[s.pillText, { color: colors.textDim }]}>{ticker}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Results / placeholder */}
      {results.length === 0 && query.length < 1 ? (
        <View style={s.placeholder}>
          <Text style={{ fontSize: 32, marginBottom: 12 }}>🔍</Text>
          <Text style={[s.placeholderText, { color: colors.textDimmer }]}>
            {t.search_empty || "Search for a ticker above to get BuddhaVest's analysis."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={item => item.ticker}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[s.item, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}
              onPress={() => openTicker(item.ticker)}>
              <Text style={[s.ticker, { color: colors.accent }]}>{item.ticker}</Text>
              <View style={{ flex: 1 }}>
                <Text style={[s.name, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
                {item.exchange ? <Text style={[s.exchange, { color: colors.textDimmer }]}>{item.exchange}</Text> : null}
              </View>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            query.length > 0 && !loading ? (
              <Text style={[s.empty, { color: colors.textDimmer }]}>{t.noData}</Text>
            ) : null
          }
        />
      )}
    </View>
  );
}

const makeStyles = (c) => StyleSheet.create({
  root:         { flex: 1 },
  header:       { paddingBottom: 12, paddingHorizontal: 16, borderBottomWidth: 0.5 },
  title:        { fontSize: 20, fontWeight: '700', textAlign: 'right' },

  // HTML: .search-box { margin-bottom: 14px; padding: 10px 14px; border-radius: 12px; }
  searchBox:    { flexDirection: 'row', alignItems: 'center', gap: 8,
                  marginHorizontal: 12, marginBottom: 14, borderRadius: 12, borderWidth: 0.5,
                  paddingHorizontal: 14, paddingVertical: 10 },
  input:        { flex: 1, fontSize: 14 },

  // HTML: .ticker-shortcuts { margin-bottom: 18px; padding-bottom: 2px; }
  pillScroll:   { maxHeight: 44, marginBottom: 18 },
  pillRow:      { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 2, alignItems: 'center' },
  pill:         { borderRadius: 20, borderWidth: 0.5, paddingHorizontal: 14, paddingVertical: 6 },
  pillText:     { fontSize: 12, fontWeight: '500' },

  placeholder:  { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  placeholderText: { fontSize: 13, textAlign: 'center', lineHeight: 20 },

  // .search-picker-item { border:1px; border-radius:12px; padding:12px 14px; margin-bottom:8px; gap:10px }
  item:         { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14,
                  marginHorizontal: 12, marginBottom: 8, borderWidth: 1, borderRadius: 12, gap: 10 },
  // .sp-ticker { font-weight:700; font-size:14px; min-width:56px }
  ticker:       { fontWeight: '700', fontSize: 14, minWidth: 56 },
  // .sp-name { flex:1; font-size:13px }
  name:         { fontSize: 13 },
  // .sp-exchange { font-size:11px }
  exchange:     { fontSize: 11, marginTop: 2 },
  empty:        { textAlign: 'center', padding: 30, fontSize: 14 },
});

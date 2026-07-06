// WatchlistScreen.js — 1:1 לפי HTML renderWatchlistScreen
import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity,
  StyleSheet, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../constants/AppContext';
import { ENDPOINTS } from '../constants/api';
import { useFocusEffect } from '@react-navigation/native';
import BrandHeader from '../components/BrandHeader';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Path, Polygon } from 'react-native-svg';

function StarIcon({ size = 20, color = '#fbbf24', filled = true }) {
  const pts = '12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26';
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Polygon points={pts} fill={filled ? color : 'none'} stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
    </Svg>
  );
}

function BookmarkIcon({ size = 36, color = '#f59e0b' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <Path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </Svg>
  );
}

const GRADIENTS = [
  ['#4ade80','#16a34a'], ['#fbbf24','#d97706'], ['#60a5fa','#2563eb'], ['#f97316','#ea580c'],
  ['#fb7185','#e11d48'], ['#34d399','#0d9488'], ['#f472b6','#db2777'], ['#38bdf8','#0284c7'],
];

function recColor(color, colors) {
  switch (color) {
    case 'green': return colors.green;
    case 'red':   return colors.red;
    case 'amber': return colors.amber;
    default:      return colors.textDim;
  }
}

function recLabel(rec, t) {
  if (!rec) return '';
  // Use i18n keys matching the API recommendation values
  const map = {
    buy:         t.rec_buy         || 'Buy',
    sell:        t.rec_sell        || 'Sell',
    hold:        t.rec_hold        || 'Hold',
    strong_buy:  t.rec_strong_buy  || 'Strong Buy',
    strong_sell: t.rec_strong_sell || 'Strong Sell',
  };
  return map[rec] || rec;
}

function TickerAvatar({ ticker, idx }) {
  const grad = GRADIENTS[idx % GRADIENTS.length];
  return (
    <LinearGradient colors={grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.avatar}>
      <Text style={styles.avatarText}>{(ticker || '?')[0].toUpperCase()}</Text>
    </LinearGradient>
  );
}

export default function WatchlistScreen({ navigation }) {
  const { colors, t, watchlist, toggleWatchlist, lang } = useApp();
  const insets = useSafeAreaInsets();
  const [prices,   setPrices]   = useState({});
  const [secondaryCurrency, setSecondaryCurrency] = useState(null); // {rate, symbol} | null
  const [loading,  setLoading]  = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const loadPricesRef = useRef(null);
  // HTML LANG_CURRENCY: he→ILS/₪, ru→RUB/₽, es→EUR/€, en→null
  const LANG_CURRENCY = { he: { code: 'ILS', symbol: '₪' }, ru: { code: 'RUB', symbol: '₽' }, es: { code: 'EUR', symbol: '€' } };

  useFocusEffect(useCallback(function() {
    if (watchlist.length) loadPrices();
    else setPrices({});
    // Auto-refresh every 90s while screen is focused (calls /analyze per ticker — heavier)
    const iv = setInterval(function() {
      if (loadPricesRef.current && watchlist.length) loadPricesRef.current();
    }, 90000);
    return function() { clearInterval(iv); };
  }, [watchlist, lang]));

  async function loadPrices() {
    setLoading(true);
    const cfg = LANG_CURRENCY[lang];
    if (cfg) {
      try {
        const exRes  = await fetch(ENDPOINTS.exchangeRate(cfg.code));
        const exData = await exRes.json();
        setSecondaryCurrency(exData.rate ? { rate: exData.rate, symbol: cfg.symbol } : null);
      } catch { setSecondaryCurrency(null); }
    } else {
      setSecondaryCurrency(null);
    }

    const newPrices = {};
    await Promise.all(watchlist.map(async function(item) {
      try {
        const res  = await fetch(ENDPOINTS.analyze(item.ticker, lang));
        const data = await res.json();
        newPrices[item.ticker] = {
          price:               data.current_price,
          change:              data.price_change_pct,
          score:               data.final_score,
          recommendation:      data.recommendation,
          recommendation_color: data.recommendation_color,
          company_name:        data.company_name,
        };
      } catch {}
    }));
    setPrices(newPrices);
    setLastUpdated(new Date());
    setLoading(false);
  }
  loadPricesRef.current = loadPrices;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>

      {/* Brand Header — greeting per screen like HTML */}
      <BrandHeader greeting={t.greeting_watchlist || 'My Watchlist'} />

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', paddingHorizontal: 14, paddingTop: 6, minHeight: 24 }}>
        {loading
          ? <ActivityIndicator size="small" color={colors.accent} />
          : lastUpdated
            ? <Text style={{ fontSize: 11, color: colors.textDimmer }}>
                {'↻ ' + lastUpdated.getHours().toString().padStart(2,'0') + ':' + lastUpdated.getMinutes().toString().padStart(2,'0') + ':' + lastUpdated.getSeconds().toString().padStart(2,'0')}
              </Text>
            : null
        }
      </View>

      <FlatList
        data={watchlist}
        keyExtractor={function(item) { return item.ticker; }}
        contentContainerStyle={watchlist.length === 0 ? styles.emptyContainer : { paddingHorizontal: 14, paddingTop: 4, paddingBottom: insets.bottom + 16 }}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <BookmarkIcon size={48} color={colors.textDimmer} />
            <Text style={[styles.emptyText, { color: colors.textDimmer }]}>{t.watchlistEmpty}</Text>
          </View>
        }
        renderItem={function({ item, index }) {
          const p = prices[item.ticker] || {};
          const rColor   = recColor(p.recommendation_color, colors);
          const displayName = p.company_name || item.name || '';

          return (
            <TouchableOpacity
              style={[styles.row, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}
              onPress={function() { navigation.navigate('Stock', { ticker: item.ticker, name: displayName || item.name }); }}>

              <TickerAvatar ticker={item.ticker} idx={index} />

              <View style={styles.mid}>
                <Text style={[styles.ticker, { color: colors.text }]}>{item.ticker}</Text>
                <Text style={[styles.name, { color: colors.textDim }]} numberOfLines={1}>{displayName}</Text>
              </View>

              <View style={styles.right}>
                {p.price != null && (
                  <Text style={[styles.price, { color: colors.text }]}>{'$' + p.price.toFixed(2)}</Text>
                )}
                {p.price != null && secondaryCurrency != null && (
                  <Text style={[styles.ils, { color: colors.textDimmer }]}>
                    {secondaryCurrency.symbol + (p.price * secondaryCurrency.rate).toFixed(2)}
                  </Text>
                )}
                {p.score != null && (
                  <Text style={[styles.change, { color: rColor }]}>
                    {p.score + '% ' + (p.recommendation || '')}
                  </Text>
                )}
              </View>

              <TouchableOpacity
                onPress={function() { toggleWatchlist(item.ticker, item.name); }}
                style={styles.starBtn}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <StarIcon size={20} color="#fbbf24" filled={true} />
              </TouchableOpacity>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root:     { flex: 1 },
  // HTML: .mover-row { background:var(--card-alt); border:0.5px; border-radius:10px; padding:10px 12px; margin-bottom:8px }
  row:      { flexDirection: 'row', alignItems: 'center',
              paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 0.5, marginBottom: 8, gap: 10 },
  // HTML: .mover-icon { width:32px; height:32px; border-radius:8px }
  avatar:    { width: 32, height: 32, borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  mid:    { flex: 1 },
  ticker: { fontSize: 13, fontWeight: '600' },
  name:   { fontSize: 11, marginTop: 2 },
  right:  { alignItems: 'flex-end' },
  price:  { fontSize: 14, fontWeight: '600' },
  ils:    { fontSize: 11, marginTop: 1 },
  change: { fontSize: 12, marginTop: 2 },
  starBtn: { padding: 4 },
  emptyWrap:      { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyContainer: { flexGrow: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText:      { fontSize: 14, textAlign: 'center', marginTop: 12, lineHeight: 22 },
});

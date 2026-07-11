import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { openArticle } from '../utils/linkUtils';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useApp } from '../constants/AppContext';
import { ENDPOINTS } from '../constants/api';
import BrandHeader from '../components/BrandHeader';

// Column widths (px) for horizontal-scroll market table
const COL = { ticker: 80, price: 64, change: 60, volume: 60, avg: 60, cap: 66 };
const TABLE_W = COL.ticker + COL.price + COL.change + COL.volume + COL.avg + COL.cap; // ~440

const GRADIENTS = [
  ['#4ade80','#16a34a'], ['#fbbf24','#d97706'], ['#60a5fa','#2563eb'], ['#a78bfa','#7c3aed'],
  ['#fb7185','#e11d48'], ['#34d399','#0d9488'], ['#f472b6','#db2777'], ['#38bdf8','#0284c7'],
];

function fmtBig(n) {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9)  return '$' + (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6)  return '$' + (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3)  return '$' + (n / 1e3).toFixed(2) + 'K';
  return '$' + n.toString();
}

function fmtIdxValue(key, value, item) {
  if (value == null) return '—';
  if (key === 'fx')     return (item?.fxPrefix || '') + value.toFixed(2);
  if (key === 'usdils') return '₪' + value.toFixed(2); // legacy
  if (key === 'vix')    return value.toFixed(1);
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// Fetch live FX rate from Yahoo Finance (e.g. 'RUB=X', 'EUR=X')
async function fetchFXRate(symbol) {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?interval=1d&range=1d';
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await res.json();
    return json?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
  } catch(e) { return null; }
}

function fmtAge(pub, t) {
  if (!pub) return '';
  try {
    const h = Math.floor((Date.now() - new Date(pub)) / 3600000);
    if (h < 1)  return t.time_less_hour || 'just now';
    if (h < 24) return (t.time_hours || '{n}h ago').replace('{n}', h);
    return (t.time_days || '{n}d ago').replace('{n}', Math.floor(h / 24));
  } catch(e) { return ''; }
}

// fmtDate — short date string (DD/MM/YYYY) for news meta
function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return dd + '/' + mm + '/' + yyyy;
  } catch(e) { return ''; }
}

function TickerAvatar({ ticker, idx, size = 32 }) {
  // HTML: .mover-icon { width:32px; height:32px; border-radius:8px; background:linear-gradient(135deg,...) }
  const grad = GRADIENTS[idx % GRADIENTS.length];
  return (
    <LinearGradient
      colors={grad}
      start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
      style={{
        width: size, height: size, borderRadius: size * 0.25,
        justifyContent: 'center', alignItems: 'center',
      }}>
      <Text style={{ color: '#fff', fontWeight: '600', fontSize: size * 0.44 }}>
        {(ticker || '?')[0].toUpperCase()}
      </Text>
    </LinearGradient>
  );
}

export default function HomeScreen({ navigation }) {
  const { colors, t, isDark, lang, langReady } = useApp();
  const insets = useSafeAreaInsets();

  const [baseIndices, setBaseIndices] = useState([]);   // S&P, Nasdaq, VIX only
  const [fxRates,     setFxRates]     = useState({});   // { ILS, RUB, EUR } — fetched once
  const [movers,      setMovers]      = useState([]);
  const [tableData,   setTableData]   = useState([]);
  const [news,        setNews]        = useState([]);
  const [usdIls,      setUsdIls]      = useState(null);
  const [refreshing,  setRefreshing]  = useState(false);
  const [sortKey,     setSortKey]     = useState('market_cap');
  const [sortDir,     setSortDir]     = useState(-1);
  const [lastUpdated, setLastUpdated] = useState(null); // Date of last successful refresh
  const [wakingUp,    setWakingUp]    = useState(false);

  // Use a ref so the interval always calls the latest loadAll closure
  const loadAllRef = useRef(null);

  // Wait for real lang from AsyncStorage before first fetch
  useEffect(function() {
    if (!langReady) return;
    loadAll();
    const iv = setInterval(function() { loadAllRef.current && loadAllRef.current(); }, 30000);
    return function() { clearInterval(iv); };
  }, [langReady]);

  // Reload news when language changes
  useEffect(function() {
    if (!langReady) return;
    loadNews();
  }, [lang]);

  // Derived indices: baseIndices + FX tile for current language (no extra fetch on lang switch)
  const FX_CONFIG = {
    he: { key: 'ILS', label: 'USD/ILS', fxPrefix: '₪' },
    ru: { key: 'RUB', label: 'USD/RUB', fxPrefix: '₽' },
    es: { key: 'EUR', label: 'USD/EUR', fxPrefix: '€' },
  };
  const indices = useMemo(function() {
    const cfg = FX_CONFIG[lang];
    if (!cfg || !fxRates[cfg.key]) return baseIndices;
    return [...baseIndices, { key: 'fx', label: cfg.label, value: fxRates[cfg.key], change_pct: null, fxPrefix: cfg.fxPrefix }];
  }, [baseIndices, lang, fxRates]);

  async function loadAll() {
    await Promise.all([loadMarket(), loadNews(), loadFX()]);
    setLastUpdated(new Date());
  }
  loadAllRef.current = loadAll;

  // Fetch all FX rates once in parallel — no per-language delay
  async function loadFX() {
    try {
      const [ILS, RUB, EUR] = await Promise.all([
        fetchFXRate('ILS=X'),
        fetchFXRate('RUB=X'),
        fetchFXRate('EUR=X'),
      ]);
      const rates = {};
      if (ILS) rates.ILS = ILS;
      if (RUB) rates.RUB = RUB;
      if (EUR) rates.EUR = EUR;
      if (Object.keys(rates).length) setFxRates(rates);
    } catch(e) {}
  }

  async function loadMarket() {
    const tryFetch = function(ms) {
      return Promise.race([
        fetch(ENDPOINTS.marketOverview()).then(function(r) {
          if (!r.ok) throw new Error('err');
          return r.json();
        }),
        new Promise(function(_, rej) { setTimeout(function() { rej(new Error('timeout')); }, ms || 20000); }),
      ]);
    };
    const applyData = function(data) {
      const idxArr = [];
      if (data['S&P 500']) idxArr.push({ key: 'sp500',  label: 'S&P 500', value: data['S&P 500'].value, change_pct: data['S&P 500'].change_pct });
      if (data['Nasdaq'])  idxArr.push({ key: 'nasdaq', label: 'Nasdaq',  value: data['Nasdaq'].value,  change_pct: data['Nasdaq'].change_pct });
      if (data['VIX'])     idxArr.push({ key: 'vix',    label: 'VIX',     value: data['VIX'].value,    change_pct: null });
      setBaseIndices(idxArr);
      if (data.usd_ils) { setUsdIls(data.usd_ils); setFxRates(function(prev) { return { ...prev, ILS: data.usd_ils }; }); }
      const allMovers = data.movers || [];
      setTableData(allMovers);
      const top4 = [...allMovers]
        .filter(function(m) { return m.change_pct != null; })
        .sort(function(a, b) { return Math.abs(b.change_pct) - Math.abs(a.change_pct); })
        .slice(0, 4);
      setMovers(top4);
    };
    try {
      applyData(await tryFetch(20000));
    } catch(e) {
      setWakingUp(true);
      await new Promise(function(r) { setTimeout(r, 3000); });
      try {
        applyData(await tryFetch(50000));
      } catch(e) {}
      setWakingUp(false);
    }
  }

  async function loadNews() {
    try {
      const res  = await fetch(ENDPOINTS.news(lang));
      const data = await res.json();
      setNews((data.articles || []).slice(0, 3));
    } catch(e) {}
  }

  const onRefresh = useCallback(async function() {
    setRefreshing(true); await loadAll(); setRefreshing(false);
  }, []);

  function handleSort(key) {
    if (sortKey === key) setSortDir(function(d) { return d * -1; });
    else { setSortKey(key); setSortDir(-1); }
  }

  const sortedTable = [...tableData].sort(function(a, b) {
    const va = a[sortKey] != null ? a[sortKey] : -Infinity;
    const vb = b[sortKey] != null ? b[sortKey] : -Infinity;
    if (typeof va === 'string') return va.localeCompare(vb) * sortDir;
    return (va - vb) * sortDir;
  });

  function cc(v) { return v > 0 ? colors.green : v < 0 ? colors.red : colors.textDim; }

  // Index label icons — VIX emoji is dynamic
  const idxIcon = { sp500: '📈', nasdaq: '📊', usdils: '₪' };
  function vixEmoji(v) {
    if (v == null) return '😐';
    if (v < 15) return '😊';
    if (v < 20) return '😌';
    if (v < 25) return '😐';
    if (v < 30) return '😟';
    return '😱';
  }

  return (
    <View style={[s.root, { backgroundColor: colors.bg }]}>

      {/* ── Brand Header (logo always visible, greeting changes per screen like HTML) ── */}
      <BrandHeader onRefresh={loadAll} greeting={t.greeting_home || 'Markets · Live'} />

      {/* ── Waking up banner ── */}
      {wakingUp && (
        <View style={{ backgroundColor: colors.cardAlt, padding: 10, alignItems: 'center', borderBottomWidth: 0.5, borderBottomColor: colors.cardBorder }}>
          <Text style={{ color: colors.textDim, fontSize: 13 }}>
            {t.waking_up || '⏳ Server waking up, please wait…'}
          </Text>
        </View>
      )}

      {/* ── Search box (read-only → SearchTab) ── */}
      <TouchableOpacity
        style={[s.searchBox, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}
        onPress={function() { navigation.navigate('SearchTab'); }}
        activeOpacity={0.75}>
        <Text style={{ fontSize: 14 }}>🔍</Text>
        <Text style={[s.searchPlaceholder, { color: colors.textDimmer }]}>
          {t.searchPlaceholder || 'Search ticker (e.g. AAPL, MSFT)...'}
        </Text>
      </TouchableOpacity>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}>

        {/* ── Index grid 2×2 ── */}
        <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <Text style={[s.cardTitle, { color: colors.text, marginBottom: 0 }]}>🌐 {t.marketStatus || 'Market Status'}</Text>
            {lastUpdated && (
              <Text style={{ fontSize: 11, color: colors.textDimmer }}>
                {'↻ ' + lastUpdated.getHours().toString().padStart(2,'0') + ':' + lastUpdated.getMinutes().toString().padStart(2,'0') + ':' + lastUpdated.getSeconds().toString().padStart(2,'0')}
              </Text>
            )}
          </View>
          <View style={s.indexGrid}>
            {indices.length === 0
              ? [0,1,2,3].map(function(i) {
                  return (
                    <View key={i} style={[s.indexTile, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}>
                      <Text style={[s.iLabel, { color: colors.textDim }]}>—</Text>
                      <Text style={[s.iValue, { color: colors.text }]}>—</Text>
                    </View>
                  );
                })
              : indices.map(function(idx) {
                  return (
                    <View key={idx.key} style={[s.indexTile, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}>
                      {/* .i-label { font-size:12px } */}
                      <Text style={[s.iLabel, { color: colors.textDim }]}>
                        {(idx.key === 'vix' ? vixEmoji(idx.value) : (idxIcon[idx.key] || '')) + ' ' + idx.label}
                      </Text>
                      {/* .i-value { font-size:16px; font-weight:600 } */}
                      <Text style={[s.iValue, { color: colors.text }]}>
                        {fmtIdxValue(idx.key, idx.value, idx)}
                      </Text>
                      {/* .i-change { font-size:11px } */}
                      {idx.key === 'vix' ? (
                        <Text style={[s.iChange, { color: colors.textDimmer }]}>
                          {idx.value != null ? (idx.value < 20 ? (t.vix_calm || 'Calm market') : (t.vix_volatile || 'High volatility')) : '—'}
                        </Text>
                      ) : (idx.key === 'fx' || idx.key === 'usdils') ? (
                        <Text style={[s.iChange, { color: colors.textDimmer }]}>{t.live_rate || 'Live rate'}</Text>
                      ) : idx.change_pct != null ? (
                        <Text style={[s.iChange, { color: cc(idx.change_pct) }]}>
                          {idx.change_pct >= 0 ? '+' : ''}{idx.change_pct.toFixed(2)}%
                        </Text>
                      ) : null}
                    </View>
                  );
                })}
          </View>
        </View>

        {/* ── Tip banner ── */}
        {/* dark: gradient bg(#332d4d→#2a2640) + accent text | light: card bg + 1px border + text */}
        {isDark ? (
          <LinearGradient colors={['#2d1f00', '#1c1f26']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={s.tipBanner}>
            <Text style={{ fontSize: 14, color: colors.amber }}>💡</Text>
            <Text style={[s.tipText, { color: colors.accent, flex: 1 }]}>
              {t.tip_banner || 'Live market data from Yahoo Finance. Green doesn\'t mean "buy" — check the full analysis before deciding.'}
            </Text>
          </LinearGradient>
        ) : (
          <View style={[s.tipBanner, { backgroundColor: colors.card, borderColor: colors.cardBorder, borderWidth: 1 }]}>
            <Text style={{ fontSize: 14, color: colors.amber }}>💡</Text>
            <Text style={[s.tipText, { color: colors.text, flex: 1 }]}>
              {t.tip_banner || 'Live market data from Yahoo Finance. Green doesn\'t mean "buy" — check the full analysis before deciding.'}
            </Text>
          </View>
        )}

        {/* ── Live Right Now (top 4 movers) ── */}
        <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
          <Text style={[s.cardTitle, { color: colors.text }]}>🔥 {t.live_now || 'Live Right Now'}</Text>
          {movers.length === 0
            ? <ActivityIndicator color={colors.accent} style={{ margin: 16 }} />
            : movers.map(function(m, i) {
                return (
                  <TouchableOpacity
                    key={m.ticker}
                    style={[s.moverRow, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}
                    onPress={function() { navigation.navigate('Stock', { ticker: m.ticker, name: m.name }); }}>
                    <TickerAvatar ticker={m.ticker} idx={i} />
                    <View style={s.moverMid}>
                      <Text style={[s.moverTicker, { color: colors.text }]}>{m.ticker}</Text>
                      <Text style={[s.moverName, { color: colors.textDim }]} numberOfLines={1}>{m.name}</Text>
                    </View>
                    <View style={s.moverRight}>
                      <Text style={[s.moverPrice, { color: colors.text }]}>
                        {m.price != null ? '$' + m.price.toFixed(2) : '—'}
                      </Text>
                      {m.price != null && usdIls != null && lang === 'he' && (
                        <Text style={[s.moverIls, { color: colors.textDimmer }]}>
                          {'₪' + (m.price * usdIls).toFixed(2)}
                        </Text>
                      )}
                      {m.change_pct != null && (
                        <Text style={[s.moverChg, { color: cc(m.change_pct) }]}>
                          {m.change_pct >= 0 ? '+' : ''}{m.change_pct.toFixed(2)}%
                        </Text>
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })
          }
        </View>

        {/* ── Markets Table (horizontal scroll) ── */}
        <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder, paddingHorizontal: 0 }]}>
          <Text style={[s.cardTitle, { color: colors.text, paddingHorizontal: 16 }]}>
            📊 {t.markets_table_title || 'Watchlist Snapshot'}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={true}>
            <View style={{ width: TABLE_W }}>
              {/* Header row */}
              <View style={[s.tableHeader, { borderBottomColor: colors.cardBorder }]}>
                {[
                  { key: 'ticker',     label: t.col_symbol     || 'Symbol', w: COL.ticker },
                  { key: 'price',      label: t.col_price      || 'Price',  w: COL.price  },
                  { key: 'change_pct', label: t.col_change     || 'Change', w: COL.change },
                  { key: 'volume',     label: t.col_volume     || 'Volume', w: COL.volume },
                  { key: 'avg_volume', label: t.col_avg_volume || 'Avg Vol', w: COL.avg   },
                  { key: 'market_cap', label: 'Cap',                       w: COL.cap    },
                ].map(function(col) {
                  const active = sortKey === col.key;
                  return (
                    <TouchableOpacity
                      key={col.key}
                      style={{ width: col.w, paddingHorizontal: 4 }}
                      onPress={function() { handleSort(col.key); }}>
                      <Text style={[s.thText, {
                        color: active ? colors.accent : colors.textDim,
                        textDecorationLine: active ? 'underline' : 'none',
                      }]}>
                        {col.label}{active ? (sortDir === 1 ? ' ↑' : ' ↓') : ''}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {/* Data rows */}
              {sortedTable.length === 0
                ? <ActivityIndicator color={colors.accent} style={{ margin: 12 }} />
                : sortedTable.map(function(m, i) {
                    return (
                      <TouchableOpacity
                        key={m.ticker}
                        style={[s.tableRow, {
                          borderBottomColor: colors.cardBorder,
                          borderBottomWidth: i < sortedTable.length - 1 ? 0.5 : 0,
                        }]}
                        onPress={function() { navigation.navigate('Stock', { ticker: m.ticker, name: m.name }); }}>
                        {/* Ticker + Name */}
                        <View style={{ width: COL.ticker, paddingHorizontal: 4 }}>
                          <Text style={[s.tdTicker, { color: colors.text }]}>{m.ticker}</Text>
                          <Text style={[s.tdName, { color: colors.textDimmer }]} numberOfLines={1}>{m.name}</Text>
                        </View>
                        {/* Price */}
                        <Text style={[s.td, { width: COL.price, color: colors.text }]}>
                          {m.price != null ? '$' + m.price.toFixed(2) : '—'}
                        </Text>
                        {/* Change % */}
                        <Text style={[s.td, { width: COL.change, color: m.change_pct != null ? cc(m.change_pct) : colors.textDim }]}>
                          {m.change_pct != null ? (m.change_pct >= 0 ? '+' : '') + m.change_pct.toFixed(2) + '%' : '—'}
                        </Text>
                        {/* Volume */}
                        <Text style={[s.td, { width: COL.volume, color: colors.textDim }]}>
                          {m.volume != null ? fmtBig(m.volume).replace('$', '') : '—'}
                        </Text>
                        {/* Avg Volume */}
                        <Text style={[s.td, { width: COL.avg, color: colors.textDim }]}>
                          {m.avg_volume != null ? fmtBig(m.avg_volume).replace('$', '') : '—'}
                        </Text>
                        {/* Market Cap */}
                        <Text style={[s.td, { width: COL.cap, color: colors.textDim }]}>
                          {fmtBig(m.market_cap)}
                        </Text>
                      </TouchableOpacity>
                    );
                  })
              }
            </View>
          </ScrollView>
        </View>

        {/* ── News ── */}
        {/* HTML: <h3 ti-news color:#60a5fa> + news items + "לכל החדשות" link centered at bottom */}
        <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
          <Text style={[s.cardTitle, { color: colors.text }]}>📰 {t.news_title || 'Market News'}</Text>
          {news.length === 0
            ? <ActivityIndicator color={colors.accent} style={{ margin: 16 }} />
            : news.map(function(item, i) {
                return (
                  <TouchableOpacity
                    key={i}
                    style={[s.newsCard, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}
                    onPress={function() { openArticle(item.link, lang, navigation); }}>
                    <Text style={[s.nTitle, { color: colors.text }]} numberOfLines={3}>{item.title}</Text>
                    <Text style={[s.nMeta, { color: colors.textDimmer }]}>
                      {[item.publisher, fmtDate(item.published), fmtAge(item.published, t)].filter(Boolean).join(' · ')}
                    </Text>
                  </TouchableOpacity>
                );
              })
          }
          {/* HTML: .back-link at bottom center: "לכל החדשות →" */}
          <TouchableOpacity
            onPress={function() { navigation.navigate('NewsTab'); }}
            style={s.viewAllWrap}>
            <Text style={[s.viewAll, { color: colors.accent }]}>{t.view_all_news || 'View all news'} ›</Text>
          </TouchableOpacity>
        </View>

        {/* ── Source note ── */}
        <Text style={[s.srcNote, { color: colors.textDimmer }]}>
          {t.source_live || 'Data source: Yahoo Finance (yfinance) - live data'}
        </Text>
      </ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1 },

  // .search-box
  searchBox:         { flexDirection: 'row', alignItems: 'center', gap: 8,
                       marginHorizontal: 12, marginBottom: 14,
                       borderRadius: 12, borderWidth: 0.5, paddingHorizontal: 14, paddingVertical: 10 },
  searchPlaceholder: { flex: 1, fontSize: 14 },

  // .card { border:0.5px; border-radius:14px; padding:16px; margin-bottom:14px }
  card:         { marginHorizontal: 12, marginBottom: 14, borderRadius: 14, padding: 16, borderWidth: 0.5 },
  // .card h3 { font-size:13px; font-weight:600 }
  cardTitle:    { fontSize: 13, fontWeight: '600', marginBottom: 10 },
  // HTML: .back-link { justify-content:center; margin-top:10px } for "לכל החדשות"
  viewAllWrap:  { alignItems: 'center', marginTop: 10 },
  viewAll:      { fontSize: 12, fontWeight: '500' },

  // .index-grid { gap:10px } .index-tile { border:0.5px; border-radius:10px; padding:10px 12px }
  indexGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  indexTile: { width: '47.5%', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, borderWidth: 0.5 },
  iLabel:    { fontSize: 12, marginBottom: 2 },      // .i-label { font-size:12px }
  iValue:    { fontSize: 16, fontWeight: '600' },    // .i-value { font-size:16px; font-weight:600 }
  iChange:   { fontSize: 11, marginTop: 2 },         // .i-change { font-size:11px }

  // HTML: .tip-banner { padding: 10px 12px; margin-bottom: 14px; border-radius: 10px; }
  tipBanner: { flexDirection: 'row', alignItems: 'flex-start', gap: 8,
               marginHorizontal: 12, marginBottom: 14, borderRadius: 10,
               paddingVertical: 10, paddingHorizontal: 12 },

  // HTML: .mover-row { background:var(--card-alt); border:0.5px; border-radius:10px; padding:10px 12px; margin-bottom:8px }
  moverRow:    { flexDirection: 'row', alignItems: 'center', borderRadius: 10,
                 paddingVertical: 10, paddingHorizontal: 12, marginBottom: 8, borderWidth: 0.5 },
  // .mover-mid { flex:1; padding:0 8px } .mover-ticker { font-size:13px; font-weight:600 }
  moverMid:    { flex: 1, paddingHorizontal: 8 },
  moverTicker: { fontSize: 13, fontWeight: '600' },
  moverName:   { fontSize: 11, marginTop: 2 },
  // .mover-right { text-align:right } .mover-price { font-size:14px; font-weight:600 }
  moverRight:  { alignItems: 'flex-end' },
  moverPrice:  { fontSize: 14, fontWeight: '600' },
  // .m-ils { font-size:11px; color:var(--text-dimmer) }
  moverIls:    { fontSize: 11, marginTop: 1 },
  moverChg:    { fontSize: 12, marginTop: 2 },

  // Market table
  tableHeader:   { flexDirection: 'row', paddingVertical: 5, borderBottomWidth: 0.5 },
  tableRow:      { flexDirection: 'row', paddingVertical: 6 },
  thText:        { fontSize: 10, fontWeight: '600', paddingHorizontal: 3 },
  tdTicker:      { fontSize: 11, fontWeight: '600' },
  tdName:        { fontSize: 9, marginTop: 1 },
  td:            { fontSize: 11, paddingHorizontal: 3, textAlign: 'right' },

  // News
  newsSection:   { marginBottom: 16 },
  newsCard:      { borderRadius: 10, borderWidth: 0.5, padding: 12, marginBottom: 8 },
  nTitle:        { fontSize: 13, fontWeight: '500', lineHeight: 19, marginBottom: 4 },
  nMeta:         { fontSize: 11 },
  tipText:       { fontSize: 12, lineHeight: 18, flex: 1 },
  srcNote:       { fontSize: 11, marginTop: 10, textAlign: 'center' },
  seeAll:        { fontSize: 13, fontWeight: '600', textAlign: 'center', marginTop: 8, padding: 8 },

  loadRow:       { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', padding: 16 },
});

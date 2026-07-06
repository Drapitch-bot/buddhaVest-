import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../constants/AppContext';
import { ENDPOINTS } from '../constants/api';
import PriceChart from '../components/PriceChart';
import BrandHeader from '../components/BrandHeader';

// Maps frontend metricKey → backend endpoint key.
// Calculated scores (moat, cash_runway) don't have their own time-series,
// so we show the closest meaningful proxy metric instead.
const METRIC_KEY_MAP = {
  debt_to_equity:        'debt_equity',
  liabilities_to_equity: 'liab_equity',
  operating_cash_flow:   'operating_cf',
  free_cash_flow:        'free_cf',
  moat:                  'gross_margin',   // proxy: gross margin trend
  cash_runway:           'free_cf',        // proxy: free cash flow trend
  net_income_trend:      'net_income',
  // pass-through (same key on both sides):
  // pe_ratio, peg_ratio, gross_margin, operating_margin, net_margin,
  // cost_of_revenue, current_ratio, cash_position, eps, revenue,
  // net_income, forward_pe, price_to_book, price_to_sales, ev_to_ebitda,
  // dividend, buyback
};

const FETCH_TIMEOUT_MS = 55000;

// Normalize a single item from the server into { date, value }
function normalizeItem(item) {
  if (Array.isArray(item)) {
    return { date: String(item[0] || ''), value: item[1] };
  }
  const value = item.value ?? item.v ?? item.val ?? null;
  const date  = item.date  || item.period || item.quarter
              || item.year  || item.label  || '';
  return { date: String(date), value };
}

// Yahoo Finance monthly price history — try query2 then query1
async function fetchYahooPrices(ticker) {
  const endpoints = [
    `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1mo&range=5y`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1mo&range=5y`,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      });
      if (!res.ok) continue;
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) continue;
      const timestamps = result.timestamp || [];
      const closes = result.indicators?.adjclose?.[0]?.adjclose
                  || result.indicators?.quote?.[0]?.close
                  || [];
      const series = timestamps
        .map((ts, i) => ({
          date:  new Date(ts * 1000).toISOString().slice(0, 7),
          value: closes[i] != null ? Math.round(closes[i] * 100) / 100 : null,
        }))
        .filter(p => p.value != null);
      if (series.length > 1) return series;
    } catch { /* try next */ }
  }
  return null;
}

// Stooq CSV monthly price history (open, publicly accessible — same source as backend)
async function fetchStooqPrices(ticker) {
  try {
    // Stooq uses lowercase + .us suffix for US-listed stocks
    const sym = ticker.replace(/[^A-Za-z0-9]/g, '').toLowerCase() + '.us';
    const url = `https://stooq.com/q/d/l/?s=${sym}&i=m`;
    const res = await fetch(url, { headers: { 'Accept': 'text/csv' } });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text.includes('No data') || text.trim().split('\n').length < 3) return null;
    // CSV: Date,Open,High,Low,Close,Volume  (newest first)
    const lines = text.trim().split('\n').slice(1); // drop header
    const series = lines
      .map(line => {
        const cols = line.split(',');
        const date  = cols[0]?.slice(0, 7); // YYYY-MM
        const close = parseFloat(cols[4]);
        return (date && !isNaN(close)) ? { date, value: Math.round(close * 100) / 100 } : null;
      })
      .filter(Boolean)
      .reverse(); // Stooq returns newest-first; chart wants oldest-first
    return series.length > 1 ? series : null;
  } catch { return null; }
}

// Yahoo Finance v7 downloadable CSV — different endpoint, often less blocked
async function fetchYahooV7Prices(ticker) {
  try {
    const period1 = Math.floor(new Date('2020-01-01').getTime() / 1000);
    const period2 = Math.floor(Date.now() / 1000);
    const url = `https://query1.finance.yahoo.com/v7/finance/download/${ticker}?period1=${period1}&period2=${period2}&interval=1mo&events=history&includeAdjustedClose=true`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/csv,*/*' },
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text.toLowerCase().includes('error') || text.trim().split('\n').length < 3) return null;
    const lines = text.trim().split('\n').slice(1);
    const series = lines
      .map(line => {
        const cols = line.split(',');
        const date  = cols[0]?.slice(0, 7);                   // YYYY-MM
        const close = parseFloat(cols[5] ?? cols[4]);          // Adj Close or Close
        return (date && !isNaN(close)) ? { date, value: Math.round(close * 100) / 100 } : null;
      })
      .filter(Boolean);
    return series.length > 1 ? series : null;
  } catch { return null; }
}

// Race 3 client-side sources — used ONLY during backend cold start (first ~50s).
// Tiingo key lives on the backend (/price-history endpoint) — never in the bundle.
async function fetchFallbackPrices(ticker) {
  const [y, s, yv7] = await Promise.all([
    fetchYahooPrices(ticker).catch(function() { return null; }),
    fetchStooqPrices(ticker).catch(function() { return null; }),
    fetchYahooV7Prices(ticker).catch(function() { return null; }),
  ]);
  return (y   && y.length   > 1) ? y
       : (s   && s.length   > 1) ? s
       : (yv7 && yv7.length > 1) ? yv7
       : null;
}

// Same logic as MetricTile: score ≥70 → green, ≥40 → amber, <40 → red, null → purple
function tileScoreColor(score, colors) {
  if (score == null) return colors.purple || '#7c3aed';
  if (score >= 70)   return colors.green  || '#22c55e';
  if (score >= 40)   return colors.amber  || '#fbbf24';
  return               colors.red    || '#ef4444';
}

export default function MetricHistoryScreen({ route, navigation }) {
  const { ticker, metricKey, label, tileNote, tileScore, tileValue } = route.params;
  const { colors, t } = useApp();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState('quarterly');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [slowLoad, setSlowLoad] = useState(false);
  const [yahooPrices, setYahooPrices] = useState(null);
  const [fallbackLoading, setFallbackLoading] = useState(false);
  const slowTimer = useRef(null);
  const loadId    = useRef(0);   // generation counter — prevents stale fallback from clobbering a newer load

  const apiKey = METRIC_KEY_MAP[metricKey] || metricKey;

  useEffect(() => { loadHistory(); }, [ticker, metricKey]);

  // Auto-switch to annual if quarterly is empty but annual has data
  useEffect(() => {
    if (!data || data.use_price) return;
    const q = Array.isArray(data.quarterly) ? data.quarterly : [];
    const a = Array.isArray(data.annual)    ? data.annual    : [];
    if (q.length < 2 && a.length >= 2 && mode === 'quarterly') {
      setMode('annual');
    }
  }, [data]);

  async function loadHistory() {
    // Bump generation so any in-flight fallback from a previous call becomes stale.
    loadId.current += 1;
    const myId = loadId.current;

    // Flag set to true once the backend delivers real metric data.
    // Prevents the fallback from overwriting it if both finish around the same time.
    const metricLoaded = { current: false };

    setLoading(true);
    setError(false);
    setSlowLoad(false);
    setData(null);
    setYahooPrices(null);
    setFallbackLoading(true);
    setMode('quarterly');

    slowTimer.current = setTimeout(() => setSlowLoad(true), 5000);

    // ── Fallback starts IMMEDIATELY — parallel with backend ──────────────────
    // As soon as Yahoo/Stooq return price data, we stop the spinner and show a
    // price chart. If the backend later responds with real metric data, it
    // overwrites the price chart and clears the fallback.
    fetchFallbackPrices(ticker).then(function(yp) {
      if (loadId.current !== myId) return;   // stale — newer loadHistory() fired
      setFallbackLoading(false);
      if (!yp || yp.length < 2) return;
      if (metricLoaded.current) return;       // backend already has metric data
      setYahooPrices(yp);
      setLoading(false);                      // stop spinner NOW
      clearTimeout(slowTimer.current);
      setSlowLoad(false);
    }).catch(function() { setFallbackLoading(false); });

    // ── Backend request ───────────────────────────────────────────────────────
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(ENDPOINTS.metricHistory(ticker, apiKey), {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      clearTimeout(slowTimer.current);
      setSlowLoad(false);

      if (!res.ok) {
        setError(true);
      } else {
        const json = await res.json();
        const isUsePrice = json?.use_price;
        const hasMetricData = isUsePrice
          ? (json?.price_history?.length > 1)
          : Array.isArray(json)
              ? json.length > 1
              : (json?.quarterly?.length > 1 || json?.annual?.length > 1);

        setData(json);

        if (hasMetricData) {
          // Real metric series arrived — clear the fallback price chart.
          metricLoaded.current = true;
          setYahooPrices(null);
        }
        // If no metric data, the fallback (already in flight) will populate yahooPrices.
      }
    } catch {
      clearTimeout(timeout);
      clearTimeout(slowTimer.current);
      setSlowLoad(false);
      setError(true);
    }

    // Final stop: covers the case where the backend responded but the fallback
    // hadn't fired yet (so setLoading(false) wasn't called from the .then()).
    if (loadId.current === myId) setLoading(false);
  }

  const usePrice = data?.use_price;

  const rawSeries = usePrice
    ? (data?.price_history || [])
    : (Array.isArray(data) ? data : (data?.[mode] || []));

  const series = rawSeries
    .map(normalizeItem)
    .filter(p => p.value != null);

  const usingYahooFallback = series.length < 2 && yahooPrices && yahooPrices.length > 1;
  const effectiveSeries = usingYahooFallback ? yahooPrices : series;

  // Show BOTH: tile note (exact truncated text from tile) AND i18n full explanation
  const i18nExpl = t.metric_explanations?.[metricKey] || t.metric_explanations?.[apiKey] || null;
  // serverExpl: only if different from both above
  const serverExpl = data?.explanation || data?.expl || null;

  const currentValue = effectiveSeries.length > 0
    ? effectiveSeries[effectiveSeries.length - 1]?.value
    : null;

  const chartData = effectiveSeries.length > 1
    ? { prices: effectiveSeries.map(p => p.value), dates: effectiveSeries.map(p => p.date) }
    : null;

  // Show quarterly/annual toggle only when both arrays have data
  const qHasData = Array.isArray(data?.quarterly) && data.quarterly.length > 1;
  const aHasData = Array.isArray(data?.annual)    && data.annual.length    > 1;
  const showModeToggle = !usePrice && !usingYahooFallback && !loading && !error
                       && (qHasData || aHasData);

  const s = makeStyles(colors);

  return (
    <View style={[s.container, { backgroundColor: colors.bg }]}>
      <BrandHeader />

      <View style={[s.header, {
        backgroundColor: colors.card,
        borderBottomColor: colors.cardBorder,
        paddingTop: insets.top + 10,
      }]}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={[s.back, { color: colors.accent }]}>{'<'}</Text>
        </TouchableOpacity>
        <Text style={[s.title, { color: colors.text }]}>{label || metricKey}</Text>
        <View style={{ width: 30 }} />
      </View>

      {/* ── Explanations: BOTH tile note AND i18n full explanation, shown immediately ── */}
      {tileNote ? (
        <View style={[s.explBox, {
          backgroundColor: tileScoreColor(tileScore, colors) + '22',
          borderColor:     tileScoreColor(tileScore, colors) + '55',
          marginHorizontal: 16,
          marginTop: 12,
          marginBottom: 4,
        }]}>
          <Text style={[s.explText, { color: tileScoreColor(tileScore, colors) }]}>{tileNote}</Text>
        </View>
      ) : null}
      {i18nExpl && i18nExpl !== tileNote ? (
        <View style={[s.explBox, {
          backgroundColor: (colors.accent || '#6366f1') + '15',
          borderColor: (colors.accent || '#6366f1') + '40',
          marginHorizontal: 16,
          marginTop: tileNote ? 6 : 12,
          marginBottom: 4,
        }]}>
          <Text style={[s.explText, { color: colors.textDim }]}>{i18nExpl}</Text>
        </View>
      ) : null}
      {serverExpl && serverExpl !== tileNote && serverExpl !== i18nExpl ? (
        <View style={[s.explBox, {
          backgroundColor: (colors.accent || '#6366f1') + '10',
          borderColor: (colors.accent || '#6366f1') + '30',
          marginHorizontal: 16,
          marginTop: 6,
          marginBottom: 4,
        }]}>
          <Text style={[s.explText, { color: colors.textDimmer }]}>{serverExpl}</Text>
        </View>
      ) : null}

      {showModeToggle && (
        <View style={[s.modeRow, { backgroundColor: colors.card, borderBottomColor: colors.cardBorder }]}>
          {[
            { key: 'quarterly', label: t.quarterly || 'Quarterly', has: qHasData },
            { key: 'annual',    label: t.annual    || 'Annual',    has: aHasData },
          ].map(m => (
            <TouchableOpacity
              key={m.key}
              disabled={!m.has}
              style={[
                s.modeBtn,
                { backgroundColor: mode === m.key ? colors.accent : colors.cardAlt, borderRadius: 10 },
                !m.has && { opacity: 0.4 },
              ]}
              onPress={() => setMode(m.key)}>
              <Text style={[s.modeBtnText, { color: mode === m.key ? '#fff' : colors.textDim }]}>
                {m.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color={colors.accent} />
          {slowLoad && (
            <View style={[s.wakeupBanner, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}>
              <Text style={[s.wakeupText, { color: colors.textDim }]}>
                {t.waking_up || 'Server is waking up... this may take up to a minute on first load'}
              </Text>
            </View>
          )}
        </View>
      ) : (
        <ScrollView contentContainerStyle={[s.content, { paddingBottom: insets.bottom + 24 }]}>


          {/* Error / no-data section */}
          {error && !usingYahooFallback ? (
            <View style={{ alignItems: 'center', paddingTop: 24, paddingBottom: 24 }}>
              <Text style={[s.noData, { color: colors.textDimmer, marginBottom: 20 }]}>
                {t.loadError || 'Could not load data. Server may be starting up.'}
              </Text>
              <TouchableOpacity
                style={[s.retryBtn, { backgroundColor: colors.accent }]}
                onPress={loadHistory}>
                <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>
                  {t.retry || 'Retry'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {/* Fallback notice */}
              {(usePrice || usingYahooFallback) && (
                <View style={[s.noDataBanner, {
                  backgroundColor: (colors.amber || '#fbbf24') + '22',
                  borderColor: colors.amber || '#fbbf24',
                }]}>
                  <Text style={[s.noDataText, { color: colors.amber || '#fbbf24' }]}>
                    {t.use_price_fallback || 'No history available for this metric – showing stock price as context'}
                  </Text>
                </View>
              )}

              {/* Chart */}
              {chartData ? (
                <>
                  <PriceChart data={chartData} colors={colors} height={220} />
                  {currentValue != null && (
                    <Text style={[s.currentValue, { color: colors.text }]}>
                      {typeof currentValue === 'number'
                        ? (Math.abs(currentValue) >= 1e9
                            ? '$' + (currentValue / 1e9).toFixed(2) + 'B'
                            : Math.abs(currentValue) >= 1e6
                            ? '$' + (currentValue / 1e6).toFixed(2) + 'M'
                            : currentValue % 1 === 0
                            ? currentValue.toString()
                            : currentValue.toFixed(2))
                        : String(currentValue)}
                    </Text>
                  )}
                </>
              ) : (
                <View style={{ alignItems: 'center', marginTop: 24, marginBottom: 16, paddingHorizontal: 20 }}>
                  {fallbackLoading ? (
                    // Fallback still in flight — show mini spinner instead of "No data"
                    <ActivityIndicator size="small" color={colors.accent} style={{ marginBottom: 8 }} />
                  ) : (
                    <>
                      {/* If tile had a value, show it prominently with explanation */}
                      {tileValue != null ? (
                        <>
                          <Text style={[s.currentValue, { color: colors.text, marginBottom: 8 }]}>
                            {typeof tileValue === 'number'
                              ? (Math.abs(tileValue) >= 1e9
                                  ? '$' + (tileValue / 1e9).toFixed(2) + 'B'
                                  : Math.abs(tileValue) >= 1e6
                                  ? '$' + (tileValue / 1e6).toFixed(2) + 'M'
                                  : tileValue % 1 === 0
                                  ? tileValue.toString()
                                  : tileValue.toFixed(2))
                              : String(tileValue)}
                          </Text>
                          <View style={[s.noDataBanner, {
                            backgroundColor: (colors.accent || '#6366f1') + '15',
                            borderColor: (colors.accent || '#6366f1') + '40',
                            marginBottom: 16,
                          }]}>
                            <Text style={[s.noDataText, { color: colors.textDim }]}>
                              {t.no_history_for_metric || 'No historical series available for this metric. The value shown is the current reading from the latest financial report.'}
                            </Text>
                          </View>
                        </>
                      ) : (
                        <Text style={[s.noData, { color: colors.textDimmer, marginBottom: 16 }]}>
                          {t.noData || 'No data available.'}
                        </Text>
                      )}
                      <TouchableOpacity
                        style={[s.retryBtn, { backgroundColor: colors.accent }]}
                        onPress={loadHistory}>
                        <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>
                          {t.retry || 'Retry'}
                        </Text>
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              )}
            </>
          )}

        </ScrollView>
      )}
    </View>
  );
}

const makeStyles = (c) => StyleSheet.create({
  container:    { flex: 1 },
  header:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                  paddingBottom: 12, paddingHorizontal: 16, borderBottomWidth: 0.5 },
  back:         { fontSize: 22 },
  title:        { fontSize: 17, fontWeight: 'bold', flex: 1, textAlign: 'center' },

  modeRow:      { flexDirection: 'row', padding: 10, gap: 10, borderBottomWidth: 0.5 },
  modeBtn:      { flex: 1, padding: 10, alignItems: 'center' },
  modeBtnText:  { fontWeight: '600', fontSize: 14 },

  content:      { padding: 16 },

  wakeupBanner: { marginTop: 24, marginHorizontal: 24, padding: 14, borderRadius: 10,
                  borderWidth: 0.5, alignItems: 'center' },
  wakeupText:   { fontSize: 13, textAlign: 'center', lineHeight: 20 },

  noDataBanner: { padding: 12, borderRadius: 8, borderWidth: 1, marginBottom: 16 },
  noDataText:   { fontSize: 13, textAlign: 'center' },

  currentValue: { fontSize: 28, fontWeight: 'bold', textAlign: 'center', marginVertical: 14 },
  noData:       { textAlign: 'center', fontSize: 14 },

  retryBtn:     { paddingHorizontal: 28, paddingVertical: 12, borderRadius: 10 },

  explBox:      { marginTop: 16, padding: 14, borderRadius: 10, borderWidth: 1 },
  explText:     { fontSize: 13, lineHeight: 20 },
  sourceTag:    { fontSize: 11, marginTop: 8, textAlign: 'center' },
});

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../constants/AppContext';
import { ENDPOINTS } from '../constants/api';
import { captureIssue } from '../utils/monitoring';
import { httpError, classifyError, canRetry, errorText } from '../utils/errors';
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

// The only metrics a raw stock-PRICE chart legitimately belongs to. Module
// scope because both the fetch decision and the render decision use it.
const PRICE_METRICS = new Set(['price', 'stock_price', 'share_price']);

// Metrics whose chart is NOT the metric itself. The code has always known this
// (see METRIC_KEY_MAP's "proxy" comments and the forward-P/E substitution in
// main.py) but the user was never told: the screen showed "Forward P/E 38.62"
// above a line running 66–363, because that line is TRAILING P/E. Each of these
// now renders an explicit note saying what the chart actually is.
const PROXY_CHART = {
  forward_pe:  'proxy_chart_forward_pe',
  moat:        'proxy_chart_moat',
  cash_runway: 'proxy_chart_cash_runway',
};

// Metrics where the headline number and the chart are computed from DIFFERENT
// sources, verified against the live API on WMT:
//   debt_to_equity  Yahoo's debtToEquity field  vs  Total Debt / Equity   (10%)
//   ev_to_ebitda    Yahoo's enterpriseToEbitda  vs  our EV calc          (7.6%)
//   buyback         annual report / market cap  vs  quarterly TTM        (31%)
//   peg_ratio       provider field              vs  computed from EPS    (5.7%)
// None of these is a bug — they are legitimate methodology differences. But the
// user sees one title above two different numbers, so we say so.
const COMPUTED_DIFFERENTLY = new Set(['debt_to_equity', 'ev_to_ebitda', 'buyback', 'peg_ratio']);

// Metrics that are ratios/percentages — no $ sign in chart tooltip
const RATIO_METRICS = new Set([
  'pe_ratio', 'forward_pe', 'peg_ratio',
  'price_to_book', 'price_to_sales', 'pb_ratio', 'ps_ratio',
  'ev_to_ebitda', 'ev_ebitda',
  'debt_to_equity', 'debt_equity', 'liab_equity', 'liabilities_to_equity',
  'current_ratio',
  'gross_margin', 'operating_margin', 'net_margin', 'profit_margin',
  'roe', 'roa',
  'moat',
  'dividend', 'buyback',
]);

// Normalize a single item from the server into { date, value }
function normalizeItem(item) {
  if (Array.isArray(item)) {
    return { date: String(item[0] || ''), value: item[1] };
  }
  // A null/primitive entry inside the series used to throw here on item.value.
  if (!item || typeof item !== 'object') return { date: '', value: null };
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
    } catch(e) {
      // One of several fallback price sources. Failure here is the normal case
      // for most of them; the loop moves on and the caller reports if ALL of
      // them came back empty.
    }
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
  } catch(e) { return null; }
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
  } catch(e) { return null; }
}

// Race 3 client-side sources — used ONLY during backend cold start (first ~50s).
// Tiingo key lives on the backend (/price-history endpoint) — never in the bundle.
async function fetchFallbackPrices(ticker) {
  const [y, s, yv7] = await Promise.all([
    fetchYahooPrices(ticker).catch(function() { return null; }),
    fetchStooqPrices(ticker).catch(function() { return null; }),
    fetchYahooV7Prices(ticker).catch(function() { return null; }),
  ]);
  const series = (y   && y.length   > 1) ? y
               : (s   && s.length   > 1) ? s
               : (yv7 && yv7.length > 1) ? yv7
               : null;
  // Keep only the last 12 monthly points. Stooq returns FULL history (20+
  // years) — a two-decade price chart as "reference" under a metric title is
  // confusing and crowds the axis labels. 1Y matches the rest of the app.
  return series ? series.slice(-12) : null;
}

// Same ladder as the tile the user just tapped, so the signal carries across
// both screens.
//
// `null` used to fall back to colors.purple — which in this theme IS '#f59e0b',
// i.e. AMBER. Every metric opened from "Additional Valuation Multiples" passes
// no score, so its note box rendered as an amber warning wrapped around a
// sentence that only explains what the metric means. No score = no verdict =
// no colour.
function tileScoreColor(score, colors) {
  if (score == null) return colors.textDim;
  if (score >= 70)   return colors.green  || '#22c55e';
  if (score >= 40)   return colors.amber  || '#fbbf24';
  return               colors.red    || '#ef4444';
}

// ValTile metrics carry no score but DO have a colour (P/B above 5 is red), so
// the stock screen passes it explicitly. Without it the number was red on one
// screen and grey on the next.
function signalColor(tileSignal, tileScore, colors) {
  if (tileSignal === 'green') return colors.green;
  if (tileSignal === 'red')   return colors.red;
  if (tileSignal === 'amber') return colors.amber;
  return tileScoreColor(tileScore, colors);
}

export default function MetricHistoryScreen({ route, navigation }) {
  const { ticker, metricKey, label, tileNote, tileScore, tileValue, tileValueText, tileSignal } = route.params;
  // Company name for the header line above the metric. Optional: a caller that
  // doesn't pass it still renders, showing the ticker alone.
  //
  // The caller often has nothing better than the ticker itself to pass — the
  // search screen navigates with name === ticker, and /analyze may not have
  // answered yet. That produced the header "AMZN · AMZN". Compare case- and
  // space-insensitively and drop the duplicate half.
  const _rawName = route.params.companyName || null;
  const _sameAsTicker = _rawName && ticker &&
    String(_rawName).trim().toLowerCase() === String(ticker).trim().toLowerCase();
  const stockLabel = !ticker ? null
                   : (_rawName && !_sameAsTicker) ? `${ticker} · ${_rawName}`
                   : ticker;
  // Currency of THIS stock ('₪' for TASE). Values here are the same figures the
  // tile showed, so they must carry the same symbol.
  // TWO currencies, because a company can trade in one and report in another
  // (ESLT.TA trades in ILS, reports in USD). `cur` labels the metric's own
  // figures; `priceCur` labels a PRICE fallback chart, which is always in the
  // trading currency. Using one for both would print "$2512" on Elbit's price.
  const cur      = route.params.cur || '$';
  const priceCur = route.params.priceCur || cur;
  const { colors, t, lang } = useApp();
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
    setMode('quarterly');

    slowTimer.current = setTimeout(() => setSlowLoad(true), 5000);

    // ── Price fallback ────────────────────────────────────────────────────────
    // Only fetched when a price chart could actually be DISPLAYED. A stock-price
    // line is suppressed under every non-price metric (it is meaningless there),
    // so fetching it anyway meant 3 external requests — Yahoo x2 + Stooq — on
    // every metric tap for data that was thrown away.
    const wantPriceFallback = PRICE_METRICS.has(metricKey);
    setFallbackLoading(wantPriceFallback);
    if (wantPriceFallback) {
      fetchFallbackPrices(ticker).then(function(yp) {
        if (loadId.current !== myId) return;   // stale — newer loadHistory() fired
        setFallbackLoading(false);
        if (!yp || yp.length < 2) return;
        if (metricLoaded.current) return;       // backend already has metric data
        setYahooPrices(yp);
        setLoading(false);                      // stop spinner NOW
        clearTimeout(slowTimer.current);
        setSlowLoad(false);
      }).catch(function() {
        // Guarded like the success path: a stale rejection must not clear the
        // spinner that a newer load just turned on.
        if (loadId.current === myId) setFallbackLoading(false);
      });
    }

    // ── Backend request ───────────────────────────────────────────────────────
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(ENDPOINTS.metricHistory(ticker, apiKey), {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      // The two "try again" buttons call loadHistory() directly, so a second
      // load can start while the first is still in flight. Only the newest
      // generation may write: without this, a slow FAILED first attempt could
      // land after a successful retry and replace the chart with an error
      // screen (or the reverse — a stale success wiping a fresh error).
      if (loadId.current !== myId) return;
      clearTimeout(slowTimer.current);
      setSlowLoad(false);

      if (!res.ok) {
        // Was `setError(true)` — the response carried 404 / 429 / 504 and all
        // three rendered "Could not load data. Server may be starting up."
        setError(classifyError(httpError(res.status)));
      } else {
        const json = await res.json();
        if (loadId.current !== myId) return;   // stale — newer load owns the screen
        const isUsePrice = json?.use_price;
        const hasMetricData = isUsePrice
          ? (json?.price_history?.length > 1)
          : Array.isArray(json)
              ? json.length > 1
              : (json?.quarterly?.length > 1 || json?.annual?.length > 1);

        setData(json);
        if (json && json.empty_reason) {
          captureIssue('empty_chart', { ticker: ticker, metric: apiKey, reason: json.empty_reason });
        }

        if (hasMetricData) {
          // Real metric series arrived — clear the fallback price chart.
          metricLoaded.current = true;
          setYahooPrices(null);
        }
        // If no metric data, the fallback (already in flight) will populate yahooPrices.
      }
    } catch(e) {
      clearTimeout(timeout);
      if (loadId.current !== myId) return;
      clearTimeout(slowTimer.current);
      setSlowLoad(false);
      setError(classifyError(e));
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

  // A stock-PRICE chart under ANY other metric (EV/EBITDA, Forward P/E,
  // Share Buyback, Cash Position…) is meaningless — the numbers on the axis
  // aren't the metric, and a decades-long price line reads as if it were.
  // The only metric a price chart legitimately belongs to is the price itself.
  const suppressPriceChart = (usePrice || usingYahooFallback)
                          && !PRICE_METRICS.has(metricKey);

  // Show BOTH: tile note (exact truncated text from tile) AND i18n full explanation
  // These explanation boxes are translated sentences; without a direction they
  // rendered left-to-right in Hebrew, same as the stock screen used to.
  const isRtl = lang === 'he';
  const dirStyle = { textAlign: isRtl ? 'right' : 'left', writingDirection: isRtl ? 'rtl' : 'ltr' };

  // ONE rule, no exceptions: the chart line carries the metric's own colour —
  // the same one the tile showed. Amber tile, amber line. Green, green. Red, red.
  // Blue ONLY when the metric has no verdict at all (no score and no threshold),
  // e.g. revenue or operating cash flow: informational, never a judgement.
  //
  // Dividend and buyback used to be forced blue on the grounds that a falling
  // yield is ambiguous. That reasoning was about the TREND — but the colour does
  // not describe the trend, it echoes the metric's verdict. The line's shape
  // already shows direction.
  const hasVerdict = tileSignal != null || tileScore != null;
  const chartSignal = hasVerdict
    ? signalColor(tileSignal, tileScore, colors)
    : (colors.blue || '#60a5fa');

  const i18nExpl = t.metric_explanations?.[metricKey] || t.metric_explanations?.[apiKey] || null;
  // serverExpl: only if different from both above
  const serverExpl = data?.explanation || data?.expl || null;

  const currentValue = effectiveSeries.length > 0
    ? effectiveSeries[effectiveSeries.length - 1]?.value
    : null;


  const chartData = (effectiveSeries.length > 1 && !suppressPriceChart)
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
        {/* WHICH stock this is, above the metric name. Without it the screen read
            "EV/EBITDA · 103.36" with nothing tying the number to a company — the
            reader loses the context the moment they tap through from the tile. */}
        <View style={{ flex: 1, paddingHorizontal: 4 }}>
          {stockLabel ? (
            <Text numberOfLines={1} ellipsizeMode="tail"
                  style={[s.stockLine, { color: colors.accent }]}>
              {stockLabel}
            </Text>
          ) : null}
          {/* adjustsFontSizeToFit shrinks a long metric name rather than
              truncating it — "יחס התחייבויות להון עצמי" has to stay readable.
              numberOfLines={2} gives it somewhere to go first. */}
          <Text numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.75}
                style={[s.title, { color: colors.text }]}>
            {t.metric_names?.[metricKey] || label || metricKey}
          </Text>
        </View>
        <View style={{ width: 30 }} />
      </View>

      {/* ── Explanations: BOTH tile note AND i18n full explanation, shown immediately ── */}
      {tileNote ? (
        <View style={[s.explBox, {
          backgroundColor: signalColor(tileSignal, tileScore, colors) + '22',
          borderColor:     signalColor(tileSignal, tileScore, colors) + '55',
          marginHorizontal: 16,
          marginTop: 12,
          marginBottom: 4,
        }]}>
          <Text style={[s.explText, { color: signalColor(tileSignal, tileScore, colors) }, dirStyle]}>{tileNote}</Text>
        </View>
      ) : null}
      {i18nExpl && i18nExpl !== tileNote ? (
        <View style={[s.explBox, {
          /* Pure explanation of what the metric means — never a warning.
             This used colors.accent, which is '#f59e0b' (amber) in this theme. */
          backgroundColor: colors.cardAlt,
          borderColor: colors.cardBorder,
          marginHorizontal: 16,
          marginTop: tileNote ? 6 : 12,
          marginBottom: 4,
        }]}>
          <Text style={[s.explText, { color: colors.textDim }, dirStyle]}>{i18nExpl}</Text>
        </View>
      ) : null}
      {serverExpl && serverExpl !== tileNote && serverExpl !== i18nExpl ? (
        <View style={[s.explBox, {
          backgroundColor: colors.cardAlt,
          borderColor: colors.cardBorder,
          marginHorizontal: 16,
          marginTop: 6,
          marginBottom: 4,
        }]}>
          <Text style={[s.explText, { color: colors.textDimmer }, dirStyle]}>{serverExpl}</Text>
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
            <View style={{ alignItems: 'center', paddingTop: 24, paddingBottom: 24, paddingHorizontal: 12 }}>
              {(function() {
                const et = errorText(error, t, { ticker: ticker });
                return (
                  <>
                    {et.title ? (
                      <Text style={[s.noData, {
                        color: colors.text, fontWeight: '600', marginBottom: 6, textAlign: 'center',
                        writingDirection: isRtl ? 'rtl' : 'ltr',
                      }]}>{et.title}</Text>
                    ) : null}
                    <Text style={[s.noData, {
                      color: colors.textDimmer, marginBottom: 20, textAlign: 'center',
                      writingDirection: isRtl ? 'rtl' : 'ltr',
                    }]}>
                      {et.msg || t.loadError || 'Could not load data. Server may be starting up.'}
                    </Text>
                  </>
                );
              })()}
              {/* Retrying a 404 or a 429 reproduces the same failure. */}
              {canRetry(error) ? (
                <TouchableOpacity
                  style={[s.retryBtn, { backgroundColor: colors.accent }]}
                  onPress={loadHistory}>
                  <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>
                    {t.retry || 'Retry'}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : (
            <>
              {/* Fallback notice — only when an actual price chart is shown.
                  For ratio metrics the chart is suppressed and the value+note
                  view below carries its own (correct) explanation. */}
              {(usePrice || usingYahooFallback) && !suppressPriceChart && (
                <View style={[s.noDataBanner, {
                  backgroundColor: colors.cardAlt,
                  borderColor: colors.cardBorder,
                }]}>
                  <Text style={[s.noDataText, { color: colors.textDim }, { writingDirection: isRtl ? 'rtl' : 'ltr' }]}>
                    {tileValue != null
                      ? (t.use_price_fallback_with_value || 'No historical series tracked for this metric. Current value: {v}. Showing stock price chart for reference.')
                          .replace('{v}', typeof tileValue === 'number'
                            ? (Math.abs(tileValue) >= 1e12 ? cur + (Math.abs(tileValue) / 1e12).toFixed(2) + 'T'
                              : Math.abs(tileValue) >= 1e9  ? cur + (Math.abs(tileValue) / 1e9).toFixed(2) + 'B'
                              : Math.abs(tileValue) >= 1e6  ? cur + (Math.abs(tileValue) / 1e6).toFixed(2) + 'M'
                              : tileValue % 1 === 0 ? tileValue.toString()
                              : tileValue.toFixed(2))
                            : String(tileValue))
                      : (t.use_price_fallback || 'No historical series tracked for this metric. Showing stock price chart for reference.')}
                  </Text>
                </View>
              )}

              {/* Chart */}
              {chartData ? (
                <>
                  {PROXY_CHART[metricKey] && t[PROXY_CHART[metricKey]] ? (
                    <View style={[s.noDataBanner, {
                      backgroundColor: colors.cardAlt,
                      borderColor: colors.cardBorder,
                    }]}>
                      <Text style={[s.noDataText, { color: colors.textDim },
                                    { writingDirection: isRtl ? 'rtl' : 'ltr' }]}>
                        {t[PROXY_CHART[metricKey]]}
                      </Text>
                    </View>
                  ) : null}
                  <PriceChart
                    data={chartData}
                    colors={colors}
                    height={220}
                    currency={(usePrice || usingYahooFallback) ? priceCur : cur}
                    showCurrency={usePrice || usingYahooFallback || !RATIO_METRICS.has(metricKey)}
                    /* A price fallback chart is a PRICE — rising is good even
                       under a "lower is better" metric, so don't invert it. */
                    /* Same verdict colour the tile showed. A price fallback
                       chart is a PRICE, so it keeps the direction rule. */
                    signal={(usePrice || usingYahooFallback) ? undefined
                            : chartSignal} />
                  {(tileValue != null && !usingYahooFallback) || currentValue != null ? (
                    <Text style={[s.currentValue, { color: colors.text }]}>
                      {(function() {
                        // Prefer tileValue (live API) over currentValue (last historical point)
                        // so the number always matches what was shown on the tile.
                        const v = (!usingYahooFallback && tileValue != null) ? tileValue : currentValue;
                        if (v == null) return '';
                        if (typeof v !== 'number') return String(v);
                        const isRatio = RATIO_METRICS.has(metricKey);
                        const abs = Math.abs(v);
                        const sign = v < 0 ? '-' : '';
                        if (!isRatio) {
                          if (abs >= 1e12) return sign + cur + (abs / 1e12).toFixed(2) + 'T';
                          if (abs >= 1e9)  return sign + cur + (abs / 1e9).toFixed(2) + 'B';
                          if (abs >= 1e6)  return sign + cur + (abs / 1e6).toFixed(2) + 'M';
                        }
                        return v % 1 === 0 ? v.toString() : v.toFixed(2);
                      })()}
                    </Text>
                  ) : null}
                  {/* Where the two numbers come from. This was four lines of prose
                      in a bordered box ABOVE the chart, and it read like an error
                      message on every stock. It appears on every stock because for
                      these four metrics the provider's figure and our calculation
                      essentially always differ — GOOGL: 24.42 against 20.1, an 18%
                      gap. Gating it behind a threshold was the wrong fix: the
                      statement is always true, so the answer is to make it small,
                      not conditional. One dim line under the number. */}
                  {COMPUTED_DIFFERENTLY.has(metricKey) && t.chart_method_note ? (
                    <View style={[s.methodChip, {
                      backgroundColor: colors.cardAlt,
                      borderColor: colors.cardBorder,
                    }]}>
                      <Text style={[s.methodNote, { color: colors.textDim },
                                    { writingDirection: isRtl ? 'rtl' : 'ltr' }]}>
                        {'ⓘ  ' + t.chart_method_note}
                      </Text>
                    </View>
                  ) : null}
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
                            {tileValueText != null
                              ? tileValueText
                              : typeof tileValue === 'number'
                              ? (() => {
                                  const isRatio = RATIO_METRICS.has(metricKey);
                                  const abs = Math.abs(tileValue);
                                  const sign = tileValue < 0 ? '-' : '';
                                  if (!isRatio) {
                                    if (abs >= 1e12) return sign + cur + (abs / 1e12).toFixed(2) + 'T';
                                    if (abs >= 1e9)  return sign + cur + (abs / 1e9).toFixed(2) + 'B';
                                    if (abs >= 1e6)  return sign + cur + (abs / 1e6).toFixed(2) + 'M';
                                  }
                                  return tileValue % 1 === 0 ? tileValue.toString() : tileValue.toFixed(2);
                                })()
                              : String(tileValue)}
                          </Text>
                          <View style={[s.noDataBanner, {
                            backgroundColor: colors.cardAlt,
                            borderColor: colors.cardBorder,
                            marginBottom: 16,
                          }]}>
                            <Text style={[s.noDataText, { color: colors.textDim }, { writingDirection: isRtl ? 'rtl' : 'ltr' }]}>
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
  // `alignItems: 'flex-start'` and not 'center': with a two-line column in the
  // middle, centring the row let the taller column overflow the header's height
  // and the metric name was clipped by the border. Starting at the top lets the
  // header grow to whatever the text needs.
  header:       { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
                  paddingBottom: 12, paddingHorizontal: 16, borderBottomWidth: 0.5 },
  back:         { fontSize: 22, lineHeight: 26 },
  // No `flex: 1` on the title any more — it is inside a column now, and a flex
  // child of a column stretches VERTICALLY, which is what pushed it out of view.
  // `lineHeight` is set explicitly so two stacked lines reserve real space
  // instead of relying on the platform default.
  title:        { fontSize: 16, fontWeight: 'bold', textAlign: 'center', lineHeight: 21 },
  stockLine:    { fontSize: 12, fontWeight: '600', textAlign: 'center',
                  lineHeight: 16, marginBottom: 1 },

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
  // Small, dim, and under the number — a footnote, not a warning.
  // A soft chip, not a bare grey line — same card styling as the explanation
  // boxes above, so it reads as part of the design instead of leftover text.
  methodChip:   { alignSelf: 'center', marginTop: 10, marginBottom: 4,
                  marginHorizontal: 16, paddingVertical: 6, paddingHorizontal: 12,
                  borderRadius: 8, borderWidth: 0.5 },
  methodNote:   { fontSize: 11, textAlign: 'center', lineHeight: 15 },
  noData:       { textAlign: 'center', fontSize: 14 },

  retryBtn:     { paddingHorizontal: 28, paddingVertical: 12, borderRadius: 10 },

  explBox:      { marginTop: 16, padding: 12, borderRadius: 10, borderWidth: 1 },
  explText:     { fontSize: 11, lineHeight: 16 },
  sourceTag:    { fontSize: 11, marginTop: 8, textAlign: 'center' },
});

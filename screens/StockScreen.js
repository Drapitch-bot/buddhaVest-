// StockScreen.js — 1:1 copy of BuddhaVest HTML renderResult()
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, Linking, Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../constants/AppContext';
import { ENDPOINTS } from '../constants/api';
import { openArticle } from '../utils/linkUtils';
import ScoreGauge from '../components/ScoreGauge';
import PriceChart from '../components/PriceChart';
import MetricTile from '../components/MetricTile';
import EventsCard from '../components/EventsCard';
import NewsCard from '../components/NewsCard';
import FinancialsCard from '../components/FinancialsCard';
import ETFCard from '../components/ETFCard';
import BrandHeader from '../components/BrandHeader';
import { LinearGradient } from 'expo-linear-gradient';

// Monk images (recommendation_color)
const MONK = {
  green: require('../assets/monk_buy.png'),
  amber: require('../assets/monk_hold.png'),
  red:   require('../assets/monk_sell.png'),
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatBigNumber(num) {
  if (num == null) return '—';
  const abs = Math.abs(num);
  if (abs >= 1e12) return (num / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9)  return (num / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6)  return (num / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3)  return (num / 1e3).toFixed(2) + 'K';
  return String(num);
}

function metricValueDisplay(key, metric) {
  const v = metric && metric.value;
  if (v == null) return '—';
  const bigKeys   = ['free_cash_flow', 'net_income_trend', 'operating_cash_flow', 'cash_position', 'cost_of_revenue'];
  const ratioKeys = ['current_ratio', 'debt_to_equity', 'peg_ratio', 'liabilities_to_equity'];
  const pctKeys   = ['operating_margin', 'gross_margin', 'net_margin', 'moat', 'dividend', 'buyback'];
  if (bigKeys.includes(key))   return '$' + formatBigNumber(v);
  if (ratioKeys.includes(key)) return String(v);
  if (pctKeys.includes(key))   return v + '%';
  if (key === 'pe_ratio')      return String(v);
  if (key === 'cash_runway')   return Math.round(v) + ' mo';
  return String(v);
}

function changeColor(pct, colors) {
  if (pct == null) return colors.textDimmer;
  return pct >= 0 ? colors.green : colors.red;
}

function recColorFor(rc, colors) {
  if (rc === 'green') return colors.green;
  if (rc === 'red')   return colors.red;
  if (rc === 'amber') return colors.amber;
  return colors.textDim;
}

function gaugeColor(score, colors) {
  if (score >= 75) return colors.green;
  if (score >= 50) return colors.amber;
  return colors.red;
}

function timeAgo(published, t) {
  if (!published) return '';
  try {
    const ts = /^\d+$/.test(String(published)) ? parseInt(published) * 1000 : new Date(published).getTime();
    const h = Math.floor((Date.now() - ts) / 3600000);
    if (h < 1)  return t.time_less_hour || 'less than an hour ago';
    if (h < 24) return (t.time_hours || '{n}h ago').replace('{n}', h);
    return (t.time_days || '{n}d ago').replace('{n}', Math.floor(h / 24));
  } catch(e) { return ''; }
}

// ── MetricsGrid ───────────────────────────────────────────────────────────────
function MetricsGrid({ metricKeys, metrics, colors, navigation, ticker, t }) {
  const pairs = metricKeys.filter(function(k) {
    const m = metrics[k];
    if (!m) return false;
    if (k === 'dividend' || k === 'buyback') return true;
    return m.value != null;
  });
  if (!pairs.length) return null;
  return (
    <View style={s.metricsGrid}>
      {pairs.map(function(key) {
        const m = metrics[key];
        const displayLabel = t.metric_names?.[key] || m.label || key;
        return (
          <MetricTile
            key={key}
            label={displayLabel}
            value={metricValueDisplay(key, m)}
            note={m.explanation}
            score={m.score}
            colors={colors}
            onPress={function() {
              navigation.navigate('MetricHistory', {
                ticker: ticker,
                metricKey: key,
                label: displayLabel,
                tileNote: m.explanation || null,
                tileScore: m.score ?? null,
                tileValue: m.value ?? null,
              });
            }}
          />
        );
      })}
    </View>
  );
}

// ── BreakdownRow ──────────────────────────────────────────────────────────────
function BreakdownRow({ label, score, sub, colors }) {
  if (score == null) return null;
  const pct = Math.max(0, Math.min(100, score));
  const barCol = pct >= 75 ? colors.green : pct >= 50 ? colors.amber : colors.red;
  return (
    <View style={s.breakRow}>
      <View style={s.breakTop}>
        <Text style={[s.breakLabel, { color: colors.textDim }]}>{label}</Text>
        <Text style={[s.breakVal, { color: colors.text }]}>{pct}%</Text>
      </View>
      <View style={[s.barBg, { backgroundColor: colors.cardAlt }]}>
        <View style={[s.barFg, { width: pct + '%', backgroundColor: barCol }]} />
      </View>
      {sub ? <Text style={[s.breakSub, { color: colors.textDimmer }]}>{sub}</Text> : null}
    </View>
  );
}

// ── SignalItem ────────────────────────────────────────────────────────────────
function SignalItem({ item, colors, t, lang, navigation }) {
  const toneColors = { positive: colors.green, negative: colors.red, neutral: colors.textDimmer };
  const toneIcons  = { positive: '▲', negative: '▼', neutral: '—' };
  const tColor = toneColors[item.tone] || colors.textDimmer;
  const tIcon  = toneIcons[item.tone]  || '—';
  const hasLink = item.link && item.link.trim();
  return (
    <TouchableOpacity
      style={[s.newsCard, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}
      onPress={function() { openArticle(item.link, lang, navigation); }}
      activeOpacity={hasLink ? 0.75 : 1}>
      <Text style={[s.nTitle, { color: colors.text }]}>
        <Text style={{ color: tColor }}>{tIcon + ' '}</Text>
        {item.title}
      </Text>
      {item.categories && item.categories.length > 0 && (
        <View style={s.tagsRow}>
          {item.categories.map(function(c, i) {
            return (
              <View key={i} style={[s.tag, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}>
                <Text style={[s.tagText, { color: colors.textDim }]}>{c.label}</Text>
              </View>
            );
          })}
        </View>
      )}
      <Text style={[s.nMeta, { color: colors.textDimmer }]}>
        {[item.publisher, item.published ? timeAgo(item.published, t) : null, !hasLink ? (t.no_link_available || 'no link available') : null].filter(Boolean).join(' · ')}
      </Text>
    </TouchableOpacity>
  );
}

// ── ValExtra tile ─────────────────────────────────────────────────────────────
function ValTile({ label, value, note, valColor, colors, onPress }) {
  return (
    <TouchableOpacity
      style={[s.metricTileBase, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}
      onPress={onPress} activeOpacity={0.7}>
      <Text style={[s.mLabel, { color: colors.textDim }]}>{label}</Text>
      <Text style={[s.mValue, { color: valColor || colors.text }]}>{value || '—'}</Text>
      {note ? <Text style={[s.mNote, { color: colors.textDimmer }]} numberOfLines={2}>{note}</Text> : null}
    </TouchableOpacity>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function StockScreen({ route, navigation }) {
  const { ticker, name } = route.params;
  const { colors, t, lang, isInWatchlist, toggleWatchlist } = useApp();

  const insets = useSafeAreaInsets();

  const [data,        setData]        = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [wakingUp,    setWakingUp]    = useState(false);
  const [refreshing,  setRefreshing]  = useState(false);
  const [signals,     setSignals]     = useState(null);
  const [bizExpanded, setBizExpanded] = useState(false);
  const [secondaryCurrency, setSecondaryCurrency] = useState(null); // {rate, symbol} | null

  const inWatchlist = isInWatchlist(ticker);

  // Reload when the ticker OR the language changes (analysis text, signals
  // and secondary currency are all language-dependent)
  useEffect(function() { loadStock(); }, [ticker, lang]);

  // Guards against RACE CONDITIONS on fast language/ticker switches:
  // only the LATEST request is allowed to write state — a stale response
  // (e.g. the old language) that resolves later is discarded.
  const reqIdRef = useRef(0);

  async function loadStock() {
    const reqId = ++reqIdRef.current;
    setLoading(true); setError(null); setWakingUp(false); setSignals(null); setBizExpanded(false);
    const tryFetch = function(ms) {
      return Promise.race([
        fetch(ENDPOINTS.analyze(ticker, lang)).then(function(r) {
          if (!r.ok) throw new Error('Server error');
          return r.json();
        }),
        new Promise(function(_, rej) { setTimeout(function() { rej(new Error('timeout')); }, ms || 20000); })
      ]);
    };
    // Time-based gentle note: only if the load drags past 4s, and only for the
    // current request. Clears the moment data arrives; a warm server never
    // triggers it.
    var slowTimer = setTimeout(function() {
      if (reqId === reqIdRef.current) setWakingUp(true);
    }, 4000);
    try {
      const json = await tryFetch(20000);
      if (reqId !== reqIdRef.current) { clearTimeout(slowTimer); return; } // stale
      setData(json);
      fetchSignals(json.ticker || ticker, reqId);
      fetchExchangeRate(reqId);
      clearTimeout(slowTimer); setWakingUp(false);
      setLoading(false);
    } catch(e) {
      if (reqId !== reqIdRef.current) { clearTimeout(slowTimer); return; }
      // First attempt failed — keep the gentle note and retry once, longer.
      await new Promise(function(r) { setTimeout(r, 8000); });
      if (reqId !== reqIdRef.current) { clearTimeout(slowTimer); return; }
      try {
        const json = await tryFetch(40000);
        if (reqId !== reqIdRef.current) { clearTimeout(slowTimer); return; }
        setData(json);
        fetchSignals(json.ticker || ticker, reqId);
        fetchExchangeRate(reqId);
      } catch(e) {
        if (reqId !== reqIdRef.current) { clearTimeout(slowTimer); return; }
        setError('connection_error');
      }
      clearTimeout(slowTimer); setWakingUp(false);
      setLoading(false);
    }
  }

  async function fetchSignals(tk, reqId) {
    try {
      const res  = await fetch(ENDPOINTS.signals(tk, lang));
      const json = await res.json();
      if (reqId !== reqIdRef.current) return;
      setSignals(json.flagged || json.signals || []);
    } catch(e) { if (reqId === reqIdRef.current) setSignals([]); }
  }

  async function fetchExchangeRate(reqId) {
    // HTML LANG_CURRENCY: he→ILS/₪, ru→RUB/₽, es→EUR/€, en→null
    const LANG_CURRENCY = { he: { code: 'ILS', symbol: '₪' }, ru: { code: 'RUB', symbol: '₽' }, es: { code: 'EUR', symbol: '€' } };
    const cfg = LANG_CURRENCY[lang];
    if (!cfg) { setSecondaryCurrency(null); return; }
    try {
      const res  = await fetch(ENDPOINTS.exchangeRate(cfg.code));
      const json = await res.json();
      if (reqId !== reqIdRef.current) return;
      setSecondaryCurrency(json.rate ? { rate: json.rate, symbol: cfg.symbol } : null);
    } catch(e) { if (reqId === reqIdRef.current) setSecondaryCurrency(null); }
  }

  // deps MUST include lang: with [ticker] only, pull-to-refresh kept a stale
  // closure of loadStock frozen at the mount-time language — refreshing after
  // a language switch refetched in the OLD language and overwrote the UI.
  const onRefresh = useCallback(async function() {
    setRefreshing(true); await loadStock(); setRefreshing(false);
  }, [ticker, lang]);

  const m   = (data && data.metrics)         || {};
  const ov  = (data && data.overview)        || {};
  const cs  = (data && data.category_scores) || {};
  const ve  = (data && data.valuation_extra) || {};
  const history = data && data.history;

  // Israeli stocks are already priced in shekel (server tags price_currency
  // 'ILS'): show ₪ as the primary symbol and skip the USD→ILS second line.
  const priceIsILS  = data && data.price_currency === 'ILS';
  const priceSymbol = priceIsILS ? '₪' : '$';
  const showSecondaryCcy = !priceIsILS && secondaryCurrency != null;

  function incomeLabelFor() {
    const hasDiv = m.dividend && m.dividend.pays_dividend;
    const hasBB  = m.buyback  && m.buyback.does_buyback;
    if (hasDiv && hasBB) return { label: t.income_label_div_bb || 'Cash Flow, Dividend & Buyback', sub: t.income_sub_div_bb   || '' };
    if (hasDiv)          return { label: t.income_label_div    || 'Cash Flow & Dividend',          sub: t.income_sub_with_div || '' };
    if (hasBB)           return { label: t.income_label_bb     || 'Cash Flow & Buyback',           sub: t.income_sub_with_bb  || '' };
    return               { label: t.income_label               || 'Cash Flow',                     sub: t.income_sub_no_div   || '' };
  }

  var rangePct = 50;
  if (ov.week52_low != null && ov.week52_high != null && data && data.current_price != null && ov.week52_high > ov.week52_low) {
    rangePct = Math.max(0, Math.min(100, (data.current_price - ov.week52_low) / (ov.week52_high - ov.week52_low) * 100));
  }

  const monkSrc = MONK[(data && data.recommendation_color)] || MONK.amber;
  const rcColor = recColorFor(data && data.recommendation_color, colors);

  // Map recommendation_color → i18n label/explanation (avoids server-side Hebrew)
  const REC_MAP = {
    green: { label: t.rec_buy,          explain: t.rec_explain_green },
    amber: { label: t.rec_hold,         explain: t.rec_explain_amber },
    red:   { label: t.rec_avoid,        explain: t.rec_explain_red   },
    gray:  { label: t.rec_insufficient, explain: t.rec_explain_gray  },
  };
  const recInfo = REC_MAP[data && data.recommendation_color] || REC_MAP.gray;

  // Build dividend/buyback summary from metric values (avoids server-side Hebrew)
  const divPct = m.dividend && m.dividend.value != null ? m.dividend.value : null;
  const divSummary = m.dividend
    ? (m.dividend.pays_dividend && divPct != null
        ? (t.dividend_pays || 'Pays dividend (~{pct}%)').replace('{pct}', divPct.toFixed(1))
        : (t.dividend_none || 'No dividend'))
    : null;
  const bbPct = m.buyback && m.buyback.value != null ? m.buyback.value : null;
  const bbSummary = m.buyback
    ? (m.buyback.does_buyback && bbPct != null
        ? (t.buyback_yes || 'Buys back shares (~{pct}%)').replace('{pct}', bbPct.toFixed(1))
        : (t.buyback_no || 'No buyback'))
    : null;

  return (
    <View style={[s.root, { backgroundColor: colors.bg }]}>

      {/* ── Brand Header — logo always visible, like HTML fixed header ── */}
      <BrandHeader onRefresh={onRefresh} />

      {/* Body */}
      {loading ? (
        <View style={s.loadWrap}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={[s.loadText, { color: colors.textDim }]}>{(t.analyzing || 'Analyzing') + ' ' + ticker + '...'}</Text>
        </View>
      ) : error ? (
        <View style={s.errorWrap}>
          <Text style={{ fontSize: 36, marginBottom: 8 }}>{'⚠️'}</Text>
          <Text style={[s.errorTitle, { color: colors.text }]}>
            {(t.cant_analyze || 'Cannot analyze') + ' ' + ticker}
          </Text>
          <Text style={[s.errorMsg, { color: colors.textDim }]}>
            {t.cant_connect || "Couldn't connect to BuddhaVest's server."}
          </Text>
          <TouchableOpacity onPress={loadStock} style={[s.retryBtn, { backgroundColor: colors.accent }]}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>{t.retry || 'Try again'}</Text>
          </TouchableOpacity>
        </View>
      ) : data && data.partial_data ? (
        /* partial_data — only price available, no fundamentals (matches HTML placeholder) */
        <ScrollView contentContainerStyle={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 }}>
          <Text style={{ fontSize: 40, marginBottom: 8 }}>{'📊'}</Text>
          <Text style={[s.stockTicker, { color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: 4 }]}>{data.ticker}</Text>
          {data.current_price != null && (
            <Text style={{ fontSize: 24, fontWeight: '700', color: colors.text, marginBottom: 4 }}>
              {priceSymbol + data.current_price.toFixed(2)}
            </Text>
          )}
          {data.current_price != null && showSecondaryCcy && (
            <Text style={{ fontSize: 14, color: colors.textDim, marginBottom: 14 }}>
              {secondaryCurrency.symbol + (data.current_price * secondaryCurrency.rate).toFixed(2)}
            </Text>
          )}
          <Text style={{ fontSize: 13, maxWidth: 320, textAlign: 'center', lineHeight: 20, color: colors.textDim }}>
            {data.partial_data_note || ''}
          </Text>
        </ScrollView>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}>

          {/* .back-link — like HTML: ← ticker */}
          <TouchableOpacity
            onPress={function() { navigation.goBack(); }}
            style={s.backLink}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={[s.backLinkText, { color: colors.textDim }]}>{'← ' + ticker}</Text>
          </TouchableOpacity>

          {/* .stock-title — HTML: [name / ticker+icons] [price+ILS] */}
          <View style={[s.stockTitle, { backgroundColor: colors.bg }]}>
            <View style={{ flex: 1 }}>
              <Text style={[s.stockName, { color: colors.text }]} numberOfLines={2}>
                {data && data.company_name}
              </Text>
              {/* ticker row: ticker + icon buttons inline (matches HTML .stock-title) */}
              <View style={s.tickerRow}>
                <Text style={[s.stockTicker, { color: colors.textDim }]}>{ticker}</Text>
                <TouchableOpacity
                  onPress={function() { toggleWatchlist(ticker, name || (data && data.company_name)); }}
                  style={[s.iconBtn, { backgroundColor: colors.cardAlt, borderColor: inWatchlist ? colors.amber : colors.cardBorder }]}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                  <Text style={{ fontSize: 15, color: inWatchlist ? colors.amber : colors.textDim }}>
                    {inWatchlist ? '★' : '☆'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={function() { openArticle('https://seekingalpha.com/symbol/' + ticker); }}
                  style={[s.iconBtn, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                  <Text style={{ fontSize: 15, color: colors.textDim }}>{'↗'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={function() { navigation.getParent()?.navigate('MoreTab', { screen: 'Root', params: { addJournalTicker: ticker } }); }}
                  style={[s.iconBtn, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                  <Text style={{ fontSize: 15, color: colors.textDim }}>{'📝'}</Text>
                </TouchableOpacity>
              </View>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              {data && data.current_price != null ? (
                <Text style={[s.stockPrice, { color: colors.text }]}>{priceSymbol + data.current_price.toFixed(2)}</Text>
              ) : null}
              {/* .price-ils { font-size:12px; color:text-dim } */}
              {data && data.current_price != null && showSecondaryCcy ? (
                <Text style={[s.stockPriceIls, { color: colors.textDim }]}>
                  {secondaryCurrency.symbol + (data.current_price * secondaryCurrency.rate).toFixed(2)}
                </Text>
              ) : null}
            </View>
          </View>

          {/* Recommendation card */}
          {data && data.final_score != null ? (
            <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
              <View style={s.recRow}>
                <Image source={monkSrc} style={s.monkImg} resizeMode="contain" />
                <ScoreGauge score={data.final_score} colors={colors} />
                <View style={s.decisionInfo}>
                  <Text style={[s.recLabel, { color: colors.textDim }]}>{t.buddhavest_rec || 'Our Conclusion'}</Text>
                  <Text style={[s.recValue, { color: rcColor }]}>{recInfo.label}</Text>
                  <Text style={[s.recExplain, { color: colors.textDimmer }]} numberOfLines={3}>{recInfo.explain}</Text>
                </View>
              </View>
              {divSummary ? (
                <View style={[s.divLine, { borderTopColor: colors.cardBorder }]}>
                  <Text>{m.dividend && m.dividend.pays_dividend ? '🪙' : '🚫'}</Text>
                  <Text style={[s.divText, { color: colors.textDim }]}>{divSummary}</Text>
                </View>
              ) : null}
              {bbSummary ? (
                <View style={[s.divLine, { borderTopColor: colors.cardBorder }]}>
                  <Text>{m.buyback && m.buyback.does_buyback ? '♻️' : '🚫'}</Text>
                  <Text style={[s.divText, { color: colors.textDim }]}>{bbSummary}</Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {/* Overview card */}
          {(ov.market_cap || ov.week52_low != null) ? (
            <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
              <Text style={[s.cardTitle, { color: colors.text }]}>{'🏦 ' + (t.overview || 'Overview')}</Text>
              <View style={s.overviewGrid}>
                {ov.market_cap ? (
                  <View style={[s.overviewTile, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}>
                    <Text style={[s.oLabel, { color: colors.textDim }]}>{t.market_cap || 'Market Cap'}</Text>
                    <Text style={[s.oValue, { color: colors.text }]}>{'$' + formatBigNumber(ov.market_cap)}</Text>
                  </View>
                ) : null}
                {ov.sector ? (
                  <View style={[s.overviewTile,
                    { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder },
                    ov.business_summary ? { width: '100%' } : null,
                  ]}>
                    <Text style={[s.oLabel, { color: colors.textDim }]}>{t.sector_label || 'Sector'}</Text>
                    <Text style={[s.oValue, { color: colors.text }]} numberOfLines={2}>
                      {ov.sector + (ov.industry && ov.industry !== ov.sector ? ' · ' + ov.industry : '')}
                    </Text>
                    {ov.business_summary ? (
                      <View style={{ marginTop: 6 }}>
                        <Text style={[s.bizSummary, { color: colors.textDimmer, textAlign: lang === 'he' ? 'right' : 'left', writingDirection: lang === 'he' ? 'rtl' : 'ltr' }]} numberOfLines={bizExpanded ? undefined : 3}>
                          {ov.business_summary}
                        </Text>
                        {ov.business_summary.length > 200 ? (
                          <TouchableOpacity onPress={function() { setBizExpanded(function(e) { return !e; }); }}>
                            <Text style={{ color: colors.accent, fontSize: 12, marginTop: 4 }}>
                              {bizExpanded ? (t.show_less || 'Show less') : (t.read_more || 'Read more')}
                            </Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                ) : null}
                {ov.volume ? (
                  <View style={[s.overviewTile, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}>
                    <Text style={[s.oLabel, { color: colors.textDim }]}>{t.volume_label || 'Volume'}</Text>
                    <Text style={[s.oValue, { color: colors.text }]}>{formatBigNumber(ov.volume)}</Text>
                  </View>
                ) : null}
                {ov.avg_volume ? (
                  <View style={[s.overviewTile, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}>
                    <Text style={[s.oLabel, { color: colors.textDim }]}>{t.avg_volume_label || 'Avg Volume'}</Text>
                    <Text style={[s.oValue, { color: colors.text }]}>{formatBigNumber(ov.avg_volume)}</Text>
                  </View>
                ) : null}
              </View>

              {ov.week52_low != null && ov.week52_high != null ? (
                <View>
                  <Text style={[s.oLabel, { color: colors.textDim, marginBottom: 6 }]}>{t.week52_label || '52-Week Range'}</Text>
                  <LinearGradient
                    colors={['#f87171', '#fbbf24', '#4ade80']}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={s.rangeTrack}>
                    <View style={[s.rangeMarker, { left: rangePct + '%', backgroundColor: colors.text }]} />
                  </LinearGradient>
                  <View style={s.rangeLabels}>
                    <Text style={[s.rangeLabel, { color: colors.textDimmer }]}>{'$' + ov.week52_low.toFixed(2)}</Text>
                    <Text style={[s.rangeLabel, { color: colors.textDimmer }]}>{'$' + ov.week52_high.toFixed(2)}</Text>
                  </View>
                </View>
              ) : null}
            </View>
          ) : null}

          {/* Valuation card */}
          {(m.pe_ratio && m.pe_ratio.value != null) || (m.peg_ratio && m.peg_ratio.value != null) ? (
            <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
              <Text style={[s.cardTitle, { color: colors.text }]}>{'🏷️ ' + (t.valuation || 'Valuation')}</Text>
              <MetricsGrid metricKeys={['pe_ratio', 'peg_ratio']} metrics={m} colors={colors} navigation={navigation} ticker={ticker} t={t} />
            </View>
          ) : null}

          {/* Profitability card */}
          <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
            <Text style={[s.cardTitle, { color: colors.text }]}>{'📊 ' + (t.profitability || 'Profitability & Margins')}</Text>
            <MetricsGrid metricKeys={['gross_margin','operating_margin','net_margin','cost_of_revenue','moat']} metrics={m} colors={colors} navigation={navigation} ticker={ticker} t={t} />
          </View>

          {/* Balance card */}
          <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
            <Text style={[s.cardTitle, { color: colors.text }]}>{'🏦 ' + (t.balanceSheet || 'Balance Sheet & Cash Flow')}</Text>
            <MetricsGrid
              metricKeys={[
                'current_ratio','debt_to_equity','liabilities_to_equity',
                'cash_position','operating_cash_flow','free_cash_flow',
                ...(m.cash_runway && m.cash_runway.value != null ? ['cash_runway'] : []),
                'dividend','buyback',
              ]}
              metrics={m} colors={colors} navigation={navigation} ticker={ticker} t={t} />
          </View>

          {/* Price chart card */}
          <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
            <Text style={[s.cardTitle, { color: colors.text }]}>{'📈 ' + (t.priceHistory || 'Price - Last 12 Months')}</Text>
            {history && history.prices && history.prices.length > 1 ? (
              <View style={s.chartWrap}>
                <PriceChart
                  data={{ prices: history.prices, dates: history.dates || [] }}
                  colors={colors}
                  height={160}
                />
              </View>
            ) : (
              <Text style={[s.noChartData, { color: colors.textDimmer }]}>
                {t.noChartData || 'Not enough historical data to display a chart.'}
              </Text>
            )}
          </View>

          {/* Score breakdown card */}
          <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
            <Text style={[s.cardTitle, { color: colors.text }]}>{'📋 ' + (t.scoreBreakdown || 'Score Breakdown')}</Text>
            <BreakdownRow label={t.businessQuality || 'Business Quality'} score={cs.quality} colors={colors} />
            <BreakdownRow label={t.valuationScore || 'Valuation'} score={cs.valuation} colors={colors} />
            {(function() {
              const inc = incomeLabelFor();
              return <BreakdownRow label={inc.label} score={cs.income} sub={inc.sub} colors={colors} />;
            })()}
          </View>

          {/* Signals card */}
          <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
            <Text style={[s.cardTitle, { color: colors.text }]}>{'📡 ' + (t.signals || 'Things to Watch')}</Text>
            <Text style={[s.cardDesc, { color: colors.textDimmer }]}>
              {t.signals_desc || 'Automatic keyword scan of recent headlines. Not a financial indicator, not part of the score.'}
            </Text>
            {signals == null ? (
              <View style={s.loadRow}>
                <ActivityIndicator color={colors.accent} size="small" />
                <Text style={[s.loadText, { color: colors.textDim }]}>{t.scanningNews || 'Scanning articles...'}</Text>
              </View>
            ) : signals.length === 0 ? (
              <Text style={[s.noData, { color: colors.textDimmer }]}>
                {t.no_signals || 'No headlines requiring special attention found in recent news.'}
              </Text>
            ) : signals.map(function(item, i) { return <SignalItem key={i} item={item} colors={colors} t={t} lang={lang} navigation={navigation} />; })}
          </View>

          {/* Munger checklist card */}
          <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
            <Text style={[s.cardTitle, { color: colors.text }]}>{'🧠 ' + (t.munger_title || 'A reminder before you decide')}</Text>
            <Text style={[s.cardDesc, { color: colors.textDimmer }]}>
              {t.munger_desc || "A few questions worth asking yourself, inspired by Charlie Munger's approach."}
            </Text>
            {[
              { icon: '🧭', q: t.munger_circle_q    || 'Do I actually understand this business?',              d: t.munger_circle_d    || "If it's hard to explain in one sentence how the company makes money, it might be outside your circle of competence." },
              { icon: '🎯', q: t.munger_focus_q     || 'How many companies am I actually tracking in depth?',  d: t.munger_focus_d     || 'A concentrated portfolio of a few companies you know well usually beats wide diversification.' },
              { icon: '⏳', q: t.munger_patience_q  || 'Am I expecting a quick win, or letting time do the work?', d: t.munger_patience_d || 'Real business growth takes years, not months.' },
              { icon: '😐', q: t.munger_temperament_q || 'Am I reacting to market noise, or to facts about the business?', d: t.munger_temperament_d || 'Sharp drops tempt panic and sharp rallies tempt FOMO.' },
            ].map(function(item, i) {
              return (
                <View key={i} style={s.mungerItem}>
                  <Text style={[s.mungerIcon, { color: colors.accent }]}>{item.icon}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.mungerQ, { color: colors.text }]}>{item.q}</Text>
                    <Text style={[s.mungerD, { color: colors.textDim }]}>{item.d}</Text>
                  </View>
                </View>
              );
            })}
          </View>

          {/* Valuation Extra card */}
          {(ve.forward_pe || ve.price_to_book || ve.price_to_sales || ve.ev_to_ebitda) ? (
            <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
              <Text style={[s.cardTitle, { color: colors.text }]}>{'🧮 ' + (t.valuation_section || 'Additional Valuation Multiples')}</Text>
              <View style={s.metricsGrid}>
                {ve.forward_pe ? (
                  <ValTile label={t.metric_names?.forward_pe || 'Forward P/E'} value={String(ve.forward_pe)}
                    note={t.forward_pe_note || 'P/E multiple based on future projections'}
                    valColor={ve.trailing_pe && ve.forward_pe < ve.trailing_pe ? colors.green : colors.text}
                    colors={colors}
                    onPress={function() { navigation.navigate('MetricHistory', { ticker: ticker, metricKey: 'forward_pe', label: t.metric_names?.forward_pe || 'Forward P/E', tileNote: t.forward_pe_note || 'P/E multiple based on future projections', tileScore: null, tileValue: ve.forward_pe ?? null }); }} />
                ) : null}
                {ve.price_to_book ? (
                  <ValTile label={t.metric_names?.price_to_book || 'P/B'} value={String(ve.price_to_book)}
                    note={t.pb_note || 'Price relative to net asset value'}
                    valColor={ve.price_to_book < 1 ? colors.green : ve.price_to_book > 5 ? colors.red : colors.text}
                    colors={colors}
                    onPress={function() { navigation.navigate('MetricHistory', { ticker: ticker, metricKey: 'price_to_book', label: t.metric_names?.price_to_book || 'P/B', tileNote: t.pb_note || 'Price relative to net asset value', tileScore: null, tileValue: ve.price_to_book ?? null }); }} />
                ) : null}
                {ve.price_to_sales ? (
                  <ValTile label={t.metric_names?.price_to_sales || 'P/S'} value={String(ve.price_to_sales)}
                    note={t.ps_note || 'Price relative to revenue'}
                    colors={colors}
                    onPress={function() { navigation.navigate('MetricHistory', { ticker: ticker, metricKey: 'price_to_sales', label: t.metric_names?.price_to_sales || 'P/S', tileNote: t.ps_note || 'Price relative to revenue', tileScore: null, tileValue: ve.price_to_sales ?? null }); }} />
                ) : null}
                {ve.ev_to_ebitda ? (
                  <ValTile label={t.metric_names?.ev_to_ebitda || 'EV/EBITDA'} value={String(ve.ev_to_ebitda)}
                    note={t.ev_ebitda_note || 'Enterprise multiple'}
                    valColor={ve.ev_to_ebitda < 10 ? colors.green : ve.ev_to_ebitda > 25 ? colors.red : colors.text}
                    colors={colors}
                    onPress={function() { navigation.navigate('MetricHistory', { ticker: ticker, metricKey: 'ev_to_ebitda', label: t.metric_names?.ev_to_ebitda || 'EV/EBITDA', tileNote: t.ev_ebitda_note || 'Enterprise multiple', tileScore: null, tileValue: ve.ev_to_ebitda ?? null }); }} />
                ) : null}
              </View>
              <Text style={[s.noteSmall, { color: colors.textDimmer }]}>
                {t.valuation_extra_note || 'These metrics are not included in the overall score — additional info for comparison'}
              </Text>
            </View>
          ) : null}

          {/* ETF card */}
          <ETFCard ticker={ticker} colors={colors} t={t} navigation={navigation} />

          {/* Events card */}
          <EventsCard ticker={ticker} colors={colors} t={t} />

          {/* Financials card */}
          <FinancialsCard ticker={ticker} colors={colors} t={t} lang={lang} />

          {/* Recent news card */}
          <NewsCard ticker={ticker} colors={colors} t={t} lang={lang} navigation={navigation} />

          {/* source-note */}
          <Text style={[s.sourceNote, { color: colors.textDimmer }]}>
            {t.source_annual || 'Data source: Yahoo Finance (yfinance) - latest annual figures'}
          </Text>
        </ScrollView>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1 },

  // Nav bar (.back-link + icon-btns)
  backLink:   { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  backLinkText: { fontSize: 13 },
  // .back-link { color:text-dim; font-size:13px }
  tickerRow:  { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  // .icon-btn { width:28px; height:28px; border-radius:8px; background:card-alt; border:0.5px }
  iconBtn:    { width: 28, height: 28, borderRadius: 8, borderWidth: 0.5, alignItems: 'center', justifyContent: 'center' },

  // .card { background:card; border:0.5px solid card-border; border-radius:14px; padding:16px; margin-bottom:14px }
  card:      { borderWidth: 0.5, borderRadius: 14, padding: 16, marginHorizontal: 12, marginBottom: 14 },
  // .card h3 { font-size:13px; font-weight:600; margin:0 0 10px }
  cardTitle: { fontSize: 13, fontWeight: '600', marginBottom: 10 },
  cardDesc:  { fontSize: 12, marginBottom: 10, lineHeight: 18 },

  // .stock-title { margin-bottom: 14px }
  stockTitle:    { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 6, paddingBottom: 0, marginBottom: 14 },
  // .name { font-weight:600; font-size:17px }
  stockName:     { fontSize: 17, fontWeight: '600', marginBottom: 2 },
  // .ticker { font-size:13px; color:text-dim }
  stockTicker:   { fontSize: 13 },
  // .price { font-size:17px; font-weight:600 }
  stockPrice:    { fontSize: 17, fontWeight: '600' },
  // .price-ils { font-size:12px; color:text-dim }
  stockPriceIls: { fontSize: 12, marginTop: 2 },

  // rec card row
  recRow:      { flexDirection: 'row', alignItems: 'flex-end', gap: 12, marginBottom: 10 },
  // .buddhavest-character { width:46px; height:auto; align-self:flex-end; margin-bottom:-8px }
  // RN needs explicit height — monk images are ~357x434 ratio ≈ 0.82, so h = 46/0.82 ≈ 56
  monkImg:     { width: 46, height: 56, alignSelf: 'flex-end', marginBottom: -8 },
  decisionInfo: { flex: 1 },
  recLabel:    { fontSize: 12, marginBottom: 4 },   // HTML: margin:0 0 4px
  recValue:    { fontSize: 18, fontWeight: '600', marginBottom: 6 },  // HTML: margin:0 0 6px
  recExplain:  { fontSize: 12, lineHeight: 16 },

  // dividend/buyback lines
  divLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 12, borderTopWidth: 0.5 },
  divText: { flex: 1, fontSize: 12, lineHeight: 17 },

  // overview grid — HTML: grid-template-columns: repeat(2, minmax(0,1fr)) gap:10px
  overviewGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 12 },
  // .overview-tile { background:card-alt; border:0.5px; border-radius:10px; padding:10px 12px }
  overviewTile: { width: '48%', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, borderWidth: 0.5, marginBottom: 10 },
  // .o-label { font-size:11px }
  oLabel: { fontSize: 11, marginBottom: 2 },
  // .o-value { font-size:15px; font-weight:600 }
  oValue: { fontSize: 15, fontWeight: '600' },
  bizSummary: { fontSize: 11, lineHeight: 17 },

  // range bar
  rangeTrack:  { height: 6, borderRadius: 3, overflow: 'hidden', marginBottom: 4 },
  rangeMarker: { position: 'absolute', top: -3, width: 2, height: 12, backgroundColor: '#f5f5f5' },
  rangeLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  rangeLabel:  { fontSize: 11 },

  // metrics grid (2 col, space-between, row margin on tiles)
  metricsGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },

  // valuation extra tiles
  metricTileBase: { width: '48%', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, borderWidth: 0.5, minHeight: 76, marginBottom: 10 },
  mLabel: { fontSize: 12, marginBottom: 4 },
  mValue: { fontSize: 17, fontWeight: '600' },
  mNote:  { fontSize: 11, marginTop: 4, lineHeight: 15 },

  // .chart-wrap { height:160px }
  chartWrap:   { height: 160, marginVertical: 4 },
  noChartData: { fontSize: 13, textAlign: 'center', padding: 16 },

  // score breakdown
  breakRow:  { marginBottom: 8 },
  breakTop:  { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 },
  breakLabel: { fontSize: 12, fontWeight: '500' },
  breakVal:  { fontSize: 12, fontWeight: '600' },
  breakSub:  { fontSize: 11, marginBottom: 4, lineHeight: 15 },
  barBg:     { height: 6, borderRadius: 4, overflow: 'hidden' },
  barFg:     { height: 6, borderRadius: 4 },

  // .news-card { background:card-alt; border:0.5px solid card-border; border-radius:10px; padding:12px; margin-bottom:8px }
  newsCard: { borderRadius: 10, borderWidth: 0.5, padding: 12, marginBottom: 8 },
  // .n-title { font-size:13px; font-weight:500 }
  nTitle:   { fontSize: 13, fontWeight: '500', lineHeight: 19, marginBottom: 4 },
  // .n-meta { font-size:11px; color:text-dimmer }
  nMeta:    { fontSize: 11 },
  tagsRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 4 },
  tag:      { borderRadius: 10, borderWidth: 0.5, paddingVertical: 2, paddingHorizontal: 8 },
  tagText:  { fontSize: 11 },

  // munger
  mungerItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 8 },
  mungerIcon: { fontSize: 20, width: 28, textAlign: 'center', marginTop: 1 },
  mungerQ:    { fontSize: 13, fontWeight: '600', marginBottom: 3, lineHeight: 18 },
  mungerD:    { fontSize: 12, lineHeight: 17 },

  sourceNote: { fontSize: 11, textAlign: 'center', marginTop: 16, marginBottom: 8, paddingHorizontal: 16 },
});

import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { ENDPOINTS } from '../constants/api';

export default function ETFCard({ ticker, colors, t, navigation }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadETF(); }, [ticker]);

  async function loadETF() {
    setLoading(true);
    try {
      const res = await fetch(ENDPOINTS.etfInfo(ticker));
      const json = await res.json();
      setData(json);
    } catch (e) {}
    setLoading(false);
  }

  function fmtPct(v) {
    if (v == null) return '—';
    return `${(v * 100).toFixed(2)}%`;
  }
  function fmtAssets(v) {
    if (v == null) return '—';
    if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
    if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
    return `$${(v / 1e6).toFixed(0)}M`;
  }

  if (loading) return null;
  // HTML: if (!data.is_etf) return; — only show for actual ETFs
  if (!data || !data.is_etf) return null;

  // HTML: expense ratio color coded — green < 0.2%, amber < 0.5%, red >= 0.5%
  function expenseColor(ratio) {
    if (ratio == null) return colors.text;
    if (ratio < 0.002) return colors.green;
    if (ratio < 0.005) return colors.amber;
    return colors.red;
  }

  const tiles = [
    { label: t.etfFamily, value: data.fund_family, small: true },
    { label: t.etfCategory, value: data.category, small: true },
    { label: t.etfAssets, value: fmtAssets(data.total_assets), pressable: true },
    { label: t.etfExpense, value: data.expense_ratio != null ? `${(data.expense_ratio * 100).toFixed(2)}%` : '—', color: expenseColor(data.expense_ratio) },
    { label: t.etfYield, value: fmtPct(data.yield) },
    { label: t.etfYtd, value: fmtPct(data.ytd_return), color: data.ytd_return >= 0 ? colors.green : colors.red, pressable: true },
    { label: t.etf1y, value: fmtPct(data.one_year_return), color: data.one_year_return >= 0 ? colors.green : colors.red },
    { label: t.etf3y, value: fmtPct(data.three_year_return), color: data.three_year_return >= 0 ? colors.green : colors.red },
    { label: t.etf5y, value: fmtPct(data.five_year_return), color: data.five_year_return >= 0 ? colors.green : colors.red },
    { label: t.etfBeta, value: data.beta?.toFixed(2) },
  ].filter(tile => tile.value && tile.value !== '—');

  return (
    <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
      <Text style={[s.title, { color: colors.text }]}>🏦 {t.etfTitle}</Text>
      <View style={s.grid}>
        {tiles.map((tile, i) => (
          <TouchableOpacity
            key={i}
            style={[s.tile, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}
            onPress={tile.pressable ? () => navigation.navigate('MetricHistory', { ticker, metricKey: 'price', label: tile.label }) : undefined}
            activeOpacity={tile.pressable ? 0.7 : 1}>
            <Text style={[s.tileLabel, { color: colors.textDimmer }]}>{tile.label}</Text>
            <Text style={[s.tileValue, tile.small && s.tileValueSmall, { color: tile.color || colors.text }]}>{tile.value}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Holdings */}
      {data.top_holdings?.length > 0 && (
        <>
          <Text style={[s.holdingsTitle, { color: colors.textDim }]}>{t.holdings}</Text>
          {data.top_holdings.map((h, i) => (
            <View key={i} style={[s.holdingRow, { borderBottomColor: colors.cardBorder }]}>
              <Text style={[s.holdingName, { color: colors.text }]}>{h.name || h.symbol}</Text>
              <Text style={[s.holdingPct, { color: colors.accent }]}>{(h.pct || 0).toFixed(2)}%</Text>
            </View>
          ))}
        </>
      )}

      <Text style={[s.etfNote, { color: colors.amber }]}>
        ⚠️ {t.etfNoFinancials}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  card: { marginHorizontal: 12, marginBottom: 14, borderRadius: 14, padding: 16, borderWidth: 0.5 },
  title: { fontSize: 13, fontWeight: '600', marginBottom: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  tile: { width: '49%', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, borderWidth: 0.5, minHeight: 76 },
  tileLabel: { fontSize: 12, marginBottom: 4 },
  tileValueSmall: { fontSize: 14 },
  holdingsTitle: { fontSize: 13, fontWeight: '700', textAlign: 'right', marginBottom: 8, marginTop: 4 },
  holdingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 0.5 },
  holdingName: { fontSize: 13, flex: 1 },
  holdingPct: { fontSize: 13, fontWeight: '600' },
  etfNote: { fontSize: 12, textAlign: 'right', marginTop: 12, lineHeight: 18 },
});

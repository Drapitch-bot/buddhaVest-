import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { ENDPOINTS } from '../constants/api';

const IMPORTANT_ROWS = new Set([
  "Total Revenue","Operating Revenue","Gross Profit","Operating Income",
  "EBIT","EBITDA","Net Income","Net Income Common Stockholders",
  "Diluted EPS","Basic EPS","Research And Development",
  "Selling General And Administration","Total Expenses",
  "Total Assets","Current Assets","Current Liabilities",
  "Total Debt","Long Term Debt","Stockholders Equity","Common Stock Equity",
  "Cash And Cash Equivalents","Cash Cash Equivalents And Short Term Investments",
  "Total Liabilities Net Minority Interest","Working Capital",
  "Operating Cash Flow","Free Cash Flow","Capital Expenditure",
  "Net Income From Continuing Operations","Net Income Continuous Operations",
]);

// "2024-12-31" → "Dec'24", "2024-09-30" → "Sep'24"
// Annual: "2024-12-31" → "2024" (just the year)
function fmtColDate(col, period) {
  if (!col) return '';
  const s = String(col).trim();
  const m = s.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (m) {
    if (period === 'annual') return m[1]; // just the year
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[parseInt(m[2]) - 1] + "'" + m[1].slice(2);
  }
  return s;
}

export default function FinancialsCard({ ticker, colors, t }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState('income');
  const [period, setPeriod] = useState('quarterly');

  useEffect(() => { loadFinancials(); }, [ticker]);

  async function loadFinancials() {
    setLoading(true);
    try {
      const res = await fetch(ENDPOINTS.financials(ticker));
      const json = await res.json();
      setData(json);
    } catch (e) {}
    setLoading(false);
  }

  function fmtVal(v) {
    if (v === null || v === undefined) return '—';
    const n = Number(v);
    if (isNaN(n)) return String(v);
    const abs = Math.abs(n);
    const neg = n < 0;
    let str;
    if (abs >= 1e12) str = (abs / 1e12).toFixed(2) + 'T';
    else if (abs >= 1e9)  str = (abs / 1e9).toFixed(2) + 'B';
    else if (abs >= 1e6)  str = (abs / 1e6).toFixed(2) + 'M';
    else if (abs >= 1e3)  str = (abs / 1e3).toFixed(1) + 'K';
    else str = abs.toFixed(2);
    return neg ? '-' + str : str;
  }

  const sheetTabs = [
    { key: 'income',   label: t.quarterly_income   || 'Income' },
    { key: 'balance',  label: t.quarterly_balance   || 'Balance' },
    { key: 'cashflow', label: t.quarterly_cashflow  || 'Cash Flow' },
  ];

  const periodTabs = [
    { key: 'quarterly', label: t.quarterly || 'Quarterly' },
    { key: 'annual',    label: t.annual    || 'Annual' },
  ];

  const tableKey = sheet + '_' + period;
  const rawTable = data?.[tableKey] || { columns: [], rows: [] };
  const table = {
    columns: rawTable.columns || [],
    rows: (rawTable.rows || []).filter(r => IMPORTANT_ROWS.has(r.label)),
  };

  return (
    <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
      <Text style={[s.title, { color: colors.text }]}>{'📑 ' + (t.financials_title || 'Financial Reports')}</Text>

      {/* Sheet tabs */}
      <View style={s.tabs}>
        {sheetTabs.map(tb => (
          <TouchableOpacity key={tb.key}
            style={[s.tab, { backgroundColor: sheet === tb.key ? colors.purpleBg : colors.cardAlt, borderColor: colors.cardBorder }]}
            onPress={() => setSheet(tb.key)}>
            <Text style={[s.tabText, { color: sheet === tb.key ? colors.purple : colors.textDim }]}>{tb.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Period toggle */}
      <View style={[s.tabs, { marginBottom: 14 }]}>
        {periodTabs.map(pt => (
          <TouchableOpacity key={pt.key}
            style={[s.tab, { backgroundColor: period === pt.key ? colors.purpleBg : colors.cardAlt, borderColor: colors.cardBorder }]}
            onPress={() => setPeriod(pt.key)}>
            <Text style={[s.tabText, { color: period === pt.key ? colors.purple : colors.textDim }]}>{pt.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ margin: 16 }} />
      ) : !table.columns.length || !table.rows.length ? (
        <Text style={[s.empty, { color: colors.textDimmer }]}>{t.noData || 'No data available.'}</Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={true}>
          <View>
            {/* Header row */}
            <View style={[s.row, { borderBottomWidth: 0.5, borderBottomColor: colors.cardBorder }]}>
              <View style={s.labelCell} />
              {table.columns.map((col, i) => (
                <Text key={i} style={[s.colHeader, { color: colors.textDim }]}>
                  {fmtColDate(col, period)}
                </Text>
              ))}
            </View>
            {/* Data rows */}
            {table.rows.map((row, ri) => (
              <View key={ri} style={[s.row, { backgroundColor: ri % 2 === 0 ? 'transparent' : colors.cardAlt + '66' }]}>
                <Text style={[s.rowLabel, { color: colors.textDim }]} numberOfLines={1} ellipsizeMode="tail">
                  {row.label}
                </Text>
                {(row.values || []).map((v, vi) => (
                  <Text key={vi} style={[s.cell, { color: Number(v) < 0 ? colors.red : colors.text }]}>
                    {fmtVal(v)}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card:      { marginHorizontal: 12, marginBottom: 14, borderRadius: 14, padding: 16, borderWidth: 0.5 },
  title:     { fontSize: 13, fontWeight: '600', marginBottom: 10 },
  tabs:      { flexDirection: 'row', gap: 6, marginBottom: 8 },
  tab:       { flex: 1, paddingVertical: 7, borderRadius: 10, alignItems: 'center', borderWidth: 0.5 },
  tabText:   { fontSize: 12, fontWeight: '600' },
  row:       { flexDirection: 'row', alignItems: 'center', paddingVertical: 7 },
  labelCell: { width: 152 },
  rowLabel:  { width: 152, fontSize: 11, paddingRight: 8 },
  colHeader: { width: 80, fontSize: 11, textAlign: 'right', fontWeight: '700', paddingHorizontal: 4 },
  cell:      { width: 80, fontSize: 11, textAlign: 'right', paddingHorizontal: 4 },
  empty:     { textAlign: 'center', padding: 16, fontSize: 13 },
});

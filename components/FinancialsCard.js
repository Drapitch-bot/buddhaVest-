import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity, Modal } from 'react-native';
import { ENDPOINTS } from '../constants/api';

// Row label → explanation key in t.fin_explanations (see i18n.js).
// Every IMPORTANT row has an entry, so every visible row is tappable.
const FIN_KEYS = {
  "Total Revenue": 'total_revenue',
  "Operating Revenue": 'operating_revenue',
  "Gross Profit": 'gross_profit',
  "Operating Income": 'operating_income',
  "EBIT": 'ebit',
  "EBITDA": 'ebitda',
  "Net Income": 'net_income',
  "Net Income Common Stockholders": 'net_income_common',
  "Diluted EPS": 'diluted_eps',
  "Basic EPS": 'basic_eps',
  "Research And Development": 'rnd',
  "Selling General And Administration": 'sga',
  "Total Expenses": 'total_expenses',
  "Total Assets": 'total_assets',
  "Current Assets": 'current_assets',
  "Current Liabilities": 'current_liabilities',
  "Total Debt": 'total_debt',
  "Long Term Debt": 'long_term_debt',
  "Stockholders Equity": 'stockholders_equity',
  "Common Stock Equity": 'common_stock_equity',
  "Cash And Cash Equivalents": 'cash_equivalents',
  "Cash Cash Equivalents And Short Term Investments": 'cash_and_sti',
  "Total Liabilities Net Minority Interest": 'total_liabilities',
  "Working Capital": 'working_capital',
  "Operating Cash Flow": 'operating_cash_flow',
  "Free Cash Flow": 'free_cash_flow',
  "Capital Expenditure": 'capex',
  "Net Income From Continuing Operations": 'ni_continuing',
  "Net Income Continuous Operations": 'ni_continuing',
};

const IMPORTANT_ROWS = new Set(Object.keys(FIN_KEYS));

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

export default function FinancialsCard({ ticker, colors, t, lang = 'en' }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState('income');
  const [period, setPeriod] = useState('quarterly');
  const [selRow, setSelRow] = useState(null); // { label, key } | null
  const isRtl = lang === 'he';

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
            {/* Data rows — tappable: opens a plain-language explanation */}
            {table.rows.map((row, ri) => (
              <TouchableOpacity
                key={ri}
                activeOpacity={0.6}
                onPress={() => setSelRow({ label: row.label, key: FIN_KEYS[row.label] })}
                style={[s.row, { backgroundColor: ri % 2 === 0 ? 'transparent' : colors.cardAlt + '66' }]}>
                <View style={[s.labelWrap]}>
                  <Text style={[s.rowLabel, { color: colors.textDim }]} numberOfLines={1} ellipsizeMode="tail">
                    {row.label}
                  </Text>
                  <Text style={[s.infoMark, { color: colors.textDimmer || colors.textDim }]}>ⓘ</Text>
                </View>
                {(row.values || []).map((v, vi) => (
                  <Text key={vi} style={[s.cell, { color: Number(v) < 0 ? colors.red : colors.text }]}>
                    {fmtVal(v)}
                  </Text>
                ))}
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      )}

      {/* ── Explanation modal: tap a row → what this line means + its history ── */}
      <Modal
        visible={!!selRow}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setSelRow(null)}>
        <TouchableOpacity
          style={s.modalOverlay}
          activeOpacity={1}
          onPress={() => setSelRow(null)}>
          <TouchableOpacity
            activeOpacity={1}
            style={[s.modalCard, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}
            onPress={() => {}}>
            {selRow && (
              <>
                <Text style={[s.modalTitle, { color: colors.text, textAlign: isRtl ? 'right' : 'left' }]}>
                  {selRow.label}
                </Text>
                <ScrollView style={{ flexGrow: 0 }}>
                <Text style={[s.modalBody, {
                  color: colors.textDim,
                  textAlign: isRtl ? 'right' : 'left',
                  writingDirection: isRtl ? 'rtl' : 'ltr',
                }]}>
                  {(t.fin_explanations && t.fin_explanations[selRow.key]) || ''}
                </Text>

                {/* History of this row: annual + quarterly, whatever exists */}
                {['annual', 'quarterly'].map(function(p) {
                  const tbl = data?.[sheet + '_' + p];
                  const r = (tbl?.rows || []).find(function(x) { return x.label === selRow.label; });
                  if (!r || !(tbl.columns || []).length) return null;
                  return (
                    <View key={p} style={{ marginTop: 10 }}>
                      <Text style={[s.modalSection, { color: colors.text, textAlign: isRtl ? 'right' : 'left' }]}>
                        {p === 'annual' ? (t.annual || 'Annual') : (t.quarterly || 'Quarterly')}
                      </Text>
                      {tbl.columns.map(function(col, i) {
                        const v = (r.values || [])[i];
                        if (v === null || v === undefined) return null;
                        return (
                          <View key={i} style={[s.modalRow, { borderBottomColor: colors.cardBorder }]}>
                            <Text style={[s.modalDate, { color: colors.textDimmer || colors.textDim }]}>
                              {fmtColDate(col, p)}
                            </Text>
                            <Text style={[s.modalVal, { color: Number(v) < 0 ? colors.red : colors.text }]}>
                              {fmtVal(v)}
                            </Text>
                          </View>
                        );
                      })}
                    </View>
                  );
                })}
                </ScrollView>

                <TouchableOpacity
                  onPress={() => setSelRow(null)}
                  style={[s.modalClose, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}>
                  <Text style={{ color: colors.accent || colors.text, fontSize: 13, fontWeight: '600' }}>
                    {t.back || 'Close'}
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
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
  labelWrap: { width: 152, flexDirection: 'row', alignItems: 'center', paddingRight: 8 },
  rowLabel:  { flexShrink: 1, fontSize: 11 },
  infoMark:  { fontSize: 9, marginLeft: 4 },
  colHeader: { width: 80, fontSize: 11, textAlign: 'right', fontWeight: '700', paddingHorizontal: 4 },
  cell:      { width: 80, fontSize: 11, textAlign: 'right', paddingHorizontal: 4 },
  empty:     { textAlign: 'center', padding: 16, fontSize: 13 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 24 },
  modalCard:    { borderRadius: 14, borderWidth: 0.5, padding: 18, maxHeight: '80%' },
  modalTitle:   { fontSize: 15, fontWeight: '700', marginBottom: 8 },
  modalBody:    { fontSize: 13, lineHeight: 20 },
  modalSection: { fontSize: 12, fontWeight: '700', marginBottom: 4 },
  modalRow:     { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 0.5 },
  modalDate:    { fontSize: 12 },
  modalVal:     { fontSize: 12, fontWeight: '600' },
  modalClose:   { marginTop: 14, borderRadius: 10, borderWidth: 0.5, paddingVertical: 10, alignItems: 'center' },
});

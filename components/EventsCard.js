import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { ENDPOINTS } from '../constants/api';

const typeIcon  = { earnings: '📋', dividend: '💰', past_earnings: '📊', calendar: '📅' };
const typeColor = { earnings: '#a78bfa', dividend: '#34d399', past_earnings: '#60a5fa', calendar: '#fbbf24' };

export default function EventsCard({ ticker, colors, t }) {
  const [events,  setEvents]  = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadEvents(); }, [ticker]);

  async function loadEvents() {
    setLoading(true);
    try {
      const res  = await fetch(ENDPOINTS.events(ticker));
      const data = await res.json();
      setEvents(data.events || []);
    } catch { setEvents([]); }
    setLoading(false);
  }

  function parsePastDetail(detail, date) {
    if (!detail) return '';
    const revMatch = detail.match(/Rev:\s*(\S+)/);
    const niMatch  = detail.match(/NI:\s*(\S+)/);
    const epsMatch = detail.match(/EPS:\s*(\S+)/);
    const gmMatch  = detail.match(/GM:\s*(\S+)/);
    let period = '';
    if (date) {
      const d = new Date(date);
      const q = Math.floor(d.getMonth() / 3) + 1;
      period = `Q${q} ${d.getFullYear()}`;
    }
    const parts = [];
    if (revMatch) parts.push(`${t.events_revenue || 'Revenue'}: ${revMatch[1]}`);
    if (niMatch)  parts.push(`${t.events_net_income || 'Net Income'}: ${niMatch[1]}`);
    if (epsMatch) parts.push(`EPS: ${epsMatch[1]}`);
    if (gmMatch)  parts.push(`${t.events_gross_margin || 'Gross Margin'}: ${gmMatch[1]}`);
    return (period ? `${period}` : '') + (parts.length ? ' · ' + parts.join(' · ') : '');
  }

  const now      = new Date().toISOString().slice(0, 10);
  const upcoming = (events || []).filter(e => e.date >= now).sort((a, b) => a.date.localeCompare(b.date));
  const past     = (events || []).filter(e => e.date <  now).sort((a, b) => b.date.localeCompare(a.date));

  function getTypeLabel(type) {
    if (type === 'earnings')      return t.events_earnings  || 'Next Earnings Report';
    if (type === 'dividend')      return t.events_dividend  || 'Ex-Dividend Date';
    if (type === 'past_earnings') return t.events_past_q    || 'Quarterly Report';
    return t.events_calendar || 'Event';
  }

  return (
    <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
      <Text style={[s.title, { color: colors.text }]}>
        {t.events_title || '📅 Events Calendar'}
      </Text>
      <Text style={[s.desc, { color: colors.textDimmer }]}>
        {t.events_desc || "What's shown here: next earnings date, dividend dates, and last 4 quarterly reports."}
      </Text>

      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ margin: 16 }} />
      ) : !events || events.length === 0 ? (
        <Text style={[s.empty, { color: colors.textDimmer }]}>
          {t.events_no_data || t.noEvents || 'No events available'}
        </Text>
      ) : (
        <>
          {upcoming.length > 0 && (
            <>
              <Text style={[s.sectionLabel, { color: colors.accent }]}>
                {t.events_upcoming || 'Upcoming'}
              </Text>
              {upcoming.map((e, i) => (
                <View key={i} style={[s.eventRow, { borderBottomColor: colors.cardBorder }]}>
                  <Text style={[s.eventIcon, { color: typeColor[e.type] || colors.textDimmer }]}>
                    {typeIcon[e.type] || '📅'}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.eventTitle, { color: colors.text }]}>
                      {getTypeLabel(e.type) || e.label}
                    </Text>
                    <Text style={[s.eventDetail, { color: colors.textDimmer }]}>
                      {e.date}{e.detail ? ' · ' + e.detail : ''}
                    </Text>
                  </View>
                </View>
              ))}
            </>
          )}

          {past.length > 0 && (
            <>
              <Text style={[s.sectionLabel, { color: colors.textDim, marginTop: 10 }]}>
                {t.events_past || 'Recent Reports'}
              </Text>
              {past.slice(0, 4).map((e, i) => (
                <View key={i} style={[s.eventRow, { borderBottomColor: colors.cardBorder }]}>
                  <Text style={[s.eventIcon, { color: typeColor[e.type] || colors.textDimmer }]}>
                    {typeIcon[e.type] || '📅'}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.eventTitle, { color: colors.text }]}>
                      {getTypeLabel(e.type) || e.label}
                    </Text>
                    <Text style={[s.eventDetail, { color: colors.textDimmer }]}>
                      {e.type === 'past_earnings'
                        ? parsePastDetail(e.detail, e.date)
                        : `${e.date}${e.detail ? ' · ' + e.detail : ''}`}
                    </Text>
                  </View>
                </View>
              ))}
            </>
          )}
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card:         { marginHorizontal: 12, marginBottom: 14, borderRadius: 14, padding: 16, borderWidth: 0.5 },
  title:        { fontSize: 13, fontWeight: '600', marginBottom: 6 },
  desc:         { fontSize: 11, marginBottom: 12, lineHeight: 16 },
  sectionLabel: { fontSize: 11, fontWeight: '700', marginBottom: 4 },
  eventRow:     { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: 0.5, gap: 10 },
  eventIcon:    { fontSize: 16, marginTop: 1 },
  eventTitle:   { fontSize: 13, fontWeight: '500' },
  eventDetail:  { fontSize: 11, marginTop: 2, lineHeight: 16, writingDirection: 'ltr', textAlign: 'left' },
  empty:        { textAlign: 'center', padding: 16, fontSize: 13 },
});

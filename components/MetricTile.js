import React from 'react';
import { Text, TouchableOpacity, StyleSheet } from 'react-native';

// score >= 70 → green, >= 40 → amber, else → red.
// No score means NO VERDICT, so it must read neutral — amber would announce a
// warning about a metric we simply could not evaluate.
function scoreColor(score, colors) {
  if (score == null) return colors.text;
  if (score >= 70) return colors.green;
  if (score >= 40) return colors.amber;
  return colors.red;
}

// `rtl` drives text direction for the note, which is a translated sentence.
// `sub` is the same figure in the reader's own currency — the small grey line
// under the number, exactly as the share price already does it.
export default function MetricTile({ label, value, sub, note, score, colors, onPress, rtl }) {
  const dir = { textAlign: rtl ? 'right' : 'left', writingDirection: rtl ? 'rtl' : 'ltr' };
  const signal = scoreColor(score, colors);
  return (
    <TouchableOpacity
      style={[s.tile, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}
      onPress={onPress}
      activeOpacity={0.7}>
      {/* .m-label { font-size:12px; color:var(--text-dim) } */}
      <Text style={[s.label, { color: colors.textDim }, dir]} numberOfLines={1}>{label}</Text>
      {/* .m-value { font-size:17px; font-weight:600 }
          The NUMBER and the NOTE carry the SAME colour. The note was coloured by
          score while the number stayed neutral, so a red warning sentence sat
          under a plain black figure — two different signals about one metric.
          A missing score leaves both neutral: no verdict, no colour. */}
      <Text style={[s.value, { color: signal }, dir]} numberOfLines={1}>{value ?? '—'}</Text>
      {/* The converted figure. Deliberately NOT coloured by score: it is the
          same number in another currency, not a second verdict. Grey and
          smaller, so it reads as a footnote to the value above it — the same
          relationship the price and its converted line already have. */}
      {sub ? (
        <Text style={[s.sub, { color: colors.textDim }, dir]} numberOfLines={1}>{sub}</Text>
      ) : null}
      {/* .m-note { font-size:11px; margin:4px 0 0; line-height:1.35 } */}
      {note ? (
        <Text style={[s.note, { color: signal }, dir]} numberOfLines={2}>{note}</Text>
      ) : null}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  // .metric-tile { background:card-alt; border:0.5px; border-radius:10px; padding:10px 12px }
  tile:  { width: '48%', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12,
           borderWidth: 0.5, minHeight: 76, marginBottom: 10 },
  // .m-label { font-size:12px }
  label: { fontSize: 12, marginBottom: 2 },
  // Smaller than the value, larger than the note: it is a restatement of
  // the number, not commentary on it.
  sub:   { fontSize: 12, marginTop: 1 },
  // .m-value { font-size:17px; font-weight:600 }
  value: { fontSize: 17, fontWeight: '600' },
  // .m-note { font-size:11px; margin:4px 0 0; line-height:1.35 }
  note:  { fontSize: 11, marginTop: 4, lineHeight: 15 },
});

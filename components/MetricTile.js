import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

// noteClass from HTML: score >= 70 → green, >= 40 → amber, else → red, null → textDimmer
function scoreColor(score, colors) {
  if (score == null) return colors.textDimmer;
  if (score >= 70) return colors.green;
  if (score >= 40) return colors.amber;
  return colors.red;
}

export default function MetricTile({ label, value, note, score, colors, onPress }) {
  return (
    <TouchableOpacity
      style={[s.tile, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}
      onPress={onPress}
      activeOpacity={0.7}>
      {/* .m-label { font-size:12px; color:var(--text-dim) } */}
      <Text style={[s.label, { color: colors.textDim }]} numberOfLines={1}>{label}</Text>
      {/* .m-value { font-size:17px; font-weight:600 } */}
      <Text style={[s.value, { color: colors.text }]} numberOfLines={1}>{value ?? '—'}</Text>
      {/* .m-note { font-size:11px; margin:4px 0 0; line-height:1.35 } */}
      {note ? (
        <Text style={[s.note, { color: scoreColor(score, colors) }]} numberOfLines={2}>{note}</Text>
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
  // .m-value { font-size:17px; font-weight:600 }
  value: { fontSize: 17, fontWeight: '600' },
  // .m-note { font-size:11px; margin:4px 0 0; line-height:1.35 }
  note:  { fontSize: 11, marginTop: 4, lineHeight: 15 },
});

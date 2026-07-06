import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle, G } from 'react-native-svg';

// Matches HTML gauge exactly:
// .gauge-wrap { width:88px; height:88px }
// .gauge-bg/.gauge-fg { stroke-width:10 }
// .gauge-label { font-size:22px; font-weight:600 }
// SVG viewBox="0 0 100 100", circle cx=50 cy=50 r=42
// stroke-dasharray=264, rotated -90deg

const SIZE = 88;
const CIRCUMFERENCE = 264; // approx 2*pi*42

export default function ScoreGauge({ score, colors }) {
  const gaugeColor = score >= 75 ? colors.green : score >= 50 ? colors.amber : colors.red;
  const offset = CIRCUMFERENCE - (CIRCUMFERENCE * (score || 0) / 100);

  return (
    <View style={s.wrap}>
      <Svg width={SIZE} height={SIZE} viewBox="0 0 100 100">
        {/* HTML: transform: rotate(-90deg) scaleX(-1) on the SVG element
            scaleX(-1) = translate(100,0) scale(-1,1) in SVG coords (viewBox 0 0 100 100)
            This flips fill direction so gauge fills counter-clockwise from 12 o'clock */}
        <G transform="translate(100, 0) scale(-1, 1)">
          {/* .gauge-bg { stroke-width:10 } */}
          <Circle
            cx="50" cy="50" r="42"
            fill="none"
            stroke={colors.cardBorder}
            strokeWidth="10"
          />
          {/* .gauge-fg { stroke-width:10; stroke-linecap:round } — rotated -90deg */}
          <Circle
            cx="50" cy="50" r="42"
            fill="none"
            stroke={gaugeColor}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
            rotation={-90}
            origin="50, 50"
          />
        </G>
      </Svg>
      {/* .gauge-label { font-size:22px; font-weight:600 } */}
      <View style={StyleSheet.absoluteFill}>
        <View style={s.center}>
          <Text style={[s.label, { color: colors.text }]}>{score}%</Text>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap:   { width: SIZE, height: SIZE },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // .gauge-label { font-size:22px; font-weight:600 }
  label:  { fontSize: 22, fontWeight: '600' },
});

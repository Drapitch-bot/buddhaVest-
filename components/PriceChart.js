import React, { useState, useRef } from 'react';
import { View, PanResponder, Dimensions } from 'react-native';
import Svg, { Path, Defs, LinearGradient, Stop, Line, Circle, Text as SvgText, Rect } from 'react-native-svg';

const { width: SCREEN_W } = Dimensions.get('window');

// data = { dates: string[], prices: number[] }  (from API history field)
export default function PriceChart({ data, colors, height = 200, showCurrency = true }) {
  const [tooltipIdx, setTooltipIdx] = useState(null);
  const chartRef = useRef(null);

  if (!data || !data.prices || data.prices.length < 2) return null;

  const prices = data.prices;
  const dates  = data.dates || prices.map((_, i) => String(i));

  const W = SCREEN_W - 48;   // margin 24 on each side
  const H = height;
  const PAD = { top: 20, bottom: 32, left: 8, right: 8 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top  - PAD.bottom;

  const minV = Math.min(...prices);
  const maxV = Math.max(...prices);
  const range = maxV - minV || 1;

  function xOf(i) { return PAD.left + (i / (prices.length - 1)) * cW; }
  function yOf(v) { return PAD.top + cH - ((v - minV) / range) * cH; }

  const pts      = prices.map((v, i) => ({ x: xOf(i), y: yOf(v) }));
  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const fillPath = linePath
    + ` L ${pts[pts.length - 1].x.toFixed(1)} ${(PAD.top + cH).toFixed(1)}`
    + ` L ${pts[0].x.toFixed(1)} ${(PAD.top + cH).toFixed(1)} Z`;

  const isUp      = prices[prices.length - 1] >= prices[0];
  const lineColor = isUp ? (colors.green || '#4ade80') : (colors.red || '#f87171');

  // Y axis labels (3 levels)
  const yLevels = [minV, (minV + maxV) / 2, maxV];

  // ── PanResponder ──────────────────────────────────────────────────────────
  // Keep a ref to latest prices so PanResponder (created once) always uses
  // the current data length — not the stale value from the first render.
  const pricesRef = useRef(prices);
  pricesRef.current = prices;
  const cWRef = useRef(cW);
  cWRef.current = cW;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder:  () => true,
      onPanResponderGrant: (evt) => {
        const localX = evt.nativeEvent.locationX - PAD.left;
        const n = pricesRef.current.length;
        const idx = Math.round((localX / cWRef.current) * (n - 1));
        setTooltipIdx(Math.max(0, Math.min(n - 1, idx)));
      },
      onPanResponderMove: (evt) => {
        const localX = evt.nativeEvent.locationX - PAD.left;
        const n = pricesRef.current.length;
        const idx = Math.round((localX / cWRef.current) * (n - 1));
        setTooltipIdx(Math.max(0, Math.min(n - 1, idx)));
      },
      onPanResponderRelease: () => {
        setTooltipIdx(null);
      },
      onPanResponderTerminate: () => {
        setTooltipIdx(null);
      },
    })
  ).current;

  // Tooltip positioning
  const tp = tooltipIdx != null ? pts[tooltipIdx] : null;
  const TOOLTIP_W = 86;
  const TOOLTIP_H = 34;
  const tipX = tp ? Math.min(tp.x + 10, W - TOOLTIP_W - 4) : 0;
  const tipY = tp ? Math.max(tp.y - TOOLTIP_H - 6, PAD.top) : 0;

  function fmtPrice(v) {
    if (!showCurrency) return v >= 1000 ? (v / 1000).toFixed(2) + 'K' : v.toFixed(2);
    return v >= 1000 ? '$' + (v / 1000).toFixed(2) + 'K' : '$' + v.toFixed(2);
  }

  // fmtDate for tooltip: "Jan 15, 2024" or quarter string as-is
  function fmtDate(d) {
    if (!d) return '';
    const s = String(d);
    if (/^Q\d/.test(s)) return s;
    try {
      const dt = new Date(s);
      if (isNaN(dt.getTime())) return s;
      return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch { return s; }
  }

  // fmtDateShort for x-axis — handles ISO dates "2024-03-31" → "Mar'24"
  // and quarter strings "Q1 2024" → returned as-is
  function fmtDateShort(d) {
    if (!d) return '';
    const s = String(d);
    // If it looks like a quarter string already (e.g. "Q1 2024"), return as-is
    if (/^Q\d/.test(s)) return s;
    try {
      const dt = new Date(s);
      if (isNaN(dt.getTime())) return s;
      const mon = dt.toLocaleDateString('en-US', { month: 'short' });
      const yr  = String(dt.getFullYear()).slice(2);
      return `${mon}'${yr}`;
    } catch { return s; }
  }

  return (
    <View
      ref={chartRef}
      style={{ width: W, height: H }}
      {...panResponder.panHandlers}>
      <Svg width={W} height={H}>
        <Defs>
          <LinearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0"   stopColor={lineColor} stopOpacity="0.25" />
            <Stop offset="1"   stopColor={lineColor} stopOpacity="0.02" />
          </LinearGradient>
        </Defs>

        {/* Gradient fill */}
        <Path d={fillPath} fill="url(#grad)" />

        {/* Price line */}
        <Path d={linePath} stroke={lineColor} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />

        {/* Y axis labels */}
        {yLevels.map((v, i) => (
          <SvgText key={i} x={W - 4} y={yOf(v) + 4} fontSize={9} fill={colors.textDimmer || '#6b7280'} textAnchor="end">
            {v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v.toFixed(1)}
          </SvgText>
        ))}

        {/* X axis date labels — show up to 5 evenly spaced labels */}
        {(() => {
          const n = prices.length;
          if (n < 2) return null;
          const step = Math.max(1, Math.ceil(n / 5));
          const indices = [];
          for (let i = 0; i < n; i += step) indices.push(i);
          if (indices[indices.length - 1] !== n - 1) indices.push(n - 1);
          return indices.map((idx, j) => (
            <SvgText
              key={'x' + j}
              x={xOf(idx)}
              y={PAD.top + cH + 14}
              fontSize={8}
              fill={colors.textDimmer || '#6b7280'}
              textAnchor={idx === 0 ? 'start' : idx === n - 1 ? 'end' : 'middle'}>
              {fmtDateShort(dates[idx])}
            </SvgText>
          ));
        })()}

        {/* Tooltip */}
        {tp && (
          <>
            {/* Crosshair */}
            <Line
              x1={tp.x} y1={PAD.top}
              x2={tp.x} y2={PAD.top + cH}
              stroke={colors.textDimmer || '#6b7280'} strokeWidth={1} strokeDasharray="4,3" />
            {/* Dot */}
            <Circle cx={tp.x} cy={tp.y} r={5} fill={lineColor} stroke={colors.card || '#1e2130'} strokeWidth={2} />
            {/* Label box */}
            <Rect x={tipX} y={tipY} width={TOOLTIP_W} height={TOOLTIP_H} rx={6}
              fill={colors.card || '#1e2130'} stroke={colors.cardBorder || '#2d3148'} strokeWidth={0.5} />
            <SvgText x={tipX + 6} y={tipY + 13} fontSize={9.5} fill={colors.textDim || '#9ca3af'}>
              {fmtDate(dates[tooltipIdx])}
            </SvgText>
            <SvgText x={tipX + 6} y={tipY + 26} fontSize={11} fill={lineColor} fontWeight="700">
              {fmtPrice(prices[tooltipIdx])}
            </SvgText>
          </>
        )}
      </Svg>
    </View>
  );
}

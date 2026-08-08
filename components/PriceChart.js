import React, { useState, useRef } from 'react';
import { View, PanResponder, Dimensions, useWindowDimensions } from 'react-native';
import Svg, { Path, Defs, LinearGradient, Stop, Line, Circle, Text as SvgText, Rect } from 'react-native-svg';

// Fallback only — the live width comes from useWindowDimensions inside the
// component so the chart re-lays-out when a tablet rotates.
const SCREEN_W_INITIAL = Dimensions.get('window').width;

// Layout constants — module scope so the PanResponder closure can use them
// without depending on render-time values.
const PAD = { top: 20, bottom: 32, left: 8, right: 8 };

// data = { dates: string[], prices: number[] }  (from API history field)
// `currency` is the symbol to prefix values with ('₪' for TASE listings).
// It was hard-coded to '$', so an Israeli stock's chart labelled shekel values
// as dollars.
// `signal` is the verdict colour the CALLER already decided — the very colour
// the tile that opened this screen is showing. Pass it and the line matches.
//
// Colouring by trend was the mistake: P/B falling 14.9 -> 6.84 is an improving
// trend, so the line went green, while 6.84 is still above the "expensive"
// threshold of 5 and the tile showed red. Two screens, one number, opposite
// verdicts. Shape already carries the trend; colour carries the verdict.
//
// Omit `signal` (plain price charts) and it falls back to direction: a rising
// price is good news for a holder, which is the one case where trend IS the
// verdict.
export default function PriceChart({ data, colors, height = 200, showCurrency = true, currency = '$', signal = undefined }) {
  // RULES OF HOOKS: every hook must run on EVERY render, so they all live
  // above the "no data" early return. Previously three useRef calls sat below
  // it — if this component ever rendered empty first and with data after,
  // React would throw "Rendered more hooks than during the previous render".
  const { width: winW } = useWindowDimensions();
  const [tooltipIdx, setTooltipIdx] = useState(null);
  const chartRef  = useRef(null);
  const pricesRef = useRef([]);
  const cWRef     = useRef(1);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder:  () => true,
      onPanResponderGrant: (evt) => {
        const localX = evt.nativeEvent.locationX - PAD.left;
        const n = pricesRef.current.length;
        if (n < 2 || !cWRef.current) return;
        const idx = Math.round((localX / cWRef.current) * (n - 1));
        setTooltipIdx(Math.max(0, Math.min(n - 1, idx)));
      },
      onPanResponderMove: (evt) => {
        const localX = evt.nativeEvent.locationX - PAD.left;
        const n = pricesRef.current.length;
        if (n < 2 || !cWRef.current) return;
        const idx = Math.round((localX / cWRef.current) * (n - 1));
        setTooltipIdx(Math.max(0, Math.min(n - 1, idx)));
      },
      onPanResponderRelease:   () => { setTooltipIdx(null); },
      onPanResponderTerminate: () => { setTooltipIdx(null); },
    })
  ).current;

  const hasData = !!(data && data.prices && data.prices.length >= 2);
  const prices  = hasData ? data.prices : [];
  const dates   = hasData ? (data.dates || prices.map((_, i) => String(i))) : [];

  const W = (winW || SCREEN_W_INITIAL) - 48;   // margin 24 on each side
  const H = height;
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top  - PAD.bottom;

  // Keep refs pointing at the latest data for the (once-created) PanResponder.
  pricesRef.current = prices;
  cWRef.current = cW;

  if (!hasData) return null;

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
  const lineColor = signal !== undefined
    ? signal
    : (isUp ? (colors.green || '#4ade80') : (colors.red || '#f87171'));

  // Y axis labels (3 levels)
  const yLevels = [minV, (minV + maxV) / 2, maxV];

  // Tooltip positioning
  const tp = tooltipIdx != null ? pts[tooltipIdx] : null;
  const TOOLTIP_W = 86;
  const TOOLTIP_H = 34;
  const tipX = tp ? Math.min(tp.x + 10, W - TOOLTIP_W - 4) : 0;
  const tipY = tp ? Math.max(tp.y - TOOLTIP_H - 6, PAD.top) : 0;

  function fmtPrice(v) {
    const prefix = showCurrency ? (currency || '$') : '';
    const abs = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (abs >= 1e12) return sign + prefix + (abs / 1e12).toFixed(2) + 'T';
    if (abs >= 1e9)  return sign + prefix + (abs / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6)  return sign + prefix + (abs / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3)  return sign + prefix + (abs / 1e3).toFixed(2) + 'K';
    return sign + prefix + abs.toFixed(2);
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
    } catch(e) { return s; }
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
    } catch(e) { return s; }
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
            {(() => {
              const abs = Math.abs(v);
              const sign = v < 0 ? '-' : '';
              if (abs >= 1e12) return sign + (abs / 1e12).toFixed(1) + 'T';
              if (abs >= 1e9)  return sign + (abs / 1e9).toFixed(1) + 'B';
              if (abs >= 1e6)  return sign + (abs / 1e6).toFixed(1) + 'M';
              if (abs >= 1e3)  return sign + (abs / 1e3).toFixed(1) + 'K';
              return v.toFixed(1);
            })()}
          </SvgText>
        ))}

        {/* X axis date labels.
            The old rule was "every n/5th point, then always append the last one",
            and that last append is what collided: with 53 points the labels landed
            at 0,11,22,33,44 and then 52 — eight points apart where the others were
            eleven, so "Jan 2026" and "Aug 2026" printed on top of each other.
            It depended on the series length, so it appeared on some stocks and
            some metrics and not others.

            Now the count comes from the space available: however many labels fit
            at MIN_GAP pixels apart, evenly spread, first and last included. No
            series length or screen width can produce an overlap. */}
        {(() => {
          const n = prices.length;
          if (n < 2) return null;
          const MIN_GAP = 46;                  // ~6 chars at fontSize 8, plus breathing room
          const maxLabels = Math.max(2, Math.min(6, Math.floor(cW / MIN_GAP) + 1));

          // Evenly spaced candidates, then a hard filter on the ACTUAL pixel
          // distance. Spacing them evenly by index is not enough: with 10 points
          // and 6 labels, rounding puts two of them one index apart — 33px on a
          // 360dp screen, still overlapping. Measuring the gap is the only way
          // the invariant actually holds.
          const indices = [];
          for (let k = 0; k < maxLabels; k++) {
            const idx = Math.round((k / (maxLabels - 1)) * (n - 1));
            if (!indices.length) { indices.push(idx); continue; }
            const prev = indices[indices.length - 1];
            if (idx !== prev && xOf(idx) - xOf(prev) >= MIN_GAP) indices.push(idx);
          }
          // The last point must always be labelled. If it would crowd the one
          // before it, REPLACE that one instead of squeezing in beside it —
          // appending unconditionally is exactly what printed "Jan 2026" on top
          // of "Aug 2026".
          const last = indices[indices.length - 1];
          if (last !== n - 1) {
            if (xOf(n - 1) - xOf(last) >= MIN_GAP) indices.push(n - 1);
            else indices[indices.length - 1] = n - 1;
          }
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

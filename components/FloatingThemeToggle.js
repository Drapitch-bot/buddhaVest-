// FloatingThemeToggle.js
// Parent wrapper in App.js has direction:'ltr' which forces physical left coordinates.
// So left:X always means X from the physical left edge — no RTL logic needed.
import React, { useRef, useEffect } from 'react';
import { Animated, PanResponder, Text, Dimensions, StyleSheet, useWindowDimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useApp } from '../constants/AppContext';

const STORAGE_KEY = 'themeTogglePos_v3';
const BTN = 44;
// Initial values only — the live screen size comes from useWindowDimensions
// below, because tablets can now rotate and the window size changes at runtime.
const W0 = Dimensions.get('window').width;
const H0 = Dimensions.get('window').height;

const DEFAULT_X = W0 - BTN - 16;
const DEFAULT_Y = Math.round(H0 * 0.4);

export default function FloatingThemeToggle() {
  const { isDark, toggleTheme } = useApp();
  const toggleRef = useRef(toggleTheme);
  toggleRef.current = toggleTheme;

  // Live dimensions: on a rotating tablet the old module-level constants went
  // stale, so a position saved in portrait could land off-screen in landscape
  // and the button became invisible.
  const { width: W, height: H } = useWindowDimensions();
  const boundsRef = useRef({ W, H });
  boundsRef.current = { W, H };

  const pan = useRef(new Animated.ValueXY({ x: DEFAULT_X, y: DEFAULT_Y })).current;
  const startPos = useRef({ x: DEFAULT_X, y: DEFAULT_Y });
  const hasMoved = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then(raw => {
      if (!raw) return;
      try {
        const pos = JSON.parse(raw);
        // Reject non-numeric/corrupt values — Math.min(x, undefined) is NaN and
        // would place the button at an invalid (invisible) position.
        if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
        const b = boundsRef.current;
        pan.setValue({
          x: Math.max(0, Math.min(b.W - BTN, pos.x)),
          y: Math.max(0, Math.min(b.H - BTN, pos.y)),
        });
      } catch(e) {}
    });
  }, []);

  // Re-clamp whenever the window size changes (rotation / split-screen) so the
  // button can never end up outside the visible area.
  useEffect(() => {
    const x = Math.max(0, Math.min(W - BTN, pan.x._value));
    const y = Math.max(0, Math.min(H - BTN, pan.y._value));
    pan.setValue({ x, y });
  }, [W, H]);

  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gs) =>
      Math.abs(gs.dx) > 5 || Math.abs(gs.dy) > 5,

    onPanResponderGrant: () => {
      hasMoved.current = false;
      startPos.current = { x: pan.x._value, y: pan.y._value };
    },

    onPanResponderMove: (_, gs) => {
      if (Math.abs(gs.dx) > 5 || Math.abs(gs.dy) > 5) hasMoved.current = true;
      const b = boundsRef.current;   // current screen size, not the mount-time one
      const x = Math.max(0, Math.min(b.W - BTN, startPos.current.x + gs.dx));
      const y = Math.max(0, Math.min(b.H - BTN, startPos.current.y + gs.dy));
      pan.setValue({ x, y });
    },

    onPanResponderRelease: () => {
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({
        x: pan.x._value,
        y: pan.y._value,
      }));
      if (!hasMoved.current) toggleRef.current();
    },
  })).current;

  const bg = isDark ? '#1c1f26' : '#f8f8ff';
  const border = isDark ? '#f59e0b' : '#d97706';

  return (
    <Animated.View
      style={[s.btn, { left: pan.x, top: pan.y, backgroundColor: bg, borderColor: border }]}
      {...panResponder.panHandlers}>
      <Text style={s.emoji}>{isDark ? '\u{1F319}' : '☀️'}</Text>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  btn: {
    position: 'absolute',
    width: BTN,
    height: BTN,
    borderRadius: BTN / 2,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 99999,
    elevation: 30,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 4,
  },
  emoji: {
    fontSize: 20,
    textAlign: 'center',
    textAlignVertical: 'center',
    includeFontPadding: false,
    lineHeight: BTN - 4,
  },
});

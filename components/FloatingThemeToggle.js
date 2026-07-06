// FloatingThemeToggle.js
// Parent wrapper in App.js has direction:'ltr' which forces physical left coordinates.
// So left:X always means X from the physical left edge — no RTL logic needed.
import React, { useRef, useEffect } from 'react';
import { Animated, PanResponder, Text, Dimensions, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useApp } from '../constants/AppContext';

const STORAGE_KEY = 'themeTogglePos_v3';
const W = Dimensions.get('window').width;
const H = Dimensions.get('window').height;
const BTN = 44;

const DEFAULT_X = W - BTN - 16;
const DEFAULT_Y = Math.round(H * 0.4);

export default function FloatingThemeToggle() {
  const { isDark, toggleTheme } = useApp();
  const toggleRef = useRef(toggleTheme);
  toggleRef.current = toggleTheme;

  const pan = useRef(new Animated.ValueXY({ x: DEFAULT_X, y: DEFAULT_Y })).current;
  const startPos = useRef({ x: DEFAULT_X, y: DEFAULT_Y });
  const hasMoved = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then(raw => {
      if (!raw) return;
      try {
        const pos = JSON.parse(raw);
        const x = Math.max(0, Math.min(W - BTN, pos.x));
        const y = Math.max(0, Math.min(H - BTN, pos.y));
        pan.setValue({ x, y });
      } catch {}
    });
  }, []);

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
      const x = Math.max(0, Math.min(W - BTN, startPos.current.x + gs.dx));
      const y = Math.max(0, Math.min(H - BTN, startPos.current.y + gs.dy));
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

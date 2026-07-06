// BrandHeader.js — centered brand, bell left, greeting below brand
// Theme toggle is now FloatingThemeToggle in App.js
//
// Layout (3-column):
//   [bell]   [monk · text · spin-icon]   [spacer]
//              greeting centered below
import React, { useRef, useState, useEffect } from 'react';
import {
  View, Text, Image, TouchableOpacity, Animated,
  StyleSheet, Modal, ScrollView, TouchableWithoutFeedback,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Path, Circle } from 'react-native-svg';

import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../constants/AppContext';

const MONK_DARK  = require('../assets/brand_dark_monk.png');
const MONK_LIGHT = require('../assets/brand_light_monk.png');
const TEXT_DARK  = require('../assets/brand_dark_text.png');
const TEXT_LIGHT = require('../assets/brand_light_text.png');
const ICON_DARK  = require('../assets/brand_dark_icon.png');
const ICON_LIGHT = require('../assets/brand_light_icon.png');
const BELL_DARK  = require('../assets/bell_dark.png');   // cream bell — for dark mode
const BELL_LIGHT = require('../assets/bell_light.png');  // darker bell — for light mode

export default function BrandHeader({ onRefresh, greeting }) {
  const { colors, isDark, t } = useApp();
  const insets = useSafeAreaInsets();
  const spinAnim = useRef(new Animated.Value(0)).current;
  const spin = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const [notifVisible, setNotifVisible] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem('notif_seen').then(val => {
      if (!val) setHasUnread(true); // never opened before → show dot
    });
  }, []);

  function openNotif() {
    setNotifVisible(true);
    if (hasUnread) {
      setHasUnread(false);
      AsyncStorage.setItem('notif_seen', '1');
    }
  }

  function handleRefresh() {
    spinAnim.setValue(0);
    Animated.timing(spinAnim, { toValue: 1, duration: 600, useNativeDriver: true }).start();
    if (onRefresh) onRefresh();
  }

  // IDENTICAL dimensions in both modes — only colors/images change, never sizes.
  // resizeMode="contain" scales each image proportionally inside its fixed box;
  // transparent margins (from differing aspect ratios) are invisible.
  const MONK_H = 52, MONK_W = 36;
  const TEXT_H = 20, TEXT_W = 109;
  const ICON_H = 28, ICON_W = 28;

  const notifItems = [
    { icon: '👋', text: t.notif_welcome },
    { icon: '💡', text: t.notif_tip },
    { icon: '🔄', text: t.notif_refresh },
  ];

  return (
    <>
      <View
        style={[
          s.header,
          {
            backgroundColor: colors.card,
            borderBottomColor: colors.cardBorder,
            paddingTop: insets.top + 4,
          },
        ]}
      >
        {/* LEFT: bell */}
        <View style={s.side}>
          <TouchableOpacity activeOpacity={0.75} onPress={openNotif} style={s.bellBtn}>
            <Image
              source={isDark ? BELL_DARK : BELL_LIGHT}
              style={s.bellImg}
              resizeMode="contain"
            />
            {hasUnread && (
              <View style={[s.bellDot, { backgroundColor: colors.red, borderColor: colors.bg }]} />
            )}
          </TouchableOpacity>
        </View>

        {/* CENTER: monk + text + spin icon + greeting */}
        <View style={s.brandCenter}>
          <View style={s.brandRow}>
            <Image
              source={isDark ? MONK_DARK : MONK_LIGHT}
              style={{ height: MONK_H, width: MONK_W }}
              resizeMode="contain"
            />
            <Image
              source={isDark ? TEXT_DARK : TEXT_LIGHT}
              style={{ height: TEXT_H, width: TEXT_W }}
              resizeMode="contain"
            />
            <TouchableOpacity onPress={handleRefresh} activeOpacity={0.8}>
              <Animated.Image
                source={isDark ? ICON_DARK : ICON_LIGHT}
                style={{ height: ICON_H, width: ICON_W, transform: [{ rotate: spin }] }}
                resizeMode="contain"
              />
            </TouchableOpacity>
          </View>
          <Text style={[s.greeting, { color: colors.textDim }]}>
            {greeting || t.greeting_home || 'Markets · Live'}
          </Text>
        </View>

        {/* RIGHT: spacer — same width as left so brand stays centered */}
        <View style={s.side} />
      </View>

      {/* Notifications Modal */}
      <Modal
        visible={notifVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setNotifVisible(false)}>
        <TouchableWithoutFeedback onPress={() => setNotifVisible(false)}>
          <View style={s.modalOverlay}>
            <TouchableWithoutFeedback>
              <View style={[s.notifPanel, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
                <View style={[s.notifHeader, { borderBottomColor: colors.cardBorder }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={colors.text} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <Path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                      <Path d="M13.73 21a2 2 0 0 1-3.46 0" />
                    </Svg>
                    <Text style={[s.notifTitle, { color: colors.text }]}>{t.notif_title || 'Notifications'}</Text>
                  </View>
                  <TouchableOpacity onPress={() => setNotifVisible(false)}>
                    <Text style={{ color: colors.textDim, fontSize: 18 }}>✕</Text>
                  </TouchableOpacity>
                </View>
                <ScrollView>
                  {notifItems.map((item, i) => (
                    <View key={i} style={[s.notifItem, { borderBottomColor: colors.cardBorder }]}>
                      <Text style={{ fontSize: 20, marginRight: 10 }}>{item.icon}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={[s.notifText, { color: colors.text }]} numberOfLines={3}>{item.text}</Text>
                        <Text style={[s.notifTime, { color: colors.textDimmer }]}>
                          {t.notif_now || 'Now'}
                        </Text>
                      </View>
                    </View>
                  ))}
                </ScrollView>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </>
  );
}

const SIDE_W = 50;

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 6,
    borderBottomWidth: 0.5,
    marginBottom: 12,
  },
  side: { width: SIDE_W, alignItems: 'flex-start' },
  bellBtn: {
    width: 32, height: 32,
    justifyContent: 'center', alignItems: 'center',
  },
  bellImg: { width: 26, height: 26 },
  bellDot: {
    position: 'absolute', top: -2, left: -2,
    width: 10, height: 10, borderRadius: 5, borderWidth: 2,
  },
  brandCenter: { flex: 1, alignItems: 'center' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  greeting: { fontSize: 11, marginTop: 2, textAlign: 'center' },
  // Notifications
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-start', alignItems: 'flex-start',
    paddingTop: 90, paddingLeft: 14,
  },
  notifPanel: { width: 300, maxHeight: 420, borderRadius: 14, borderWidth: 0.5, overflow: 'hidden' },
  notifHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 14, borderBottomWidth: 0.5,
  },
  notifTitle: { fontSize: 14, fontWeight: '700' },
  notifItem: { flexDirection: 'row', alignItems: 'flex-start', padding: 12, borderBottomWidth: 0.5 },
  notifText: { fontSize: 12, lineHeight: 18 },
  notifTime: { fontSize: 11, marginTop: 4 },
});

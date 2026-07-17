import React, { useEffect, useRef } from 'react';
import * as Updates from 'expo-updates';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  View, Text, Image, Animated, StyleSheet, Dimensions,
} from 'react-native';
import { API_BASE } from '../constants/api';

const { width: W, height: H } = Dimensions.get('window');

// Cap layout on large screens so the splash doesn't balloon on tablets.
// On phones (W < 600 / H drives these) the caps never bite → no change.
const IS_TABLET   = W >= 700;
const SPLASH_W    = Math.min(W, 600);
const MONK_WIDTH  = IS_TABLET ? Math.min(W * 0.72, 380) : W * 0.72;
const MONK_HEIGHT = IS_TABLET ? Math.min(H * 0.58, 520) : H * 0.58;

const MONK      = require('../assets/opening_monk.png');
const LOGO_TEXT = require('../assets/brand_light_text.png'); // text-only, no monk

export default function SplashScreen({ onDone }) {
  const fadeAnim  = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(20)).current;

  useEffect(() => {
    // Pre-warm Render backend — fire and forget so HomeScreen finds it awake
    fetch(API_BASE + '/status').catch(function() {});

    var cancelled = false;

    // If we just restarted to apply an OTA update, DON'T play the full splash
    // again — the user already sat through it once this launch. Quick fade
    // straight into the app instead of a second monk+quote screen.
    AsyncStorage.getItem('ota_reloaded').then(function(flag) {
      if (cancelled) return;
      if (flag === '1') {
        AsyncStorage.removeItem('ota_reloaded').catch(function() {});
        Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver: true })
          .start(function() { onDone?.(); });
        return;
      }

      // Check for OTA update while splash is showing — silent, no extra delay.
      // Only auto-reload if the download finished fast (still on/near splash);
      // otherwise the update applies on the next open instead of restarting
      // the app mid-use. Mark the reload so the second launch skips the splash.
      if (!__DEV__) {
        var otaStart = Date.now();
        Updates.checkForUpdateAsync()
          .then(function(r) { if (r.isAvailable) return Updates.fetchUpdateAsync(); })
          .then(function(r) {
            if (r && r.isNew && Date.now() - otaStart < 8000) {
              return AsyncStorage.setItem('ota_reloaded', '1')
                .catch(function() {})
                .then(function() { Updates.reloadAsync(); });
            }
          })
          .catch(function() {});
      }

      Animated.parallel([
        Animated.timing(fadeAnim,  { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(slideAnim, { toValue: 0, duration: 800, useNativeDriver: true }),
      ]).start(() => {
        Animated.sequence([
          Animated.delay(3200),
          Animated.timing(fadeAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
        ]).start(() => onDone?.());
      });
    }).catch(function() {
      // AsyncStorage failed — behave exactly as before (full splash, no OTA skip)
      if (cancelled) return;
      Animated.parallel([
        Animated.timing(fadeAnim,  { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(slideAnim, { toValue: 0, duration: 800, useNativeDriver: true }),
      ]).start(() => {
        Animated.sequence([
          Animated.delay(3200),
          Animated.timing(fadeAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
        ]).start(() => onDone?.());
      });
    });

    return function() { cancelled = true; };
  }, []);

  return (
    <View style={s.root}>
      <Animated.View style={[s.inner, {
        opacity:   fadeAnim,
        transform: [{ translateY: slideAnim }],
      }]}>

        {/* ── Monk image — centered, takes upper portion ── */}
        <Image
          source={MONK}
          style={s.monk}
          resizeMode="contain"
        />

        {/* ── Bottom zone: logo left + quote right ── */}
        <View style={s.bottomZone}>

          {/* Logo — text only, no monk */}
          <View style={s.logoWrap}>
            <Image
              source={LOGO_TEXT}
              style={s.logo}
              resizeMode="contain"
            />
          </View>

          {/* Quote — right side */}
          <View style={s.quoteWrap}>
            <Text style={s.quoteText}>
              "Patience is a virtue —{'\n'}and a lesson that must be taught."
            </Text>
          </View>

        </View>

      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  inner: {
    width: SPLASH_W,
    height: H,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Monk — centered, tall
  monk: {
    width:  MONK_WIDTH,
    height: MONK_HEIGHT,
    marginBottom: 0,
  },

  // Bottom zone: logo left + quote right, aligned at monk waist level
  bottomZone: {
    width: SPLASH_W,
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 24,
    marginTop: -H * 0.10, // pulls up to overlap monk's lower portion
  },

  logoWrap: {
    flex: 1,
    alignItems: 'flex-start',
    paddingLeft: 4,
  },
  logo: {
    width: 150,
    height: 28,
  },

  quoteWrap: {
    flex: 1,
    alignItems: 'flex-end',
    paddingRight: 4,
  },
  quoteText: {
    fontSize: 13,
    fontStyle: 'italic',
    fontWeight: '500',
    color: '#1c1f26',
    lineHeight: 20,
    textAlign: 'right',
  },
});

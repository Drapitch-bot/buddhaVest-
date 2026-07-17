import React, { useState, useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import { View, Text, ScrollView, TouchableOpacity, Image, I18nManager, useWindowDimensions, Dimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ScreenOrientation from 'expo-screen-orientation';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppProvider, useApp } from './constants/AppContext';
import FloatingThemeToggle from './components/FloatingThemeToggle';
import SplashScreen from './screens/SplashScreen';
import HomeScreen from './screens/HomeScreen';
import SearchScreen from './screens/SearchScreen';
import WatchlistScreen from './screens/WatchlistScreen';
import NewsScreen from './screens/NewsScreen';
import MoreScreen from './screens/MoreScreen';
import StockScreen from './screens/StockScreen';
import MetricHistoryScreen from './screens/MetricHistoryScreen';
import ArticleScreen from './screens/ArticleScreen';

I18nManager.allowRTL(true);

const Tab          = createBottomTabNavigator();
const HomeStack      = createStackNavigator();
const SearchStack    = createStackNavigator();
const WatchlistStack = createStackNavigator();
const NewsStack      = createStackNavigator();
const MoreStack      = createStackNavigator();

const TAB_ICONS = {
  home:      require('./assets/tab_home.png'),
  search:    require('./assets/tab_search.png'),
  star:      require('./assets/tab_watchlist.png'),
  news:      require('./assets/tab_news.png'),
  more:      require('./assets/tab_more.png'),
};

function TabIcon({ name, focused, size = 24 }) {
  return (
    <Image
      source={TAB_ICONS[name]}
      style={{ width: size, height: size, opacity: focused ? 1 : 0.45 }}
      resizeMode="contain"
    />
  );
}

function stackOpts(colors) {
  return { headerShown: false, cardStyle: { backgroundColor: colors.bg } };
}

function HomeNavigator() {
  const { colors } = useApp();
  return (
    <HomeStack.Navigator screenOptions={stackOpts(colors)}>
      <HomeStack.Screen name="Root"          component={HomeScreen} />
      <HomeStack.Screen name="Stock"         component={StockScreen} />
      <HomeStack.Screen name="MetricHistory" component={MetricHistoryScreen} />
      <HomeStack.Screen name="Article"       component={ArticleScreen} />
    </HomeStack.Navigator>
  );
}

function SearchNavigator() {
  const { colors } = useApp();
  return (
    <SearchStack.Navigator screenOptions={stackOpts(colors)}>
      <SearchStack.Screen name="Root"          component={SearchScreen} />
      <SearchStack.Screen name="Stock"         component={StockScreen} />
      <SearchStack.Screen name="MetricHistory" component={MetricHistoryScreen} />
      <SearchStack.Screen name="Article"       component={ArticleScreen} />
    </SearchStack.Navigator>
  );
}

function WatchlistNavigator() {
  const { colors } = useApp();
  return (
    <WatchlistStack.Navigator screenOptions={stackOpts(colors)}>
      <WatchlistStack.Screen name="Root"          component={WatchlistScreen} />
      <WatchlistStack.Screen name="Stock"         component={StockScreen} />
      <WatchlistStack.Screen name="MetricHistory" component={MetricHistoryScreen} />
      <WatchlistStack.Screen name="Article"       component={ArticleScreen} />
    </WatchlistStack.Navigator>
  );
}

function NewsNavigator() {
  const { colors } = useApp();
  return (
    <NewsStack.Navigator screenOptions={stackOpts(colors)}>
      <NewsStack.Screen name="Root"    component={NewsScreen} />
      <NewsStack.Screen name="Article" component={ArticleScreen} />
    </NewsStack.Navigator>
  );
}

function MoreNavigator() {
  const { colors } = useApp();
  return (
    <MoreStack.Navigator screenOptions={stackOpts(colors)}>
      <MoreStack.Screen name="Root" component={MoreScreen} />
    </MoreStack.Navigator>
  );
}

function MainTabs() {
  const { colors, t, isDark } = useApp();
  const insets = useSafeAreaInsets();
  const activeTint   = isDark ? '#f59e0b' : '#d97706';
  const inactiveTint = isDark ? '#6b7280' : '#9ca3af';
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopWidth: 0.5,
          borderTopColor: colors.cardBorder,
          elevation: 0,
          shadowOpacity: 0,
          paddingTop: 4,
          paddingBottom: insets.bottom + 6,
          height: 56 + insets.bottom,
        },
        tabBarActiveTintColor: activeTint,
        tabBarInactiveTintColor: inactiveTint,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}>
      <Tab.Screen name="HomeTab" component={HomeNavigator}
        options={{ tabBarLabel: t.home || 'Home', tabBarIcon: ({ focused }) => <TabIcon name="home" focused={focused} /> }} />
      <Tab.Screen name="SearchTab" component={SearchNavigator}
        options={{ tabBarLabel: t.search || 'Search', tabBarIcon: ({ focused }) => <TabIcon name="search" focused={focused} /> }} />
      <Tab.Screen name="WatchlistTab" component={WatchlistNavigator}
        options={{ tabBarLabel: t.watchlist || 'Watchlist', tabBarIcon: ({ focused }) => <TabIcon name="star" focused={focused} /> }} />
      <Tab.Screen name="NewsTab" component={NewsNavigator}
        options={{ tabBarLabel: t.news || 'News', tabBarIcon: ({ focused }) => <TabIcon name="news" focused={focused} /> }} />
      <Tab.Screen name="MoreTab" component={MoreNavigator}
        options={{ tabBarLabel: t.more || 'More', tabBarIcon: ({ focused }) => <TabIcon name="more" focused={focused} /> }} />
    </Tab.Navigator>
  );
}

// On large screens (tablets, width >= 700dp) the phone-oriented layout would
// stretch edge-to-edge and look sparse. This centers the whole UI in a
// phone-width column and fills the sides with the theme background. On phones
// (width < 700) it returns children untouched — a guaranteed no-op.
function TabletFrame({ children }) {
  const { colors } = useApp();
  const { width } = useWindowDimensions();
  if (width < 700) return children;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, flexDirection: 'row', justifyContent: 'center' }}>
      <View style={{ flex: 1, maxWidth: 600 }}>{children}</View>
    </View>
  );
}

// First-launch explicit consent: "this is a research tool, not financial
// advice". Shown once (flag in AsyncStorage), in the user's language, on top
// of the app. Explicit agreement is stronger legal footing than the implied
// consent in the ToS alone.
function ConsentGate() {
  const { colors, t, lang, langReady } = useApp();
  const [accepted, setAccepted] = useState(null); // null = loading, true/false
  const isRtl = lang === 'he';

  useEffect(function() {
    AsyncStorage.getItem('disclaimer_accepted')
      .then(function(v) { setAccepted(v === '1'); })
      .catch(function() { setAccepted(false); });
  }, []);

  // Wait for both the flag and the saved language (avoid flashing English)
  if (accepted !== false || !langReady) return null;

  function agree() {
    setAccepted(true);
    AsyncStorage.setItem('disclaimer_accepted', '1').catch(function() {});
  }

  return (
    <View style={{
      position: 'absolute', left: 0, top: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 22,
    }}>
      <View style={{
        backgroundColor: colors.card, borderRadius: 16, padding: 20,
        maxHeight: '82%', borderWidth: 0.5, borderColor: colors.cardBorder,
      }}>
        <Text style={{
          color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: 12,
          textAlign: isRtl ? 'right' : 'left', writingDirection: isRtl ? 'rtl' : 'ltr',
        }}>
          {t.consent_title || 'Before you start'}
        </Text>
        <ScrollView style={{ flexGrow: 0 }}>
          <Text style={{
            color: colors.text, fontSize: 14, lineHeight: 22,
            textAlign: isRtl ? 'right' : 'left', writingDirection: isRtl ? 'rtl' : 'ltr',
          }}>
            {t.consent_body || ''}
          </Text>
        </ScrollView>
        <TouchableOpacity
          onPress={agree}
          activeOpacity={0.8}
          style={{
            marginTop: 16, backgroundColor: '#f59e0b', borderRadius: 10,
            paddingVertical: 13, alignItems: 'center',
          }}>
          <Text style={{ color: '#1c1f26', fontSize: 15, fontWeight: '700' }}>
            {t.consent_agree || 'I understand and agree'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function App() {
  const [showSplash, setShowSplash] = useState(true);

  // Tablets (shortest side >= 600dp, the Android sw600dp definition) may rotate
  // freely; phones stay locked to portrait so their layout is never affected.
  useEffect(function() {
    var dim = Dimensions.get('window');
    var isTablet = Math.min(dim.width, dim.height) >= 600;
    (async function() {
      try {
        if (isTablet) {
          await ScreenOrientation.unlockAsync();
        } else {
          await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
        }
      } catch (e) {}
    })();
  }, []);

  if (showSplash) {
    return (
      <SafeAreaProvider>
        <SplashScreen onDone={() => setShowSplash(false)} />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <AppProvider>
        <TabletFrame>
          <View style={{ flex: 1 }}>
            <NavigationContainer>
              <MainTabs />
            </NavigationContainer>
            {/* LTR overlay: physical left coords for draggable button regardless of RTL locale */}
            <View
              style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, direction: 'ltr' }}
              pointerEvents="box-none">
              <FloatingThemeToggle />
            </View>
            <ConsentGate />
          </View>
        </TabletFrame>
      </AppProvider>
    </SafeAreaProvider>
  );
}

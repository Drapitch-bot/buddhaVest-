import React, { useState, useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import { View, Image, I18nManager } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Updates from 'expo-updates';
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

export default function App() {
  const [showSplash, setShowSplash] = useState(true);

  useEffect(() => {
    if (__DEV__) return;
    (async () => {
      try {
        const update = await Updates.checkForUpdateAsync();
        if (update.isAvailable) {
          await Updates.fetchUpdateAsync();
          await Updates.reloadAsync();
        }
      } catch {}
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
        </View>
      </AppProvider>
    </SafeAreaProvider>
  );
}

import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { darkColors, lightColors } from '../constants/colors';
import { getLang } from '../constants/i18n';
import { captureError } from '../utils/monitoring';

const AppContext = createContext();

export function AppProvider({ children }) {
  const [isDark, setIsDark] = useState(true);
  const [lang, setLang] = useState('en');
  const [langReady, setLangReady] = useState(false);
  const [watchlist, setWatchlist] = useState([]);
  const [translateArticles, setTranslateArticles] = useState(true);
  const [showLocalCurrency, setShowLocalCurrency] = useState(true);

  const colors = isDark ? darkColors : lightColors;
  const t = getLang(lang);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const theme = await AsyncStorage.getItem('theme');
      const savedLang = await AsyncStorage.getItem('lang');
      const savedWatchlist = await AsyncStorage.getItem('watchlist');
      const savedTranslate = await AsyncStorage.getItem('translateArticles');
      const savedLocalCurrency = await AsyncStorage.getItem('showLocalCurrency');
      if (theme) setIsDark(theme === 'dark');
      if (savedLang) setLang(savedLang);
      if (savedWatchlist) {
        // Tolerate corrupt/legacy storage: anything that isn't an array would
        // crash every .some()/.filter()/.map() call downstream.
        const parsed = JSON.parse(savedWatchlist);
        if (Array.isArray(parsed)) setWatchlist(parsed);
      }
      if (savedTranslate !== null) setTranslateArticles(savedTranslate === 'true');
      if (savedLocalCurrency !== null) setShowLocalCurrency(savedLocalCurrency === 'true');
    } catch (e) {
      // Continuing with defaults is right — but it means the user's language,
      // theme and entire watchlist quietly reverted, and nothing said so.
      captureError('settings_load', e);
    }
    setLangReady(true);
  }

  async function toggleTheme() {
    const newDark = !isDark;
    setIsDark(newDark);
    await AsyncStorage.setItem('theme', newDark ? 'dark' : 'light');
  }

  async function changeLang(newLang) {
    setLang(newLang);
    await AsyncStorage.setItem('lang', newLang);
  }

  async function toggleTranslateArticles() {
    const next = !translateArticles;
    setTranslateArticles(next);
    await AsyncStorage.setItem('translateArticles', String(next));
  }

  async function toggleShowLocalCurrency() {
    const next = !showLocalCurrency;
    setShowLocalCurrency(next);
    await AsyncStorage.setItem('showLocalCurrency', String(next));
  }

  function resetSettingsState() {
    setTranslateArticles(true);
    setShowLocalCurrency(true);
    setWatchlist([]);
    // 'en' matches the cold-start default (useState('en')) — previously 'he',
    // which made the session Hebrew but the next launch English. Now consistent.
    setLang('en');
  }

  // Uses the functional form so the new list is always derived from the LATEST
  // state, never from a stale closure. Without this, a fast double-tap (or a
  // tap before loadSettings finished) computed from an outdated list and the
  // second write silently dropped the first change.
  async function toggleWatchlist(ticker, name) {
    let newList = null;
    setWatchlist(function(prev) {
      const list = Array.isArray(prev) ? prev : [];
      newList = list.some(w => w.ticker === ticker)
        ? list.filter(w => w.ticker !== ticker)
        : [...list, { ticker, name }];
      return newList;
    });
    if (newList) {
      try {
        await AsyncStorage.setItem('watchlist', JSON.stringify(newList));
      } catch (e) {
        // The user tapped the star, the UI showed it filled, and the write to
        // disk failed. State already changed, so it looks saved until the app
        // restarts and the stock is gone. Silence here meant that data loss
        // was invisible to everyone.
        captureError('watchlist_save', e, { ticker: ticker, size: newList.length });
      }
    }
  }

  function isInWatchlist(ticker) {
    return Array.isArray(watchlist) && watchlist.some(w => w.ticker === ticker);
  }

  return (
    <AppContext.Provider value={{
      isDark, colors, lang, langReady, t, watchlist,
      translateArticles, showLocalCurrency,
      toggleTheme, changeLang, toggleWatchlist, isInWatchlist,
      toggleTranslateArticles, toggleShowLocalCurrency, resetSettingsState,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export const useApp = () => useContext(AppContext);

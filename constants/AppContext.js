import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { darkColors, lightColors } from '../constants/colors';
import { getLang } from '../constants/i18n';

const AppContext = createContext();

export function AppProvider({ children }) {
  const [isDark, setIsDark] = useState(true);
  const [lang, setLang] = useState('en');
  const [watchlist, setWatchlist] = useState([]);

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
      if (theme) setIsDark(theme === 'dark');
      if (savedLang) setLang(savedLang);
      if (savedWatchlist) setWatchlist(JSON.parse(savedWatchlist));
    } catch (e) {}
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

  async function toggleWatchlist(ticker, name) {
    const exists = watchlist.find(w => w.ticker === ticker);
    let newList;
    if (exists) {
      newList = watchlist.filter(w => w.ticker !== ticker);
    } else {
      newList = [...watchlist, { ticker, name }];
    }
    setWatchlist(newList);
    await AsyncStorage.setItem('watchlist', JSON.stringify(newList));
  }

  function isInWatchlist(ticker) {
    return watchlist.some(w => w.ticker === ticker);
  }

  return (
    <AppContext.Provider value={{
      isDark, colors, lang, t, watchlist,
      toggleTheme, changeLang, toggleWatchlist, isInWatchlist,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export const useApp = () => useContext(AppContext);

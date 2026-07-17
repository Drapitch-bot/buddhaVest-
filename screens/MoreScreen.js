/**
 * MoreScreen.js — 1:1 לפי HTML screen-more + sub-screens:
 *   עוד אפשרויות → חדשות | מעקב | יומן מחקר | הגדרות | תנאי שימוש | מי אני?
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, Switch, TextInput, FlatList, Image,
  Alert, Platform, Linking,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useApp } from '../constants/AppContext';
import { API_BASE } from '../constants/api';
import BrandHeader from '../components/BrandHeader';

const MONK_ABOUT = require('../assets/monk_about.png'); // same image both modes

const LANGS = [
  { code: 'he', label: 'עברית' },
  { code: 'en', label: 'English' },
  { code: 'ru', label: 'Русский' },
  { code: 'es', label: 'Español' },
];

const JOURNAL_KEY = 'buddhavest_journal';

// ─── Sub-screen: Settings ─────────────────────────────────────────────────────
function SettingsScreen({ colors, t, insets, isDark, toggleTheme, lang, changeLang,
                          translateArticles, toggleTranslateArticles,
                          showLocalCurrency, toggleShowLocalCurrency, resetSettingsState, onBack }) {
  function resetAll() {
    Alert.alert(
      t.settings_reset_all,
      t.settings_reset_all_sub,
      [
        { text: t.cancel || 'Cancel', style: 'cancel' },
        {
          text: t.reset || 'Reset', style: 'destructive', onPress: async () => {
            await AsyncStorage.multiRemove(['watchlist', 'lang', JOURNAL_KEY,
              'translateArticles', 'showLocalCurrency',
              // notification memory + first-launch consent: a full reset should
              // behave like a fresh install (consent shows again on next launch)
              'notif_seen', 'notif_first_seen', 'notif_seen_sig', 'disclaimer_accepted']);
            resetSettingsState(); // reset state immediately, not just on next launch
          },
        },
      ]
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TouchableOpacity
        style={[ss.backLink, { borderBottomColor: colors.cardBorder, paddingTop: insets.top + 12, backgroundColor: colors.bg }]}
        onPress={onBack}>
        <Text style={{ color: colors.accent, fontSize: 14 }}>← {t.more_back}</Text>
      </TouchableOpacity>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>

        {/* ── Appearance ── */}
        <View style={[ss.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
          <Text style={[ss.cardTitle, { color: colors.text }]}>{'⚙️ ' + t.more_settings_title}</Text>

          {/* Theme */}
          <View style={[ss.settingsRow, { borderBottomColor: colors.cardBorder }]}>
            <View style={{ flex: 1 }}>
              <Text style={[ss.mTicker, { color: colors.text }]}>{isDark ? '🌙 ' + t.darkMode : '☀️ ' + t.lightMode}</Text>
            </View>
            <Switch value={isDark} onValueChange={toggleTheme}
              trackColor={{ false: colors.cardBorder, true: colors.accent }} thumbColor="#fff" />
          </View>

          {/* Language */}
          <View style={[ss.settingsRow, { borderBottomColor: colors.cardBorder }]}>
            <View style={{ flex: 1 }}>
              <Text style={[ss.mTicker, { color: colors.text }]}>{t.language}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                {LANGS.map(l => (
                  <TouchableOpacity key={l.code}
                    style={[ss.langBtn, {
                      backgroundColor: lang === l.code ? colors.purpleBg : colors.cardAlt,
                      borderColor: lang === l.code ? colors.purple : colors.cardBorder,
                    }]}
                    onPress={() => changeLang(l.code)}>
                    <Text style={[ss.langText, { color: lang === l.code ? colors.purple : colors.text }]}>{l.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>

          {/* Translate articles */}
          <View style={[ss.settingsRow, { borderBottomColor: colors.cardBorder }]}>
            <View style={{ flex: 1 }}>
              <Text style={[ss.mTicker, { color: colors.text }]}>{'🌐 ' + (t.settings_translate_articles || 'Auto-translate articles')}</Text>
              <Text style={[ss.mName, { color: colors.textDim }]}>{t.settings_translate_articles_sub || 'Opens articles translated to UI language'}</Text>
            </View>
            <Switch value={translateArticles} onValueChange={toggleTranslateArticles}
              trackColor={{ false: colors.cardBorder, true: colors.accent }} thumbColor="#fff" />
          </View>

          {/* Local currency */}
          {lang !== 'en' && (
            <View style={[ss.settingsRow, { borderBottomColor: colors.cardBorder }]}>
              <View style={{ flex: 1 }}>
                <Text style={[ss.mTicker, { color: colors.text }]}>{'💱 ' + (t.settings_local_currency || 'Show local currency')}</Text>
                <Text style={[ss.mName, { color: colors.textDim }]}>{t.settings_local_currency_sub || 'Show extra price in local currency'}</Text>
              </View>
              <Switch value={showLocalCurrency} onValueChange={toggleShowLocalCurrency}
                trackColor={{ false: colors.cardBorder, true: colors.accent }} thumbColor="#fff" />
            </View>
          )}
        </View>

        {/* ── About ── */}
        <View style={[ss.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
          <Text style={[ss.cardTitle, { color: colors.text }]}>{'ℹ️ ' + (t.version || 'Version')}</Text>

          <View style={[ss.settingsRow, { borderBottomColor: colors.cardBorder }]}>
            <View style={{ flex: 1 }}>
              <Text style={[ss.mTicker, { color: colors.text }]}>BuddhaVest v1.0.0</Text>
              <Text style={[ss.mName, { color: colors.textDimmer, fontSize: 11 }]}>{t.settings_version_features}</Text>
            </View>
          </View>

          {/* Contact */}
          <TouchableOpacity style={[ss.settingsRow, { borderBottomColor: 'transparent' }]}
            onPress={() => Linking.openURL('mailto:' + (t.settings_contact_email || 'supportbuddhavest@gmail.com'))}>
            <View style={{ flex: 1 }}>
              <Text style={[ss.mTicker, { color: colors.text }]}>{'✉️ ' + (t.settings_contact_title || 'Contact')}</Text>
              <Text style={[ss.mName, { color: colors.accent }]}>{t.settings_contact_email || 'supportbuddhavest@gmail.com'}</Text>
            </View>
            <Text style={{ color: colors.textDimmer, fontSize: 14 }}>›</Text>
          </TouchableOpacity>

        </View>

        {/* ── Reset ── */}
        <View style={[ss.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
          <TouchableOpacity onPress={resetAll}>
            <View style={[ss.moverRow, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}>
              <LinearGradient colors={['#fb7185', '#e11d48']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={ss.moverIcon}>
                <Text style={{ fontSize: 14 }}>🔄</Text>
              </LinearGradient>
              <View style={{ flex: 1 }}>
                <Text style={[ss.mTicker, { color: colors.text }]}>{t.settings_reset_all}</Text>
                <Text style={[ss.mName, { color: colors.textDim }]}>{t.settings_reset_all_sub}</Text>
              </View>
              <Text style={{ color: colors.textDimmer, fontSize: 14 }}>›</Text>
            </View>
          </TouchableOpacity>
        </View>

        <Text style={[ss.sourceNote, { color: colors.textDimmer }]}>{t.app_info}</Text>
        <Text style={[ss.sourceNote, { color: colors.textDimmer }]}>{t.copyright_notice}</Text>
      </ScrollView>
    </View>
  );
}

// ─── Sub-screen: Journal ─────────────────────────────────────────────────────
function JournalScreen({ colors, t, lang, insets, onBack, initialTicker }) {
  const [entries, setEntries] = useState([]);
  const [ticker, setTicker] = useState(initialTicker || '');
  const [text, setText] = useState('');

  useEffect(() => { loadEntries(); }, []);

  async function loadEntries() {
    try {
      const raw = await AsyncStorage.getItem(JOURNAL_KEY);
      setEntries(raw ? JSON.parse(raw) : []);
    } catch(e) {}
  }

  async function saveEntry() {
    if (!text.trim()) return;
    const newEntry = { ticker: ticker.trim().toUpperCase(), text: text.trim(), date: new Date().toISOString() };
    const updated = [newEntry, ...entries];
    setEntries(updated);
    await AsyncStorage.setItem(JOURNAL_KEY, JSON.stringify(updated));
    setTicker('');
    setText('');
  }

  async function deleteEntry(idx) {
    const updated = entries.filter((_, i) => i !== idx);
    setEntries(updated);
    await AsyncStorage.setItem(JOURNAL_KEY, JSON.stringify(updated));
  }

  function fmtDate(iso) {
    try {
      const d = new Date(iso);
      const locale = lang === 'he' ? 'he-IL' : lang === 'ru' ? 'ru-RU' : lang === 'es' ? 'es-ES' : 'en-US';
      return d.toLocaleDateString(locale) + ' ' + d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    } catch(e) { return ''; }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TouchableOpacity
        style={[ss.backLink, { borderBottomColor: colors.cardBorder, paddingTop: insets.top + 12, backgroundColor: colors.bg }]}
        onPress={onBack}>
        <Text style={{ color: colors.accent, fontSize: 14 }}>← {t.more_back}</Text>
      </TouchableOpacity>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        <View style={[ss.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <Text style={[ss.cardTitle, { color: colors.text, marginBottom: 0 }]}>{'📓 ' + t.journalTitle}</Text>
            {entries.length > 0 && (
              <TouchableOpacity onPress={() => {
                Alert.alert(t.journal_clear_confirm, t.journal_clear_body, [
                  { text: t.cancel, style: 'cancel' },
                  { text: t.journal_clear_yes, style: 'destructive', onPress: async () => {
                    setEntries([]);
                    await AsyncStorage.removeItem(JOURNAL_KEY);
                  }},
                ]);
              }}>
                <Text style={{ color: colors.red, fontSize: 12 }}>{'🗑 ' + t.journal_clear_confirm}</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Input area */}
          <TextInput
            style={[ss.journalInput, { backgroundColor: colors.cardAlt, color: colors.text, borderColor: colors.cardBorder }]}
            placeholder={t.journal_ticker_label}
            placeholderTextColor={colors.textDimmer}
            value={ticker}
            onChangeText={setTicker}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <TextInput
            style={[ss.journalTextarea, { backgroundColor: colors.cardAlt, color: colors.text, borderColor: colors.cardBorder }]}
            placeholder={t.journal_add_placeholder}
            placeholderTextColor={colors.textDimmer}
            value={text}
            onChangeText={setText}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
          />
          <TouchableOpacity onPress={saveEntry} activeOpacity={0.8}>
            <LinearGradient
              colors={['#a78bfa', '#7c3aed']}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              style={ss.journalSaveBtn}>
              <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>{t.journal_save}</Text>
            </LinearGradient>
          </TouchableOpacity>

          {/* Entries list */}
          {entries.length === 0 ? (
            <Text style={[ss.sourceNote, { color: colors.textDimmer, textAlign: 'center', marginTop: 20 }]}>{t.journal_empty}</Text>
          ) : (
            entries.map((e, i) => (
              <View key={i} style={[ss.journalEntry, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}>
                {e.ticker ? <Text style={[ss.jTicker, { color: colors.accent }]}>{e.ticker}</Text> : null}
                <Text style={[ss.jText, { color: colors.text }]}>{e.text}</Text>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={[ss.jDate, { color: colors.textDimmer }]}>{fmtDate(e.date)}</Text>
                  <TouchableOpacity onPress={() => deleteEntry(i)}>
                    <Text style={{ color: colors.red, fontSize: 11 }}>{t.journal_delete}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

// ─── Sub-screen: About ────────────────────────────────────────────────────────
function AboutScreen({ colors, t, insets, isDark, onBack }) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Back button — always visible, above the scroll */}
      <TouchableOpacity
        style={[ss.backLink, {
          borderBottomColor: colors.cardBorder,
          paddingTop: insets.top + 12,
          backgroundColor: colors.bg,
        }]}
        onPress={onBack}>
        <Text style={{ color: colors.accent, fontSize: 14 }}>← {t.more_back}</Text>
      </TouchableOpacity>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        <View style={[ss.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
          {/* Hero monk */}
          <View style={ss.aboutHero}>
            <Image
              source={MONK_ABOUT}
              style={{ width: 160, height: 160 }}
              resizeMode="contain"
            />
          </View>
          {/* ❓ moved to end, ? removed from title */}
          <Text style={[ss.cardTitle, { color: colors.text }]}>{t.more_about_title + ' ❓'}</Text>
          <Text style={[ss.aboutBody, { color: colors.textDim }]}>{t.about_body}</Text>
          <Text style={[ss.aboutBody, { color: colors.textDimmer, marginTop: 12, fontSize: 11 }]}>{t.copyright_notice}</Text>
        </View>
      </ScrollView>
    </View>
  );
}

// ─── Sub-screen: Terms of Service ────────────────────────────────────────────
function ToSScreen({ colors, insets, onBack, t }) {
  const sections = [
    { title: t.tos_s1_title, body: t.tos_s1_body },
    { title: t.tos_s2_title, body: t.tos_s2_body },
    { title: t.tos_s3_title, body: t.tos_s3_body },
    { title: t.tos_s4_title, body: t.tos_s4_body },
    { title: t.tos_s5_title, body: t.tos_s5_body },
    { title: t.tos_s6_title, body: t.tos_s6_body },
    { title: t.tos_s7_title, body: t.tos_s7_body },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TouchableOpacity
        style={[ss.backLink, { borderBottomColor: colors.cardBorder, paddingTop: insets.top + 12, backgroundColor: colors.bg }]}
        onPress={onBack}>
        <Text style={{ color: colors.accent, fontSize: 14 }}>← {t.more_back}</Text>
      </TouchableOpacity>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        <View style={[ss.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
          <Text style={[ss.cardTitle, { color: colors.text }]}>{'🛡️ ' + (t.more_tos_title || 'Terms of Service')}</Text>
          {sections.map((sec, i) => (
            <View key={i} style={[ss.tosSection, { borderBottomColor: colors.cardBorder, borderBottomWidth: i < sections.length - 1 ? 0.5 : 0 }]}>
              <Text style={[ss.tosTitle, { color: colors.text }]}>{sec.title}</Text>
              <Text style={[ss.tosBody, { color: colors.textDim }]}>{sec.body}</Text>
            </View>
          ))}
        </View>
        <Text style={[ss.sourceNote, { color: colors.textDimmer }]}>{t.copyright_notice}</Text>
      </ScrollView>
    </View>
  );
}

// ─── Main MoreScreen ──────────────────────────────────────────────────────────
export default function MoreScreen({ navigation, route }) {
  const { colors, t, isDark, toggleTheme, lang, changeLang, watchlist,
          translateArticles, showLocalCurrency,
          toggleTranslateArticles, toggleShowLocalCurrency, resetSettingsState } = useApp();
  const insets = useSafeAreaInsets();
  const [view, setView] = useState('main'); // 'main' | 'settings' | 'journal' | 'about' | 'tos'
  const [journalInitTicker, setJournalInitTicker] = useState('');

  // If navigated here with addJournalTicker param, open journal automatically
  React.useEffect(() => {
    const tk = route?.params?.addJournalTicker;
    if (tk) { setJournalInitTicker(tk); setView('journal'); }
  }, [route?.params?.addJournalTicker]);

  const shared = { colors, t, insets, isDark, toggleTheme, lang, changeLang, watchlist,
                   translateArticles, showLocalCurrency,
                   toggleTranslateArticles, toggleShowLocalCurrency, resetSettingsState,
                   onBack: () => setView('main') };

  if (view === 'settings') return <SettingsScreen {...shared} />;
  if (view === 'journal')  return <JournalScreen  {...shared} initialTicker={journalInitTicker} />;
  if (view === 'about')    return <AboutScreen    {...shared} />;
  if (view === 'tos')      return <ToSScreen      {...shared} />;

  // ── Main "More" menu ──
  const menuItems = [
    { icon: '📰', gradient: ['#60a5fa', '#2563eb'], title: t.more_news_title,     sub: t.more_news_sub,      action: () => navigation.navigate('NewsTab') },
    { icon: '⭐', gradient: ['#fbbf24', '#d97706'], title: t.more_watchlist_title, sub: t.more_watchlist_sub, action: () => navigation.navigate('WatchlistTab') },
    { icon: '📓', gradient: ['#a78bfa', '#7c3aed'], title: t.more_journal_title,  sub: t.more_journal_sub,   action: () => setView('journal') },
    { icon: '⚙️', gradient: ['#4ade80', '#16a34a'], title: t.more_settings_title, sub: t.more_settings_sub,  action: () => setView('settings') },
    { icon: '🛡️', gradient: ['#34d399', '#059669'], title: t.more_tos_title,      sub: t.more_tos_sub,       action: () => setView('tos') },
    { icon: '❓', gradient: ['#38bdf8', '#6366f1'], title: t.more_about_title,    sub: t.more_about_sub,     action: () => setView('about') },
  ];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>

      {/* Brand Header — greeting per screen like HTML */}
      <BrandHeader greeting={t.greeting_more || 'More Options'} />

      {/* Menu items card */}
      <View style={[ss.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
        <Text style={[ss.cardTitle, { color: colors.text }]}>{'☰ ' + (t.more_title || 'More Options')}</Text>
        {menuItems.map((item, i) => (
          <TouchableOpacity
            key={i}
            style={[ss.moverRow, {
              marginBottom: i < menuItems.length - 1 ? 8 : 0,
              backgroundColor: colors.cardAlt,
              borderColor: colors.cardBorder,
            }]}
            onPress={item.action}
            activeOpacity={0.7}>
            <LinearGradient colors={item.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={ss.moverIcon}>
              <Text style={{ fontSize: 14 }}>{item.icon}</Text>
            </LinearGradient>
            <View style={{ flex: 1 }}>
              <Text style={[ss.mTicker, { color: colors.text }]}>{item.title}</Text>
              <Text style={[ss.mName, { color: colors.textDim }]}>{item.sub}</Text>
            </View>
            <Text style={{ color: colors.textDimmer, fontSize: 16 }}>›</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Language card — matches HTML .lang-grid */}
      <View style={[ss.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
        <Text style={[ss.cardTitle, { color: colors.text }]}>{'🌐 ' + (t.more_language_title || 'Language')}</Text>
        <Text style={[ss.langDesc, { color: colors.textDimmer }]}>
          {t.more_language_sub || 'Change display language'}
        </Text>
        <View style={ss.langGrid}>
          {[
            { code: 'he', label: 'עברית' },
            { code: 'en', label: 'English' },
            { code: 'ru', label: 'Русский' },
            { code: 'es', label: 'Español' },
          ].map(l => (
            <TouchableOpacity
              key={l.code}
              style={[ss.langBtnMain,
                { borderColor: lang === l.code ? colors.purple : colors.cardBorder,
                  backgroundColor: lang === l.code ? colors.purpleBg : colors.cardAlt }]}
              onPress={() => changeLang(l.code)}>
              <Text style={[ss.langBtnText, { color: lang === l.code ? colors.purple : colors.textDim }]}>
                {l.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const ss = StyleSheet.create({
  header:       { paddingBottom: 12, paddingHorizontal: 16, borderBottomWidth: 0.5 },
  headerTitle:  { fontSize: 18, fontWeight: '700', textAlign: 'right' },
  backLink:     { paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 0.5 },
  card:         { margin: 12, borderRadius: 14, padding: 16, borderWidth: 0.5 },
  cardTitle:    { fontSize: 13, fontWeight: '600', marginBottom: 14 },
  // HTML: .mover-row { background:var(--card-alt); border:0.5px; border-radius:10px; padding:10px 12px; margin-bottom:8px }
  moverRow:     { flexDirection: 'row', alignItems: 'center', gap: 10,
                  paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 0.5 },
  // HTML: .mover-icon { width:32px; height:32px; border-radius:8px }
  moverIcon:    { width: 32, height: 32, borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  mTicker:      { fontSize: 13, fontWeight: '600' },
  mName:        { fontSize: 11, marginTop: 2 },

  settingsRow:  { paddingVertical: 14, borderBottomWidth: 0.5, flexDirection: 'row', alignItems: 'center', gap: 12 },

  // .lang-grid { grid-template-columns: repeat(2,1fr); gap:8px }
  langGrid:     { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  // .lang-btn { background:card-alt; border:0.5px; border-radius:10px; padding:10px; font-size:13px }
  langBtnMain:  { width: '47%', borderRadius: 10, paddingVertical: 10, alignItems: 'center', borderWidth: 0.5 },
  langBtnText:  { fontSize: 13, fontWeight: '500' },
  langDesc:     { fontSize: 12, marginBottom: 10 },
  langBtn:      { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, borderWidth: 0.5 },
  langText:     { fontSize: 13, fontWeight: '600' },

  // Journal
  journalInput:    { borderRadius: 10, borderWidth: 0.5, padding: 10, marginBottom: 8, fontSize: 13 },
  journalTextarea: { borderRadius: 10, borderWidth: 0.5, padding: 10, marginBottom: 10, fontSize: 13, minHeight: 80 },
  journalSaveBtn:  { borderRadius: 10, padding: 12, alignItems: 'center', marginBottom: 16 },
  journalEntry:    { borderRadius: 10, borderWidth: 0.5, padding: 10, marginBottom: 8 },
  jTicker:         { fontSize: 12, fontWeight: '600', marginBottom: 4 },
  jText:           { fontSize: 13, lineHeight: 20, marginBottom: 6 },
  jDate:           { fontSize: 11 },

  // About
  aboutHero: { alignItems: 'center', marginBottom: 16 },
  aboutBody: { fontSize: 13, lineHeight: 22 },

  // ToS
  tosSection: { paddingVertical: 14 },
  tosTitle:   { fontSize: 13, fontWeight: '600', marginBottom: 6 },
  tosBody:    { fontSize: 12, lineHeight: 20 },

  sourceNote: { textAlign: 'center', fontSize: 11, marginHorizontal: 16, marginTop: 4 },
});

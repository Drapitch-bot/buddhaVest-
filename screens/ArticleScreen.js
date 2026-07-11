import React, { useState, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, StatusBar, Linking,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../constants/AppContext';
import { translateText } from '../utils/translate';

const TRANSLATE_LANGS = new Set(['he', 'ru', 'es']);

// Injected BEFORE page JS runs — installs a MutationObserver that fires as soon
// as enough paragraph text appears. Works for both SSR and dynamic SPA sites
// (Yahoo Finance, NYT, etc.) because it watches the DOM evolve rather than
// sampling it at a fixed time. Max wait is 10 seconds.
const PREINJECT = [
  '(function(){',
  '  if(window._bvDone)return;',
  '  window._bvDone=false;',
  '  function collect(){',
  '    if(window._bvDone)return;',
  '    var items=[],tags=document.querySelectorAll("h1,h2,h3,p,li");',
  '    for(var i=0;i<tags.length&&items.length<30;i++){',
  '      var el=tags[i],txt=(el.innerText||el.textContent||"").trim();',
  '      if(txt.length>40){el.setAttribute("data-bv",items.length);items.push(txt);}',
  '    }',
  '    if(items.length>=2){',
  '      window._bvDone=true;',
  '      try{window.ReactNativeWebView.postMessage(JSON.stringify({type:"TX_REQ",items:items}));}catch(e){}',
  '    }',
  '  }',
  '  var obs=new MutationObserver(function(){',
  '    if(document.querySelectorAll("p").length>=2){obs.disconnect();setTimeout(collect,400);}',
  '  });',
  '  function start(){',
  '    obs.observe(document.body||document.documentElement,{childList:true,subtree:true});',
  '    setTimeout(function(){obs.disconnect();collect();},10000);',  // 10s hard cap
  '  }',
  '  if(document.body){start();}',
  '  else{document.addEventListener("DOMContentLoaded",start);}',
  '})(); true;',
].join('\n');

export default function ArticleScreen({ route, navigation }) {
  const { url, lang } = route.params || {};
  const { colors, t, translateArticles } = useApp();
  const insets = useSafeAreaInsets();
  const [error, setError] = useState(false);
  const webRef = useRef(null);
  const translatedRef = useRef(false);
  const needsTranslation = translateArticles && lang && TRANSLATE_LANGS.has(lang);

  const handleClose = function() { if (navigation.canGoBack()) navigation.goBack(); };

  // Reset translated flag on each new page load
  const handleLoadStart = useCallback(function() {
    translatedRef.current = false;
  }, []);

  // Translate collected texts and inject them back into the page.
  const handleMessage = useCallback(async function(event) {
    try {
      var msg = JSON.parse(event.nativeEvent.data);
      if (msg.type !== 'TX_REQ' || !msg.items || !msg.items.length) return;
      if (translatedRef.current) return;
      translatedRef.current = true;
      var translated = await Promise.all(
        msg.items.map(function(txt) { return translateText(txt, lang); })
      );
      var json = JSON.stringify(translated);
      var inject = [
        '(function(){',
        '  var t=' + json + ';',
        '  for(var i=0;i<t.length;i++){',
        '    try{',
        '      var q="[data-bv=\\""+i+"\\"]";',
        '      var e=document.querySelector(q);',
        '      if(e&&t[i])e.innerText=t[i];',
        '    }catch(x){}',
        '  }',
        '})(); true;',
      ].join('\n');
      if (webRef.current) webRef.current.injectJavaScript(inject);
    } catch (e) {}
  }, [lang]);

  return (
    <View style={[s.container, { backgroundColor: colors.bg }]}>
      <StatusBar barStyle={colors.statusBar || 'dark-content'} />
      <View style={[s.header, {
        paddingTop: insets.top + 6,
        backgroundColor: colors.card,
        borderBottomColor: colors.cardBorder,
      }]}>
        <TouchableOpacity onPress={handleClose} style={s.closeBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={[s.closeText, { color: colors.primary || '#f59e0b' }]}>
            {'✕  ' + (t.back || 'Back')}
          </Text>
        </TouchableOpacity>
        {needsTranslation && (
          <View style={s.badge}><Text style={s.badgeText}>{'מתורגם'}</Text></View>
        )}
        <TouchableOpacity onPress={function() { if (url) Linking.openURL(url); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={{ color: colors.textDim || '#6b7280', fontSize: 20 }}>{'⧉'}</Text>
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={s.errorWrap}>
          <Text style={[s.errorText, { color: colors.textDim }]}>
            {t.could_not_load || 'Could not load article'}
          </Text>
          <TouchableOpacity onPress={handleClose} style={[s.retryBtn, { borderColor: colors.cardBorder }]}>
            <Text style={{ color: colors.primary || '#f59e0b' }}>{t.back || 'Back'}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <WebView
          ref={webRef}
          source={{ uri: url }}
          style={s.webview}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          startInLoadingState={true}
          allowsInlineMediaPlayback={true}
          userAgent="Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
          injectedJavaScriptBeforeContentLoaded={needsTranslation ? PREINJECT : undefined}
          renderLoading={function() {
            return (
              <View style={[s.loadWrap, { backgroundColor: colors.bg }]}>
                <ActivityIndicator size="large" color={colors.primary || '#f59e0b'} />
              </View>
            );
          }}
          onLoadStart={handleLoadStart}
          onMessage={needsTranslation ? handleMessage : undefined}
          onError={function() { setError(true); }}
          onHttpError={function(e) { if (e.nativeEvent.statusCode >= 500) setError(true); }}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container:  { flex: 1 },
  header:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: 0.5 },
  closeBtn:   { flexDirection: 'row', alignItems: 'center' },
  closeText:  { fontSize: 15, fontWeight: '600' },
  badge:      { backgroundColor: '#4285f4', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText:  { color: '#fff', fontSize: 11, fontWeight: '600' },
  webview:    { flex: 1 },
  loadWrap:   { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                justifyContent: 'center', alignItems: 'center' },
  errorWrap:  { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16 },
  errorText:  { fontSize: 15 },
  retryBtn:   { paddingHorizontal: 20, paddingVertical: 10, borderWidth: 1, borderRadius: 8 },
});

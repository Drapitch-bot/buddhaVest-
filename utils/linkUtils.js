import { Linking } from 'react-native';

/**
 * Opens an article URL.
 * If navigation is provided: opens in-app ArticleScreen with Google Translate injection.
 * Otherwise: falls back to device browser.
 */
export function openArticle(url, lang, navigation) {
  if (!url || !url.trim()) return;
  if (navigation) {
    navigation.navigate('Article', { url, lang });
  } else {
    Linking.openURL(url).catch(function() {});
  }
}

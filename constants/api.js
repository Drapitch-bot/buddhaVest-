export const API_BASE = 'https://buddhavest.onrender.com';

// Everything interpolated into a URL goes through encodeURIComponent.
// Tickers can legitimately contain '.' and '^' (BRK.B, ^GSPC, DLEKG.TA) and a
// malformed one must never be able to alter the request path.
const e = (v) => encodeURIComponent(String(v == null ? '' : v));

// The fallbacks below are English and dollars. Every real caller passes its
// own language and currency, so these are only ever reached when something
// asks without saying - and what it gets then should be the app's default,
// which is English, not the language one of its readers happens to speak.
export const ENDPOINTS = {
  analyze: (ticker, lang = 'en') => `${API_BASE}/analyze/${e(ticker)}?lang=${e(lang)}`,
  search: (q) => `${API_BASE}/search?q=${e(q)}`,
  marketOverview: () => `${API_BASE}/market-overview`,
  news: (lang = 'en') => `${API_BASE}/news?lang=${e(lang)}`,
  stockNews: (ticker, lang = 'en') => `${API_BASE}/news/${e(ticker)}?lang=${e(lang)}`,
  financials: (ticker) => `${API_BASE}/financials/${e(ticker)}`,
  events: (ticker) => `${API_BASE}/events/${e(ticker)}`,
  signals: (ticker, lang = 'en') => `${API_BASE}/signals/${e(ticker)}?lang=${e(lang)}`,
  etfInfo: (ticker) => `${API_BASE}/etf-info/${e(ticker)}`,
  metricHistory: (ticker, metric) => `${API_BASE}/metric-history/${e(ticker)}/${e(metric)}`,
  priceHistory: (ticker) => `${API_BASE}/price-history/${e(ticker)}`,
  exchangeRate: (currency = 'USD') => `${API_BASE}/exchange-rate?currency=${e(currency)}`,
  status: () => `${API_BASE}/status`,
  quotes: (symbols) => `${API_BASE}/quotes?symbols=${e(symbols)}`,
  translateArticle: (url, lang) => `${API_BASE}/translate-article?url=${e(url)}&lang=${e(lang)}`,
};

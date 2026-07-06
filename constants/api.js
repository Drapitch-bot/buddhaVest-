export const API_BASE = 'https://buddhavest.onrender.com';

export const ENDPOINTS = {
  analyze: (ticker, lang = 'he') => `${API_BASE}/analyze/${ticker}?lang=${lang}`,
  search: (q) => `${API_BASE}/search?q=${encodeURIComponent(q)}`,
  marketOverview: () => `${API_BASE}/market-overview`,
  news: (lang = 'en') => `${API_BASE}/news?lang=${lang}`,
  stockNews: (ticker, lang = 'en') => `${API_BASE}/news/${ticker}?lang=${lang}`,
  financials: (ticker) => `${API_BASE}/financials/${ticker}`,
  events: (ticker) => `${API_BASE}/events/${ticker}`,
  signals: (ticker, lang = 'he') => `${API_BASE}/signals/${ticker}?lang=${lang}`,
  etfInfo: (ticker) => `${API_BASE}/etf-info/${ticker}`,
  metricHistory: (ticker, metric) => `${API_BASE}/metric-history/${ticker}/${metric}`,
  priceHistory: (ticker) => `${API_BASE}/price-history/${ticker}`,
  exchangeRate: (currency = 'ILS') => `${API_BASE}/exchange-rate?currency=${currency}`,
  status: () => `${API_BASE}/status`,
};

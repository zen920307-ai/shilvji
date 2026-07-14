/** 简易汇率缓存（来自 Frankfurter 公开 API，无需 key） */
const cache = {
  base: null,
  rates: null,
  at: 0,
};

const SYMBOLS = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CNY: '¥',
  KRW: '₩',
  THB: '฿',
  AUD: 'A$',
  CAD: 'C$',
  SGD: 'S$',
  HKD: 'HK$',
  TWD: 'NT$',
};

export function currencySymbol(code) {
  return SYMBOLS[code] || `${code} `;
}

export function formatMoney(amount, code) {
  if (amount == null || Number.isNaN(Number(amount))) return '—';
  const n = Number(amount);
  const digits = ['JPY', 'KRW', 'VND'].includes(code) ? 0 : 2;
  const sym = currencySymbol(code);
  return `${sym}${n.toFixed(digits)}`;
}

async function fetchRatesToCNY() {
  const now = Date.now();
  if (cache.rates && now - cache.at < 1000 * 60 * 60 * 6) {
    return cache.rates;
  }
  // Frankfurter 免费汇率；以 EUR 为中间价再换算到 CNY
  const res = await fetch('https://api.frankfurter.app/latest?from=EUR');
  if (!res.ok) throw new Error('汇率获取失败');
  const data = await res.json();
  const rates = { EUR: 1, ...data.rates };
  // 转成「1 单位外币 = ? CNY」
  const cnyPerEur = rates.CNY;
  const toCny = {};
  for (const [code, perEur] of Object.entries(rates)) {
    // 1 EUR = perEur CODE, 1 EUR = cnyPerEur CNY → 1 CODE = cnyPerEur/perEur CNY
    toCny[code] = cnyPerEur / perEur;
  }
  toCny.CNY = 1;
  cache.rates = toCny;
  cache.at = now;
  return toCny;
}

export async function toCNY(amount, currencyCode) {
  const code = (currencyCode || 'USD').toUpperCase();
  const n = Number(amount);
  if (Number.isNaN(n)) return null;
  if (code === 'CNY' || code === 'RMB') return n;
  try {
    const rates = await fetchRatesToCNY();
    const rate = rates[code];
    if (!rate) return null;
    return n * rate;
  } catch {
    // 兜底粗略汇率（仅离线时用）
    const fallback = {
      USD: 7.2,
      EUR: 7.8,
      GBP: 9.2,
      JPY: 0.048,
      KRW: 0.0053,
      THB: 0.21,
      AUD: 4.7,
      CAD: 5.2,
      SGD: 5.4,
      HKD: 0.92,
      TWD: 0.22,
    };
    return fallback[code] != null ? n * fallback[code] : null;
  }
}

export async function enrichItemsWithCNY(categories, currency) {
  const code = (currency || 'USD').toUpperCase();
  for (const cat of categories) {
    for (const item of cat.items || []) {
      const cny = await toCNY(item.price, code);
      item.price_cny = cny != null ? Math.round(cny * 100) / 100 : null;
    }
  }
  return categories;
}

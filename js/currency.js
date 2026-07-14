/** 汇率：优先 AI 实时换算，公开接口与离线表兜底 */

import { askText } from './ai.js';

const cache = {
  key: null,
  rate: null,
  source: null,
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

const FALLBACK = {
  USD: 7.24,
  EUR: 7.85,
  GBP: 9.15,
  JPY: 0.048,
  KRW: 0.0053,
  THB: 0.21,
  AUD: 4.75,
  CAD: 5.25,
  SGD: 5.45,
  HKD: 0.93,
  TWD: 0.23,
  CNY: 1,
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

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Frankfurter 公开实时汇率 → 1 外币兑 CNY */
async function fetchRateFrankfurter(code) {
  const res = await fetch(
    `https://api.frankfurter.app/latest?from=${encodeURIComponent(code)}&to=CNY`,
  );
  if (!res.ok) throw new Error('汇率接口失败');
  const data = await res.json();
  const rate = Number(data?.rates?.CNY);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('汇率无效');
  return rate;
}

/** AI 实时汇率：只要求返回数字 */
async function fetchRateViaAI(code, settings) {
  if (!settings?.apiKey?.trim()) return null;
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `今天是 ${today}。请给出 1 ${code} 兑换人民币 CNY 的当前参考中间价汇率。
只输出一个正数（可用小数，如 7.24），不要单位、不要解释、不要其它文字。`;
  const text = await askText(settings, prompt, { maxTokens: 24, temperature: 0 });
  const m = String(text).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const rate = Number(m[1]);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 10000) return null;
  return rate;
}

/**
 * 解析 1 单位外币 ≈ 多少 CNY
 * 策略：AI（有密钥）→ 公开实时接口 → 离线表
 * @returns {Promise<{ rate: number, source: string, currency: string, asOf: number }>}
 */
export async function getFxToCNY(currencyCode, settings = null) {
  const code = (currencyCode || 'USD').toUpperCase();
  if (code === 'CNY' || code === 'RMB') {
    return { rate: 1, source: 'identity', currency: 'CNY', asOf: Date.now() };
  }

  const now = Date.now();
  const cacheKey = `${code}|${settings?.apiKey ? 'ai' : 'pub'}`;
  // 45 分钟内复用，兼顾实时与请求成本
  if (cache.key === cacheKey && cache.rate && now - cache.at < 1000 * 60 * 45) {
    return {
      rate: cache.rate,
      source: cache.source,
      currency: code,
      asOf: cache.at,
    };
  }

  let rate = null;
  let source = 'fallback';

  // 1) 优先 AI 实时换算
  if (settings?.apiKey) {
    try {
      rate = await fetchRateViaAI(code, settings);
      if (rate != null) source = 'ai';
    } catch (e) {
      console.warn('AI 汇率失败，改用公开接口', e);
    }
  }

  // 2) 公开实时接口
  if (rate == null) {
    try {
      rate = await fetchRateFrankfurter(code);
      source = 'live';
    } catch (e) {
      console.warn('公开汇率失败', e);
    }
  }

  // 3) 离线兜底
  if (rate == null) {
    rate = FALLBACK[code] ?? null;
    source = 'offline';
  }

  if (rate == null) {
    return { rate: null, source: 'none', currency: code, asOf: now };
  }

  cache.key = cacheKey;
  cache.rate = rate;
  cache.source = source;
  cache.at = now;

  return { rate, source, currency: code, asOf: now };
}

export function fxSourceLabel(source) {
  if (source === 'ai') return 'AI 实时汇率';
  if (source === 'live') return '实时汇率';
  if (source === 'offline') return '参考汇率';
  if (source === 'identity') return '本币';
  return '汇率';
}

/**
 * 为菜品写入 price_cny
 * @returns {Promise<{ categories: any[], fx: object }>}
 */
export async function enrichItemsWithCNY(categories, currency, settings = null) {
  const fx = await getFxToCNY(currency, settings);
  const rate = fx.rate;
  for (const cat of categories || []) {
    for (const item of cat.items || []) {
      if (item.price != null && rate != null) {
        item.price_cny = round2(Number(item.price) * rate);
      } else {
        item.price_cny = null;
      }
    }
  }
  return { categories, fx };
}

/** @deprecated 兼容：单笔换算 */
export async function toCNY(amount, currencyCode, settings = null) {
  const n = Number(amount);
  if (Number.isNaN(n)) return null;
  const fx = await getFxToCNY(currencyCode, settings);
  if (fx.rate == null) return null;
  return round2(n * fx.rate);
}

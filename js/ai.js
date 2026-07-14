/**
 * 菜单识别：
 * - DeepSeek（纯文本）：本地 OCR → chat/completions 分类翻译
 * - xAI：/v1/responses + input_image
 * - 其它 OpenAI 兼容：chat/completions + image_url
 */

import { ocrMenuFiles } from './ocr.js';

export const CATEGORY_ORDER = [
  '推荐',
  '特色',
  '开胃',
  '前菜',
  '沙拉',
  '汤',
  '主食',
  '主菜',
  '肉类',
  '海鲜',
  '意面',
  '面',
  '饭',
  '披萨',
  '寿司',
  '烧烤',
  '炸物',
  '素食',
  '小食',
  '配菜',
  '甜点',
  '甜品',
  '饮品',
  '酒',
  '咖啡',
  '茶',
  '其他',
];

const SYSTEM_PROMPT = `你是专业的餐厅菜单整理 + 智能分类 + 翻译引擎。
用户会提供菜单照片的 OCR 原文，或（若支持看图）直接提供菜单照片。

任务：
1. 从原文/图片中整理所有菜品
2. **分类规则（很重要）**：
   - **优先使用菜单上已有的分类标题**（如 Starters / Mains / Desserts / Drinks、前菜/主菜等），原样保留 name_original，并给出 name_zh
   - 只有当菜单**没有**清晰分类、或某道菜落在分类外时，才按菜品类型智能归入（前菜/沙拉/汤/主菜/肉类/海鲜/意面/披萨/寿司/烧烤/炸物/素食/小食/甜点/饮品/酒水 等）
   - 不要把菜单原有分类打散重排成另一套完全不同的名字（除非原分类无法识别）
3. 中文翻译菜名与分类
4. 识别货币与价格

严格只输出一个 JSON 对象（不要 markdown 代码块，不要解释）：
{
  "restaurant_name": "餐厅名（看不清则写「未知餐厅」）",
  "currency": "ISO货币代码，如 USD/EUR/JPY/GBP/KRW/THB",
  "language": "菜单原文主要语言",
  "categories": [
    {
      "name_zh": "分类中文名",
      "name_original": "分类原文（优先菜单上的标题）",
      "items": [
        {
          "name_zh": "菜名中文",
          "name_original": "菜名原文（必须完整准确）",
          "price": 12.5,
          "description_zh": "一句中文简介，无则空字符串",
          "search_query": "用于搜图的简短英文食物名，如 carbonara pasta，不要整句"
        }
      ]
    }
  ]
}

规则：
1. **只收录带明确价格的菜品**。没有价格、看不清价格的行一律不要输出（price 必须是有效数字，禁止 null）
2. **只收录可点的食物/饮品**。不要输出：餐厅名、地址、电话、营业时间、税费说明、页眉页脚、过敏原声明、服务费、二维码说明、纯分类标题行、装饰文字等非菜品内容
3. 不要编造不存在的菜；OCR 可能有错字，可轻微校正菜名，但不虚构新菜
4. 分类干净，同类合并；**有原分类就跟原分类**
5. 展示顺序尽量贴近菜单阅读顺序
6. name_original 尽量忠实原文
7. search_query 必须是该菜品的标准英文菜名（如 "caesar salad"），用于搜图，禁止写无关词`;

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function compressImage(file, maxSide = 1600, quality = 0.82) {
  const dataUrl = await fileToDataUrl(file);
  const img = await loadImage(dataUrl);
  let { width, height } = img;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  width = Math.round(width * scale);
  height = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function extractJson(text) {
  if (!text) throw new Error('模型未返回内容');
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('无法解析菜单 JSON');
  return JSON.parse(t.slice(start, end + 1));
}

function categorySortKey(nameZh = '') {
  const n = String(nameZh);
  for (let i = 0; i < CATEGORY_ORDER.length; i++) {
    if (n.includes(CATEGORY_ORDER[i])) return i;
  }
  return 50;
}

function isValidPrice(price) {
  if (price == null || price === '') return false;
  const n = Number(price);
  return Number.isFinite(n) && n > 0;
}

/** 过滤明显不是菜品的名字 */
function looksLikeDishName(name = '') {
  const s = String(name).trim();
  if (s.length < 2) return false;
  const bad =
    /^(tel|phone|www\.|http|open|close|tax|vat|service|address|wifi|qr|menu|page|\d{2,}[:.]\d{2})/i.test(
      s,
    ) ||
    /营业|电话|地址|税|服务费|欢迎光临|扫码|微信|页码/.test(s);
  return !bad;
}

function normalizeMenu(raw) {
  const menu = {
    restaurant_name: raw.restaurant_name || '未知餐厅',
    currency: (raw.currency || 'USD').toUpperCase(),
    language: raw.language || '',
    categories: [],
  };

  const cats = Array.isArray(raw.categories) ? raw.categories : [];
  for (const c of cats) {
    const items = (c.items || [])
      .map((it, idx) => {
        const price = isValidPrice(it.price) ? Number(it.price) : null;
        return {
          id: `dish_${Math.random().toString(36).slice(2, 9)}_${idx}`,
          name_zh: it.name_zh || it.name_original || '未知菜品',
          name_original: it.name_original || it.name_zh || 'Unknown',
          price,
          description_zh: it.description_zh || '',
          search_query: String(it.search_query || it.name_original || it.name_zh || '')
            .trim()
            .slice(0, 48),
        };
      })
      // 无价格 / 非菜品 → 丢弃
      .filter(
        (it) =>
          isValidPrice(it.price) &&
          looksLikeDishName(it.name_original) &&
          looksLikeDishName(it.name_zh),
      );

    if (items.length) {
      menu.categories.push({
        name_zh: c.name_zh || c.name_original || '其他',
        name_original: c.name_original || c.name_zh || 'Other',
        items,
      });
    }
  }

  menu.categories.sort(
    (a, b) => categorySortKey(a.name_zh) - categorySortKey(b.name_zh),
  );

  if (!menu.categories.length) {
    throw new Error('没有识别到带价格的菜品，请换更清晰的菜单照片再试');
  }
  return menu;
}

export function detectProvider(baseUrl = '') {
  const u = (baseUrl || '').toLowerCase();
  if (/deepseek\.com/i.test(u)) return 'deepseek';
  if (/api\.x\.ai|x\.ai/i.test(u)) return 'xai';
  if (/openai\.com/i.test(u)) return 'openai';
  return 'openai-compat';
}

/** DeepSeek / 纯文本模型：不能直接看图，走 OCR + 文本 */
export function needsLocalOcr(baseUrl = '', model = '') {
  const p = detectProvider(baseUrl);
  if (p === 'deepseek') return true;
  // 显式纯文本模型名
  if (/deepseek/i.test(model) && !/vl|vision|image/i.test(model)) return true;
  return false;
}

function isXaiBase(baseUrl = '') {
  return detectProvider(baseUrl) === 'xai';
}

function appBasePath() {
  const b = import.meta.env.BASE_URL || '/';
  return b.endsWith('/') ? b.slice(0, -1) : b;
}

/**
 * 解析实际请求 URL
 * - 开发：Vite 代理 /ai-proxy-deepseek
 * - 生产：同源 /api/deepseek（Cloudflare Pages Functions）
 * - 可选 VITE_API_PROXY 覆盖
 */
function resolveEndpoint(baseUrl, path = '/chat/completions') {
  const base = (baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
  const pathNorm = path.startsWith('/') ? path : `/${path}`;
  const chatPath = pathNorm === '/chat/completions' ? '/chat/completions' : pathNorm;
  const envProxy = (import.meta.env.VITE_API_PROXY || '').replace(/\/$/, '');

  if (envProxy) {
    if (/deepseek\.com/i.test(base)) return `${envProxy}/deepseek${chatPath}`;
    if (/api\.x\.ai/i.test(base)) {
      const suffix = base.replace(/^https?:\/\/api\.x\.ai/i, '') || '/v1';
      return `${envProxy}/xai${suffix}${pathNorm}`;
    }
  }

  const isBrowser = typeof window !== 'undefined';
  const host = isBrowser ? window.location.hostname : '';
  const isLocal = !host || host === 'localhost' || host === '127.0.0.1';

  // 生产：走同源代理（Cloudflare Pages Functions）
  if (isBrowser && !isLocal && !import.meta.env.DEV) {
    const root = appBasePath();
    if (/deepseek\.com/i.test(base)) return `${root}/api/deepseek${chatPath}`;
    if (/api\.x\.ai/i.test(base)) {
      const suffix = base.replace(/^https?:\/\/api\.x\.ai/i, '') || '/v1';
      return `${root}/api/xai${suffix}${pathNorm}`;
    }
  }

  // 开发：Vite 代理
  if (import.meta.env.DEV) {
    if (/deepseek\.com/i.test(base)) return `/ai-proxy-deepseek${chatPath}`;
    if (/api\.x\.ai/i.test(base)) {
      const suffix = base.replace(/^https?:\/\/api\.x\.ai/i, '') || '/v1';
      return `/ai-proxy${suffix}${pathNorm}`;
    }
  }

  if (/api\.deepseek\.com$/i.test(base)) return `${base}${chatPath}`;
  return `${base}${pathNorm}`;
}

async function readError(res) {
  let detail = '';
  try {
    const err = await res.json();
    detail = err.error?.message || err.message || JSON.stringify(err);
  } catch {
    try {
      detail = await res.text();
    } catch {
      detail = res.statusText;
    }
  }
  return detail || res.statusText;
}

function extractResponseText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string' && data.output_text) {
    return data.output_text;
  }
  if (Array.isArray(data.output)) {
    const chunks = [];
    for (const item of data.output) {
      if (typeof item?.content === 'string') chunks.push(item.content);
      if (Array.isArray(item?.content)) {
        for (const c of item.content) {
          if (typeof c?.text === 'string') chunks.push(c.text);
        }
      }
    }
    if (chunks.length) return chunks.join('\n');
  }
  const choice = data.choices?.[0]?.message?.content;
  if (typeof choice === 'string') return choice;
  // DeepSeek thinking 模式可能把内容放在 reasoning，但最终 content 应有答案
  if (data.choices?.[0]?.message?.reasoning_content && !choice) {
    return data.choices[0].message.reasoning_content;
  }
  return '';
}

async function postJson(endpoint, apiKey, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await readError(res);
    throw new Error(`AI 请求失败 (${res.status}): ${detail || res.statusText}`);
  }
  return res.json();
}

/**
 * 轻量文本问答（用于实时汇率等）
 * @param {{ apiKey: string, baseUrl?: string, model?: string }} settings
 * @param {string} prompt
 */
export async function askText(settings, prompt, { maxTokens = 48, temperature = 0 } = {}) {
  if (!settings?.apiKey?.trim()) throw new Error('缺少 API Key');
  const base = settings.baseUrl || 'https://api.deepseek.com';
  const provider = detectProvider(base);
  const useResponses = provider === 'xai';
  const endpoint = resolveEndpoint(
    base,
    useResponses ? '/responses' : '/chat/completions',
  );
  const model =
    settings.model ||
    (provider === 'deepseek' ? 'deepseek-v4-flash' : 'grok-4.5');

  const body = useResponses
    ? {
        model,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: prompt }],
          },
        ],
      }
    : {
        model,
        temperature,
        max_tokens: maxTokens,
        ...(provider === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
        messages: [{ role: 'user', content: prompt }],
      };

  const data = await postJson(endpoint, settings.apiKey.trim(), body);
  return extractResponseText(data).trim();
}

/**
 * 测试连接（纯文本）
 */
export async function testApiConnection(settings) {
  if (!settings?.apiKey?.trim()) {
    throw new Error('请先填写 API Key');
  }
  const base = settings.baseUrl || 'https://api.deepseek.com';
  const provider = detectProvider(base);
  const useResponses = provider === 'xai';
  const endpoint = resolveEndpoint(
    base,
    useResponses ? '/responses' : '/chat/completions',
  );
  const model =
    settings.model ||
    (provider === 'deepseek' ? 'deepseek-v4-flash' : 'grok-4.5');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  const body = useResponses
    ? {
        model,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'Reply with exactly: OK' }],
          },
        ],
      }
    : {
        model,
        temperature: 0,
        max_tokens: 32,
        // DeepSeek 测试时关闭 thinking 更快
        ...(provider === 'deepseek'
          ? { thinking: { type: 'disabled' } }
          : {}),
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey.trim()}`,
      },
      signal: controller.signal,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await readError(res);
      if (res.status === 401 || res.status === 403) {
        throw new Error(`鉴权失败 (${res.status})：Key 无效或权限不足`);
      }
      throw new Error(`连接失败 (${res.status})：${detail}`);
    }

    const data = await res.json();
    const text = extractResponseText(data);
    return {
      ok: true,
      model,
      preview: String(text).slice(0, 80),
      message:
        provider === 'deepseek'
          ? 'DeepSeek 已连通（识菜单将：本地读字 + 云端翻译）'
          : '连接成功，API 可用',
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('连接超时，请检查网络或 Base URL');
    }
    if (
      err.message?.includes('Failed to fetch') ||
      err.message?.includes('NetworkError')
    ) {
      throw new Error('网络错误：无法访问 API（CORS / 断网 / URL 错误）。请用 npm run dev 启动以启用代理。');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * DeepSeek：OCR 文本 → 分类翻译
 */
async function parseViaDeepSeekText(files, settings, progress) {
  progress('ocr', { total: files.length, current: 0 });
  const ocrText = await ocrMenuFiles(files, ({ index, total, progress: p }) => {
    progress('ocr', { total, current: index, progress: p });
  });

  progress('ai', { phase: 'request' });
  const model = settings.model || 'deepseek-v4-flash';
  const endpoint = resolveEndpoint(settings.baseUrl || 'https://api.deepseek.com', '/chat/completions');

  const body = {
    model,
    temperature: 0.2,
    // 非思考模式更稳、更快出 JSON
    thinking: { type: 'disabled' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `以下是菜单照片的 OCR 原文（可能有识别错误，请智能校正但不虚构新菜）。请按系统要求只输出 JSON。\n\n${ocrText}`,
      },
    ],
  };

  const data = await postJson(endpoint, settings.apiKey, body);
  progress('ai', { phase: 'response' });
  const text = extractResponseText(data);
  progress('parse');
  return normalizeMenu(extractJson(text));
}

/**
 * xAI 看图
 */
async function parseViaXaiVision(files, settings, progress) {
  progress('compress', { total: files.length, current: 0 });
  const images = [];
  for (let i = 0; i < files.length; i++) {
    progress('compress', { total: files.length, current: i + 1 });
    images.push(await compressImage(files[i]));
  }
  progress('upload', { total: images.length });
  progress('ai', { phase: 'request' });

  const endpoint = resolveEndpoint(settings.baseUrl || 'https://api.x.ai/v1', '/responses');
  const content = [
    ...images.map((url) => ({
      type: 'input_image',
      image_url: url,
      detail: 'high',
    })),
    {
      type: 'input_text',
      text: `${SYSTEM_PROMPT}\n\n请解析菜单照片，只输出 JSON。`,
    },
  ];
  const data = await postJson(endpoint, settings.apiKey, {
    model: settings.model || 'grok-4.5',
    store: false,
    input: [{ role: 'user', content }],
  });
  progress('ai', { phase: 'response' });
  progress('parse');
  return normalizeMenu(extractJson(extractResponseText(data)));
}

/**
 * OpenAI 兼容看图
 */
async function parseViaOpenAiVision(files, settings, progress) {
  progress('compress', { total: files.length, current: 0 });
  const images = [];
  for (let i = 0; i < files.length; i++) {
    progress('compress', { total: files.length, current: i + 1 });
    images.push(await compressImage(files[i]));
  }
  progress('upload', { total: images.length });
  progress('ai', { phase: 'request' });

  const endpoint = resolveEndpoint(settings.baseUrl, '/chat/completions');
  const content = [
    { type: 'text', text: '请解析以下菜单照片，按系统要求只输出 JSON。' },
    ...images.map((url) => ({
      type: 'image_url',
      image_url: { url, detail: 'high' },
    })),
  ];
  const data = await postJson(endpoint, settings.apiKey, {
    model: settings.model || 'gpt-4o',
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
    ],
  });
  progress('ai', { phase: 'response' });
  progress('parse');
  return normalizeMenu(extractJson(extractResponseText(data)));
}

/**
 * @param {File[]} files
 * @param {{ apiKey: string, baseUrl: string, model: string }} settings
 * @param {(step: string, meta?: object) => void} [onProgress]
 */
export async function parseMenuFromImages(files, settings, onProgress) {
  const progress = typeof onProgress === 'function' ? onProgress : () => {};

  if (!settings?.apiKey) {
    throw new Error('请先在设置中配置 API Key');
  }
  if (!files?.length) {
    throw new Error('请先拍摄或上传菜单照片');
  }

  const base = settings.baseUrl || 'https://api.deepseek.com';
  const provider = detectProvider(base);

  let menu;
  try {
    if (needsLocalOcr(base, settings.model) || provider === 'deepseek') {
      menu = await parseViaDeepSeekText(files, settings, progress);
    } else if (provider === 'xai') {
      menu = await parseViaXaiVision(files, settings, progress);
    } else {
      menu = await parseViaOpenAiVision(files, settings, progress);
    }
  } catch (err) {
    // 若走看图失败且像「不支持图片」，自动降级 OCR + 文本
    const msg = err?.message || '';
    if (
      provider !== 'deepseek' &&
      /image|vision|multimodal|unknown variant|not support/i.test(msg)
    ) {
      progress('ocr', { note: '看图失败，改用本地读字…' });
      menu = await parseViaDeepSeekText(files, settings, progress);
    } else {
      throw err;
    }
  }

  progress('classify', {
    categories: menu.categories.length,
    dishes: menu.categories.reduce((n, c) => n + c.items.length, 0),
  });

  return menu;
}

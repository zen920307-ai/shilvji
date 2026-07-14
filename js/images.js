/**
 * 菜品配图 — 按「菜名」生成/检索，避免张冠李戴
 *
 * 策略（免费）：
 * 1. 优先用 Pollinations 按完整菜名生成「食物摄影」图（与菜名语义绑定，不会乱配）
 * 2. TheMealDB 仅在英文菜名高度匹配时使用真实照片
 * 3. 失败则 emoji
 */

const emojiPool = ['🥗', '🍝', '🍣', '🥩', '🍜', '🍕', '🥘', '🍲', '🍤', '🍰', '☕', '🥐', '🐟', '🍗', '🥙', '🍛'];

const cache = new Map();

export function dishEmoji(name = '') {
  let h = 0;
  const s = String(name);
  for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i) * (i + 1)) % emojiPool.length;
  return emojiPool[h];
}

function cleanQuery(q) {
  return String(q || '')
    .replace(/[^\w\s\u4e00-\u9fff'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
}

function hash(s) {
  let h = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 100000;
}

function tokens(s) {
  return cleanQuery(s)
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/^(the|and|with|from|style|house|chef|special|fresh|home)$/i.test(w));
}

function nameScore(query, mealName) {
  const qt = tokens(query);
  if (!qt.length) return 0;
  const n = cleanQuery(mealName).toLowerCase();
  let hits = 0;
  for (const w of qt) {
    if (n.includes(w)) hits += 1;
  }
  return hits / qt.length;
}

/** 构建「只描述这道菜」的英文提示，降低跑题 */
function buildFoodPrompt(query, nameOriginal, nameZh) {
  const main = cleanQuery(query || nameOriginal || nameZh || 'gourmet dish');
  // 中文菜名时仍带上原文英文 search_query
  const label = cleanQuery(nameOriginal || '') || main;
  return [
    `professional restaurant food photography`,
    `single plated dish: ${main}`,
    label !== main ? `also known as ${label}` : '',
    `appetizing, top-down or 45 degree, soft natural light`,
    `only the food on a plate, no people, no menu text, no watermark`,
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * Pollinations：按菜名生成图（免费、与菜名绑定）
 * 文档式公开接口，无需 Key
 */
function pollinationsUrl(query, nameOriginal, nameZh) {
  const prompt = buildFoodPrompt(query, nameOriginal, nameZh);
  const seed = hash(prompt);
  // 使用 flux 类默认模型；nologo 去水印
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true&enhance=true&seed=${seed}`;
}

/** TheMealDB：仅高置信真实照片 */
async function searchThemealdbStrict(query) {
  const q = cleanQuery(query);
  if (!q || q.length < 3) return null;
  // 需要有拉丁字母才适合 TheMealDB（以西餐为主）
  if (!/[a-zA-Z]{3,}/.test(q)) return null;

  const words = tokens(q);
  const tries = [words.slice(0, 3).join(' '), words.slice(0, 2).join(' '), words[0]].filter(
    (t, i, a) => t && a.indexOf(t) === i,
  );

  let best = null;
  let bestScore = 0;

  for (const term of tries) {
    try {
      const url = `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(term)}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      for (const meal of data?.meals || []) {
        const score = Math.max(nameScore(q, meal.strMeal || ''), nameScore(term, meal.strMeal || ''));
        // 要求很高：0.75+ 且菜名不能太短乱配
        if (score > bestScore && score >= 0.75 && meal.strMealThumb) {
          bestScore = score;
          best = meal.strMealThumb;
        }
      }
    } catch {
      /* next */
    }
  }
  return best;
}

/**
 * 解析单道菜图片
 * @param {{ search_query?: string, name_original?: string, name_zh?: string }} item
 */
export async function resolveFoodImageForItem(item) {
  const query = cleanQuery(item.search_query || item.name_original || item.name_zh || '');
  const cacheKey = query.toLowerCase();
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  // 1) 高置信真实图
  let url = null;
  try {
    url = await searchThemealdbStrict(item.search_query || item.name_original || '');
  } catch {
    url = null;
  }

  // 2) 按菜名生成（与菜名语义一致，不会配成别的菜）
  if (!url) {
    url = pollinationsUrl(item.search_query, item.name_original, item.name_zh);
  }

  cache.set(cacheKey, url);
  return url;
}

/** @deprecated 兼容旧调用 */
export async function resolveFoodImage(query) {
  return resolveFoodImageForItem({ search_query: query });
}

/**
 * 并行挂图
 * @param {Array} categories
 */
export async function attachImages(categories) {
  const items = [];
  for (const cat of categories) {
    for (const item of cat.items || []) items.push(item);
  }

  let i = 0;
  const concurrency = 4;

  async function worker() {
    while (i < items.length) {
      const item = items[i++];
      item.emoji = dishEmoji(item.name_original || item.name_zh);
      item.image_url = null;
      try {
        item.image_url = await resolveFoodImageForItem(item);
      } catch {
        item.image_url = null;
      }
    }
  }

  if (items.length) {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
    );
  }
  return categories;
}

export function foodImageUrl(query) {
  return pollinationsUrl(query, query, '');
}

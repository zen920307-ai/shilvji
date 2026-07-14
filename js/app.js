import {
  loadSettings,
  saveSettings,
  loadHistory,
  addHistoryEntry,
  deleteHistoryEntry,
  uid,
  PROVIDER_PRESETS,
} from './storage.js';
import { parseMenuFromImages, testApiConnection } from './ai.js';
import { formatMoney, enrichItemsWithCNY, fxSourceLabel } from './currency.js';
import { attachImages, dishEmoji } from './images.js';

/** @typedef {{ id: string, name_zh: string, name_original: string, price: number|null, price_cny: number|null, description_zh?: string, image_url?: string, emoji?: string }} Dish */
/** @typedef {{ name_zh: string, name_original: string, items: Dish[] }} Category */
/** @typedef {{ restaurant_name: string, currency: string, language?: string, categories: Category[] }} Menu */

/** 识别流水线步骤 — 文案偏旅记口吻 */
const PIPELINE_STEPS = [
  { id: 'compress', label: '收纳影像', en: 'FRAME', detail: '把菜单照片收成更轻的样子' },
  { id: 'ocr', label: '本地读字', en: 'OCR', detail: '在本机辨认菜单文字（DeepSeek 路径）' },
  { id: 'upload', label: '装进行囊', en: 'PACK', detail: '整理待读的菜单页' },
  { id: 'ai', label: '云端翻译整理', en: 'AI', detail: '分类、翻译、理出点单结构' },
  { id: 'parse', label: '理出脉络', en: 'MAP', detail: '抽出菜名、价格与层次' },
  { id: 'classify', label: '分门别类', en: 'SORT', detail: '前菜、主菜、甜与酒…' },
  { id: 'currency', label: '换算心中的价', en: 'RATE', detail: '折成熟悉的人民币' },
  { id: 'images', label: '检索配图', en: 'IMAGE', detail: '免费图库匹配真实菜品照片' },
  { id: 'done', label: '册子就绪', en: 'READY', detail: '可以慢慢点了' },
];

const state = {
  view: 'capture', // capture | loading | menu | order | receipt | history | history-detail
  photos: /** @type {{ id: string, file: File, url: string }[]} */ ([]),
  menu: /** @type {Menu|null} */ (null),
  activeCat: 0,
  /** @type {Record<string, { dish: Dish, qty: number }>} */
  cart: {},
  orderItems: /** @type {{ dish: Dish, qty: number }[]} */ ([]),
  /** 点完后的购物清单快照 */
  receipt: null,
  historyDetail: null,
  settings: loadSettings(),
  /** @type {{ stepId: string, note: string, meta: object }} */
  pipeline: { stepId: 'compress', note: '', meta: {} },
  apiTest: { status: 'idle', message: '' }, // idle | testing | ok | error
  /** 进行中任务世代号：递增后丢弃旧任务结果 */
  taskGen: 0,
  locating: false,
};

const main = document.getElementById('main');
const cartBar = document.getElementById('cart-bar');
const cartCountEl = document.getElementById('cart-count');
const cartTotalEl = document.getElementById('cart-total');
const cartTotalOrigEl = document.getElementById('cart-total-orig');
const modalSettings = document.getElementById('modal-settings');
const toastEl = document.getElementById('toast');

function zenCredit(tag = '') {
  return `<footer class="zen-footer"><em>DESIGN BY ZEN</em>${tag ? ` · ${tag}` : ' · 食旅集'}</footer>`;
}

/** 统一返回按钮结构：箭头固定槽位，保证左对齐一致 */
function backBtn(id, label) {
  return `<button type="button" class="back-link" id="${id}"><span class="back-link-ico" aria-hidden="true">←</span><span class="back-link-txt">${escapeHtml(label)}</span></button>`;
}

const ASSET_BASE = import.meta.env.BASE_URL || '/';
function asset(path) {
  return `${ASSET_BASE}${String(path).replace(/^\//, '')}`;
}

const ARROW_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14M13 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// —— UI helpers ——
/** 弱化提示：显示在顶部「食旅集」标题后 */
function toast(msg, ms = 2400) {
  const hint = document.getElementById('brand-hint');
  if (hint) {
    hint.textContent = String(msg || '');
    hint.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      hint.classList.remove('show');
      // 淡出后再清空，避免闪一下空位
      setTimeout(() => {
        if (!hint.classList.contains('show')) hint.textContent = '';
      }, 280);
    }, ms);
    return;
  }
  // 兜底
  if (toastEl) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.add('hidden'), ms);
  }
}

function goHome() {
  if (state.view === 'loading') {
    const ok = window.confirm('有任务正在进行中，需要终止任务吗？');
    if (!ok) return;
    state.taskGen += 1;
    state.pipeline = { stepId: 'compress', note: '', meta: {} };
  }
  state.view = 'capture';
  state.receipt = null;
  render();
}

/** 实测底栏高度，避免预留过大导致「底部大片空白」 */
function syncBottomBars() {
  const analyze = document.querySelector('.analyze-wrap');
  if (analyze) {
    const h = Math.ceil(analyze.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty('--analyze-h', `${h}px`);
  }
  if (cartBar && !cartBar.classList.contains('hidden')) {
    const h = Math.ceil(cartBar.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty('--cart-h', `${h}px`);
    main?.classList.add('has-cart');
  } else {
    main?.classList.remove('has-cart');
  }
}

function pressFlash(el) {
  if (!el) return;
  el.classList.add('is-pressing');
  window.setTimeout(() => el.classList.remove('is-pressing'), 160);
}

function openSettings() {
  document.getElementById('cfg-api-key').value = state.settings.apiKey || '';
  document.getElementById('cfg-base-url').value =
    state.settings.baseUrl || 'https://api.deepseek.com';
  document.getElementById('cfg-model').value =
    state.settings.model || 'deepseek-v4-flash';
  document.getElementById('cfg-currency').value = state.settings.currency || 'auto';
  state.apiTest = { status: 'idle', message: '' };
  updateApiTestUI();
  highlightPreset();
  modalSettings.classList.remove('hidden');
}

function highlightPreset() {
  const url = (document.getElementById('cfg-base-url')?.value || '').toLowerCase();
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    const key = btn.getAttribute('data-preset');
    const preset = PROVIDER_PRESETS[key];
    const on = preset && url.includes(new URL(preset.baseUrl).hostname.replace('api.', ''));
    // simpler match
    let active = false;
    if (key === 'deepseek') active = /deepseek/.test(url);
    if (key === 'xai') active = /x\.ai/.test(url);
    if (key === 'openai') active = /openai/.test(url);
    btn.classList.toggle('active', active);
  });
}

function applyPreset(key) {
  const preset = PROVIDER_PRESETS[key];
  if (!preset) return;
  document.getElementById('cfg-base-url').value = preset.baseUrl;
  document.getElementById('cfg-model').value = preset.model;
  highlightPreset();
  toast(`已填入 ${preset.label} 默认地址与模型`);
}

function closeSettings() {
  modalSettings.classList.add('hidden');
}

function readSettingsForm() {
  return {
    apiKey: document.getElementById('cfg-api-key').value.trim(),
    baseUrl:
      document.getElementById('cfg-base-url').value.trim() || 'https://api.deepseek.com',
    model:
      document.getElementById('cfg-model').value.trim() || 'deepseek-v4-flash',
    currency: document.getElementById('cfg-currency').value || 'auto',
  };
}

function updateApiTestUI() {
  const box = document.getElementById('api-test-result');
  const btn = document.getElementById('btn-test-api');
  if (!box || !btn) return;
  const { status, message } = state.apiTest;
  box.className = `api-test-result status-${status}`;
  box.classList.toggle('hidden', status === 'idle' && !message);
  if (status === 'idle' && !message) {
    box.textContent = '';
  } else {
    box.textContent = message;
  }
  btn.disabled = status === 'testing';
  btn.textContent = status === 'testing' ? '试着连通…' : '试一下能否连通';
}

async function runApiTest() {
  const cfg = readSettingsForm();
  state.apiTest = { status: 'testing', message: '正在试着敲门…' };
  updateApiTestUI();
  try {
    const result = await testApiConnection(cfg);
    state.apiTest = {
      status: 'ok',
      message: `✓ 连通顺利 · ${result.model}${result.preview ? ` · 「${result.preview}」` : ''}`,
    };
    toast('通了 · 可以启程识菜单');
  } catch (err) {
    state.apiTest = {
      status: 'error',
      message: `✕ ${err.message || '连接失败'}`,
    };
    toast(err.message || '还连不上，再检查一下密钥', 3200);
  }
  updateApiTestUI();
}

function setPipeline(stepId, note = '', meta = {}) {
  // 任务已终止则不再刷新 loading
  if (state.view !== 'loading' && state.view !== 'menu') {
    /* allow other views */
  }
  state.pipeline = { stepId, note, meta };
  if (state.view === 'loading') {
    // 局部更新 loading UI，避免整页闪烁
    const root = document.getElementById('pipeline-root');
    if (root) {
      root.outerHTML = renderPipeline();
    } else {
      render();
    }
  }
}

function cartStats() {
  let count = 0;
  let totalCny = 0;
  let totalOrig = 0;
  let hasOrig = false;
  for (const { dish, qty } of Object.values(state.cart)) {
    count += qty;
    if (dish.price_cny != null) totalCny += dish.price_cny * qty;
    if (dish.price != null) {
      totalOrig += dish.price * qty;
      hasOrig = true;
    }
  }
  return { count, totalCny, totalOrig, hasOrig };
}

function updateCartBar() {
  const show = state.view === 'menu' && Object.keys(state.cart).length > 0;
  cartBar.classList.toggle('hidden', !show);
  main?.classList.toggle('has-cart', show);
  if (!show) {
    requestAnimationFrame(syncBottomBars);
    return;
  }
  const { count, totalCny, totalOrig, hasOrig } = cartStats();
  cartCountEl.textContent = String(count);
  const cur = state.menu?.currency || 'USD';
  // 主显示原价，人民币弱化
  cartTotalEl.textContent = hasOrig ? formatMoney(totalOrig, cur) : `¥${totalCny.toFixed(2)}`;
  cartTotalOrigEl.textContent =
    totalCny > 0 ? `约 ¥${totalCny.toFixed(2)}` : '';
  requestAnimationFrame(syncBottomBars);
}

// —— Capture photos ——
function addFiles(fileList) {
  const files = Array.from(fileList || []).filter(isImageFile);
  if (!files.length) {
    toast('请选菜单照片');
    return;
  }
  for (const file of files) {
    const id = uid('photo');
    const url = URL.createObjectURL(file);
    state.photos.push({ id, file, url });
  }
  render();
}

function removePhoto(id) {
  const idx = state.photos.findIndex((p) => p.id === id);
  if (idx >= 0) {
    URL.revokeObjectURL(state.photos[idx].url);
    state.photos.splice(idx, 1);
    render();
  }
}

async function startAnalyze() {
  if (!state.photos.length) {
    toast('先拍下或选入菜单吧');
    return;
  }
  if (!state.settings.apiKey) {
    toast('先填好密钥，再读菜单');
    openSettings();
    return;
  }

  const myGen = ++state.taskGen;
  state.view = 'loading';
  state.cart = {};
  state.menu = null;
  state.pipeline = { stepId: 'compress', note: '准备中…', meta: {} };
  render();

  try {
    const files = state.photos.map((p) => p.file);
    let menu = await parseMenuFromImages(files, state.settings, (step, meta = {}) => {
      if (myGen !== state.taskGen) return;
      if (step === 'compress') {
        const cur = meta.current || 0;
        const total = meta.total || files.length;
        setPipeline(
          'compress',
          cur ? `第 ${cur} / ${total} 页菜单` : '轻轻收起照片…',
          meta,
        );
      } else if (step === 'ocr') {
        const cur = meta.current || 0;
        const total = meta.total || files.length;
        const pct = meta.progress != null ? Math.round(meta.progress * 100) : 0;
        setPipeline(
          'ocr',
          meta.note ||
            (cur ? `本地读字 ${cur}/${total}${pct ? ` · ${pct}%` : ''}` : '本机辨认菜单文字…'),
          meta,
        );
      } else if (step === 'upload') {
        setPipeline('upload', `${meta.total || files.length} 页已装进行囊`, meta);
      } else if (step === 'ai') {
        setPipeline(
          'ai',
          meta.phase === 'response' ? 'DeepSeek 正在整理…' : '交给云端分类翻译…',
          meta,
        );
      } else if (step === 'parse') {
        setPipeline('parse', '把菜名与价格一一写下…', meta);
      } else if (step === 'classify') {
        setPipeline(
          'classify',
          `${meta.categories || 0} 个篇章 · ${meta.dishes || 0} 道菜`,
          meta,
        );
      }
    });

    if (myGen !== state.taskGen) return;

    if (state.settings.currency && state.settings.currency !== 'auto') {
      menu.currency = state.settings.currency;
    }

    setPipeline('currency', `AI 实时换算 ${menu.currency} → CNY…`);
    {
      const { categories, fx } = await enrichItemsWithCNY(
        menu.categories,
        menu.currency,
        state.settings,
      );
      if (myGen !== state.taskGen) return;
      menu.categories = categories;
      menu.fx = fx;
    }

    setPipeline('images', '免费图库检索菜品照片…');
    menu.categories = await attachImages(menu.categories);
    if (myGen !== state.taskGen) return;

    setPipeline(
      'done',
      `${menu.categories.length} 个篇章 · ${countDishes(menu)} 道可点`,
    );
    await new Promise((r) => setTimeout(r, 420));
    if (myGen !== state.taskGen) return;

    menu.address = menu.address || '';
    state.menu = menu;
    state.activeCat = 0;
    state.view = 'menu';
    toast(`册子备好 · ${menu.categories.length} 类 / ${countDishes(menu)} 道`);
  } catch (err) {
    if (myGen !== state.taskGen) return;
    console.error(err);
    state.view = 'capture';
    toast(err.message || '这次没读清，再试一张更清楚的', 3200);
  }
  if (myGen === state.taskGen) render();
}

function countDishes(menu) {
  return (menu?.categories || []).reduce((n, c) => n + (c.items?.length || 0), 0);
}

// —— Cart ——
function addToCart(dish) {
  const cur = state.cart[dish.id];
  if (cur) cur.qty += 1;
  else state.cart[dish.id] = { dish, qty: 1 };
  refreshDishCard(dish.id);
  updateCartBar();
  toast(`已记下 · ${dish.name_zh}`);
  const sheet = document.getElementById('cart-sheet');
  if (sheet && !sheet.classList.contains('hidden')) renderCartSheetList();
}

function setQty(dishId, qty) {
  if (qty <= 0) {
    delete state.cart[dishId];
  } else if (state.cart[dishId]) {
    state.cart[dishId].qty = qty;
  }
  refreshDishCard(dishId);
  updateCartBar();
  // 弹层打开时同步刷新
  const sheet = document.getElementById('cart-sheet');
  if (sheet && !sheet.classList.contains('hidden')) renderCartSheetList();
}

function refreshDishCard(dishId) {
  const dish =
    state.cart[dishId]?.dish ||
    state.menu?.categories.flatMap((c) => c.items).find((d) => d.id === dishId);
  if (!dish) {
    render();
    return;
  }
  const el = document.querySelector(`[data-dish-id="${dish.id}"]`);
  if (!el) {
    render();
    return;
  }
  // 就地替换，避免列表重入场动画闪动
  const html = renderDishCard(dish);
  const wrap = document.createElement('div');
  wrap.innerHTML = html.trim();
  const next = wrap.firstElementChild;
  if (next) {
    next.style.animation = 'none';
    el.replaceWith(next);
  }
}

function checkout() {
  const items = Object.values(state.cart).map(({ dish, qty }) => ({
    dish: { ...dish },
    qty,
  }));
  if (!items.length) {
    toast('还没选菜呢');
    return;
  }
  state.orderItems = items;
  state.view = 'order';
  render();
}

function removeOrderItem(dishId) {
  state.orderItems = state.orderItems.filter((x) => x.dish.id !== dishId);
  // 同步购物车
  delete state.cart[dishId];
  if (!state.orderItems.length) {
    state.view = 'menu';
    toast('这一页又空了');
  }
  render();
}

/** 序列化当前菜单，供历史「加餐」恢复（去掉过大字段的副本） */
function snapshotMenu(menu) {
  if (!menu) return null;
  try {
    return JSON.parse(JSON.stringify(menu));
  } catch {
    return null;
  }
}

function saveCurrentOrder() {
  if (!state.orderItems.length) return;
  const { totalCny, totalOrig } = orderTotals(state.orderItems);
  const entry = {
    id: uid('order'),
    createdAt: Date.now(),
    restaurant_name: state.menu?.restaurant_name || '某处小馆',
    restaurant_address: state.menu?.address || '',
    currency: state.menu?.currency || 'USD',
    items: state.orderItems.map(({ dish, qty }) => ({
      name_zh: dish.name_zh,
      name_original: dish.name_original,
      price: dish.price,
      price_cny: dish.price_cny,
      qty,
    })),
    total_cny: totalCny,
    total_orig: totalOrig,
    menu_snapshot: snapshotMenu(state.menu),
  };
  addHistoryEntry(entry);
  toast('写进旅记了');
}

/** 从历史加餐：恢复当时菜单，回到点单页 */
function resumeOrderFromHistory(entry) {
  if (!entry?.menu_snapshot?.categories?.length) {
    toast('这条旧记没有可继续的菜单');
    return;
  }
  state.menu = entry.menu_snapshot;
  if (entry.restaurant_name) state.menu.restaurant_name = entry.restaurant_name;
  if (entry.restaurant_address != null) state.menu.address = entry.restaurant_address;
  state.activeCat = 0;
  state.cart = {};
  state.orderItems = [];
  state.receipt = null;
  state.historyDetail = null;
  state.view = 'menu';
  toast('继续加餐 · 菜单已恢复');
  render();
}

async function locateRestaurant() {
  if (!state.menu) return;
  if (!navigator.geolocation) {
    toast('当前环境不支持定位');
    return;
  }
  if (state.locating) return;
  state.locating = true;
  const btn = document.getElementById('btn-locate');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '定位中…';
  }
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 60000,
      });
    });
    const { latitude, longitude } = pos.coords;
    let address = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&accept-language=zh`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const data = await res.json();
        if (data?.display_name) address = data.display_name;
      }
    } catch {
      /* 用坐标兜底 */
    }
    state.menu.address = address;
    state.menu.lat = latitude;
    state.menu.lng = longitude;
    toast('已写入当前位置');
    // 局部刷新地址区
    const addrEl = document.getElementById('menu-address');
    if (addrEl) {
      addrEl.textContent = address;
      addrEl.classList.remove('is-empty');
    } else {
      render();
    }
  } catch (err) {
    const msg =
      err?.code === 1
        ? '需要定位权限才能获取地址'
        : err?.code === 3
          ? '定位超时，请再试一次'
          : '定位失败，请检查权限与网络';
    toast(msg, 3000);
  } finally {
    state.locating = false;
    const btn2 = document.getElementById('btn-locate');
    if (btn2) {
      btn2.disabled = false;
      btn2.textContent = '定位';
    }
  }
}

function goHistory() {
  if (state.view === 'loading') {
    const ok = window.confirm('有任务正在进行中，需要终止任务吗？');
    if (!ok) return;
    // 终止进行中任务
    state.taskGen += 1;
    state.pipeline = { stepId: 'compress', note: '', meta: {} };
  }
  state.view = 'history';
  render();
}

function orderTotals(items) {
  let totalCny = 0;
  let totalOrig = 0;
  let count = 0;
  for (const { dish, qty } of items) {
    count += qty;
    if (dish.price_cny != null) totalCny += dish.price_cny * qty;
    if (dish.price != null) totalOrig += dish.price * qty;
  }
  return { totalCny, totalOrig, count };
}

function syncChromeHeight() {
  const chrome = document.getElementById('app-chrome');
  if (!chrome) return;
  document.documentElement.style.setProperty('--app-chrome-h', `${chrome.offsetHeight}px`);
}

// —— Render ——
function render() {
  main.onclick = null;
  document.body.dataset.view = state.view;
  switch (state.view) {
    case 'capture':
      main.innerHTML = renderCapture();
      bindCapture();
      break;
    case 'loading':
      main.innerHTML = renderLoading();
      break;
    case 'menu':
      main.innerHTML = renderMenu();
      bindMenu();
      syncChromeHeight();
      break;
    case 'order':
      main.innerHTML = renderOrder();
      bindOrder();
      break;
    case 'receipt':
      main.innerHTML = renderReceipt();
      bindReceipt();
      break;
    case 'history':
      main.innerHTML = renderHistory();
      bindHistory();
      break;
    case 'history-detail':
      main.innerHTML = renderHistoryDetail();
      bindHistoryDetail();
      break;
    default:
      main.innerHTML = renderCapture();
  }
  updateCartBar();
  requestAnimationFrame(syncBottomBars);
}

/** 相册专用 accept：尽量避开系统「拍照 / 文件」入口 */
const GALLERY_ACCEPT =
  'image/jpeg,image/png,image/webp,image/heic,image/heif,image/gif,.jpg,.jpeg,.png,.webp,.heic,.heif,.gif';

function isImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('image/')) return true;
  return /\.(jpe?g|png|webp|gif|heic|heif|bmp)$/i.test(file.name || '');
}

/**
 * 直接唤起相册选图。
 * 移动端禁用 showOpenFilePicker（容易弹出「拍照/图库/文件」三选一）。
 */
function openGalleryPicker() {
  const input = document.getElementById('input-gallery');
  if (!input) return;
  input.setAttribute('accept', GALLERY_ACCEPT);
  input.removeAttribute('capture');
  // 部分 Android 对 multiple 会走更「重」的选择器，优先单图直进相册
  // 仍保留 multiple 属性以兼容连选；若系统坚持弹层，至少不带 capture
  input.value = '';
  // 同步 click：必须在用户手势栈内，立刻拉起系统相册
  input.click();
}

function openCameraPicker() {
  const input = document.getElementById('input-camera');
  if (!input) return;
  input.setAttribute('accept', 'image/*');
  input.setAttribute('capture', 'environment');
  input.value = '';
  input.click();
}

function renderCapture() {
  const n = state.photos.length;
  return `
    <section class="hero-card">
      <div class="hero-ticker anim-fade-up">
        <div class="hero-ticker-left">
          <span class="hero-ticker-mark" aria-hidden="true">◎</span>
          <span>异乡有字</span>
          <span class="hero-ticker-sep">·</span>
          <span>餐桌有诗</span>
          <span class="hero-ticker-sep">·</span>
          <span>TABLESIDE NOTES</span>
        </div>
        <span class="hero-ticker-right">把远方装订成册</span>
      </div>

      <div class="hero-banner">
        <img class="hero-banner-img" src="${asset('assets/hero-menu.jpg')}" alt="" />
        <span class="hero-num" aria-hidden="true">01</span>
        <div class="hero-body">
          <p class="hero-kicker anim-fade-up d1">
            <span>远方的一页</span>
            <span class="en">PAGES FROM AFAR</span>
          </p>
          <h2 class="hero-title anim-fade-up d2">
            <span class="hero-title-line">把菜单上的远方</span>
            <span class="hero-title-line"><em>读给你听</em></span>
          </h2>
          <p class="hero-desc anim-fade-up d3">
            一张菜单，是旅途落在餐桌上的注脚。<br/>
            对准纸上的陌生字句，<br/>
            我们替你译出名字，也译出味道，<br/>
            再把这一餐，<br/>
            整理成一张从容好用的点单卡。
          </p>
        </div>
      </div>

      <div class="hero-en-line anim-fade-up d4">
        <span>FRAME THE PAGE</span>
        <span class="hero-en-dot">·</span>
        <span>READ THE FLAVOUR</span>
        <span class="hero-en-dot">·</span>
        <span>KEEP THE JOURNEY</span>
      </div>
      <div class="hero-rule" aria-hidden="true"></div>

      <div class="capture-actions">
        <button type="button" class="btn-capture anim-fade-up d5" id="btn-camera">
          <img class="btn-capture-bg" src="${asset('assets/card-camera.jpg')}" alt="" />
          <span class="cap-icon">01 · LENS</span>
          <span class="cap-label">现场拍</span>
          <span class="cap-sub">CAPTURE NOW</span>
          <span class="cap-arrow" aria-hidden="true">${ARROW_SVG}</span>
        </button>
        <button type="button" class="btn-capture anim-fade-up d6" id="btn-gallery">
          <img class="btn-capture-bg" src="${asset('assets/card-gallery.jpg')}" alt="" />
          <span class="cap-icon">02 · ROLL</span>
          <span class="cap-label">从相册</span>
          <span class="cap-sub">FROM GALLERY</span>
          <span class="cap-arrow" aria-hidden="true">${ARROW_SVG}</span>
        </button>
      </div>
      <input id="input-camera" type="file" accept="image/*" capture="environment" hidden />
      <input id="input-gallery" type="file" accept="${GALLERY_ACCEPT}" hidden />
    </section>

    <section class="photo-section">
      <div class="section-label">
        <span>菜单页 ${n ? `· ${n}` : '· 空'} <span style="opacity:0.5">/ PAGES</span></span>
        ${n ? `<button type="button" class="btn-danger-soft" id="btn-clear-photos">全部撤下</button>` : ''}
      </div>
      ${
        n
          ? `<div class="photo-grid">
              ${state.photos
                .map(
                  (p) => `
                <div class="photo-item">
                  <img src="${p.url}" alt="菜单照片" />
                  <button type="button" class="photo-del" data-del="${p.id}" aria-label="删除">×</button>
                </div>`,
                )
                .join('')}
            </div>`
          : `<div class="empty-state">
              <div class="emoji">NO FRAMES YET</div>
              还没有菜单照片<br/>整页入镜、字迹清楚，读得更准
            </div>`
      }
    </section>

    <div class="analyze-wrap">
      <button type="button" class="btn-primary" id="btn-analyze" ${n ? '' : 'disabled'}>
        <span class="btn-ico" aria-hidden="true">☰</span>
        <span>开卷 · 读懂这页菜单</span>
        <span class="btn-ico" aria-hidden="true">${ARROW_SVG}</span>
      </button>
      <button type="button" class="btn-soft" id="btn-demo">先翻一册演示 · DEMO</button>
    </div>
  `;
}

function bindCapture() {
  document.getElementById('input-camera')?.addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });
  document.getElementById('input-gallery')?.addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });

  const camBtn = document.getElementById('btn-camera');
  const galBtn = document.getElementById('btn-gallery');

  // 必须在 click 手势内同步触发 input.click，才能立刻唤起系统相机/相册
  camBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    pressFlash(camBtn);
    openCameraPicker();
  });
  galBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    pressFlash(galBtn);
    openGalleryPicker();
  });

  document.getElementById('btn-clear-photos')?.addEventListener('click', () => {
    state.photos.forEach((p) => URL.revokeObjectURL(p.url));
    state.photos = [];
    render();
  });
  document.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => removePhoto(btn.getAttribute('data-del')));
  });
  document.getElementById('btn-analyze')?.addEventListener('click', startAnalyze);
  document.getElementById('btn-demo')?.addEventListener('click', loadDemoMenu);

  requestAnimationFrame(syncBottomBars);
}

async function loadDemoMenu() {
  const myGen = ++state.taskGen;
  state.view = 'loading';
  state.cart = {};
  state.pipeline = { stepId: 'compress', note: '演示 · 假装读一页菜单', meta: {} };
  render();

  const fakeSteps = [
    ['compress', '收起示范影像…'],
    ['upload', '装进行囊…'],
    ['ai', '细读示范字迹…'],
    ['parse', '理出脉络…'],
    ['classify', '分门别类…'],
    ['currency', '换算心中的价…'],
    ['images', '想象味道…'],
  ];
  for (const [id, note] of fakeSteps) {
    if (myGen !== state.taskGen) return;
    setPipeline(id, note);
    await new Promise((r) => setTimeout(r, 280));
  }
  if (myGen !== state.taskGen) return;

  const menu = {
    restaurant_name: '演示小馆 · Demo Bistro',
    currency: 'EUR',
    language: 'English / Italian',
    address: '',
    categories: [
      {
        name_zh: '开胃菜',
        name_original: 'Starters',
        items: [
          {
            id: 'd1',
            name_zh: '凯撒沙拉',
            name_original: 'Caesar Salad',
            price: 9.5,
            description_zh: '罗马生菜、帕玛森芝士、酸面包丁',
            search_query: 'caesar salad',
          },
          {
            id: 'd2',
            name_zh: '番茄牛油果布鲁健塔',
            name_original: 'Tomato & Avocado Bruschetta',
            price: 8.0,
            description_zh: '烤面包片配新鲜番茄与牛油果',
            search_query: 'bruschetta avocado',
          },
        ],
      },
      {
        name_zh: '主菜',
        name_original: 'Mains',
        items: [
          {
            id: 'd3',
            name_zh: '奶油培根意面',
            name_original: 'Spaghetti Carbonara',
            price: 14.5,
            description_zh: '蛋黄酱汁、意式培根、黑胡椒',
            search_query: 'spaghetti carbonara',
          },
          {
            id: 'd4',
            name_zh: '香草烤三文鱼',
            name_original: 'Herb Grilled Salmon',
            price: 18.0,
            description_zh: '时令蔬菜与柠檬黄油',
            search_query: 'grilled salmon herbs',
          },
          {
            id: 'd5',
            name_zh: '玛格丽特披萨',
            name_original: 'Pizza Margherita',
            price: 12.0,
            description_zh: '番茄、马苏里拉、罗勒',
            search_query: 'pizza margherita',
          },
        ],
      },
      {
        name_zh: '甜品与饮品',
        name_original: 'Dessert & Drinks',
        items: [
          {
            id: 'd6',
            name_zh: '提拉米苏',
            name_original: 'Tiramisu',
            price: 7.5,
            description_zh: '马斯卡彭芝士与咖啡饼干',
            search_query: 'tiramisu dessert',
          },
          {
            id: 'd7',
            name_zh: '意式浓缩咖啡',
            name_original: 'Espresso',
            price: 2.5,
            description_zh: '',
            search_query: 'espresso coffee',
          },
        ],
      },
    ],
  };
  {
    const { categories, fx } = await enrichItemsWithCNY(
      menu.categories,
      menu.currency,
      state.settings,
    );
    if (myGen !== state.taskGen) return;
    menu.categories = categories;
    menu.fx = fx;
  }
  setPipeline('images', '免费图库检索菜品照片…');
  menu.categories = await attachImages(menu.categories);
  if (myGen !== state.taskGen) return;
  setPipeline('done', `${menu.categories.length} 个篇章 · 演示册备好`);
  await new Promise((r) => setTimeout(r, 350));
  if (myGen !== state.taskGen) return;
  state.menu = menu;
  state.activeCat = 0;
  state.view = 'menu';
  toast('演示册打开了 · 可随意点点看');
  render();
}

function renderPipeline() {
  const currentIdx = Math.max(
    0,
    PIPELINE_STEPS.findIndex((s) => s.id === state.pipeline.stepId),
  );
  const current = PIPELINE_STEPS[currentIdx] || PIPELINE_STEPS[0];
  const pct = Math.round(
    ((currentIdx + (state.pipeline.stepId === 'done' ? 1 : 0.45)) / PIPELINE_STEPS.length) * 100,
  );

  return `
    <div id="pipeline-root" class="pipeline-root">
      <div class="pipeline-hero">
        <div class="pipeline-radar" aria-hidden="true">
          <div class="radar-ring r1"></div>
          <div class="radar-ring r2"></div>
          <div class="radar-ring r3"></div>
          <div class="radar-core"></div>
          <div class="radar-scan"></div>
        </div>
        <div class="pipeline-hero-text">
          <p class="pipeline-kicker">STEP ${String(currentIdx + 1).padStart(2, '0')} / ${String(PIPELINE_STEPS.length).padStart(2, '0')}</p>
          <h2 class="pipeline-title">${escapeHtml(current.label)}</h2>
          <p class="pipeline-en">${escapeHtml(current.en)}</p>
          <p class="pipeline-note">${escapeHtml(state.pipeline.note || current.detail)}</p>
        </div>
      </div>
      <div class="pipeline-bar-wrap">
        <div class="pipeline-bar">
          <div class="pipeline-bar-fill" style="width:${Math.min(100, pct)}%"></div>
        </div>
        <span class="pipeline-pct">${Math.min(100, pct)}%</span>
      </div>
      <ol class="pipeline-steps">
        ${PIPELINE_STEPS.map((s, i) => {
          let st = 'todo';
          if (i < currentIdx) st = 'done';
          else if (i === currentIdx) st = state.pipeline.stepId === 'done' ? 'done' : 'active';
          return `
            <li class="pipeline-step ${st}">
              <span class="ps-idx">${String(i + 1).padStart(2, '0')}</span>
              <span class="ps-body">
                <span class="ps-label">${escapeHtml(s.label)}</span>
                <span class="ps-en">${escapeHtml(s.en)} · ${escapeHtml(s.detail)}</span>
              </span>
              <span class="ps-mark">${st === 'done' ? '✓' : st === 'active' ? '●' : '○'}</span>
            </li>`;
        }).join('')}
      </ol>
      <p class="pipeline-foot">请保持网络 · 大约半分钟 · DESIGN BY ZEN</p>
    </div>
  `;
}

function renderLoading() {
  return `<div class="loading-panel">${renderPipeline()}</div>`;
}

function renderDishCard(dish) {
  const inCart = state.cart[dish.id];
  const cur = state.menu?.currency || 'USD';
  const priceMain =
    dish.price != null ? formatMoney(dish.price, cur) : '—';
  const priceCny =
    dish.price_cny != null ? `约 ¥${dish.price_cny.toFixed(2)}` : '';

  const action = inCart
    ? `<div class="qty-ctrl">
        <button type="button" data-qty-minus="${dish.id}">−</button>
        <span>${inCart.qty}</span>
        <button type="button" data-qty-plus="${dish.id}">+</button>
      </div>`
    : `<button type="button" class="btn-add" data-add="${dish.id}">记下</button>`;

  const img = dish.image_url
    ? `<div class="dish-img-hit" aria-hidden="true">
        <img class="dish-img" src="${dish.image_url}" alt="" loading="lazy"
          onerror="this.style.display='none';this.nextElementSibling.style.display='grid'" />
        <div class="dish-img-fallback" style="display:none">${dish.emoji || dishEmoji(dish.name_zh)}</div>
      </div>`
    : `<div class="dish-img-hit" aria-hidden="true"><div class="dish-img-fallback">${dish.emoji || '🍽️'}</div></div>`;

  return `
    <article class="dish-card" data-dish-id="${dish.id}">
      ${img}
      <div class="dish-body">
        <h3 class="dish-name-zh">${escapeHtml(dish.name_zh)}</h3>
        <p class="dish-name-orig">${escapeHtml(dish.name_original)}</p>
        ${dish.description_zh ? `<p class="dish-desc">${escapeHtml(dish.description_zh)}</p>` : ''}
        <div class="dish-foot">
          <div class="price-block">
            <span class="price-main">${priceMain}</span>
            <span class="price-cny">${priceCny}</span>
          </div>
          ${action}
        </div>
      </div>
    </article>
  `;
}

function renderMenu() {
  const menu = state.menu;
  if (!menu) return renderCapture();

  const cats = menu.categories;
  const cat = cats[state.activeCat] || cats[0];

  const fx = menu.fx;
  const dishCount = countDishes(menu);
  const fxRight =
    fx?.rate != null && menu.currency !== 'CNY'
      ? `1 ${menu.currency} ≈ ¥${Number(fx.rate).toFixed(fx.rate >= 1 ? 2 : 4)}`
      : menu.currency === 'CNY'
        ? '人民币计价'
        : '';

  const address = menu.address || '';

  return `
    <div class="menu-wrap anim-page">
      ${backBtn('btn-back-capture', '返回')}
      <div class="menu-header">
        <div class="menu-name-block">
          <input
            type="text"
            class="menu-title-input"
            id="menu-name-edit"
            value="${escapeHtml(menu.restaurant_name || '')}"
            placeholder="输入店名"
            maxlength="48"
            autocomplete="off"
          />
          <p class="menu-name-hint">点店名可编辑 · 改完会随点单一起记下</p>
        </div>
        <div class="menu-locate-row">
          <p id="menu-address" class="menu-address ${address ? '' : 'is-empty'}">${
            address ? escapeHtml(address) : '尚未定位 · 点右侧获取当前位置'
          }</p>
          <button type="button" class="btn-locate" id="btn-locate">定位</button>
        </div>
        <div class="menu-meta-row">
          <p class="menu-meta-left">${cats.length} 个分类 · ${dishCount} 道菜品</p>
          ${fxRight ? `<p class="menu-meta-right"><span class="menu-fx-tag">${escapeHtml(fxRight)}</span></p>` : ''}
        </div>
      </div>
      <div class="cat-scroll" id="cat-scroll">
        ${cats
          .map(
            (c, i) => `
          <button type="button" class="cat-chip ${i === state.activeCat ? 'active' : ''}" data-cat="${i}">
            <span class="cat-chip-top">
              <span class="cat-chip-label">${escapeHtml(c.name_zh)}</span>
              <span class="cat-count">${c.items?.length || 0}</span>
            </span>
            ${
              c.name_original
                ? `<span class="cat-chip-orig">${escapeHtml(c.name_original)}</span>`
                : ''
            }
          </button>`,
          )
          .join('')}
      </div>
      <div class="dish-list enter-anim" id="dish-list">
        ${(cat?.items || []).map((d) => renderDishCard(d)).join('')}
      </div>
    </div>
  `;
}

/** 切换分类：只更新列表与 active，保留 tab 横向滚动位置 */
function switchCategory(index) {
  const cats = state.menu?.categories || [];
  if (!cats.length) return;
  const i = Math.max(0, Math.min(Number(index) || 0, cats.length - 1));
  if (i === state.activeCat) {
    // 仍确保当前 tab 在可视区内（nearest，不会整条滚回开头）
    document.querySelector(`.cat-chip[data-cat="${i}"]`)?.scrollIntoView({
      behavior: 'smooth',
      inline: 'nearest',
      block: 'nearest',
    });
    return;
  }
  state.activeCat = i;
  const cat = cats[i];

  document.querySelectorAll('.cat-chip').forEach((btn) => {
    const idx = Number(btn.getAttribute('data-cat'));
    btn.classList.toggle('active', idx === i);
  });

  const list = document.getElementById('dish-list');
  if (list) {
    list.classList.remove('enter-anim');
    list.innerHTML = (cat?.items || []).map((d) => renderDishCard(d)).join('');
    // 切换分类时不再播入场动画，避免闪动
  }

  // inline: nearest —— 已在视野内则不动，被裁切时才微调
  document.querySelector(`.cat-chip[data-cat="${i}"]`)?.scrollIntoView({
    behavior: 'smooth',
    inline: 'nearest',
    block: 'nearest',
  });
}

function bindMenu() {
  document.getElementById('btn-back-capture')?.addEventListener('click', () => {
    state.view = 'capture';
    render();
  });
  const nameInput = document.getElementById('menu-name-edit');
  nameInput?.addEventListener('change', () => {
    if (!state.menu) return;
    const v = (nameInput.value || '').trim() || '未知餐厅';
    state.menu.restaurant_name = v;
    nameInput.value = v;
  });
  nameInput?.addEventListener('blur', () => {
    if (!state.menu) return;
    const v = (nameInput.value || '').trim() || '未知餐厅';
    state.menu.restaurant_name = v;
  });
  document.getElementById('btn-locate')?.addEventListener('click', () => {
    locateRestaurant();
  });

  // 事件委托：数量按钮会 outerHTML 替换，必须挂在容器上
  const root = main;
  root.onclick = (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const cat = t.closest('[data-cat]');
    if (cat) {
      switchCategory(cat.getAttribute('data-cat'));
      return;
    }
    const add = t.closest('[data-add]');
    if (add) {
      const dish = findDish(add.getAttribute('data-add'));
      if (dish) addToCart(dish);
      return;
    }
    const plus = t.closest('[data-qty-plus]');
    if (plus) {
      const id = plus.getAttribute('data-qty-plus');
      const cur = state.cart[id];
      if (cur) setQty(id, cur.qty + 1);
      return;
    }
    const minus = t.closest('[data-qty-minus]');
    if (minus) {
      const id = minus.getAttribute('data-qty-minus');
      const cur = state.cart[id];
      if (cur) setQty(id, cur.qty - 1);
    }
  };
}

function renderCartSheetList() {
  const listEl = document.getElementById('cart-sheet-list');
  const countEl = document.getElementById('cart-sheet-count');
  const totalEl = document.getElementById('cart-sheet-total');
  if (!listEl) return;

  const items = Object.values(state.cart);
  const cur = state.menu?.currency || 'USD';
  const { count, totalCny, totalOrig, hasOrig } = cartStats();

  if (!items.length) {
    listEl.innerHTML = `<div class="empty-state" style="margin:12px 16px;border:1px dashed var(--line-hard)">
      还没有记下菜品<br/>点菜品图或「记下」加入清单
    </div>`;
  } else {
    listEl.innerHTML = items
      .map(({ dish, qty }) => {
        const line =
          dish.price != null ? formatMoney(dish.price * qty, cur) : '—';
        return `
        <div class="cart-sheet-row" data-sheet-id="${dish.id}">
          <div>
            <p class="cart-sheet-name">${escapeHtml(dish.name_zh)}</p>
            <p class="cart-sheet-sub">${escapeHtml(dish.name_original)}</p>
          </div>
          <div class="cart-sheet-side">
            <span class="cart-sheet-price">${line}</span>
            <div class="qty-ctrl">
              <button type="button" data-sheet-minus="${dish.id}" aria-label="减少">−</button>
              <span>${qty}</span>
              <button type="button" data-sheet-plus="${dish.id}" aria-label="增加">+</button>
            </div>
          </div>
        </div>`;
      })
      .join('');
  }

  if (countEl) countEl.textContent = `${count} 份`;
  if (totalEl) {
    totalEl.textContent = hasOrig
      ? formatMoney(totalOrig, cur)
      : totalCny > 0
        ? `约 ¥${totalCny.toFixed(2)}`
        : '—';
  }
}

function openCartSheet() {
  const sheet = document.getElementById('cart-sheet');
  if (!sheet) return;
  renderCartSheetList();
  sheet.classList.remove('hidden');
  sheet.setAttribute('aria-hidden', 'false');
}

function closeCartSheet() {
  const sheet = document.getElementById('cart-sheet');
  if (!sheet) return;
  sheet.classList.add('hidden');
  sheet.setAttribute('aria-hidden', 'true');
}

function findDish(id) {
  for (const c of state.menu?.categories || []) {
    const d = c.items.find((x) => x.id === id);
    if (d) return d;
  }
  return null;
}

function setOrderQty(dishId, qty) {
  const i = state.orderItems.findIndex((x) => x.dish.id === dishId);
  if (i < 0) return;
  if (qty <= 0) {
    state.orderItems.splice(i, 1);
    delete state.cart[dishId];
    if (!state.orderItems.length) {
      state.view = 'menu';
      toast('这一页又空了');
    }
  } else {
    state.orderItems[i].qty = qty;
    if (state.cart[dishId]) state.cart[dishId].qty = qty;
    else if (state.orderItems[i].dish) {
      state.cart[dishId] = { dish: state.orderItems[i].dish, qty };
    }
  }
  render();
}

function renderOrder() {
  const items = state.orderItems;
  const { totalCny, totalOrig, count } = orderTotals(items);
  const cur = state.menu?.currency || 'USD';

  return `
    <div class="order-page">
      ${backBtn('btn-back-menu', '返回')}
      <div class="order-head">
        <h2>核对清单</h2>
      </div>
      <p class="order-tip">
        可调整每道菜的数量 · 确认后生成 <strong>菜单卡</strong> 递给服务员
      </p>
      ${items
        .map(
          ({ dish, qty }) => `
        <div class="order-card" data-order-id="${dish.id}">
          <button type="button" class="order-card-del" data-rm="${dish.id}" aria-label="删除">×</button>
          <p class="order-card-orig">${escapeHtml(dish.name_original)}</p>
          <p class="order-card-zh">${escapeHtml(dish.name_zh)}</p>
          <div class="order-card-meta">
            <div class="qty-ctrl order-qty">
              <button type="button" data-order-minus="${dish.id}" aria-label="减少">−</button>
              <span>${qty}</span>
              <button type="button" data-order-plus="${dish.id}" aria-label="增加">+</button>
            </div>
            <span class="price-stack">
              <strong class="price-orig">${dish.price != null ? formatMoney(dish.price * qty, cur) : '—'}</strong>
              ${dish.price_cny != null ? `<em class="price-cny-soft">约 ¥${(dish.price_cny * qty).toFixed(2)}</em>` : ''}
            </span>
          </div>
        </div>`,
        )
        .join('')}
      <div class="order-summary">
        <div>
          <div class="sum-label">共 ${count} 份</div>
          ${totalCny > 0 ? `<div class="sum-cny-soft">约 ¥${totalCny.toFixed(2)}</div>` : ''}
        </div>
        <strong class="sum-orig">${formatMoney(totalOrig, cur)}</strong>
      </div>
      <div class="order-actions">
        <button type="button" class="btn-soft" id="btn-save-order">写入旅记</button>
        <button type="button" class="btn-primary" id="btn-done-order">点完了</button>
      </div>
    </div>
  `;
}

function bindOrder() {
  document.getElementById('btn-back-menu')?.addEventListener('click', () => {
    state.view = 'menu';
    render();
  });
  document.querySelectorAll('[data-rm]').forEach((btn) => {
    btn.addEventListener('click', () => removeOrderItem(btn.getAttribute('data-rm')));
  });
  document.querySelectorAll('[data-order-plus]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-order-plus');
      const cur = state.orderItems.find((x) => x.dish.id === id);
      if (cur) setOrderQty(id, cur.qty + 1);
    });
  });
  document.querySelectorAll('[data-order-minus]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-order-minus');
      const cur = state.orderItems.find((x) => x.dish.id === id);
      if (cur) setOrderQty(id, cur.qty - 1);
    });
  });
  document.getElementById('btn-save-order')?.addEventListener('click', () => {
    saveCurrentOrder();
  });
  document.getElementById('btn-done-order')?.addEventListener('click', () => {
    if (!state.orderItems.length) {
      toast('清单是空的');
      return;
    }
    saveCurrentOrder();
    const { totalCny, totalOrig, count } = orderTotals(state.orderItems);
    state.receipt = {
      restaurant_name: state.menu?.restaurant_name || '某处小馆',
      currency: state.menu?.currency || 'USD',
      createdAt: Date.now(),
      items: state.orderItems.map(({ dish, qty }) => ({
        name_zh: dish.name_zh,
        name_original: dish.name_original,
        price: dish.price,
        price_cny: dish.price_cny,
        qty,
      })),
      total_cny: totalCny,
      total_orig: totalOrig,
      count,
    };
    state.cart = {};
    state.orderItems = [];
    state.view = 'receipt';
    toast('购物清单已生成');
    render();
  });
}

/** 购物清单卡：原文优先，原价突出，人民币弱化，总价以原价为主 */
function renderReceipt() {
  const r = state.receipt;
  if (!r) {
    state.view = 'history';
    return renderHistory();
  }
  const cur = r.currency || 'USD';
  let idx = 0;

  return `
    <div class="receipt-page anim-page">
      ${backBtn('btn-receipt-hist', '返回')}
      <div class="shopping-list bill-sheet" id="shopping-list-card">
        <div class="bill-perforation" aria-hidden="true"></div>
        <div class="sl-head">
          <p class="sl-kicker">TABLE CARD</p>
          <h2 class="sl-title">${escapeHtml(r.restaurant_name)}</h2>
          <p class="sl-sub">${formatTime(r.createdAt)}</p>
          <p class="sl-hint">请按下列菜品为客人准备</p>
        </div>
        <ol class="sl-rows">
          ${r.items
            .map((it) => {
              idx += 1;
              const lineOrig =
                it.price != null ? formatMoney(Number(it.price) * it.qty, cur) : '—';
              return `
              <li class="sl-row">
                <span class="sl-no">${String(idx).padStart(2, '0')}</span>
                <div class="sl-body">
                  <p class="sl-name-orig">${escapeHtml(it.name_original)}</p>
                  <p class="sl-name-zh">${escapeHtml(it.name_zh)}</p>
                </div>
                <div class="sl-qty">×${it.qty}</div>
                <div class="sl-price">
                  <span class="sl-price-orig">${lineOrig}</span>
                </div>
              </li>`;
            })
            .join('')}
        </ol>
        <div class="sl-total">
          <div class="sl-total-left">
            <span class="sl-total-label">合计 · ${r.count} 份</span>
            ${
              r.total_cny > 0
                ? `<span class="sl-total-cny">约 ¥${Number(r.total_cny).toFixed(2)}</span>`
                : ''
            }
          </div>
          <div class="sl-total-orig">${formatMoney(r.total_orig, cur)}</div>
        </div>
        <p class="sl-foot">DESIGN BY ZEN · 食旅集</p>
        <div class="bill-perforation bottom" aria-hidden="true"></div>
      </div>
      <div class="order-actions receipt-actions">
        <button type="button" class="btn-soft" id="btn-receipt-again">再点一轮</button>
        <button type="button" class="btn-primary" id="btn-receipt-done">完成</button>
      </div>
    </div>
  `;
}

function bindReceipt() {
  document.getElementById('btn-receipt-hist')?.addEventListener('click', () => {
    state.view = 'history';
    render();
  });
  document.getElementById('btn-receipt-again')?.addEventListener('click', () => {
    state.receipt = null;
    state.view = state.menu ? 'menu' : 'capture';
    render();
  });
  document.getElementById('btn-receipt-done')?.addEventListener('click', () => {
    state.view = 'history';
    toast('已保存到点单旅记');
    render();
  });
}

function renderHistory() {
  const list = loadHistory();
  return `
    <div class="history-page">
      ${backBtn('btn-hist-back', '返回')}
      <h2>点单旅记</h2>
      ${
        list.length
          ? list
              .map(
                (h) => `
            <div class="history-item" data-hid="${h.id}">
              <h3>${escapeHtml(h.restaurant_name)}</h3>
              <p>${formatTime(h.createdAt)} · ${h.items?.length || 0} 道</p>
              ${
                h.restaurant_address
                  ? `<p class="history-addr">${escapeHtml(h.restaurant_address)}</p>`
                  : ''
              }
              <div class="row">
                <span>
                  ${h.total_orig != null ? formatMoney(h.total_orig, h.currency || 'USD') : ''}
                  <em style="font-style:normal;display:block;font-size:0.68rem;color:var(--ink-faint);font-weight:400">
                    约 ¥${Number(h.total_cny || 0).toFixed(2)}
                  </em>
                </span>
                <div class="history-actions">
                  ${
                    h.menu_snapshot?.categories?.length
                      ? `<button type="button" class="btn-soft-sm" data-hresume="${h.id}">加餐</button>`
                      : ''
                  }
                  <button type="button" class="btn-danger-soft" data-hdel="${h.id}">抹去</button>
                </div>
              </div>
            </div>`,
              )
              .join('')
          : `<div class="empty-state" style="margin-top:16px">
              <div class="emoji">空白旅记</div>
              还没有写下任何一餐<br/>点完菜之后，会留在这里
            </div>`
      }
    </div>
  `;
}

function bindHistory() {
  document.getElementById('btn-hist-back')?.addEventListener('click', () => {
    state.view = state.menu ? 'menu' : 'capture';
    render();
  });
  document.querySelectorAll('[data-hid]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-hdel], [data-hresume]')) return;
      const id = el.getAttribute('data-hid');
      const item = loadHistory().find((x) => x.id === id);
      if (item) {
        state.historyDetail = item;
        state.view = 'history-detail';
        render();
      }
    });
  });
  document.querySelectorAll('[data-hresume]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-hresume');
      const item = loadHistory().find((x) => x.id === id);
      if (item) resumeOrderFromHistory(item);
    });
  });
  document.querySelectorAll('[data-hdel]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteHistoryEntry(btn.getAttribute('data-hdel'));
      toast('这一页抹掉了');
      render();
    });
  });
}

function renderHistoryDetail() {
  const h = state.historyDetail;
  if (!h) return renderHistory();
  const cur = h.currency || 'USD';
  const canResume = !!h.menu_snapshot?.categories?.length;
  return `
    <div class="order-page">
      ${backBtn('btn-hdd-back', '返回')}
      <div class="order-head">
        <h2>${escapeHtml(h.restaurant_name)}</h2>
        <p class="menu-meta" style="margin-top:8px">${formatTime(h.createdAt)}</p>
        ${
          h.restaurant_address
            ? `<p class="history-detail-addr">${escapeHtml(h.restaurant_address)}</p>`
            : `<p class="history-detail-addr is-empty">未记录地址</p>`
        }
      </div>
      <p class="order-tip">旧笺 · 原文在上 · 仍可递给服务员</p>
      ${(h.items || [])
        .map(
          (it) => `
        <div class="order-card">
          <p class="order-card-orig">${escapeHtml(it.name_original)}</p>
          <p class="order-card-zh">${escapeHtml(it.name_zh)}</p>
          <div class="order-card-meta">
            <span>× ${it.qty}</span>
            <span class="price-stack">
              <strong class="price-orig">${it.price != null ? formatMoney(it.price * it.qty, cur) : '—'}</strong>
              ${it.price_cny != null ? `<em class="price-cny-soft">约 ¥${(it.price_cny * it.qty).toFixed(2)}</em>` : ''}
            </span>
          </div>
        </div>`,
        )
        .join('')}
      <div class="order-summary">
        <div>
          <div class="sum-label">合计</div>
          <div class="sum-cny-soft">约 ¥${Number(h.total_cny || 0).toFixed(2)}</div>
        </div>
        <strong class="sum-orig">${formatMoney(h.total_orig, cur)}</strong>
      </div>
      ${
        canResume
          ? `<div class="order-actions" style="margin-top:12px">
              <button type="button" class="btn-primary" id="btn-hdd-resume" style="grid-column:1/-1">加餐 · 回到点单页</button>
            </div>`
          : ''
      }
    </div>
  `;
}

function bindHistoryDetail() {
  document.getElementById('btn-hdd-back')?.addEventListener('click', () => {
    state.view = 'history';
    render();
  });
  document.getElementById('btn-hdd-resume')?.addEventListener('click', () => {
    if (state.historyDetail) resumeOrderFromHistory(state.historyDetail);
  });
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 弹层顶部横条下拉关闭 */
function bindDragToClose(panel, handle, onClose) {
  if (!panel || !handle || handle.dataset.dragBound === '1') return;
  handle.dataset.dragBound = '1';
  let startY = 0;
  let dy = 0;
  let dragging = false;

  const onDown = (e) => {
    dragging = true;
    startY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
    dy = 0;
    panel.classList.add('is-dragging');
    panel.style.transition = 'none';
    try {
      handle.setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  const onMove = (e) => {
    if (!dragging) return;
    const y = e.clientY ?? e.touches?.[0]?.clientY ?? startY;
    dy = Math.max(0, y - startY);
    panel.style.transform = `translateY(${dy}px)`;
    if (e.cancelable) e.preventDefault();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('is-dragging');
    panel.style.transition = '';
    if (dy > 72) {
      panel.style.transform = '';
      onClose();
    } else {
      panel.style.transform = '';
    }
    dy = 0;
  };

  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}

// —— Cart sheet bindings ——
document.getElementById('btn-cart-sheet')?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  openCartSheet();
});
document.getElementById('cart-sheet')?.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t.closest('[data-close-sheet]')) {
    closeCartSheet();
    return;
  }
  const plus = t.closest('[data-sheet-plus]');
  if (plus) {
    const id = plus.getAttribute('data-sheet-plus');
    const cur = state.cart[id];
    if (cur) setQty(id, cur.qty + 1);
    return;
  }
  const minus = t.closest('[data-sheet-minus]');
  if (minus) {
    const id = minus.getAttribute('data-sheet-minus');
    const cur = state.cart[id];
    if (cur) setQty(id, cur.qty - 1);
  }
});
document.getElementById('cart-sheet-checkout')?.addEventListener('click', () => {
  closeCartSheet();
  checkout();
});

// 已点清单弹层 · 下拉关闭
bindDragToClose(
  document.querySelector('#cart-sheet .cart-sheet-panel'),
  document.querySelector('#cart-sheet [data-drag-handle]'),
  closeCartSheet,
);
// 设置弹层 · 下拉关闭
bindDragToClose(
  document.querySelector('#modal-settings .modal-sheet'),
  document.querySelector('#modal-settings [data-drag-handle]'),
  closeSettings,
);

// —— Global bindings ——
document.getElementById('btn-home')?.addEventListener('click', goHome);
document.getElementById('btn-home')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    goHome();
  }
});
document.getElementById('btn-settings')?.addEventListener('click', openSettings);
document.getElementById('btn-history')?.addEventListener('click', () => {
  goHistory();
});
document.getElementById('btn-checkout')?.addEventListener('click', checkout);

modalSettings.querySelectorAll('[data-close="settings"]').forEach((el) => {
  el.addEventListener('click', closeSettings);
});

document.getElementById('form-settings')?.addEventListener('submit', (e) => {
  e.preventDefault();
  state.settings = readSettingsForm();
  saveSettings(state.settings);
  closeSettings();
  toast('已记下这些设置');
  if (state.view === 'capture') render();
});

document.getElementById('btn-test-api')?.addEventListener('click', (e) => {
  e.preventDefault();
  runApiTest();
});

document.getElementById('provider-presets')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-preset]');
  if (!btn) return;
  applyPreset(btn.getAttribute('data-preset'));
});

document.getElementById('cfg-base-url')?.addEventListener('input', highlightPreset);

// 首次进入：支持 ?key= 一次性写入（方便手机配置，用完会从地址栏抹掉）
(function bootstrapKeyFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const key = params.get('key') || params.get('api_key');
    if (key && key.trim()) {
      state.settings = {
        ...state.settings,
        apiKey: key.trim(),
        baseUrl: state.settings.baseUrl || 'https://api.deepseek.com',
        model: state.settings.model || 'deepseek-v4-flash',
      };
      saveSettings(state.settings);
      params.delete('key');
      params.delete('api_key');
      const q = params.toString();
      const clean = `${window.location.pathname}${q ? `?${q}` : ''}${window.location.hash || ''}`;
      window.history.replaceState({}, '', clean);
      toast('密钥已写入本机，可开始使用');
    }
    // 可选：构建时注入的默认 Key（仅私有部署建议使用）
    const envKey = import.meta.env.VITE_DEEPSEEK_API_KEY;
    if (envKey && !state.settings.apiKey) {
      state.settings.apiKey = envKey;
      saveSettings(state.settings);
    }
  } catch {
    /* ignore */
  }
})();

render();
syncChromeHeight();
syncBottomBars();
window.addEventListener('resize', () => {
  syncChromeHeight();
  syncBottomBars();
});
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    syncChromeHeight();
    syncBottomBars();
  }, 120);
});

// 无 key 时轻提示（显示在标题旁）
if (!state.settings.apiKey) {
  setTimeout(() => toast('点右上角填密钥即可启程', 3200), 500);
} else {
  setTimeout(() => toast('可连拍多页 · 读前可删', 2800), 500);
}

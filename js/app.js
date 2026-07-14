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
import { formatMoney, enrichItemsWithCNY } from './currency.js';
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

const ASSET_BASE = import.meta.env.BASE_URL || '/';
function asset(path) {
  return `${ASSET_BASE}${String(path).replace(/^\//, '')}`;
}

const ARROW_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14M13 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// —— UI helpers ——
function toast(msg, ms = 2200) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.add('hidden'), ms);
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
  if (!show) return;
  const { count, totalCny, totalOrig, hasOrig } = cartStats();
  cartCountEl.textContent = String(count);
  const cur = state.menu?.currency || 'USD';
  // 主显示原价，人民币弱化
  cartTotalEl.textContent = hasOrig ? formatMoney(totalOrig, cur) : `¥${totalCny.toFixed(2)}`;
  cartTotalOrigEl.textContent =
    totalCny > 0 ? `约 ¥${totalCny.toFixed(2)}` : '';
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

  state.view = 'loading';
  state.cart = {};
  state.menu = null;
  state.pipeline = { stepId: 'compress', note: '准备中…', meta: {} };
  render();

  try {
    const files = state.photos.map((p) => p.file);
    let menu = await parseMenuFromImages(files, state.settings, (step, meta = {}) => {
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

    if (state.settings.currency && state.settings.currency !== 'auto') {
      menu.currency = state.settings.currency;
    }

    setPipeline('currency', `把 ${menu.currency} 折成熟悉的数字…`);
    menu.categories = await enrichItemsWithCNY(menu.categories, menu.currency);

    setPipeline('images', '免费图库检索菜品照片…');
    menu.categories = await attachImages(menu.categories);

    setPipeline(
      'done',
      `${menu.categories.length} 个篇章 · ${countDishes(menu)} 道可点`,
    );
    await new Promise((r) => setTimeout(r, 420));

    state.menu = menu;
    state.activeCat = 0;
    state.view = 'menu';
    toast(`册子备好 · ${menu.categories.length} 类 / ${countDishes(menu)} 道`);
  } catch (err) {
    console.error(err);
    state.view = 'capture';
    toast(err.message || '这次没读清，再试一张更清楚的', 3200);
  }
  render();
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
}

function setQty(dishId, qty) {
  if (qty <= 0) {
    delete state.cart[dishId];
  } else if (state.cart[dishId]) {
    state.cart[dishId].qty = qty;
  }
  refreshDishCard(dishId);
  updateCartBar();
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
  el.outerHTML = renderDishCard(dish);
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

function saveCurrentOrder() {
  if (!state.orderItems.length) return;
  const { totalCny, totalOrig } = orderTotals(state.orderItems);
  const entry = {
    id: uid('order'),
    createdAt: Date.now(),
    restaurant_name: state.menu?.restaurant_name || '某处小馆',
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
  };
  addHistoryEntry(entry);
  toast('写进旅记了');
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
}

/** 相册专用 accept：尽量避开系统「拍照 / 文件」入口 */
const GALLERY_ACCEPT =
  'image/jpeg,image/png,image/webp,image/heic,image/heif,image/gif,.jpg,.jpeg,.png,.webp,.heic,.heif,.gif';

function isImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('image/')) return true;
  return /\.(jpe?g|png|webp|gif|heic|heif|bmp)$/i.test(file.name || '');
}

/** 直接打开相册/图片选择，不走「拍照 or 图库 or 文件」三选一 */
async function openGalleryPicker() {
  // 桌面 Chromium：系统文件选择器（无相机选项）
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        excludeAcceptAllOption: true,
        types: [
          {
            description: 'Images',
            accept: {
              'image/jpeg': ['.jpg', '.jpeg'],
              'image/png': ['.png'],
              'image/webp': ['.webp'],
              'image/heic': ['.heic', '.heif'],
              'image/gif': ['.gif'],
            },
          },
        ],
      });
      const files = await Promise.all(handles.map((h) => h.getFile()));
      addFiles(files);
      return;
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return;
      // 继续走 input 回退
    }
  }

  const input = document.getElementById('input-gallery');
  if (!input) return;
  input.setAttribute('accept', GALLERY_ACCEPT);
  input.removeAttribute('capture');
  input.value = '';
  input.click();
}

function renderCapture() {
  const n = state.photos.length;
  return `
    <section class="hero-card">
      <div class="hero-ticker">
        <div class="hero-ticker-left">
          <span>字读成乡音</span>
          <span class="hero-ticker-dot"></span>
          <span>Tableside Poetry</span>
          <span class="hero-ticker-dot"></span>
          <span>Design by Zen</span>
        </div>
        <span>远方的纸页</span>
      </div>
      <div class="hero-visual">
        <img class="hero-visual-img" src="${asset('assets/hero-menu.jpg')}" alt="" />
        <span class="hero-num" aria-hidden="true">01</span>
        <div class="hero-body">
          <p class="hero-kicker">
            <span>异乡的纸页</span>
            <span class="en">PAGES OF ELSEWHERE</span>
          </p>
          <h2 class="hero-title">把陌生菜名<br/><em>读成乡音</em></h2>
          <p class="hero-desc">一页菜单，半段旅程。<br/>镜头对准纸上的字，我们替你译出味道，再递一张清清楚楚的点单卡，给对面那个人。</p>
          <p class="hero-en-line">
            <span><b>LENS</b> on the page</span>
            <span><b>WORDS</b> into taste</span>
            <span><b>CARD</b> to the table</span>
          </p>
        </div>
      </div>
      <div class="capture-actions">
        <label class="btn-capture">
          <img class="btn-capture-bg" src="${asset('assets/card-camera.jpg')}" alt="" />
          <span class="cap-icon">01 · LENS</span>
          <span class="cap-label">现场拍</span>
          <span class="cap-sub">Capture now</span>
          <span class="cap-arrow" aria-hidden="true">${ARROW_SVG}</span>
          <input id="input-camera" type="file" accept="image/*" capture="environment" multiple hidden />
        </label>
        <button type="button" class="btn-capture" id="btn-gallery">
          <img class="btn-capture-bg" src="${asset('assets/card-gallery.jpg')}" alt="" />
          <span class="cap-icon">02 · ROLL</span>
          <span class="cap-label">从相册</span>
          <span class="cap-sub">From gallery</span>
          <span class="cap-arrow" aria-hidden="true">${ARROW_SVG}</span>
        </button>
      </div>
      <input id="input-gallery" type="file" accept="${GALLERY_ACCEPT}" multiple hidden />
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
      ${zenCredit('旅人的菜单册')}
    </section>

    <div class="analyze-wrap">
      <button type="button" class="btn-primary" id="btn-analyze" ${n ? '' : 'disabled'}>
        <span aria-hidden="true">☰</span>
        开卷 · 读懂这页菜单
        <span aria-hidden="true">${ARROW_SVG}</span>
      </button>
      <button type="button" class="btn-soft" id="btn-demo">先翻一册演示 · DEMO</button>
      ${
        !state.settings.apiKey
          ? `<span class="tip-chip">还差一把钥匙 · 点右上角设置密钥 <span class="en">/ SET API KEY</span></span>`
          : `<span class="tip-chip">可连拍多页 · 读之前仍能删掉某一张 <span class="en">/ MULTI-PAGE OK</span></span>`
      }
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
  document.getElementById('btn-gallery')?.addEventListener('click', (e) => {
    e.preventDefault();
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
}

async function loadDemoMenu() {
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
    setPipeline(id, note);
    await new Promise((r) => setTimeout(r, 280));
  }

  const menu = {
    restaurant_name: '演示小馆 · Demo Bistro',
    currency: 'EUR',
    language: 'English / Italian',
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
  menu.categories = await enrichItemsWithCNY(menu.categories, menu.currency);
  setPipeline('images', '免费图库检索菜品照片…');
  menu.categories = await attachImages(menu.categories);
  setPipeline('done', `${menu.categories.length} 个篇章 · 演示册备好`);
  await new Promise((r) => setTimeout(r, 350));
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
    ? `<img class="dish-img" src="${dish.image_url}" alt="" loading="lazy"
         onerror="this.style.display='none';this.nextElementSibling.style.display='grid'" />
       <div class="dish-img-fallback" style="display:none">${dish.emoji || dishEmoji(dish.name_zh)}</div>`
    : `<div class="dish-img-fallback">${dish.emoji || '🍽️'}</div>`;

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

  return `
    <div class="menu-wrap">
      <button type="button" class="back-link" id="btn-back-capture">← 再拍一页</button>
      <div class="menu-header">
        <p class="menu-kicker">${cats.length} 个篇章 · Tableside · Design by Zen</p>
        <h2>${escapeHtml(menu.restaurant_name)}</h2>
        <p class="menu-meta">
          ${countDishes(menu)} 道 · ${menu.currency}
          ${menu.language ? ` · ${escapeHtml(menu.language)}` : ''}
        </p>
      </div>
      <div class="cat-scroll" id="cat-scroll">
        ${cats
          .map(
            (c, i) => `
          <button type="button" class="cat-chip ${i === state.activeCat ? 'active' : ''}" data-cat="${i}">
            ${escapeHtml(c.name_zh)}
            <span class="cat-count">${c.items?.length || 0}</span>
          </button>`,
          )
          .join('')}
      </div>
      <div class="dish-list" id="dish-list">
        ${(cat?.items || []).map((d) => renderDishCard(d)).join('')}
      </div>
      ${zenCredit('分门别类')}
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
    list.innerHTML = (cat?.items || []).map((d) => renderDishCard(d)).join('');
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

function findDish(id) {
  for (const c of state.menu?.categories || []) {
    const d = c.items.find((x) => x.id === id);
    if (d) return d;
  }
  return null;
}

function renderOrder() {
  const items = state.orderItems;
  const { totalCny, totalOrig, count } = orderTotals(items);
  const cur = state.menu?.currency || 'USD';

  return `
    <div class="order-page">
      <button type="button" class="back-link" id="btn-back-menu">← 回到菜单</button>
      <div class="order-head">
        <h2>核对清单</h2>
      </div>
      <p class="order-tip">
        确认无误后点「点完了」· 生成一张清雅的 <strong>菜单卡</strong> 递给服务员
      </p>
      ${items
        .map(
          ({ dish, qty }) => `
        <div class="order-card">
          <button type="button" class="order-card-del" data-rm="${dish.id}" aria-label="删除">×</button>
          <p class="order-card-orig">${escapeHtml(dish.name_original)}</p>
          <p class="order-card-zh">${escapeHtml(dish.name_zh)}</p>
          <div class="order-card-meta">
            <span>× ${qty}</span>
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
      ${zenCredit()}
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
    <div class="receipt-page">
      <button type="button" class="back-link" id="btn-receipt-hist">← 旅记</button>
      <div class="shopping-list" id="shopping-list-card">
        <div class="sl-ornament" aria-hidden="true"><span></span>MENU CARD<span></span></div>
        <div class="sl-head">
          <p class="sl-kicker">ORDER · FOR THE TABLE</p>
          <h2 class="sl-title">${escapeHtml(r.restaurant_name)}</h2>
          <p class="sl-sub">${formatTime(r.createdAt)} · 请按下列菜品为客人准备</p>
          <p class="sl-hint">Please prepare the items below</p>
        </div>
        <div class="sl-divider" aria-hidden="true">✦ · · · · · · · · · · · · · · ✦</div>
        <ol class="sl-rows">
          ${r.items
            .map((it) => {
              idx += 1;
              const lineOrig =
                it.price != null ? formatMoney(Number(it.price) * it.qty, cur) : '—';
              const lineCny =
                it.price_cny != null
                  ? `约 ¥${(Number(it.price_cny) * it.qty).toFixed(2)}`
                  : '';
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
                  ${lineCny ? `<span class="sl-price-cny">${lineCny}</span>` : ''}
                </div>
              </li>`;
            })
            .join('')}
        </ol>
        <div class="sl-divider" aria-hidden="true">✦ · · · · · · · · · · · · · · ✦</div>
        <div class="sl-total">
          <div class="sl-total-left">
            <span class="sl-total-label">TOTAL / 合计</span>
            <span class="sl-total-count">${r.count} items</span>
            ${
              r.total_cny > 0
                ? `<span class="sl-total-cny">约 ¥${Number(r.total_cny).toFixed(2)}</span>`
                : ''
            }
          </div>
          <div class="sl-total-orig">${formatMoney(r.total_orig, cur)}</div>
        </div>
        <p class="sl-foot">
          DESIGN BY ZEN · 食旅集
          <span class="sl-stamp">Guest Order</span>
        </p>
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
      <button type="button" class="back-link" id="btn-hist-back">← 返回</button>
      <h2>点单旅记</h2>
      ${
        list.length
          ? list
              .map(
                (h) => `
            <div class="history-item" data-hid="${h.id}">
              <h3>${escapeHtml(h.restaurant_name)}</h3>
              <p>${formatTime(h.createdAt)} · ${h.items?.length || 0} 道</p>
              <div class="row">
                <span>
                  ${h.total_orig != null ? formatMoney(h.total_orig, h.currency || 'USD') : ''}
                  <em style="font-style:normal;display:block;font-size:0.68rem;color:var(--ink-faint);font-weight:400">
                    约 ¥${Number(h.total_cny || 0).toFixed(2)}
                  </em>
                </span>
                <button type="button" class="btn-danger-soft" data-hdel="${h.id}">抹去</button>
              </div>
            </div>`,
              )
              .join('')
          : `<div class="empty-state" style="margin-top:16px">
              <div class="emoji">空白旅记</div>
              还没有写下任何一餐<br/>点完菜之后，会留在这里
            </div>`
      }
      ${zenCredit()}
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
      if (e.target.closest('[data-hdel]')) return;
      const id = el.getAttribute('data-hid');
      const item = loadHistory().find((x) => x.id === id);
      if (item) {
        state.historyDetail = item;
        state.view = 'history-detail';
        render();
      }
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
  return `
    <div class="order-page">
      <button type="button" class="back-link" id="btn-hdd-back">← 旅记目录</button>
      <div class="order-head">
        <h2>${escapeHtml(h.restaurant_name)}</h2>
        <p class="menu-meta" style="margin-top:8px">${formatTime(h.createdAt)}</p>
      </div>
      <p class="order-tip">旧笺 · 原文在上 · 仍可递给服务员 · DESIGN BY ZEN</p>
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
      ${zenCredit()}
    </div>
  `;
}

function bindHistoryDetail() {
  document.getElementById('btn-hdd-back')?.addEventListener('click', () => {
    state.view = 'history';
    render();
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

// —— Global bindings ——
document.getElementById('btn-settings')?.addEventListener('click', openSettings);
document.getElementById('btn-history')?.addEventListener('click', () => {
  state.view = 'history';
  render();
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
window.addEventListener('resize', syncChromeHeight);
window.addEventListener('orientationchange', () => setTimeout(syncChromeHeight, 120));

// 无 key 时轻提示
if (!state.settings.apiKey) {
  setTimeout(() => toast('右上角填密钥，再启程 · DESIGN BY ZEN', 2800), 600);
}

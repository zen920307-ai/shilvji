const SETTINGS_KEY = 'shilvji_settings';
const HISTORY_KEY = 'shilvji_history';

const DEFAULT_SETTINGS = {
  apiKey: '',
  // 默认 DeepSeek（用户常用）
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  currency: 'auto',
};

/** 一键预设 */
export const PROVIDER_PRESETS = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    label: 'DeepSeek',
  },
  xai: {
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4.5',
    label: 'xAI Grok',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    label: 'OpenAI',
  },
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, ...settings }));
}

export function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveHistory(list) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
}

export function addHistoryEntry(entry) {
  const list = loadHistory();
  list.unshift(entry);
  // 最多保留 50 条
  saveHistory(list.slice(0, 50));
  return list;
}

export function deleteHistoryEntry(id) {
  const list = loadHistory().filter((x) => x.id !== id);
  saveHistory(list);
  return list;
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

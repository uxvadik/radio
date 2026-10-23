// Простое реактивное хранилище с сохранением в localStorage.
const KEY = 'radio-player:state:v1';

const DEFAULTS = {
  theme: 'dark', // dark | light | auto
  volume: 0.85,
  muted: false,
  installed: false,

  // режим: radio | tv
  mode: 'radio',
  lastStation: null,
  lastChannel: null,
  activePlaylistId: 'b-altrock',
  activePlaylistRadio: 'b-altrock',
  activePlaylistTv: 'tv-edu',

  // радио
  metadata: true,
  metadataInterval: 15, // сек
  noise: false,          // шумы радио (по умолчанию выключены)
  noiseOffDefault: true, // миграция: выключить шумы у старых настроек
  metaUrls: {},          // stationId -> url метаданных

  // общее
  proxies: [
    'https://proxy.corsfix.com/?url={url}',
    'https://api.allorigins.win/raw?url={url}',
    'https://api.codetabs.com/v1/proxy?quest={url}',
    'https://corsproxy.io/?url={url}',
  ],
  customPlaylists: [], // { id, name, url, stations: [...] }
  favorites: [],       // избранное РАДИО
  recent: [],          // недавние РАДИО
  favoritesTv: [],     // избранное ТВ
  recentTv: [],        // недавние ТВ
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    const merged = { ...structuredClone(DEFAULTS), ...parsed };

    // одноразово выключаем шумы у уже сохранённых настроек
    if (parsed.noiseOffDefault !== true) {
      merged.noise = false;
      merged.noiseOffDefault = true;
      try {
        localStorage.setItem(KEY, JSON.stringify(merged));
      } catch {
        /* ignore */
      }
    }

    // corsfix нужен для ТВ (Rutube) — держим первым
    if (!Array.isArray(merged.proxies)) merged.proxies = [];
    if (!merged.proxies.some((p) => typeof p === 'string' && p.includes('corsfix.com'))) {
      merged.proxies.unshift('https://proxy.corsfix.com/?url={url}');
    }

    // для старых радио-настроек подхватываем активный плейлист
    if (parsed.activePlaylistRadio === undefined) {
      merged.activePlaylistRadio = parsed.activePlaylistId || 'b-altrock';
    }
    if (merged.mode !== 'tv' && merged.mode !== 'radio') merged.mode = 'radio';

    return merged;
  } catch {
    return structuredClone(DEFAULTS);
  }
}

let state = load();
const listeners = new Set();
let saveTimer = null;

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Не удалось сохранить состояние', e);
    }
  }, 150);
}

export const store = {
  get all() {
    return state;
  },
  get(key) {
    return state[key];
  },
  set(patch) {
    state = { ...state, ...patch };
    persist();
    listeners.forEach((fn) => fn(state));
  },
  update(fn) {
    const patch = fn(state);
    if (patch) store.set(patch);
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  reset() {
    state = structuredClone(DEFAULTS);
    persist();
    listeners.forEach((fn) => fn(state));
  },
  export() {
    return JSON.stringify(state, null, 2);
  },
  import(json) {
    const parsed = JSON.parse(json);
    state = { ...structuredClone(DEFAULTS), ...parsed };
    persist();
    listeners.forEach((fn) => fn(state));
  },
};

// --- Избранное (своё для радио и ТВ) ---------------------------------------

function favKey(mode) {
  return mode === 'tv' ? 'favoritesTv' : 'favorites';
}

export const favorites = {
  list(mode) {
    return state[favKey(mode)] || [];
  },
  has(item, mode) {
    return favorites.list(mode).some((s) => s.id === item.id || s.url === item.url);
  },
  toggle(item, mode) {
    const exists = favorites.has(item, mode);
    const key = favKey(mode);
    const next = exists
      ? favorites.list(mode).filter((s) => s.id !== item.id && s.url !== item.url)
      : [item, ...favorites.list(mode)];
    store.set({ [key]: next });
    return !exists;
  },
  remove(item, mode) {
    const key = favKey(mode);
    store.set({ [key]: favorites.list(mode).filter((s) => s.id !== item.id && s.url !== item.url) });
  },
};

// --- Недавние (своё для радио и ТВ) ----------------------------------------

function recentKey(mode) {
  return mode === 'tv' ? 'recentTv' : 'recent';
}

export const recent = {
  list(mode) {
    return state[recentKey(mode)] || [];
  },
  push(item, mode) {
    const key = recentKey(mode);
    const next = [item, ...recent.list(mode).filter((s) => s.url !== item.url)].slice(0, 30);
    store.set({ [key]: next });
  },
};

export function uid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

// Простое реактивное хранилище с сохранением в localStorage.
const KEY = 'radio-player:state:v1';

const DEFAULTS = {
  theme: 'dark', // dark | light | auto
  volume: 0.85,
  muted: false,
  metadata: true,
  metadataInterval: 15, // сек
  noise: false,         // шумы радио при буферизации (по умолчанию выключены)
  noiseOffDefault: true, // одноразовая миграция: выключить шумы у старых настроек
  installed: false,     // отмечено ли, что приложение установлено
  proxies: [
    'https://api.allorigins.win/raw?url={url}',
    'https://api.codetabs.com/v1/proxy?quest={url}',
    'https://corsproxy.io/?url={url}',
  ],
  customPlaylists: [], // { id, name, url, stations: [...] }
  favorites: [],       // станции
  recent: [],          // станции
  lastStation: null,
  activePlaylistId: 'b-altrock',
  metaUrls: {},        // stationId -> url метаданных (переопределение)
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    // для уже сохранённых настроек один раз принудительно выключаем шумы
    const firstRun = parsed.noiseOffDefault !== true;
    const merged = { ...structuredClone(DEFAULTS), ...parsed, noiseOffDefault: true };
    if (firstRun) {
      merged.noise = false;
      // сразу фиксируем в localStorage, чтобы миграция не зависела от других записей
      try {
        localStorage.setItem(KEY, JSON.stringify(merged));
      } catch {
        /* ignore */
      }
    }
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

// --- Избранное -------------------------------------------------------------

export const favorites = {
  has(station) {
    return state.favorites.some((s) => s.id === station.id || s.url === station.url);
  },
  toggle(station) {
    const exists = favorites.has(station);
    const next = exists
      ? state.favorites.filter((s) => s.id !== station.id && s.url !== station.url)
      : [station, ...state.favorites];
    store.set({ favorites: next });
    return !exists;
  },
  remove(station) {
    store.set({ favorites: state.favorites.filter((s) => s.id !== station.id && s.url !== station.url) });
  },
};

// --- Недавние --------------------------------------------------------------

export const recent = {
  push(station) {
    const next = [station, ...state.recent.filter((s) => s.url !== station.url)].slice(0, 30);
    store.set({ recent: next });
  },
};

export function uid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

// Точка входа: связывает хранилище, каталог, плеер и интерфейс.
import { store, favorites, recent, uid } from './store.js';
import { Player } from './player.js';
import { resolveNowPlaying, fetchText } from './metadata.js';
import { NoiseEngine } from './noise.js';
import { parsePlaylist, makeStation } from './m3u.js';
import { searchStations, PRESETS, BUNDLED, GTA } from './radio.js';
import { ui, h, $ } from './ui.js';

const player = new Player($('#audio'));

const noise = new NoiseEngine([
  { url: './sample/2.mp3', weight: 1 },
  { url: './sample/3.mp3', weight: 0.03 }, // «помеха телефона» — очень редко
  { url: './sample/4.mp3', weight: 1 },
  { url: './sample/1.mp3', weight: 1 },
]);
noise.enabled = store.get('noise');

const NOISE_DELAY = 400; // мс реальной тишины до включения шума
let noiseOn = false;
let silenceTimer = null;
let prevTime = null;
let stallMs = 0;

function applyNoiseVolume() {
  noise.setVolume((store.get('muted') ? 0 : store.get('volume')) * 0.4);
}

// Шум включаем ТОЛЬКО когда звук реально пропал: следим за currentTime —
// если он не двигается при «играющем» плеере, значит тишина (буферизация).
function startSilenceWatch() {
  if (silenceTimer) return;
  prevTime = null;
  stallMs = 0;
  silenceTimer = setInterval(() => {
    const a = player.audio;
    const wantsPlay = !!player.station && !a.paused && !a.ended && !player.error;
    const t = a.currentTime;
    const progressed = prevTime === null ? false : t !== prevTime;
    prevTime = t;

    if (!wantsPlay || !store.get('noise')) {
      stallMs = 0;
      if (noiseOn) {
        noise.stop();
        noiseOn = false;
      }
      return;
    }
    if (progressed) {
      stallMs = 0;
      if (noiseOn) {
        noise.stop();
        noiseOn = false;
      }
    } else {
      stallMs += 250;
      if (!noiseOn && stallMs >= NOISE_DELAY) {
        noiseOn = true;
        noise.start();
      }
    }
  }, 250);
}

let currentStations = [];
let currentPlaylistId = store.get('activePlaylistId');
let metaTimer = null;
let metaToken = 0;
let searchTimer = null;
let deferredPrompt = null;

// ------------------------------------------------------------------ тема
function resolvedTheme() {
  const t = store.get('theme');
  if (t === 'auto') return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return t;
}
function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
  const meta = document.querySelector('meta[name="theme-color"]');
  // основной theme-color оставляем системным; фон меняет CSS
  if (meta) meta.setAttribute('content', resolvedTheme() === 'dark' ? '#07080a' : '#c6cad1');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (store.get('theme') === 'auto') applyTheme();
});

// ---------------------------------------------------------------- playlists
function customPlaylists() {
  return store.get('customPlaylists');
}

const bundledCache = new Map();
async function loadBundled(b) {
  if (bundledCache.has(b.id)) return bundledCache.get(b.id);
  const text = await fetchText(b.url, []);
  const list = text ? parsePlaylist(text) : [];
  bundledCache.set(b.id, list);
  return list;
}

function allPlaylists() {
  const list = [
    { id: 'fav', name: 'Избранное', kind: 'fav' },
  ];
  if (store.get('recent').length) list.push({ id: 'recent', name: 'Недавние', kind: 'recent' });
  list.push(...BUNDLED.map((b) => ({ id: b.id, name: b.name, kind: 'bundled' })));
  list.push(...PRESETS.map((p) => ({ id: p.id, name: p.name, kind: 'preset', query: p.query })));
  list.push(...GTA.map((b) => ({ id: b.id, name: b.name, kind: 'bundled' })));
  list.push(...customPlaylists().map((p) => ({ id: p.id, name: p.name, kind: 'm3u', removable: p.id !== 'mine' })));
  return list;
}

function renderTabs() {
  ui.renderTabs(allPlaylists(), currentPlaylistId);
}

async function selectPlaylist(id, { silent } = {}) {
  currentPlaylistId = id;
  store.set({ activePlaylistId: id });
  if (!silent) exitSearch();
  renderTabs();

  if (id === 'fav') {
    currentStations = store.get('favorites');
    renderList();
    ui.setStatus('избранное');
    return;
  }
  if (id === 'recent') {
    currentStations = store.get('recent');
    renderList();
    ui.setStatus('недавние');
    return;
  }

  const bundled = [...BUNDLED, ...GTA].find((b) => b.id === id);
  if (bundled) {
    ui.setLoading();
    try {
      const list = await loadBundled(bundled);
      if (currentPlaylistId !== id) return;
      currentStations = list;
      renderList();
      ui.setStatus(bundled.name);
      if (!list.length) ui.setMessage('Плейлист пуст.');
    } catch {
      if (currentPlaylistId !== id) return;
      ui.setMessage('Не удалось загрузить встроенный плейлист.');
    }
    return;
  }

  const preset = PRESETS.find((p) => p.id === id);
  if (preset) {
    ui.setLoading();
    try {
      const list = await searchStations(preset.query);
      if (currentPlaylistId !== id) return;
      currentStations = list;
      renderList();
      ui.setStatus(`${preset.name.toLowerCase()} · каталог`);
    } catch (e) {
      if (currentPlaylistId !== id) return;
      ui.setMessage('Каталог недоступен.<br>Проверь интернет и попробуй снова.');
      ui.setStatus('ошибка каталога');
    }
    return;
  }

  const custom = customPlaylists().find((p) => p.id === id);
  if (custom) {
    if (custom.stations && custom.stations.length) {
      currentStations = custom.stations;
      renderList();
      ui.setStatus(custom.name);
      return;
    }
    ui.setLoading();
    try {
      const text = await fetchText(custom.url, store.get('proxies'));
      const list = text ? parsePlaylist(text) : [];
      const cached = customPlaylists().map((p) => (p.id === id ? { ...p, stations: list, updated: Date.now() } : p));
      store.set({ customPlaylists: cached });
      if (currentPlaylistId !== id) return;
      currentStations = list;
      renderList();
      ui.setStatus(`${custom.name} · ${list.length}`);
      if (!list.length) ui.setMessage('Плейлист пуст или не удалось прочитать.<br>Проверь ссылку.');
    } catch {
      if (currentPlaylistId !== id) return;
      ui.setMessage('Не удалось загрузить плейлист.<br>Некоторые ссылки требуют CORS-прокси — проверь настройки.');
      ui.setStatus('ошибка плейлиста');
    }
  }
}

// -------------------------------------------------------------------- список
function renderList() {
  const set = new Set();
  store.get('favorites').forEach((s) => {
    set.add(s.id);
    set.add(s.url);
  });
  ui.renderList(currentStations, {
    activeUrl: player.station && player.station.url,
    playing: player.playing,
    favoritesSet: set,
  });
}

function pickStation(i) {
  const s = currentStations[i];
  if (!s) return;
  if (player.station && player.station.url === s.url && player.audio.src) {
    player.toggle();
    return;
  }
  recent.push(s);
  player.playStation(s, currentStations, i);
  updateFavButton();
  renderList();
}

// -------------------------------------------------------------------- поиск
function enterSearch() {
  document.body.dataset.mode = 'search';
}
function exitSearch() {
  const input = $('#search');
  if (input && input.value) input.value = '';
  $('#search-clear').hidden = true;
  delete document.body.dataset.mode;
}

function onSearchInput() {
  const term = $('#search').value.trim();
  $('#search-clear').hidden = !term;
  clearTimeout(searchTimer);
  if (term.length < 2) {
    if (document.body.dataset.mode === 'search') selectPlaylist(currentPlaylistId, { silent: true });
    return;
  }
  enterSearch();
  ui.setLoading();
  ui.setStatus('поиск…');
  searchTimer = setTimeout(async () => {
    try {
      const list = await searchStations({ name: term, order: 'clickcount', reverse: 'true', limit: '80' });
      currentStations = list;
      renderList();
      ui.setStatus(`поиск: «${term}»`);
    } catch {
      ui.setMessage('Поиск недоступен. Проверь интернет.');
    }
  }, 450);
}

// ------------------------------------------------------------------- player
function badgeFor({ loading, error, station, playing }) {
  if (error) return 'ERR';
  if (loading) return 'LOAD';
  if (!station) return 'IDLE';
  if (playing) return 'LIVE';
  return 'PAUSE';
}

function trackText(st) {
  if (player.nowPlaying) return player.nowPlaying;
  if (st.error) return st.error;
  if (!st.station) return 'потоковое радио';
  if (st.loading) return 'подключаюсь к потоку…';
  if (st.playing) return 'в эфире — без данных о треке';
  return st.station.name + ' — на паузе';
}

player.on('station', (station) => {
  ui.setPlayerInfo({ station, badge: 'LOAD', track: 'подключаюсь к потоку…', playing: false });
  ui.setStatus('буферизация…');
  updateFavButton();
  startMetadata();
  noise.unlock(); // разблокируем Web Audio внутри жеста пользователя
});

player.on('state', (st) => {
  document.body.classList.toggle('playing', st.playing);
  ui.setPlayerInfo({
    station: st.station,
    badge: badgeFor(st),
    track: trackText(st),
    playing: st.playing,
  });
  if (st.error) ui.setStatus(st.error);
  else if (st.playing) ui.setStatus('в эфире');
  renderList();
  if (st.playing) refreshNowPlaying();
});

player.on('error', ({ error }) => ui.toast(error));
player.on('nowplaying', () => {
  ui.setTrack(trackText({ playing: player.playing, loading: player.loading, error: player.error, station: player.station }));
});

player.on('volume', ({ volume, muted }) => {
  ui.setVolumeBar(muted ? 0 : volume);
  ui.setMuted(muted);
});

// ---------------------------------------------------------------- метаданные
function startMetadata() {
  stopMetadata();
  metaToken++;
  player.setNowPlaying('');
  if (!store.get('metadata')) return;
  refreshNowPlaying();
  const sec = Math.max(5, Number(store.get('metadataInterval')) || 15);
  metaTimer = setInterval(refreshNowPlaying, sec * 1000);
}
function stopMetadata() {
  if (metaTimer) clearInterval(metaTimer);
  metaTimer = null;
}
async function refreshNowPlaying() {
  const s = player.station;
  if (!s || player.audio.paused) return;
  const token = metaToken;
  try {
    const res = await resolveNowPlaying(s, {
      proxies: store.get('proxies'),
      metaUrl: store.get('metaUrls')[s.id],
    });
    if (token !== metaToken) return;
    player.setNowPlaying(res ? res.raw : '');
  } catch {
    /* тихо игнорируем */
  }
}

// ------------------------------------------------------------- избранное
function updateFavButton() {
  ui.setFav(!!(player.station && favorites.has(player.station)));
}

// ------------------------------------------------------------------- шиты
function openAddSheet() {
  const nameInput = h('input', { type: 'text', placeholder: 'Название (напр. Свои радио)' });
  const urlInput = h('input', { type: 'text', placeholder: 'https://example.com/list.m3u', inputmode: 'url' });

  const sName = h('input', { type: 'text', placeholder: 'Название станции' });
  const sUrl = h('input', { type: 'text', placeholder: 'https://stream.example.com:8000/live', inputmode: 'url' });
  const sMeta = h('input', { type: 'text', placeholder: 'URL метаданных (необязательно)', inputmode: 'url' });

  const body = h('div', {},
    h('div', { class: 'section-title' }, 'Плейлист M3U'),
    h('div', { class: 'field' }, h('label', {}, 'Название'), nameInput),
    h('div', { class: 'field' }, h('label', {}, 'Ссылка на .m3u / .m3u8'), urlInput,
      h('div', { class: 'hint' }, 'Файл подхватится через CORS-прокси, если сервер не отдаёт заголовки.')),
    h('button', { class: 'btn primary', onClick: () => addM3U(nameInput.value, urlInput.value) }, 'Добавить плейлист'),

    h('div', { class: 'section-title' }, 'Отдельная станция'),
    h('div', { class: 'field' }, h('label', {}, 'Название'), sName),
    h('div', { class: 'field' }, h('label', {}, 'Прямая ссылка на поток'), sUrl),
    h('div', { class: 'field' }, h('label', {}, 'Свой URL метаданных'), sMeta),
    h('button', { class: 'btn', onClick: () => addStream(sName.value, sUrl.value, sMeta.value) }, 'Добавить станцию'),

    h('div', { class: 'section-title' }, 'Мои плейлисты'),
    ...manageList()
  );
  ui.openSheet('Добавить', body);
}

function manageList() {
  const cps = customPlaylists();
  if (!cps.length) return [h('div', { class: 'hint' }, 'Пока ничего не добавлено.')];
  return cps.map((p) =>
    h('div', { class: 'manage-item' },
      h('div', { class: 'mi-info' },
        h('div', { class: 'mi-name' }, p.name),
        h('div', { class: 'mi-sub' }, p.url ? p.url : `${(p.stations || []).length} станций`)
      ),
      h('button', {
        class: 'icon-btn',
        type: 'button',
        title: 'Удалить',
        onClick: () => {
          if (p.id === 'mine') {
            store.set({ customPlaylists: cps.filter((x) => x.id !== 'mine') });
          } else {
            store.set({ customPlaylists: cps.filter((x) => x.id !== p.id) });
          }
          ui.toast('Удалено: ' + p.name);
          if (currentPlaylistId === p.id) selectPlaylist('top');
          else renderTabs();
          openAddSheet();
        },
      }, h('span', { class: 'ico ico-close' }))
    )
  );
}

async function addM3U(name, url) {
  url = (url || '').trim();
  if (!/^https?:\/\//i.test(url)) return ui.toast('Укажи ссылку http(s)://…');
  let finalName = (name || '').trim();
  if (!finalName) {
    try {
      finalName = new URL(url).hostname;
    } catch {
      finalName = 'Плейлист';
    }
  }
  const pl = { id: uid(), name: finalName, url, stations: [] };
  store.set({ customPlaylists: [...customPlaylists(), pl] });
  ui.closeSheet();
  ui.toast('Плейлист добавлен');
  await selectPlaylist(pl.id);
}

function ensureMine() {
  let mine = customPlaylists().find((p) => p.id === 'mine');
  if (!mine) {
    mine = { id: 'mine', name: 'Мои станции', url: '', stations: [] };
    store.set({ customPlaylists: [...customPlaylists(), mine] });
  }
  return mine;
}

function addStream(name, url, metaUrl) {
  url = (url || '').trim();
  if (!/^https?:\/\//i.test(url)) return ui.toast('Укажи ссылку http(s)://…');
  const station = makeStation({ name: (name || '').trim() || url, url }, 'custom');
  const mine = ensureMine();
  const stations = [station, ...(mine.stations || [])];
  store.update((st) => ({
    customPlaylists: st.customPlaylists.map((p) => (p.id === 'mine' ? { ...p, stations } : p)),
    metaUrls: metaUrl ? { ...st.metaUrls, [station.id]: metaUrl.trim() } : st.metaUrls,
  }));
  ui.closeSheet();
  ui.toast('Станция добавлена');
  selectPlaylist('mine');
}

function detectOS() {
  const ua = navigator.userAgent || '';
  const touch = navigator.maxTouchPoints || 0;
  if (/iPhone|iPod/i.test(ua)) return 'ios';
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && touch > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  return 'other';
}

function isInstalled() {
  try {
    return (
      store.get('installed') ||
      (window.matchMedia &&
        (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: minimal-ui)').matches)) ||
      navigator.standalone === true
    );
  } catch {
    return false;
  }
}

function installSteps() {
  if (/Firefox|FxiOS/i.test(navigator.userAgent)) {
    return {
      note: 'В Firefox установка недоступна. Откройте сайт в Chrome, Edge или Safari — там можно поставить как приложение.',
      steps: [],
    };
  }
  switch (detectOS()) {
    case 'ios':
      return {
        steps: [
          'Откройте сайт в Safari',
          'Нажмите «Поделиться» (квадрат со стрелкой)',
          'Пролистайте и выберите «На экран „Домой“»',
          'Включите «Открыть как веб-приложение» → «Добавить»',
        ],
      };
    case 'android':
      return { steps: ['Меню ⋮ справа сверху', '«Установить приложение»', 'Подтвердите «Установить»'] };
    case 'macos': {
      const isSafari = /Safari/i.test(navigator.userAgent) && !/Chrome|Chromium|Edg|OPR/i.test(navigator.userAgent);
      return {
        steps: isSafari
          ? ['В меню Safari: File → Add to Dock', 'Задайте имя → «Add»']
          : ['Иконка установки в адресной строке справа', 'или ⋮ → «Установить приложение…»'],
      };
    }
    case 'windows':
      return { steps: ['Иконка установки в адресной строке справа', 'или ⋮ → «Установить приложение…»'] };
    default:
      return { steps: ['Откройте меню браузера', '«Установить приложение» / «Add to Home screen»'] };
  }
}

function buildInstallCard() {
  if (isInstalled()) return null;
  const { steps, note } = installSteps();

  const children = [
    h('h3', {}, h('span', { class: 'ico ico-install' }), 'Установить приложение'),
    h('p', { class: 'ic-note' }, 'Иконка на экране, полный экран без адресной строки, запуск в один тап. Реагирует на кнопки на наушниках и медиа-клавиши клавиатуры. Весит копейки — это тот же сайт.'),
  ];
  if (note) children.push(h('p', { class: 'ic-note' }, note));
  if (steps.length) children.push(h('ol', {}, ...steps.map((s) => h('li', {}, s))));
  if (deferredPrompt) {
    children.push(
      h('button', {
        class: 'btn primary',
        onClick: async () => {
          try {
            deferredPrompt.prompt();
            await deferredPrompt.userChoice;
          } catch {
            /* отменено */
          }
          deferredPrompt = null;
          ui.closeSheet();
        },
      }, 'Установить')
    );
  }
  return h('div', { class: 'install-card' }, ...children);
}

function openSettingsSheet() {
  const themeSel = h('select', {},
    h('option', { value: 'dark' }, 'Тёмная'),
    h('option', { value: 'light' }, 'Светлая'),
    h('option', { value: 'auto' }, 'Как в системе')
  );
  themeSel.value = store.get('theme');

  const metaChk = h('input', { type: 'checkbox', checked: store.get('metadata') });
  const noiseChk = h('input', { type: 'checkbox', checked: store.get('noise') });
  const interval = h('input', { type: 'number', min: '5', max: '120', value: store.get('metadataInterval') });
  const proxies = h('textarea', { class: 'proxy-area' });
  proxies.value = store.get('proxies').join('\n');
  proxies.style.cssText = 'width:100%;min-height:96px;padding:11px 12px;background:var(--panel-2);border:1px solid var(--line);border-radius:10px;font:12px var(--mono);color:var(--text);outline:none';

  const importFile = h('input', { type: 'file', accept: '.json,application/json', hidden: true });

  const body = h('div', {},
    buildInstallCard(),
    h('div', { class: 'section-title' }, 'Внешний вид'),
    h('div', { class: 'field' }, h('label', {}, 'Тема'), themeSel),

    h('div', { class: 'section-title' }, 'Метаданные «сейчас играет»'),
    h('label', { class: 'switch' },
      h('span', {}, h('span', { class: 'sw-txt' }, 'Показывать трек'), h('div', { class: 'sw-sub' }, 'Читаем статус Icecast/SHOUTcast через прокси')),
      metaChk
    ),
    h('div', { class: 'field', style: { marginTop: '12px' } }, h('label', {}, 'Интервал обновления, сек'), interval),
    h('div', { class: 'field' }, h('label', {}, 'CORS-прокси (по одному в строке, {url} — место ссылки)'), proxies,
      h('div', { class: 'hint' }, 'Прокси нужны, т.к. серверы радио не отдают CORS-заголовки. Если один не работает — попробуй другой.'))
,
    h('button', { class: 'btn primary', onClick: () => {
      const list = proxies.value.split('\n').map((s) => s.trim()).filter(Boolean);
      store.set({
        theme: themeSel.value,
        metadata: metaChk.checked,
        metadataInterval: Math.max(5, Number(interval.value) || 15),
        proxies: list,
        noise: noiseChk.checked,
      });
      applyTheme();
      startMetadata();
      noise.enabled = noiseChk.checked;
      if (!noiseChk.checked) noise.stop();
      ui.toast('Настройки сохранены');
      ui.closeSheet();
    } }, 'Сохранить'),

    h('div', { class: 'section-title' }, 'Звук'),
    h('label', { class: 'switch' },
      h('span', {}, h('span', { class: 'sw-txt' }, 'Шумы при буферизации'), h('div', { class: 'sw-sub' }, 'Радиопомехи вместо тишины, пока грузится поток')),
      noiseChk
    ),

    h('div', { class: 'section-title' }, 'Данные'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onClick: exportData }, 'Экспорт'),
      h('button', { class: 'btn', onClick: () => importFile.click() }, 'Импорт')
    ),
    h('div', { class: 'btn-row', style: { marginTop: '8px' } },
      h('button', { class: 'btn danger', onClick: () => {
        if (confirm('Сбросить все настройки, избранное и плейлисты?')) {
          store.reset();
          location.reload();
        }
      } }, 'Сбросить всё')
    ),

    h('div', { class: 'section-title' }, 'Обновление'),
    h('button', { class: 'btn primary', onClick: forceUpdate }, 'Обновить приложение'),
    h('div', { class: 'hint', style: { marginTop: '6px' } }, 'Скачает свежую версию с сервера и перезагрузит приложение. Воспроизведение остановится.'),
    importFile,
    h('div', { class: 'hint', style: { marginTop: '14px' } }, 'Установка: открой меню браузера → «Добавить на главный экран». На iPhone — «Поделиться» → «На экран Домой».')
  );

  importFile.addEventListener('change', async () => {
    const file = importFile.files[0];
    if (!file) return;
    try {
      store.import(await file.text());
      applyTheme();
      location.reload();
    } catch {
      ui.toast('Некорректный файл');
    }
  });

  ui.openSheet('Настройки', body);
}

async function forceUpdate() {
  ui.toast('Обновляю…', 2000);
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    // обновляем HTTP-кэш браузера: тянем файлы в обход кэша (GitHub Pages кэширует JS)
    const bust = [
      './',
      './index.html',
      './css/app.css',
      './js/app.js',
      './js/store.js',
      './js/ui.js',
      './js/player.js',
      './js/radio.js',
      './js/m3u.js',
      './js/metadata.js',
      './js/noise.js',
      './manifest.webmanifest',
      './sw.js',
    ];
    await Promise.all(bust.map((u) => fetch(u, { cache: 'reload' }).catch(() => {})));
  } catch (e) {
    console.warn('Не удалось сбросить кэш', e);
  }
  const url = new URL(location.href);
  url.searchParams.set('u', Date.now().toString(36));
  location.replace(url.toString());
}

function exportData() {
  const blob = new Blob([store.export()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'radio-player-settings.json';
  a.click();
  URL.revokeObjectURL(a.href);
  ui.toast('Файл сохранён');
}

function openStationSheet(index) {
  const s = currentStations[index];
  if (!s) return;
  const isCustom = s.source === 'custom' || s.source === 'm3u';
  const nameInput = h('input', { type: 'text', value: s.name });
  const urlInput = h('input', { type: 'text', value: s.url, inputmode: 'url' });
  const metaInput = h('input', { type: 'text', value: store.get('metaUrls')[s.id] || '', placeholder: 'напр. https://host:8000/status-json.xsl', inputmode: 'url' });

  const favLabel = favorites.has(s) ? 'Убрать из избранного' : 'В избранное';

  const body = h('div', {},
    h('div', { class: 'field' }, h('label', {}, 'Название'), nameInput),
    h('div', { class: 'field' }, h('label', {}, 'Поток'), urlInput),
    h('div', { class: 'field' }, h('label', {}, 'Свой URL метаданных'), metaInput,
      h('div', { class: 'hint' }, 'Если трек не определяется автоматически — укажи страницу Icecast (/status-json.xsl) или SHOUTcast (/7.html).')),

    h('button', { class: 'btn', onClick: () => {
      const on = favorites.toggle({ ...s, name: nameInput.value.trim() || s.name });
      updateFavButton();
      renderList();
      ui.toast(on ? 'Добавлено в избранное' : 'Убрано из избранного');
      ui.closeSheet();
    } }, favLabel),

    h('div', { class: 'btn-row', style: { marginTop: '8px' } },
      h('button', { class: 'btn primary', onClick: () => {
        const name = nameInput.value.trim() || s.name;
        const url = urlInput.value.trim() || s.url;
        const metaUrl = metaInput.value.trim();
        store.update((st) => ({
          metaUrls: { ...st.metaUrls, [s.id]: metaUrl },
          customPlaylists: st.customPlaylists.map((p) => ({
            ...p,
            stations: (p.stations || []).map((x) => (x.id === s.id ? { ...x, name, url } : x)),
          })),
          favorites: st.favorites.map((x) => (x.id === s.id ? { ...x, name, url } : x)),
        }));
        if (player.station && player.station.url === s.url) {
          player.station.name = name;
          player.station.url = url;
        }
        startMetadata();
        renderList();
        ui.toast('Сохранено');
        ui.closeSheet();
      } }, 'Сохранить'),

      isCustom
        ? h('button', { class: 'btn danger', onClick: () => {
            store.update((st) => ({
              customPlaylists: st.customPlaylists.map((p) => ({
                ...p,
                stations: (p.stations || []).filter((x) => x.id !== s.id),
              })),
              favorites: st.favorites.filter((x) => x.id !== s.id),
            }));
            currentStations = currentStations.filter((x) => x.id !== s.id);
            renderList();
            ui.toast('Удалено');
            ui.closeSheet();
          } }, 'Удалить')
        : null
    )
  );
  ui.openSheet('Станция', body);
}

// ------------------------------------------------------------------- UI bind
function bindTopbar() {
  $('#btn-theme').addEventListener('click', () => {
    const order = ['dark', 'light', 'auto'];
    const next = order[(order.indexOf(store.get('theme')) + 1) % order.length];
    store.set({ theme: next });
    applyTheme();
    ui.toast({ dark: 'Тёмная тема', light: 'Светлая тема', auto: 'Как в системе' }[next]);
  });

  $('#btn-settings').addEventListener('click', openSettingsSheet);
  $('#btn-add').addEventListener('click', openAddSheet);
  $('#btn-play').addEventListener('click', () => {
    if (!player.station && currentStations.length) pickStation(0);
    else player.toggle();
  });
  $('#btn-next').addEventListener('click', () => player.next());
  $('#btn-prev').addEventListener('click', () => player.prev());
  $('#btn-mute').addEventListener('click', () => {
    const muted = !store.get('muted');
    store.set({ muted });
    player.setMuted(muted);
    ui.setMuted(muted);
    ui.setVolumeBar(muted ? 0 : store.get('volume'));
    applyNoiseVolume();
  });
  $('#btn-fav').addEventListener('click', () => {
    if (!player.station) return ui.toast('Сначала включи станцию');
    const added = favorites.toggle(player.station);
    updateFavButton();
    renderTabs();
    renderList();
    ui.toast(added ? 'В избранном' : 'Убрано из избранного');
  });

  const vol = $('#vol');
  vol.addEventListener('input', () => {
    const v = Number(vol.value) / 100;
    store.set({ volume: v, muted: false });
    player.setVolume(v);
    player.setMuted(false);
    ui.setVolumeBar(v);
    ui.setMuted(false);
    applyNoiseVolume();
  });

  $('#search').addEventListener('input', onSearchInput);
  $('#search-clear').addEventListener('click', () => {
    $('#search').value = '';
    $('#search-clear').hidden = true;
    selectPlaylist(currentPlaylistId, { silent: true });
  });

  // колесо мыши по ленте вкладок листает её по горизонтали (тачпад умеет сам)
  $('#tabs').addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // горизонтальный жест — как есть
      e.preventDefault();
      const el = e.currentTarget;
      let d = e.deltaY;
      if (e.deltaMode === 1) d *= 28; // строки (Firefox)
      else if (e.deltaMode === 2) d *= el.clientWidth; // страницы
      el.scrollLeft += d;
    },
    { passive: false }
  );

  $('#tabs').addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-remove]');
    const tab = e.target.closest('.tab');
    if (!tab) return;
    if (removeBtn && tab.dataset.id) {
      const id = tab.dataset.id;
      store.set({ customPlaylists: customPlaylists().filter((p) => p.id !== id) });
      ui.toast('Плейлист удалён');
      if (currentPlaylistId === id) selectPlaylist('top');
      else renderTabs();
      return;
    }
    selectPlaylist(tab.dataset.id);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      player.toggle();
    } else if (e.code === 'ArrowRight') player.next();
    else if (e.code === 'ArrowLeft') player.prev();
  });
}

ui.onPick = pickStation;
ui.onLongPress = openStationSheet;

// ------------------------------------------------------------------- start
function init() {
  applyTheme();
  bindTopbar();

  const vol = store.get('volume');
  player.setVolume(vol);
  player.setMuted(store.get('muted'));
  ui.setVolumeBar(store.get('muted') ? 0 : vol);
  ui.setMuted(store.get('muted'));
  applyNoiseVolume();
  startSilenceWatch();

  const last = store.get('lastStation');
  ui.setPlayerInfo({
    station: last,
    badge: 'IDLE',
    track: last ? last.name : 'потоковое радио',
    playing: false,
  });

  renderTabs();
  const validIds = allPlaylists().map((p) => p.id);
  if (!validIds.includes(currentPlaylistId)) currentPlaylistId = 'top';
  selectPlaylist(currentPlaylistId, { silent: true });
}

player.on('state', (st) => {
  if (st.station) store.set({ lastStation: st.station });
});

init();

// запрет зума (pinch на iOS, где user-scalable игнорируется)
['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) =>
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false })
);

// --------------------------------------------------------------------- PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      const hadController = !!navigator.serviceWorker.controller;

      const checkForUpdate = () => reg.update().catch(() => {});
      // проверяем при возврате в приложение и раз в час
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) checkForUpdate();
      });
      setInterval(checkForUpdate, 60 * 60 * 1000);

      let reloading = false;
      const reload = () => {
        if (reloading) return;
        reloading = true;
        location.reload();
      };

      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state !== 'installed' || !navigator.serviceWorker.controller) return;
          // новый SW готов; если ничего не играет — обновляемся молча
          if (!player.playing) reload();
          else ui.toast('Обновление готово — перезапусти приложение', 4000);
        });
      });

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController && !player.playing) reload();
      });
    } catch (e) {
      console.warn('SW не зарегистрирован', e);
    }
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});
window.addEventListener('appinstalled', () => {
  store.set({ installed: true });
  ui.toast('Установлено!');
});

// Точка входа: объединённый плеер RADIO / TV.
import { store, favorites, recent, uid } from './store.js';
import { Player } from './player.js';
import { parsePlaylist, makeStation } from './m3u.js';
import { BUNDLED as TV_BUNDLED } from './tv.js';
import { fetchText } from './net.js';
import { resolveNowPlaying } from './metadata.js';
import { NoiseEngine } from './noise.js';
import { searchStations, PRESETS, BUNDLED as RADIO_BUNDLED, GTA } from './radio.js';
import { ui, h, $ } from './ui.js';

const player = new Player($('#video'));
const appEl = $('#app');
const playerEl = $('#player');
const modeSwitch = $('#mode-switch');
const btnPip = $('#btn-pip');

// ------------------------------------------------------------------- шумы
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

// Шум включаем ТОЛЬКО когда звук реально пропал (currentTime замер) в радио-режиме.
function startSilenceWatch() {
  if (silenceTimer) return;
  prevTime = null;
  stallMs = 0;
  silenceTimer = setInterval(() => {
    const a = player.video;
    const wantsPlay = mode === 'radio' && !!player.channel && !a.paused && !a.ended && !player.error;
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

// ------------------------------------------------------------------ состояние
let mode = store.get('mode') === 'tv' ? 'tv' : 'radio';
let currentPlaylistId = defaultPlaylistId(mode);
let currentChannels = [];
let selectToken = 0;
let metaTimer = null;
let metaToken = 0;
let searchTimer = null;
let searchMode = false;
let deferredPrompt = null;
let miniDrag = null;

const bundledCache = new Map();

function defaultPlaylistId(m) {
  if (m === 'tv') return store.get('activePlaylistTv') || 'tv-edu';
  return store.get('activePlaylistRadio') || 'b-altrock';
}

function customPlaylists() {
  return store.get('customPlaylists');
}

function inCustomPlaylist(item) {
  return customPlaylists().some((p) => (p.stations || []).some((x) => x.id === item.id));
}

// ------------------------------------------------------------------ тема
function resolvedTheme() {
  const t = store.get('theme');
  if (t === 'auto') return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return t;
}
function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolvedTheme() === 'dark' ? '#07080a' : '#c6cad1');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (store.get('theme') === 'auto') applyTheme();
});

// ---------------------------------------------------------------- playlists
function radioPlaylists() {
  const list = [{ id: 'fav', name: 'Избранное', kind: 'fav' }];
  if (recent.list('radio').length) list.push({ id: 'recent', name: 'Недавние', kind: 'recent' });
  list.push(...RADIO_BUNDLED.map((b) => ({ id: b.id, name: b.name, kind: 'bundled' })));
  list.push(...PRESETS.map((p) => ({ id: p.id, name: p.name, kind: 'preset', query: p.query })));
  list.push(...GTA.map((b) => ({ id: b.id, name: b.name, kind: 'bundled' })));
  list.push(...customPlaylists().map((p) => ({ id: p.id, name: p.name, kind: 'custom', removable: p.id !== 'mine' })));
  return list;
}

function tvPlaylists() {
  const edu = TV_BUNDLED.filter((b) => b.id === 'tv-edu' || b.id === 'tv-edu-kids');
  const comedy = TV_BUNDLED.filter((b) => b.id === 'tv-comedy' || b.id === 'tv-archive');
  const rest = TV_BUNDLED.filter((b) => !edu.includes(b) && !comedy.includes(b));
  const list = [{ id: 'fav', name: 'Избранное', kind: 'fav' }];
  if (recent.list('tv').length) list.push({ id: 'recent', name: 'Недавние', kind: 'recent' });
  list.push(...edu.map((b) => ({ id: b.id, name: b.name, kind: 'bundled' })));
  list.push(...comedy.map((b) => ({ id: b.id, name: b.name, kind: 'bundled' })));
  list.push({ id: 'tv-all', name: 'Все', kind: 'all' });
  list.push(...rest.map((b) => ({ id: b.id, name: b.name, kind: 'bundled' })));
  list.push(...customPlaylists().map((p) => ({ id: p.id, name: p.name, kind: 'custom', removable: p.id !== 'mine' })));
  return list;
}

function allPlaylists() {
  return mode === 'tv' ? tvPlaylists() : radioPlaylists();
}

function renderTabs() {
  ui.renderTabs(allPlaylists(), currentPlaylistId);
}

async function loadBundled(b) {
  if (bundledCache.has(b.id)) return bundledCache.get(b.id);
  const text = await fetchText(b.url, [], { directFirst: true });
  if (!text) throw new Error('Нет ответа');
  const list = parsePlaylist(text);
  bundledCache.set(b.id, list);
  return list;
}

async function loadAllBundled() {
  const lists = await Promise.all(TV_BUNDLED.map((b) => loadBundled(b).catch(() => [])));
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const c of list) {
      if (!c.url || seen.has(c.url)) continue;
      seen.add(c.url);
      out.push(c);
    }
  }
  return out;
}

function expand(list) {
  return (list || []).filter((c) => c && c.url);
}

async function selectPlaylist(id, { silent } = {}) {
  const playlists = allPlaylists();
  if (!playlists.some((p) => p.id === id)) id = defaultPlaylistId(mode);
  const meta = playlists.find((p) => p.id === id);
  const token = ++selectToken;

  currentPlaylistId = id;
  store.set({
    activePlaylistId: id,
    ...(mode === 'radio' ? { activePlaylistRadio: id } : { activePlaylistTv: id }),
  });
  if (!silent) exitSearch();
  renderTabs();

  if (id === 'fav') {
    currentChannels = expand(favorites.list(mode));
    renderList();
    ui.setStatus('избранное');
    if (!currentChannels.length) ui.setMessage('В избранном пока пусто.<br>Отметь звёздочкой.');
    return;
  }
  if (id === 'recent') {
    currentChannels = expand(recent.list(mode));
    renderList();
    ui.setStatus('недавние');
    if (!currentChannels.length) ui.setMessage('Здесь появятся то, что ты слушал и смотрел.');
    return;
  }

  ui.setLoading();
  try {
    let list = [];
    if (meta && meta.kind === 'all') {
      list = await loadAllBundled();
      if (token !== selectToken) return;
      ui.setStatus('все каналы');
    } else if (meta && meta.kind === 'bundled') {
      const b = [...RADIO_BUNDLED, ...GTA, ...TV_BUNDLED].find((x) => x.id === id);
      if (!b) throw new Error('Нет плейлиста');
      list = await loadBundled(b);
      if (token !== selectToken) return;
      ui.setStatus(meta.name.toLowerCase());
    } else if (meta && meta.kind === 'preset') {
      list = await searchStations(meta.query);
      if (token !== selectToken) return;
      ui.setStatus(`${meta.name.toLowerCase()} · каталог`);
    } else if (meta && meta.kind === 'custom') {
      const p = customPlaylists().find((x) => x.id === id);
      if (!p) return selectPlaylist(defaultPlaylistId(mode), { silent: true });
      if (p.stations && p.stations.length) {
        list = p.stations;
      } else if (p.url) {
        const text = await fetchText(p.url, store.get('proxies'));
        if (token !== selectToken) return;
        list = text ? parsePlaylist(text) : [];
        store.set({
          customPlaylists: customPlaylists().map((x) => (x.id === id ? { ...x, stations: list, updated: Date.now() } : x)),
        });
      }
      if (token !== selectToken) return;
      ui.setStatus(`${meta.name.toLowerCase()}${list.length ? ' · ' + list.length : ''}`);
    }

    currentChannels = expand(list);
    renderList();
    if (!currentChannels.length) {
      ui.setMessage(
        mode === 'radio'
          ? 'Плейлист пуст или не удалось прочитать.<br>Проверь ссылку и CORS-прокси.'
          : 'В этом плейлисте пока нет каналов.'
      );
    }
  } catch {
    if (token !== selectToken) return;
    ui.setMessage(
      mode === 'radio'
        ? 'Не удалось загрузить. Проверь интернет и CORS-прокси в настройках.'
        : 'Не удалось загрузить встроенный плейлист.'
    );
    ui.setStatus('ошибка');
    currentChannels = [];
    renderList();
  }
}

// -------------------------------------------------------------------- список
function renderList() {
  const set = new Set();
  favorites.list(mode).forEach((c) => {
    set.add(c.id);
    set.add(c.url);
  });
  ui.renderList(currentChannels, {
    mode,
    activeUrl: player.channel && player.channel.url,
    playing: player.playing,
    favoritesSet: set,
  });
}

function pickChannel(i) {
  const c = currentChannels[i];
  if (!c) return;
  const same = player.channel && player.channel.url === c.url && player.video.src;
  if (same) {
    if (player.error) player.reload();
    else player.toggle();
    return;
  }
  recent.push(c, mode);
  renderTabs();
  player.playStation(c, currentChannels, i);
  updateFavButton();
  renderList();
}

// -------------------------------------------------------------------- поиск
function enterSearch() {
  searchMode = true;
}
function exitSearch() {
  searchMode = false;
  const input = $('#search');
  if (input && input.value) input.value = '';
  const clear = $('#search-clear');
  if (clear) clear.hidden = true;
}

function onSearchInput() {
  if (mode !== 'radio') return;
  const term = $('#search').value.trim();
  $('#search-clear').hidden = !term;
  clearTimeout(searchTimer);
  if (term.length < 2) {
    if (searchMode) selectPlaylist(currentPlaylistId, { silent: true });
    return;
  }
  enterSearch();
  ui.setLoading();
  ui.setStatus('поиск…');
  searchTimer = setTimeout(async () => {
    try {
      const list = await searchStations({ name: term, order: 'clickcount', reverse: 'true', limit: '80' });
      if (!searchMode) return;
      currentChannels = list;
      renderList();
      ui.setStatus(`поиск: «${term}»`);
    } catch {
      if (!searchMode) return;
      ui.setMessage('Поиск недоступен. Проверь интернет.');
    }
  }, 450);
}

// ------------------------------------------------------------------- player
function badgeFor(st) {
  if (st.error) return 'ERR';
  if (st.loading) return 'LOAD';
  if (!st.channel) return 'IDLE';
  if (st.playing) return 'LIVE';
  return 'PAUSE';
}

function trackText(st) {
  if (mode === 'radio') {
    if (player.nowPlaying) return player.nowPlaying;
    if (st.error) return st.error;
    if (!st.channel) return 'потоковое радио';
    if (st.loading) return 'подключаюсь к потоку…';
    if (st.playing) return 'в эфире — без данных о треке';
    return st.channel.name + ' — на паузе';
  }
  if (st.error) return st.error;
  if (!st.channel) return 'потоковое телевидение';
  if (st.playing) return st.channel.group ? `прямой эфир · ${st.channel.group}` : 'прямой эфир';
  if (st.loading) return 'подключаюсь к потоку…';
  return `пауза · ${st.channel.name}`;
}

function screenState(st) {
  if (st.error) return 'error';
  if (!st.channel) return 'idle';
  if (st.playing) return 'playing';
  if (st.loading) return 'loading';
  return 'paused';
}
function screenHint(st) {
  if (st.error) return st.error;
  if (!st.channel) return 'выбери канал';
  if (st.loading) return 'подключаюсь к потоку…';
  return 'пауза';
}

function applyPlayerState(st) {
  if (mode === 'tv') {
    ui.setScreenState(screenState(st), { logo: st.channel && st.channel.favicon, text: screenHint(st) });
  }
  ui.setPlayerInfo({
    channel: st.channel,
    badge: badgeFor(st),
    track: trackText(st),
    playing: st.playing,
  });
  document.body.classList.toggle('playing', !!st.playing);
  if ((!st.channel || st.error) && document.body.classList.contains('mini')) exitMini();

  if (st.error) ui.setStatus(st.error);
  else if (st.playing) ui.setStatus('в эфире');
  else if (st.loading) ui.setStatus('буферизация…');
  else if (!st.channel) ui.setStatus('готово');

  renderList();
  if (mode === 'radio' && st.playing) refreshNowPlaying();
}

player.on('station', (channel) => {
  ui.setResolution('');
  applyPlayerState({ channel, loading: true, error: null, playing: false });
  updateFavButton();
  if (mode === 'radio') {
    startMetadata();
    noise.unlock(); // разблокируем Web Audio в жесте пользователя
  }
});

player.on('state', (st) => {
  applyPlayerState(st);
  if (st.channel) store.set(mode === 'radio' ? { lastStation: st.channel } : { lastChannel: st.channel });
});

player.on('quality', ({ width, height }) => {
  if (mode !== 'tv') return;
  ui.setResolution(height ? `${height}p` : width ? `${width}×${height}` : '');
});

player.on('error', ({ error }) => ui.toast(error));
player.on('blocked', () => ui.toast('Нажми ▶ — браузер заблокировал автозапуск', 3500));
player.on('nowplaying', () => {
  ui.setTrack(
    trackText({ playing: player.playing, loading: player.loading, error: player.error, channel: player.channel })
  );
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
  if (mode !== 'radio' || !store.get('metadata')) return;
  refreshNowPlaying();
  const sec = Math.max(5, Number(store.get('metadataInterval')) || 15);
  metaTimer = setInterval(refreshNowPlaying, sec * 1000);
}
function stopMetadata() {
  if (metaTimer) clearInterval(metaTimer);
  metaTimer = null;
}
async function refreshNowPlaying() {
  const s = player.channel;
  if (mode !== 'radio' || !s || player.video.paused) return;
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
  ui.setFav(!!(player.channel && favorites.has(player.channel, mode)));
}

// ------------------------------------------------------ картинка в картинке
function isPipActive() {
  const v = player.video;
  return (
    document.body.classList.contains('pip') ||
    document.body.classList.contains('mini') ||
    document.pictureInPictureElement === v ||
    v.webkitPresentationMode === 'picture-in-picture'
  );
}
function updatePipButton() {
  const active = isPipActive();
  const label = active ? 'Выключить картинку в картинке' : 'Картинка в картинке';
  btnPip.title = label;
  btnPip.setAttribute('aria-label', label);
  btnPip.setAttribute('aria-pressed', active ? 'true' : 'false');
}
function setNativePip(active) {
  document.body.classList.toggle('pip', !!active);
  updatePipButton();
}
function clearMiniPosition() {
  playerEl.style.left = '';
  playerEl.style.top = '';
  playerEl.style.right = '';
  playerEl.style.bottom = '';
}
async function enterMini() {
  if (document.body.classList.contains('mini')) return;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    try {
      await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } catch {
      /* ignore */
    }
  }
  document.body.classList.add('mini');
  clearMiniPosition();
  updatePipButton();
  ui.toast('Мини-плеер: перетаскивай и нажми, чтобы вернуть', 2600);
}
function exitMini() {
  if (!document.body.classList.contains('mini')) return;
  document.body.classList.remove('mini', 'mini-dragging');
  miniDrag = null;
  clearMiniPosition();
  updatePipButton();
}
async function togglePictureInPicture() {
  if (mode !== 'tv') return;
  const v = player.video;
  if (document.body.classList.contains('mini')) {
    exitMini();
    return;
  }
  if (!player.channel || player.error) return ui.toast('Сначала включи канал');
  if (document.pictureInPictureElement) {
    try {
      await document.exitPictureInPicture();
    } catch {
      /* ignore */
    }
    return;
  }
  if (v.webkitPresentationMode === 'picture-in-picture') {
    try {
      v.webkitSetPresentationMode('inline');
    } catch {
      /* ignore */
    }
    return;
  }
  const canStandard = !!(document.pictureInPictureEnabled && v.requestPictureInPicture);
  let canWebkit = false;
  try {
    canWebkit =
      typeof v.webkitSetPresentationMode === 'function' &&
      (typeof v.webkitSupportsPresentationMode !== 'function' || v.webkitSupportsPresentationMode('picture-in-picture'));
  } catch {
    canWebkit = false;
  }
  if (!canStandard && !canWebkit) {
    enterMini();
    return;
  }
  try {
    if (canStandard) await v.requestPictureInPicture();
    else v.webkitSetPresentationMode('picture-in-picture');
  } catch {
    enterMini();
  }
}
function bindMiniDrag() {
  playerEl.addEventListener('pointerdown', (e) => {
    if (!document.body.classList.contains('mini') || e.button > 0) return;
    if (e.target.closest('button, input')) return;
    const rect = playerEl.getBoundingClientRect();
    miniDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, left: rect.left, top: rect.top, moved: false };
    try {
      playerEl.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    e.preventDefault();
  });
  playerEl.addEventListener('pointermove', (e) => {
    if (!miniDrag || e.pointerId !== miniDrag.id) return;
    const dx = e.clientX - miniDrag.sx;
    const dy = e.clientY - miniDrag.sy;
    if (!miniDrag.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
    miniDrag.moved = true;
    document.body.classList.add('mini-dragging');
    const app = appEl.getBoundingClientRect();
    const w = playerEl.offsetWidth;
    const h = playerEl.offsetHeight;
    const left = Math.max(app.left + 6, Math.min(miniDrag.left + dx, app.right - w - 6));
    const top = Math.max(app.top + 6, Math.min(miniDrag.top + dy, app.bottom - h - 6));
    playerEl.style.left = `${left - app.left}px`;
    playerEl.style.top = `${top - app.top}px`;
    playerEl.style.right = 'auto';
    playerEl.style.bottom = 'auto';
  });
  const end = (e) => {
    if (!miniDrag || (e && e.pointerId !== miniDrag.id)) return;
    const moved = miniDrag.moved;
    miniDrag = null;
    document.body.classList.remove('mini-dragging');
    if (!moved) exitMini();
  };
  playerEl.addEventListener('pointerup', end);
  playerEl.addEventListener('pointercancel', end);
}
function bindPictureInPicture() {
  const v = player.video;
  btnPip.addEventListener('click', togglePictureInPicture);
  v.addEventListener('enterpictureinpicture', () => setNativePip(true));
  v.addEventListener('leavepictureinpicture', () => setNativePip(false));
  v.addEventListener('webkitpresentationmodechanged', () =>
    setNativePip(v.webkitPresentationMode === 'picture-in-picture')
  );
  bindMiniDrag();
  updatePipButton();
}

function toggleFullscreen() {
  if (mode !== 'tv') return;
  if (document.body.classList.contains('mini')) exitMini();
  const el = playerEl;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
    return;
  }
  const video = player.video;
  if (video.webkitEnterFullscreen) {
    try {
      video.webkitEnterFullscreen();
      return;
    } catch {
      /* ignore */
    }
  }
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
}

// ------------------------------------------------------------- добавление
function openAddSheet() {
  if (mode !== 'radio') return;
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
          store.set({ customPlaylists: cps.filter((x) => x.id !== p.id) });
          ui.toast('Удалено: ' + p.name);
          if (currentPlaylistId === p.id) selectPlaylist(defaultPlaylistId(mode));
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

// -------------------------------------------------------------- установка
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
    h('p', { class: 'ic-note' }, 'Иконка на экране, полный экран без адресной строки, запуск в один тап. Реагирует на кнопки наушников и медиа-клавиши клавиатуры. Весит копейки — это тот же сайт.'),
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
  noiseChk.addEventListener('change', () => {
    store.set({ noise: noiseChk.checked });
    noise.enabled = noiseChk.checked;
    if (!noiseChk.checked) noise.stop();
  });
  const interval = h('input', { type: 'number', min: '5', max: '120', value: store.get('metadataInterval') });
  const proxies = h('textarea', { class: 'proxy-area' });
  proxies.value = store.get('proxies').join('\n');
  proxies.style.cssText =
    'width:100%;min-height:96px;padding:11px 12px;background:var(--panel-2);border:1px solid var(--line);border-radius:10px;font:12px var(--mono);color:var(--text);outline:none';

  const importFile = h('input', { type: 'file', accept: '.json,application/json', hidden: true });

  const body = h('div', {},
    buildInstallCard(),
    h('div', { class: 'section-title' }, 'Внешний вид'),
    h('div', { class: 'field' }, h('label', {}, 'Тема'), themeSel),

    h('div', { class: 'section-title' }, 'Радио: «сейчас играет»'),
    h('label', { class: 'switch' },
      h('span', {}, h('span', { class: 'sw-txt' }, 'Показывать трек'), h('div', { class: 'sw-sub' }, 'Читаем статус Icecast/SHOUTcast через прокси')),
      metaChk
    ),
    h('div', { class: 'field', style: { marginTop: '12px' } }, h('label', {}, 'Интервал обновления, сек'), interval),
    h('label', { class: 'switch' },
      h('span', {}, h('span', { class: 'sw-txt' }, 'Шумы при буферизации'), h('div', { class: 'sw-sub' }, 'Радиопомехи вместо тишины, пока грузится поток')),
      noiseChk
    ),

    h('div', { class: 'section-title' }, 'CORS-прокси'),
    h('div', { class: 'field' }, h('label', {}, 'По одному в строке, {url} — место ссылки'), proxies,
      h('div', { class: 'hint' }, 'Нужны для метаданных радио, добавления плейлистов и ТВ (Rutube). Если один не работает — попробуй другой.')),

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
    h('div', { class: 'hint', style: { marginTop: '14px' } }, 'Потоки открываются напрямую с серверов. Приложению нужен интернет; интерфейс и встроенные плейлисты кэшируются.')
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
    const bust = [
      './',
      './index.html',
      './css/app.css',
      './js/app.js',
      './js/store.js',
      './js/ui.js',
      './js/player.js',
      './js/radio.js',
      './js/tv.js',
      './js/net.js',
      './js/m3u.js',
      './js/metadata.js',
      './js/noise.js',
      './vendor/hls.min.js',
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
  a.download = 'radio-tv-settings.json';
  a.click();
  URL.revokeObjectURL(a.href);
  ui.toast('Файл сохранён');
}

function openStationSheet(index) {
  const c = currentChannels[index];
  if (!c) return;
  const isCustom = c.source === 'custom' || inCustomPlaylist(c);
  const nameInput = h('input', { type: 'text', value: c.name });
  const urlInput = h('input', { type: 'text', value: c.url, inputmode: 'url' });
  const metaInput = h('input', {
    type: 'text',
    value: store.get('metaUrls')[c.id] || '',
    placeholder: mode === 'radio' ? 'напр. https://host:8000/status-json.xsl' : 'https://… (необязательно)',
    inputmode: 'url',
  });
  const favLabel = favorites.has(c, mode) ? 'Убрать из избранного' : 'В избранное';

  const body = h('div', {},
    h('div', { class: 'field' }, h('label', {}, 'Название'), nameInput),
    h('div', { class: 'field' }, h('label', {}, 'Поток'), urlInput),
    mode === 'radio'
      ? h('div', { class: 'field' }, h('label', {}, 'Свой URL метаданных'), metaInput,
          h('div', { class: 'hint' }, 'Если трек не определяется автоматически — укажи страницу Icecast (/status-json.xsl) или SHOUTcast (/7.html).'))
      : h('div', { class: 'field' }, h('label', {}, 'Логотип / метаданные'), metaInput,
          h('div', { class: 'hint' }, 'Для ТВ это необязательно.')),

    h('button', { class: 'btn', onClick: () => {
      const on = favorites.toggle({ ...c, name: nameInput.value.trim() || c.name }, mode);
      updateFavButton();
      renderList();
      ui.toast(on ? 'Добавлено в избранное' : 'Убрано из избранного');
      ui.closeSheet();
    } }, favLabel),

    h('div', { class: 'btn-row', style: { marginTop: '8px' } },
      h('button', { class: 'btn primary', onClick: () => {
        const name = nameInput.value.trim() || c.name;
        const url = urlInput.value.trim() || c.url;
        const metaUrl = metaInput.value.trim();
        const fk = mode === 'tv' ? 'favoritesTv' : 'favorites';
        store.update((st) => ({
          metaUrls: { ...st.metaUrls, [c.id]: metaUrl },
          customPlaylists: st.customPlaylists.map((p) => ({
            ...p,
            stations: (p.stations || []).map((x) => (x.id === c.id ? { ...x, name, url } : x)),
          })),
          [fk]: (st[fk] || []).map((x) => (x.id === c.id ? { ...x, name, url } : x)),
        }));
        const urlChanged = url !== c.url;
        if (player.channel && player.channel.id === c.id) {
          const updated = { ...player.channel, name, url };
          if (urlChanged) player.playStation(updated, currentChannels, index);
          else player.channel = updated;
        }
        if (mode === 'radio') startMetadata();
        renderList();
        ui.toast('Сохранено');
        ui.closeSheet();
      } }, 'Сохранить'),

      isCustom
        ? h('button', { class: 'btn danger', onClick: () => {
            const fk = mode === 'tv' ? 'favoritesTv' : 'favorites';
            store.update((st) => ({
              customPlaylists: st.customPlaylists.map((p) => ({
                ...p,
                stations: (p.stations || []).filter((x) => x.id !== c.id),
              })),
              [fk]: (st[fk] || []).filter((x) => x.id !== c.id),
            }));
            currentChannels = currentChannels.filter((x) => x.id !== c.id);
            if (player.channel && player.channel.id === c.id) player.stop();
            renderList();
            ui.toast('Удалено');
            ui.closeSheet();
          } }, 'Удалить')
        : null
    )
  );
  ui.openSheet('Станция / канал', body);
}

// ------------------------------------------------------------------ режимы
function applyMode() {
  appEl.dataset.mode = mode;
  modeSwitch.dataset.mode = mode;
  [...modeSwitch.querySelectorAll('.mode-opt')].forEach((el) => el.classList.toggle('active', el.dataset.pos === mode));
}

function resetIdle() {
  const last = mode === 'radio' ? store.get('lastStation') : store.get('lastChannel');
  ui.setPlayerInfo({
    channel: last,
    badge: 'IDLE',
    track: mode === 'radio' ? (last ? last.name : 'потоковое радио') : last ? last.name : 'потоковое телевидение',
    playing: false,
  });
  if (mode === 'tv') {
    ui.setScreenState('idle', { logo: last && last.favicon, text: last ? 'нажми ▶, чтобы продолжить' : 'выбери канал' });
  }
  ui.setResolution('');
  ui.setStatus('готово');
}

function setMode(next) {
  if (next === mode) return;
  if (player.channel) player.stop();
  stopMetadata();
  noise.stop();
  noiseOn = false;
  exitSearch();
  mode = next;
  store.set({ mode });
  currentPlaylistId = defaultPlaylistId(mode);
  applyMode();
  resetIdle();
  selectPlaylist(currentPlaylistId, { silent: true });
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
  $('#btn-fs').addEventListener('click', toggleFullscreen);
  $('#btn-add').addEventListener('click', openAddSheet);

  modeSwitch.addEventListener('click', () => setMode(mode === 'radio' ? 'tv' : 'radio'));

  $('#btn-play').addEventListener('click', () => {
    if (player.channel && player.error) {
      player.reload();
      return;
    }
    if (!player.channel) {
      const last = mode === 'radio' ? store.get('lastStation') : store.get('lastChannel');
      const idx = last ? currentChannels.findIndex((c) => c.url === last.url) : -1;
      if (idx >= 0) pickChannel(idx);
      else if (last) player.playStation(last, currentChannels, -1);
      else if (currentChannels.length) pickChannel(0);
      return;
    }
    player.toggle();
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
    if (!player.channel) return ui.toast('Сначала включи');
    const added = favorites.toggle(player.channel, mode);
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

  $('#tabs').addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      const el = e.currentTarget;
      let d = e.deltaY;
      if (e.deltaMode === 1) d *= 28;
      else if (e.deltaMode === 2) d *= el.clientWidth;
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
      if (currentPlaylistId === id) selectPlaylist(defaultPlaylistId(mode));
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
    else if (mode === 'tv' && (e.key === 'f' || e.key === 'F')) toggleFullscreen();
    else if (mode === 'tv' && (e.key === 'p' || e.key === 'P')) togglePictureInPicture();
  });

  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('fs', !!document.fullscreenElement);
  });
  document.addEventListener('webkitfullscreenchange', () => {
    document.body.classList.toggle('fs', !!document.webkitFullscreenElement);
  });
}

ui.onPick = pickChannel;
ui.onLongPress = openStationSheet;

// ------------------------------------------------------------------- start
function init() {
  applyTheme();
  applyMode();
  bindTopbar();
  bindPictureInPicture();

  const vol = store.get('volume');
  player.setVolume(vol);
  player.setMuted(store.get('muted'));
  ui.setVolumeBar(store.get('muted') ? 0 : vol);
  ui.setMuted(store.get('muted'));
  applyNoiseVolume();
  startSilenceWatch();

  resetIdle();

  renderTabs();
  const ids = allPlaylists().map((p) => p.id);
  if (!ids.includes(currentPlaylistId)) currentPlaylistId = defaultPlaylistId(mode);
  selectPlaylist(currentPlaylistId, { silent: true });
}

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
      reg.update().catch(() => {});
      const hadController = !!navigator.serviceWorker.controller;

      const checkForUpdate = () => reg.update().catch(() => {});
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

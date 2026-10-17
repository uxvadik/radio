// Клиент каталога radio-browser.info с перебором зеркал.
import { makeStation } from './m3u.js';

const MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
  'https://fi1.api.radio-browser.info',
];

let activeMirror = null;

async function request(path) {
  const mirrors = activeMirror ? [activeMirror, ...MIRRORS.filter((m) => m !== activeMirror)] : MIRRORS;
  let lastErr;
  for (const base of mirrors) {
    try {
      const res = await fetch(base + path, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      activeMirror = base;
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Каталог недоступен');
}

function fromRB(s) {
  return makeStation(
    {
      id: 'rb-' + s.stationuuid,
      name: (s.name || '').trim(),
      url: s.url_resolved || s.url,
      favicon: s.favicon || '',
      homepage: s.homepage || '',
      country: s.country || '',
      countrycode: s.country_code || '',
      language: s.language || '',
      tags: s.tags || '',
      codec: s.codec || '',
      bitrate: s.bitrate || 0,
      votes: s.votes || 0,
      clickcount: s.clickcount || 0,
    },
    'radio'
  );
}

function qs(params) {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  });
  return p.toString();
}

const BASE = { hidebroken: 'true', limit: 60 };

export async function searchStations(params) {
  const data = await request('/json/stations/search?' + qs({ ...BASE, ...params }));
  return (data || []).map(fromRB).filter((s) => s.url);
}

export async function topStations(limit = 60) {
  const data = await request('/json/stations/topclick/' + limit + '?hidebroken=true');
  return (data || []).map(fromRB).filter((s) => s.url);
}

export const MIRROR_HOST = () => activeMirror || MIRRORS[0];

// Встроенные (локальные) m3u-плейлисты, лежат рядом с приложением.
export const BUNDLED = [
  { id: 'b-altrock', name: 'Alt Rock', url: './playlists/altrock.m3u' },
  { id: 'b-covera', name: 'Каверы', url: './playlists/covera.m3u' },
  { id: 'b-deephouse', name: 'Deep House', url: './playlists/deephouse.m3u' },
  { id: 'b-jazz', name: 'Jazz', url: './playlists/jazz.m3u' },
  { id: 'b-airadio', name: 'AI', url: './playlists/airadio.m3u' },
  { id: 'b-nfs', name: 'NFS', url: './playlists/nfs.m3u' },
];

// Плейлисты GTA — показываются в самом конце списка категорий.
export const GTA = [
  { id: 'gta-3', name: 'GTA III', url: './playlists/gta-3.m3u' },
  { id: 'gta-vc', name: 'GTA VC', url: './playlists/gta-vc.m3u' },
  { id: 'gta-sa', name: 'GTA SA', url: './playlists/gta-sa.m3u' },
  { id: 'gta-4', name: 'GTA IV', url: './playlists/gta-4.m3u' },
  { id: 'gta-lcs', name: 'GTA LCS', url: './playlists/gta-lcs.m3u' },
  { id: 'gta-vcs', name: 'GTA VCS', url: './playlists/gta-vcs.m3u' },
];


// Предустановленные плейлисты (запросы к каталогу).
export const PRESETS = [
  { id: 'top', name: 'Топ', query: { order: 'clickcount', reverse: 'true' } },
  { id: 'ru', name: 'Россия', query: { countrycode: 'RU', order: 'clickcount', reverse: 'true' } },
  { id: 'pop', name: 'Поп', query: { tag: 'pop', order: 'clickcount', reverse: 'true' } },
  { id: 'rock', name: 'Рок', query: { tag: 'rock', order: 'clickcount', reverse: 'true' } },
  { id: 'dance', name: 'Танцевальная', query: { tag: 'dance', order: 'clickcount', reverse: 'true' } },
  { id: 'electronic', name: 'Электроника', query: { tag: 'electronic', order: 'clickcount', reverse: 'true' } },
  { id: 'hiphop', name: 'Хип-хоп', query: { tag: 'hip hop', order: 'clickcount', reverse: 'true' } },
  { id: 'jazz', name: 'Джаз', query: { tag: 'jazz', order: 'clickcount', reverse: 'true' } },
  { id: 'classical', name: 'Классика', query: { tag: 'classical', order: 'clickcount', reverse: 'true' } },
  { id: 'retro', name: 'Ретро', query: { tag: 'oldies', order: 'clickcount', reverse: 'true' } },
  { id: 'news', name: 'Новости', query: { tag: 'news', order: 'clickcount', reverse: 'true' } },
  { id: 'lofi', name: 'Lo-Fi', query: { tag: 'lofi', order: 'clickcount', reverse: 'true' } },
  { id: 'ambient', name: 'Ambient', query: { tag: 'ambient', order: 'clickcount', reverse: 'true' } },
  { id: 'metal', name: 'Метал', query: { tag: 'metal', order: 'clickcount', reverse: 'true' } },
  { id: 'talk', name: 'Разговорное', query: { tag: 'talk', order: 'clickcount', reverse: 'true' } },
];

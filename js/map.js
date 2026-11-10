// Leaflet-карта и Radio Garden: точки-города, по клику — станции.
import { makeStation } from './m3u.js';
import { fetchText } from './net.js';

let leafletLoader = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletLoader) {
    leafletLoader = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = './vendor/leaflet/leaflet.js';
      s.async = true;
      s.onload = () => (window.L ? resolve(window.L) : reject(new Error('Leaflet не загрузился')));
      s.onerror = () => reject(new Error('Leaflet не загрузился'));
      document.head.append(s);
    });
  }
  return leafletLoader;
}

// ------------------------------------------------------------------ Radio Garden
const RG_API = 'https://radio.garden/api/ara/content/';
const JINA = 'https://r.jina.ai/';
const PLACES_KEY = 'rg-places:v1';
const PLACES_TTL = 14 * 24 * 3600 * 1000; // 14 дней

function withTimeout(ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(id) };
}

function extractJson(text) {
  if (!text) return null;
  let body = String(text);
  const marker = 'Markdown Content:';
  const i = body.indexOf(marker);
  if (i >= 0) body = body.slice(i + marker.length);
  body = body.trim();
  body = body.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '');
  const start = body.indexOf('{');
  if (start < 0) return null;
  body = body.slice(start).trim();
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function fetchJina(target, timeout) {
  const { signal, done } = withTimeout(timeout);
  try {
    const res = await fetch(JINA + target, { signal, headers: { Accept: 'text/plain, application/json' } });
    done();
    if (!res.ok) return null;
    return extractJson(await res.text());
  } catch {
    done();
    return null;
  }
}

export async function fetchRadioGarden(path, proxies = [], { timeout = 45000 } = {}) {
  const target = RG_API + path;
  // Jina Reader — единственный публичный путь, который реально отдаёт Radio Garden с CORS.
  const jina = await fetchJina(target, timeout);
  if (jina) return jina;
  // запасной путь: настроенные CORS-прокси (например, свой Cloudflare Worker)
  const text = await fetchText(target, proxies);
  return extractJson(text);
}

function encodePlaces(list) {
  return list.map((p) => [p.id, p.title, p.lat, p.lon, p.country || '', p.size || 0]);
}
function decodePlaces(compact) {
  if (!Array.isArray(compact)) return [];
  return compact.map((x) => ({ id: x[0], title: x[1], lat: x[2], lon: x[3], country: x[4] || '', size: x[5] || 0 }));
}

export function loadPlacesCache() {
  try {
    const raw = localStorage.getItem(PLACES_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.list)) return null;
    return { places: decodePlaces(data.list), fresh: Date.now() - (data.ts || 0) < PLACES_TTL };
  } catch {
    return null;
  }
}

export function savePlacesCache(places) {
  try {
    localStorage.setItem(PLACES_KEY, JSON.stringify({ ts: Date.now(), list: encodePlaces(places) }));
  } catch {
    /* переполнение localStorage — не критично */
  }
}

export async function fetchPlaces(proxies) {
  const data = await fetchRadioGarden('places', proxies, { timeout: 60000 });
  const list = data && data.data && Array.isArray(data.data.list) ? data.data.list : [];
  return list
    .filter((x) => Array.isArray(x.geo) && x.geo.length >= 2)
    .map((x) => ({
      id: x.id,
      title: x.title,
      lon: Number(x.geo[0]),
      lat: Number(x.geo[1]),
      country: x.country || '',
      size: x.size || 0,
    }));
}

export async function fetchPlaceChannels(place, proxies) {
  const data = await fetchRadioGarden(`page/${encodeURIComponent(place.id)}/channels`, proxies);
  const content = data && data.data && Array.isArray(data.data.content) ? data.data.content : [];
  const items = content.flatMap((c) => (Array.isArray(c.items) ? c.items : []));
  const out = [];
  for (const it of items) {
    const p = it && it.page;
    if (!p || !p.url) continue;
    if (p.secure === false) continue; // http-поток не откроется на HTTPS
    const channelId = String(p.url).split('/').filter(Boolean).pop();
    if (!channelId) continue;
    const station = makeStation(
      {
        id: 'rg-' + channelId,
        name: p.title || channelId,
        url: `https://radio.garden/api/ara/content/listen/${channelId}/channel.mp3`,
        country: (p.country && p.country.title) || place.country || '',
        group: (p.place && p.place.title) || place.title || '',
      },
      'radiogarden'
    );
    out.push(station);
  }
  return out;
}

// ------------------------------------------------------------------ Leaflet карта
export class FMMap {
  constructor({ el, statusEl, hintEl, onOpenPlace }) {
    this.el = el;
    this.statusEl = statusEl;
    this.hintEl = hintEl;
    this.onOpenPlace = onOpenPlace;
    this.map = null;
    this.layer = null;
    this.places = [];
    this._initPromise = null;
  }

  async ensure() {
    if (this.map) {
      this.map.invalidateSize();
      return this.map;
    }
    if (!this._initPromise) {
      this._initPromise = (async () => {
        const L = await loadLeaflet();
        this.map = L.map(this.el, { zoomControl: true, worldCopyJump: true, minZoom: 2, maxZoom: 12 }).setView([22, 0], 2);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap',
        }).addTo(this.map);
        this.layer = L.layerGroup().addTo(this.map);
        this.map.on('moveend zoomend', () => this.render());
        setTimeout(() => this.map.invalidateSize(), 60);
        return this.map;
      })().catch((e) => {
        this.status('Не удалось загрузить карту');
        this._initPromise = null;
        throw e;
      });
    }
    return this._initPromise;
  }

  setPlaces(places) {
    this.places = places || [];
    this.render();
    if (this.hintEl && this.places.length) this.hintEl.hidden = true;
  }

  status(text) {
    if (!this.statusEl) return;
    if (!text) {
      this.statusEl.hidden = true;
      this.statusEl.textContent = '';
      return;
    }
    this.statusEl.hidden = false;
    this.statusEl.textContent = text;
  }

  render() {
    if (!this.map || !this.places.length || !window.L) return;
    const L = window.L;
    const bounds = this.map.getBounds();
    const visible = this.places.filter((p) => bounds.contains([p.lat, p.lon]));
    visible.sort((a, b) => (b.size || 0) - (a.size || 0));
    const cap = this.map.getZoom() <= 3 ? 250 : 700; // на обзорном зуме меньше точек
    const shown = visible.slice(0, cap);
    this.layer.clearLayers();
    for (const p of shown) {
      const r = 3 + Math.min(5, Math.log2((p.size || 1) + 1));
      const marker = L.circleMarker([p.lat, p.lon], {
        radius: r,
        color: '#f2ab3e',
        weight: 1,
        opacity: 0.9,
        fillColor: '#f2ab3e',
        fillOpacity: 0.78,
      });
      marker.bindTooltip(p.title, { direction: 'top', offset: [0, -4] });
      marker.on('click', () => this.onOpenPlace && this.onOpenPlace(p));
      this.layer.addLayer(marker);
    }
  }

  invalidate() {
    if (this.map) setTimeout(() => this.map.invalidateSize(), 60);
  }
}

// Определение «сейчас играет» для Icecast / SHOUTcast.
// Браузер не отдаёт ICY-заголовки напрямую, поэтому читаем статус-страницы
// сервера (/status-json.xsl, /7.html, /stats?json=1) через CORS-прокси.

function timeoutSignal(ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(id) };
}

let preferredProxy = null;

function candidateUrls(streamUrl) {
  let u;
  try {
    u = new URL(streamUrl);
  } catch {
    return [];
  }
  const origin = u.origin;
  const dirMatch = u.pathname.match(/^(.*\/)/);
  const dir = dirMatch ? dirMatch[1] : '/';
  const set = new Set([
    origin + '/status-json.xsl',
    origin + '/status.xsl',
    origin + '/7.html',
    origin + '/stats?sid=1&json=1',
    origin + '/stats?json=1',
  ]);
  if (dir !== '/') set.add(origin + dir + 'status-json.xsl');
  const list = [...set];
  // AzuraCast: /listen/<shortcode>/... -> /api/nowplaying/<shortcode> (богаче: артист+трек)
  const az = u.pathname.match(/^\/listen\/([^/]+)\//);
  if (az) list.unshift(origin + '/api/nowplaying/' + az[1]);
  return list;
}

function applyProxy(template, url) {
  if (!template || template === 'direct') return url;
  return template.replace('{url}', encodeURIComponent(url));
}

async function tryFetch(url, proxies, perTryMs = 6000) {
  // 1) напрямую (вдруг сервер отдаёт CORS), затем прокси (рабочий — первым)
  const ordered = preferredProxy
    ? [preferredProxy, ...proxies.filter((p) => p !== preferredProxy)]
    : proxies;
  const attempts = [{ label: 'direct', url }];
  for (const p of ordered) attempts.push({ label: p, url: applyProxy(p, url) });

  for (const a of attempts) {
    const { signal, done } = timeoutSignal(a.label === 'direct' ? 3500 : perTryMs);
    try {
      const res = await fetch(a.url, { signal, headers: { Accept: 'application/json, text/plain, */*' } });
      done();
      if (!res.ok) continue;
      const text = await res.text();
      if (text && text.trim()) {
        if (a.label !== 'direct') preferredProxy = a.label;
        return text;
      }
    } catch {
      done();
    }
  }
  return null;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function splitArtistTitle(text) {
  const clean = decodeEntities(text);
  const m = clean.match(/^(.*?)\s+[-–—]\s+(.*)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: '', title: clean };
}

function parseIcecast(text, mountPath) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const stats = data.icestats || data;
  let source = stats.source;
  if (!source) return null;
  if (Array.isArray(source)) {
    // у сервера может быть много монтов — ищем свой по пути потока
    const byMount = mountPath
      ? source.find((s) => {
          try {
            return new URL(s.listenurl).pathname === mountPath;
          } catch {
            return false;
          }
        })
      : null;
    source = byMount || source.find((s) => s.title || s.songtitle || s.artist) || source[0];
  }
  const raw = (source.title || source.songtitle || source.yp_currently_playing || '').trim();
  if (!raw) return null;
  return { raw: decodeEntities(raw), ...splitArtistTitle(raw), server: (source.server_name || '').trim(), source: 'icecast' };
}

function parseIcecastXsl(html) {
  // грубый разбор HTML статус-страницы Icecast
  const grab = (label) => {
    const re = new RegExp(label + '[:<][^>]*>\\s*<td[^>]*>([^<]+)', 'i');
    const m = html.match(re);
    return m ? m[1].replace(/&amp;/g, '&').trim() : '';
  };
  let raw = grab('Current Song');
  if (!raw) {
    const m = html.match(/Current Song:?\s*<\/td>\s*<td[^>]*>([^<]+)/i);
    raw = m ? m[1].trim() : '';
  }
  if (!raw) return null;
  return { raw, ...splitArtistTitle(raw), source: 'icecast-xsl' };
}

function parseShoutcast7(html) {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || html.match(/<body[^>]*>([\s\S]*)/i);
  const body = (m ? m[1] : html).trim();
  const parts = body.split(',').map((s) => s.trim());
  if (parts.length < 7) return null;
  const raw = parts[6] || '';
  if (!raw) return null;
  return { raw, ...splitArtistTitle(raw), server: parts[7] || '', source: 'shoutcast' };
}

function parseShoutcastJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const raw = (data.songtitle || data.streamtitle || data.title || '').trim();
  if (!raw) return null;
  return { raw, ...splitArtistTitle(raw), server: (data.servertitle || '').trim(), source: 'shoutcast2' };
}

function parseAzuraCast(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const root = Array.isArray(data) ? data[0] : data;
  const np = root && root.now_playing;
  if (!np) return null;
  const song = np.song || {};
  const raw = (song.text || [song.artist, song.title].filter(Boolean).join(' - ') || '').trim();
  if (!raw) return null;
  return {
    raw,
    artist: song.artist || '',
    title: song.title || '',
    art: song.art || '',
    server: (root.station && root.station.name) || '',
    source: 'azuracast',
  };
}

function parseStatusText(text, streamUrl) {
  const t = text.trim();
  if (!t) return null;
  let mountPath = '';
  if (streamUrl) {
    try {
      mountPath = new URL(streamUrl).pathname;
    } catch {
      mountPath = '';
    }
  }
  if (t[0] === '{' || t[0] === '[') return parseAzuraCast(t) || parseIcecast(t, mountPath) || parseShoutcastJson(t);
  if (/<html|<\/body>|<\/table>/i.test(t)) return parseShoutcast7(t) || parseIcecastXsl(t);
  return null;
}

/**
 * Возвращает { raw, artist, title, server, source } либо null.
 * @param {object} station
 * @param {{proxies?: string[], metaUrl?: string}} opts
 */
export async function resolveNowPlaying(station, opts = {}) {
  const proxies = opts.proxies && opts.proxies.length ? opts.proxies : [];
  const urls = opts.metaUrl ? [opts.metaUrl, ...candidateUrls(station.url)] : candidateUrls(station.url);
  for (const url of urls) {
    const text = await tryFetch(url, proxies);
    if (text) {
      const parsed = parseStatusText(text, station.url);
      if (parsed) return parsed;
    }
  }
  return null;
}

export const _internal = { candidateUrls, parseStatusText, splitArtistTitle };

/** Загрузка произвольного текста (например, m3u) с перебором прокси. */
export async function fetchText(url, proxies = []) {
  return tryFetch(url, proxies);
}

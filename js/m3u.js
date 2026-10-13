// Парсер M3U / M3U8 / PLS плейлистов.

function attrParse(line) {
  const attrs = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(line))) attrs[m[1].toLowerCase()] = m[2];
  return attrs;
}

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return 's' + (h >>> 0).toString(36);
}

export function makeStation(fields, source = 'm3u') {
  const url = fields.url || '';
  return {
    id: fields.id || hash(url + (fields.name || '')),
    name: (fields.name || url).trim(),
    url,
    favicon: fields.favicon || '',
    homepage: fields.homepage || '',
    country: fields.country || '',
    countrycode: fields.countrycode || '',
    language: fields.language || '',
    tags: fields.tags || '',
    codec: fields.codec || '',
    bitrate: fields.bitrate || 0,
    votes: fields.votes || 0,
    clickcount: fields.clickcount || 0,
    group: fields.group || '',
    source,
  };
}

// Парсит текст m3u/m3u8 в массив станций.
export function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const stations = [];
  let pending = null;

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (/^#EXTINF:/i.test(line)) {
      const comma = line.indexOf(',');
      const info = comma >= 0 ? line.slice(0, comma) : line;
      const title = comma >= 0 ? line.slice(comma + 1).trim() : '';
      const attrs = attrParse(info);
      pending = {
        name: title,
        favicon: attrs['tvg-logo'] || attrs['logo'] || '',
        group: attrs['group-title'] || attrs['group'] || '',
        tvgId: attrs['tvg-id'] || '',
      };
      continue;
    }

    if (/^#EXTGRP:/i.test(line)) {
      if (pending) pending.group = line.slice(8).trim();
      continue;
    }

    if (line.startsWith('#')) continue; // прочие директивы игнорируем

    // строка с URL
    if (/^(https?|rtmp|rtsp|icy|mms):/i.test(line) || line.includes('/') || line.includes('.')) {
      const s = makeStation({ ...(pending || {}), url: line }, 'm3u');
      if (pending && pending.name) s.name = pending.name;
      stations.push(s);
      pending = null;
    }
  }
  return stations;
}

// Парсер PLS (на всякий случай).
export function parsePLS(text) {
  const stations = [];
  const lines = text.split(/\r?\n/);
  let count = 0;
  for (const l of lines) if (/^NumberOfEntries=/i.test(l)) count = parseInt(l.split('=')[1], 10) || 0;
  for (let i = 1; i <= count; i++) {
    const fileL = lines.find((l) => new RegExp(`^File${i}=`, 'i').test(l));
    const titleL = lines.find((l) => new RegExp(`^Title${i}=`, 'i').test(l));
    if (!fileL) continue;
    const url = fileL.split('=').slice(1).join('=').trim();
    const name = titleL ? titleL.split('=').slice(1).join('=').trim() : url;
    stations.push(makeStation({ url, name }, 'm3u'));
  }
  return stations;
}

export function parsePlaylist(text) {
  if (/^\[playlist\]/im.test(text)) return parsePLS(text);
  return parseM3U(text);
}

// Имя плейлиста из #PLAYLIST: (если есть).
export function playlistName(text) {
  const m = text.match(/^#PLAYLIST:(.+)$/im);
  return m ? m[1].trim() : '';
}

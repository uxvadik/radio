// Воспроизведение ТВ-потоков: MP4 напрямую, HLS нативно (Safari) или через hls.js.
import { fetchText } from './net.js';
import { store } from './store.js';

const HLS_SCRIPT = './vendor/hls.min.js';
let hlsLoader = null;

function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLoader) {
    hlsLoader = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = HLS_SCRIPT;
      s.async = true;
      s.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('hls.js не загрузился')));
      s.onerror = () => reject(new Error('hls.js не загрузился'));
      document.head.append(s);
    });
  }
  return hlsLoader;
}

function isHlsUrl(url) {
  return /\.m3u8(\?|#|$)/i.test(url) || /\/playlist\.m3u8/i.test(url) || String(url).startsWith('blob:');
}

function isRutubeUrl(url) {
  return /^https?:\/\/bl\.rutube\.ru\/livestream\//i.test(url);
}

function isRutubeVideoUrl(url) {
  return /^https?:\/\/rutube\.ru\/video\//i.test(url) || /^https?:\/\/rutube\.ru\/api\/play\/options\//i.test(url);
}

// На iOS и в Safari HLS играет нативно; в Chrome/Firefox — через hls.js.
function prefersNativeHls() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  if (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1) return true;
  return /^((?!chrome|chromium|android|crios|fxios|edg|opr).)*safari/i.test(ua);
}

export class Player {
  constructor(video) {
    this.video = video;
    this.queue = [];
    this.index = -1;
    this.channel = null;
    this.nowPlaying = '';
    this.loading = false;
    this.error = null;
    this._hls = null;
    this._blobUrl = null;
    this._forceHigh = false;
    this._level = null;
    this._token = 0;
    this._listeners = new Map();
    this._bindVideo();
    this._initMediaSession();
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event).delete(fn);
  }

  _emit(event, payload) {
    (this._listeners.get(event) || []).forEach((fn) => fn(payload));
  }

  get playing() {
    const v = this.video;
    return !!this.channel && !v.paused && !v.ended && v.readyState > 2;
  }

  get hasSource() {
    return !!this.channel && !this.error;
  }

  // Универсальный медиаэлемент (используется детектором тишины для шумов).
  get media() {
    return this.video;
  }

  _bindVideo() {
    const v = this.video;
    v.addEventListener('loadstart', () => this._setLoading(true));
    v.addEventListener('waiting', () => this._setLoading(true));
    v.addEventListener('stalled', () => this._setLoading(true));
    v.addEventListener('playing', () => {
      this._setLoading(false);
      this.error = null;
      this._emitState();
      this._reportQuality();
    });
    v.addEventListener('canplay', () => this._setLoading(false));
    v.addEventListener('loadedmetadata', () => this._reportQuality());
    v.addEventListener('timeupdate', () => {
      if (!v.paused && v.readyState >= 3) this._setLoading(false);
    });
    v.addEventListener('play', () => this._emitState());
    v.addEventListener('pause', () => this._emitState());
    v.addEventListener('volumechange', () => this._emit('volume', { volume: v.volume, muted: v.muted }));
    v.addEventListener('error', () => {
      if (!this.channel || !this._expectSource) return;
      this._setLoading(false);
      this.error = 'Канал недоступен';
      this._emit('error', { channel: this.channel, error: this.error });
      this._emitState();
    });
    v.addEventListener('ended', () => {
      if (this.channel) this.next();
    });
  }

  _setLoading(value) {
    if (this.loading !== value) {
      this.loading = value;
      this._emitState();
    }
  }

  _emitState() {
    this._emit('state', {
      playing: this.playing,
      loading: this.loading,
      error: this.error,
      channel: this.channel,
      hasSource: this.hasSource,
    });
  }

  _reportQuality() {
    const v = this.video;
    let width = v.videoWidth || 0;
    let height = v.videoHeight || 0;
    if (this._level) {
      width = this._level.width || width;
      height = this._level.height || height;
    }
    if (width || height) this._emit('quality', { width, height });
  }

  // «Сейчас играет» для радио: метаданные трека поверх названия станции.
  setNowPlaying(text) {
    this.nowPlaying = text || '';
    this._updateMediaSession();
    this._emit('nowplaying', this.nowPlaying);
  }

  setQueue(channels, index = -1) {
    this.queue = Array.isArray(channels) ? channels : [];
    this.index = index;
  }

  _destroyHls() {
    if (this._blobUrl) {
      try {
        URL.revokeObjectURL(this._blobUrl);
      } catch {
        /* ignore */
      }
      this._blobUrl = null;
    }
    if (this._hls) {
      try {
        this._hls.destroy();
      } catch {
        /* ignore */
      }
      this._hls = null;
    }
  }

  async playStation(channel, queue, index) {
    if (!channel || !channel.url) return;
    if (queue) this.setQueue(queue, index ?? this.queue.indexOf(channel));
    else if (index !== undefined) this.index = index;

    const token = ++this._token;
    this._destroyHls();
    this._level = null;
    this._forceHigh = false;
    this._expectSource = false;
    this.error = null;
    this.nowPlaying = '';
    this.channel = channel;
    this.loading = true;
    this.video.removeAttribute('src');
    try {
      this.video.load();
    } catch {
      /* ignore */
    }
    this._updateMediaSession();
    this._emit('station', channel);
    this._emitState();

    if (location.protocol === 'https:' && /^http:\/\//i.test(channel.url)) {
      this._fail('HTTP-поток не откроется на HTTPS-странице');
      return;
    }

    let streamUrl = channel.url;
    if (isRutubeVideoUrl(streamUrl)) {
      const idMatch = streamUrl.match(/\/video\/([0-9a-f]{32})/i);
      const videoId = idMatch ? idMatch[1] : null;
      if (!videoId) {
        this._fail('Некорректная ссылка на видео');
        return;
      }
      const apiUrl = `https://rutube.ru/api/play/options/${videoId}/?no_404=true`;
      const jsonText = await fetchText(apiUrl, store.get('proxies'), { directFirst: false });
      if (token !== this._token) return;
      let master = '';
      try {
        master = JSON.parse(jsonText || '{}')?.video_balancer?.default || '';
      } catch {
        master = '';
      }
      if (!master) {
        this._fail('Видео недоступно');
        return;
      }
      this._forceHigh = true;
      if (prefersNativeHls()) {
        streamUrl = master;
      } else {
        const masterText = await fetchText(master, store.get('proxies'), { directFirst: false });
        if (token !== this._token) return;
        if (!masterText || !/#EXTM3U/i.test(masterText)) {
          this._fail('Видео недоступно');
          return;
        }
        this._blobUrl = URL.createObjectURL(new Blob([masterText], { type: 'application/vnd.apple.mpegurl' }));
        streamUrl = this._blobUrl;
      }
    } else if (isRutubeUrl(streamUrl)) {
      const master = await fetchText(streamUrl, store.get('proxies'), { directFirst: false });
      if (token !== this._token) return;
      if (!master || !/#EXTM3U/i.test(master)) {
        this._fail('Не удалось получить поток');
        return;
      }
      const base = streamUrl;
      const rawLines = master.split(/\r?\n/).map((line) => {
        const t = line.trim();
        if (t && !t.startsWith('#') && !/^https?:\/\//i.test(t)) {
          try {
            return new URL(t, base).toString();
          } catch {
            return line;
          }
        }
        return line;
      });

      // Rutube отдаёт по два CDN на качество. rtbcdn.ru часто недоступен,
      // river-1.rutube.ru работает стабильнее — оставляем только его.
      const lines = [];
      let hasRiver = false;
      for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];
        if (line.startsWith('#EXT-X-STREAM-INF')) {
          const next = rawLines[i + 1] || '';
          if (/river-1\.rutube\.ru/i.test(next)) {
            lines.push(line, next);
            hasRiver = true;
          }
          i++;
          continue;
        }
        if (!/^https?:\/\//i.test(line.trim())) lines.push(line);
      }
      const source = hasRiver ? lines : rawLines;
      const rewritten = source.join('\n');
      if (prefersNativeHls()) {
        const variants = source.map((l) => l.trim()).filter((l) => /^https?:\/\//i.test(l));
        streamUrl = variants[0] || streamUrl;
      } else {
        this._blobUrl = URL.createObjectURL(new Blob([rewritten], { type: 'application/vnd.apple.mpegurl' }));
        streamUrl = this._blobUrl;
      }
    }

    const hlsUrl = isHlsUrl(streamUrl);
    const nativeHls = this.video.canPlayType('application/vnd.apple.mpegurl') !== '';

    try {
      if (hlsUrl && !prefersNativeHls()) {
        const Hls = await loadHls();
        if (token !== this._token) return;
        if (!Hls.isSupported()) {
          if (!nativeHls) throw new Error('Браузер не поддерживает HLS');
          this._expectSource = true;
          this.video.src = streamUrl;
          this.video.load();
          this._emitState();
          this._attemptPlay();
          return;
        }
        let netRetries = 0;
        let mediaRetries = 0;
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 30,
          maxBufferLength: 30,
          manifestLoadingTimeOut: 12000,
          levelLoadingTimeOut: 12000,
          fragLoadingTimeOut: 20000,
        });
        this._hls = hls;
        this._expectSource = true;
        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
          if (token === this._token) hls.loadSource(streamUrl);
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (token !== this._token) return;
          if (this._forceHigh && hls.levels && hls.levels.length) {
            hls.currentLevel = hls.levels.length - 1;
          }
          this._reportQuality();
          this._attemptPlay();
        });
        hls.on(Hls.Events.LEVEL_SWITCHED, (_evt, data) => {
          if (token !== this._token) return;
          this._level = hls.levels[data.level] || null;
          this._reportQuality();
        });
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (token !== this._token || !data || !data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && netRetries < 1) {
            netRetries++;
            if (/manifest/i.test(data.details || '')) hls.loadSource(streamUrl);
            else hls.startLoad();
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries < 1) {
            mediaRetries++;
            hls.recoverMediaError();
            return;
          }
          this._fail('Канал недоступен');
        });
        hls.attachMedia(this.video);
      } else {
        this._expectSource = true;
        this.video.src = streamUrl;
        this.video.load();
      }
    } catch (e) {
      if (token !== this._token) return;
      this._fail(e && e.message ? e.message : 'Не удалось открыть поток');
      return;
    }

    this._emitState();
    this._attemptPlay();
  }

  async _attemptPlay() {
    if (!this.channel) return;
    try {
      await this.video.play();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      if (e && e.name === 'NotAllowedError') {
        this._setLoading(false);
        this._emit('blocked', { channel: this.channel });
        this._emitState();
        return;
      }
      if (!this.loading) this._fail('Не удалось открыть поток');
    }
  }

  _fail(message) {
    this._destroyHls();
    this._expectSource = false;
    this._setLoading(false);
    this.error = message;
    this._emit('error', { channel: this.channel, error: message });
    this._emitState();
  }

  async toggle() {
    if (!this.channel || !this.video.src) return;
    if (this.video.paused) {
      try {
        await this.video.play();
      } catch {
        /* autoplay guard */
      }
    } else {
      this.video.pause();
    }
  }

  async reload() {
    if (!this.channel) return;
    const ch = this.channel;
    const q = this.queue;
    const i = this.index;
    await this.playStation(ch, q, i);
  }

  stop() {
    this._token++;
    this._destroyHls();
    this._expectSource = false;
    this.video.pause();
    this.video.removeAttribute('src');
    try {
      this.video.load();
    } catch {
      /* ignore */
    }
    this.channel = null;
    this.loading = false;
    this.error = null;
    this._updateMediaSession();
    this._emitState();
  }

  next() {
    if (!this.queue.length) return;
    const i = this.index < 0 ? 0 : (this.index + 1) % this.queue.length;
    this.playStation(this.queue[i], this.queue, i);
  }

  prev() {
    if (!this.queue.length) return;
    const i = this.index <= 0 ? this.queue.length - 1 : this.index - 1;
    this.playStation(this.queue[i], this.queue, i);
  }

  setVolume(v) {
    this.video.volume = Math.max(0, Math.min(1, v));
  }

  setMuted(m) {
    this.video.muted = !!m;
  }

  _initMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler?.('play', () => this.toggle());
    ms.setActionHandler?.('pause', () => this.toggle());
    ms.setActionHandler?.('previoustrack', () => this.prev());
    ms.setActionHandler?.('nexttrack', () => this.next());
    ms.setActionHandler?.('stop', () => this.stop());
  }

  _updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const ch = this.channel;
    if (!ch) {
      ms.metadata = null;
      return;
    }
    const artwork = ch.favicon
      ? [
          { src: ch.favicon, sizes: '512x512', type: 'image/png' },
          { src: ch.favicon, sizes: '256x256', type: 'image/png' },
        ]
      : [];
    ms.metadata = new MediaMetadata({
      title: String(this.nowPlaying || ch.name || 'RADIO / TV').slice(0, 120),
      artist: ch.group || 'RADIO / TV',
      album: 'RADIO / TV',
      artwork,
    });
    if ('playbackState' in ms) {
      ms.playbackState = this.playing ? 'playing' : this.video.paused ? 'paused' : 'none';
    }
  }
}

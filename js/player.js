// Управление воспроизведением потока + Media Session.
export class Player {
  constructor(audio) {
    this.audio = audio;
    this.queue = [];
    this.index = -1;
    this.station = null;
    this.loading = false;
    this.error = null;
    this._listeners = new Map();
    this._bindAudio();
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
    return !this.audio.paused && !this.audio.ended && this.audio.readyState > 2;
  }

  _bindAudio() {
    const a = this.audio;
    a.addEventListener('loadstart', () => this._setLoading(true));
    a.addEventListener('waiting', () => this._setLoading(true));
    a.addEventListener('stalled', () => this._setLoading(true));
    a.addEventListener('playing', () => {
      this._setLoading(false);
      this.error = null;
      this._emitState();
    });
    a.addEventListener('canplay', () => this._setLoading(false));
    a.addEventListener('play', () => this._emitState());
    a.addEventListener('pause', () => this._emitState());
    a.addEventListener('volumechange', () => this._emit('volume', { volume: a.volume, muted: a.muted }));
    a.addEventListener('error', () => {
      this._setLoading(false);
      this.error = 'Не удалось открыть поток';
      this._emit('error', { station: this.station, error: this.error });
      this._emitState();
    });
    a.addEventListener('ended', () => {
      if (this.station) this.next();
    });
  }

  _setLoading(v) {
    if (this.loading !== v) {
      this.loading = v;
      this._emitState();
    }
  }

  _emitState() {
    this._emit('state', {
      playing: this.playing,
      loading: this.loading,
      error: this.error,
      station: this.station,
    });
  }

  setQueue(stations, index = -1) {
    this.queue = Array.isArray(stations) ? stations : [];
    this.index = index;
  }

  async playStation(station, queue, index) {
    if (queue) this.setQueue(queue, index ?? this.queue.indexOf(station));
    this.station = station;
    this.error = null;
    this._setLoading(true);
    this.audio.src = station.url;
    this.audio.load();
    this._updateMediaSession();
    this._emit('station', station);
    this._emitState();
    try {
      await this.audio.play();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      this.error =
        e && e.name === 'NotAllowedError'
          ? 'Нажми ▶ ещё раз — браузер заблокировал автозапуск'
          : 'Не удалось открыть поток';
      this._setLoading(false);
      this._emit('error', { station, error: this.error });
      this._emitState();
    }
  }

  async toggle() {
    if (!this.station || !this.audio.src) return;
    if (this.audio.paused) {
      try {
        await this.audio.play();
      } catch {
        /* autoplay guard */
      }
    } else {
      this.audio.pause();
    }
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.station = null;
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
    this.audio.volume = Math.max(0, Math.min(1, v));
  }

  setMuted(m) {
    this.audio.muted = !!m;
  }

  setNowPlaying(text) {
    this.nowPlaying = text;
    this._updateMediaSession(text);
    this._emit('nowplaying', text);
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

  _updateMediaSession(nowPlaying) {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const s = this.station;
    if (!s) {
      ms.metadata = null;
      return;
    }
    const artwork = s.favicon
      ? [
          { src: s.favicon, sizes: '512x512', type: 'image/png' },
          { src: s.favicon, sizes: '256x256', type: 'image/png' },
        ]
      : [];
    const title = nowPlaying || s.name;
    ms.metadata = new MediaMetadata({
      title: String(title || 'Радио').slice(0, 120),
      artist: s.name || '',
      album: 'RADIO',
      artwork,
    });
    if ('playbackState' in ms) {
      ms.playbackState = this.playing ? 'playing' : this.audio.paused ? 'paused' : 'none';
    }
  }
}

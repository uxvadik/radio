// Шумы радио во время буферизации. Играем через Web Audio, чтобы не конфликтовать
// с <audio>-элементом потока и иметь точные фейды.
export class NoiseEngine {
  constructor(urls) {
    this.urls = urls;
    this.ctx = null;
    this.gain = null;
    this.buffers = [];
    this.src = null;
    this.enabled = true;
    this.volume = 0.35;
    this.fade = 0.35; // сек
    this._active = false;
    this._idx = 0;
    this._nextTimer = null;
    this._loadPromise = null;
  }

  // Создаём/возобновляем AudioContext строго из жеста пользователя.
  async unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC();
        this.gain = this.ctx.createGain();
        this.gain.gain.value = 0;
        this.gain.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx.state === 'running' || this.ctx.state === 'suspended';
    } catch {
      return false;
    }
  }

  _decode(ab) {
    return new Promise((resolve, reject) => {
      const p = this.ctx.decodeAudioData(ab, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  // Грузим сэмплы последовательно (от лёгкого к тяжёлому), готовы — по первому.
  _load() {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = (async () => {
      for (const u of this.urls) {
        try {
          const res = await fetch(u);
          if (!res.ok) continue;
          const buf = await this._decode(await res.arrayBuffer());
          if (buf) this.buffers.push(buf);
        } catch {
          /* пропускаем битый сэмпл */
        }
      }
    })();
    return this._loadPromise;
  }

  async start() {
    if (!this.enabled) return;
    if (!(await this.unlock())) return;
    this._load();

    // ждём хотя бы пару сэмплов (обычно мгновенно, они мелкие), но не дольше 1.5 с
    const deadline = Date.now() + 1500;
    while (this.buffers.length < 2 && this.buffers.length < this.urls.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!this.buffers.length || this._active) return;

    this._active = true;
    // начинаем со случайного сэмпла, дальше идём по кругу — без однообразия
    this._idx = Math.floor(Math.random() * this.buffers.length);
    this._spawn(true);
  }

  // Запускает текущий сэмпл; по окончании — следующий по кругу.
  _spawn(fadeIn) {
    const buf = this.buffers[this._idx % this.buffers.length];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = this.buffers.length === 1;
    src.connect(this.gain);

    const advance = () => {
      if (!this._active || src !== this.src) return;
      clearTimeout(this._nextTimer);
      this._idx++;
      this._spawn(false);
    };
    src.onended = advance;
    src.start();
    this.src = src;

    // страховка: если onended не сработал (некоторые движки), переключим по таймеру
    if (!src.loop) {
      clearTimeout(this._nextTimer);
      this._nextTimer = setTimeout(advance, buf.duration * 1000 + 300);
    }

    const t = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    if (fadeIn) {
      this.gain.gain.setValueAtTime(Math.max(0.0001, this.gain.gain.value), t);
      this.gain.gain.linearRampToValueAtTime(this.volume, t + this.fade);
    } else {
      this.gain.gain.setTargetAtTime(this.volume, t, 0.02);
    }
  }

  stop() {
    if (!this._active || !this.ctx) return;
    this._active = false;
    clearTimeout(this._nextTimer);
    this._nextTimer = null;
    const src = this.src;
    this.src = null;
    const t = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(0, t + this.fade);
    if (src) {
      try {
        src.onended = null;
        src.stop(t + this.fade + 0.05);
      } catch {
        /* уже остановлен */
      }
    }
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this._active && this.ctx) {
      this.gain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }
  }
}

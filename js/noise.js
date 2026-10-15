// Шумы радио во время буферизации. Играем через Web Audio, чтобы не конфликтовать
// с <audio>-элементом потока и иметь точные фейды.
//
// Сэмпл выбирается взвешенно-случайно (без повтора подряд). Некоторым сэмплам
// можно задать малый вес — тогда они звучат редко.
export class NoiseEngine {
  constructor(samples) {
    this.samples = samples.map((s) => (typeof s === 'string' ? { url: s, weight: 1 } : { url: s.url, weight: s.weight ?? 1 }));
    this.ctx = null;
    this.gain = null;
    this.buffers = []; // [{ buffer, weight }]
    this.src = null;
    this.enabled = true;
    this.volume = 0.35;
    this.fade = 0.35; // сек
    this._active = false;
    this._last = -1;
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
      return true;
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

  // Грузим сэмплы последовательно (от лёгкого к тяжёлому).
  _load() {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = (async () => {
      for (const s of this.samples) {
        try {
          const res = await fetch(s.url);
          if (!res.ok) continue;
          const buf = await this._decode(await res.arrayBuffer());
          if (buf) this.buffers.push({ buffer: buf, weight: s.weight });
        } catch {
          /* пропускаем битый сэмпл */
        }
      }
    })();
    return this._loadPromise;
  }

  // Взвешенный выбор без немедленного повтора.
  _pick() {
    const n = this.buffers.length;
    if (n <= 1) return 0;
    const total = this.buffers.reduce((a, b) => a + b.weight, 0);
    for (let attempt = 0; attempt < 8; attempt++) {
      let r = Math.random() * total;
      for (let i = 0; i < n; i++) {
        r -= this.buffers[i].weight;
        if (r <= 0) {
          if (i !== this._last) return i;
          break;
        }
      }
    }
    return (this._last + 1) % n;
  }

  async start() {
    if (!this.enabled) return;
    if (!(await this.unlock())) return;
    this._load();

    // ждём хотя бы пару сэмплов (обычно мгновенно, они мелкие), но не дольше 1.5 с
    const deadline = Date.now() + 1500;
    while (this.buffers.length < 2 && this.buffers.length < this.samples.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!this.buffers.length || this._active) return;

    this._active = true;
    this._spawn(true);
  }

  _spawn(fadeIn) {
    const idx = this._pick();
    this._last = idx;
    const buf = this.buffers[idx].buffer;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = this.buffers.length === 1;
    src.connect(this.gain);

    const advance = () => {
      if (!this._active || src !== this.src) return;
      clearTimeout(this._nextTimer);
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

// DOM-слой: рендер списка/табов/плеера, тосты, шиты.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'value') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class UI {
  constructor() {
    this.listEl = $('#list');
    this.tabsEl = $('#tabs');
    this.statusText = $('#status-text');
    this.statusCount = $('#status-count');
    this.toastEl = $('#toast');
    this.sheet = $('#sheet');
    this.sheetTitle = $('#sheet-title');
    this.sheetBody = $('#sheet-body');
    this.backdrop = $('#backdrop');
    this.npStation = $('#np-station');
    this.npTrack = $('#np-track');
    this.npBadge = $('#np-badge');
    this.spectrum = $('#spectrum');

    this.onPick = null;
    this.onLongPress = null;
    this._pressTimer = null;
    this._suppressClick = false;
    this._bindList();
    this._bindSheet();
  }

  _bindList() {
    this.listEl.addEventListener('click', (e) => {
      if (this._suppressClick) {
        this._suppressClick = false;
        return;
      }
      const row = e.target.closest('[data-i]');
      if (row && this.onPick) this.onPick(Number(row.dataset.i));
    });
    const start = (e) => {
      const row = e.target.closest('[data-i]');
      if (!row) return;
      this._pressTimer = setTimeout(() => {
        this._pressTimer = null;
        this._suppressClick = true;
        if (this.onLongPress) this.onLongPress(Number(row.dataset.i));
      }, 550);
    };
    const cancel = () => {
      if (this._pressTimer) {
        clearTimeout(this._pressTimer);
        this._pressTimer = null;
      }
    };
    this.listEl.addEventListener('pointerdown', start);
    this.listEl.addEventListener('pointerup', cancel);
    this.listEl.addEventListener('pointerleave', cancel);
    this.listEl.addEventListener('pointercancel', cancel);
    this.listEl.addEventListener('scroll', cancel, { passive: true });
    this.listEl.addEventListener('contextmenu', (e) => {
      if (e.target.closest('[data-i]')) e.preventDefault();
    });
  }

  _bindSheet() {
    const close = () => this.closeSheet();
    $('#sheet-close').addEventListener('click', close);
    this.backdrop.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
  }

  // ------------------------------------------------------------- список
  setLoading() {
    this.listEl.replaceChildren(h('div', { class: 'list-msg' }, h('div', { class: 'spinner' }), 'Загружаю станции…'));
    this.setStatus('соединяюсь с каталогом…');
  }

  setMessage(text) {
    this.listEl.replaceChildren(h('div', { class: 'list-empty', html: text }));
  }

  renderList(stations, { activeUrl, playing, favoritesSet } = {}) {
    if (!stations || !stations.length) {
      this.setMessage('Ничего не найдено.');
      this.setCount(0);
      return;
    }
    const frag = document.createDocumentFragment();
    stations.forEach((s, i) => {
      const active = activeUrl && s.url === activeUrl;
      const fav = favoritesSet ? favoritesSet.has(s.id) || favoritesSet.has(s.url) : false;
      const sub = this._sub(s);
      const row = h('div', {
        class: 'station' + (active ? ' active' : '') + (active && !playing ? ' paused' : ''),
        dataset: { i, url: s.url },
      });
      row.innerHTML =
        `<div class="eq"><span class="num">${i + 1}</span>` +
        `<span class="eq-bars"><i></i><i></i><i></i></span></div>` +
        `<div class="info"><div class="name">${esc(s.name)}</div>` +
        `<div class="meta">${esc(sub)}</div></div>` +
        (fav ? '<span class="fav-mark ico ico-star"></span>' : '');
      frag.append(row);
    });
    this.listEl.replaceChildren(frag);
    this.setCount(stations.length);
  }

  _sub(s) {
    const bits = [];
    if (s.country) bits.push(s.country);
    if (s.bitrate) bits.push(s.bitrate + ' kbps');
    if (s.codec) bits.push(String(s.codec).toUpperCase());
    if (!bits.length && s.group) bits.push(s.group);
    if (!bits.length && s.url) {
      try {
        bits.push(new URL(s.url).hostname);
      } catch {
        /* ignore */
      }
    }
    return bits.join(' · ');
  }

  // -------------------------------------------------------------- табы
  renderTabs(playlists, activeId) {
    const frag = document.createDocumentFragment();
    playlists.forEach((p) => {
      const tab = h('button', {
        class: 'tab' + (p.id === activeId ? ' active' : ''),
        type: 'button',
        dataset: { id: p.id },
      });
      tab.innerHTML = esc(p.name) + (p.removable ? '<span class="tab-x" data-remove="1">×</span>' : '');
      frag.append(tab);
    });
    this.tabsEl.replaceChildren(frag);
    const active = this.tabsEl.querySelector('.tab.active');
    if (active) active.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  // ------------------------------------------------------------- плеер
  setPlayerInfo({ station, badge, track, playing }) {
    this.npStation.textContent = station ? station.name : '— выбери станцию —';
    if (badge) this.npBadge.textContent = badge;
    this.setTrack(track ?? (station ? 'потоковое радио' : 'потоковое радио'));
    document.body.classList.toggle('playing', !!playing);
  }

  setTrack(text) {
    const el = this.npTrack;
    el.classList.remove('scrolling');
    el.style.animationDuration = '';
    el.textContent = text || '—';
    requestAnimationFrame(() => {
      const wrap = el.parentElement;
      if (!wrap) return;
      if (el.scrollWidth > wrap.clientWidth + 6) {
        el.textContent = `${text}   •   ${text}`;
        const dur = Math.max(7, Math.round(el.scrollWidth / 35));
        el.style.animationDuration = dur + 's';
        el.classList.add('scrolling');
      }
    });
  }

  setStatus(text, count) {
    if (text !== undefined) this.statusText.textContent = text;
    if (count !== undefined) this.statusCount.textContent = count ? String(count) : '';
  }

  setCount(n) {
    this.statusCount.textContent = n ? String(n) : '';
  }

  setVolumeBar(pct) {
    const r = $('#vol');
    if (r) {
      r.value = String(Math.round(pct * 100));
      r.style.setProperty('--vol', Math.round(pct * 100) + '%');
    }
  }

  setMuted(m) {
    document.body.classList.toggle('muted', !!m);
  }

  setFav(on) {
    document.body.classList.toggle('fav', !!on);
  }

  // ------------------------------------------------------------- тосты
  toast(msg, ms = 2200) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  // -------------------------------------------------------------- шиты
  openSheet(title, node) {
    this.sheetTitle.textContent = title;
    this.sheetBody.replaceChildren(node);
    this.backdrop.hidden = false;
    this.sheet.hidden = false;
    requestAnimationFrame(() => {
      this.backdrop.classList.add('show');
      this.sheet.classList.add('show');
    });
  }

  closeSheet() {
    this.backdrop.classList.remove('show');
    this.sheet.classList.remove('show');
    setTimeout(() => {
      this.backdrop.hidden = true;
      this.sheet.hidden = true;
    }, 220);
  }
}

export const ui = new UI();
export { esc };

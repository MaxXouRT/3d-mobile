// Petits utilitaires d'interface : création d'éléments, icônes, panneaux, curseurs, messages.
export const $ = (s, r = document) => r.querySelector(s);

export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && k !== 'list') e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}

const P = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  undo: '<path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 010 12"/>',
  redo: '<path d="M15 7l5 5-5 5"/><path d="M20 12H10a6 6 0 000 12"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  fx: '<path d="M10 3l1.8 5.2L17 10l-5.2 1.8L10 17l-1.8-5.2L3 10l5.2-1.8L10 3z"/><path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9L18 15z"/>',
  onion: '<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6" stroke-dasharray="2.5 2.5"/>',
  menu: '<circle cx="12" cy="5" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="19" r="1.3" fill="currentColor"/>',
  play: '<path d="M7 4l13 8-13 8V4z" fill="currentColor"/>',
  pause: '<path d="M7 4v16M17 4v16" stroke-width="3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  brush: '<path d="M4 20c0-3 1.5-4.5 4-4.5L18.5 5a2.1 2.1 0 013 3L11 18.500c0 1.500-2 3.500-7 1.500z"/>',
  eraser: '<path d="M8 20l-5-5L14 4l7 7-9 9H8z"/><path d="M9 9l7 7"/><path d="M12 20h9"/>',
  bucket: '<path d="M11 3l9 9-7.500 7.500a2 2 0 01-2.800 0L4 13.800a2 2 0 010-2.800L11 3z"/><path d="M4.500 12.500h14.500"/><path d="M20.500 16.500s1.500 2 1.500 3a1.500 1.500 0 01-3 0c0-1 1.500-3 1.500-3z" fill="currentColor"/>',
  pipette: '<path d="M14 6l4 4"/><path d="M16 4a2.800 2.800 0 014 4l-3 3-4-4 3-3z"/><path d="M13 7l-9 9v4h4l9-9"/>',
  shape: '<rect x="3" y="3" width="11" height="11" rx="1"/><circle cx="15.500" cy="15.500" r="5.500"/>',
  move: '<path d="M12 2v20M2 12h20"/><path d="M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3"/>',
  camera: '<rect x="2" y="7" width="14" height="11" rx="2"/><path d="M16 11l6-3v9l-6-3"/>',
  eye: '<path d="M2 12s3.500-7 10-7 10 7 10 7-3.500 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.500 5.200A9.500 9.500 0 0112 5c6.500 0 10 7 10 7a17 17 0 01-3.200 4M6.300 6.300A17 17 0 002 12s3.500 7 10 7a9.500 9.500 0 004.200-1"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 017.500-2"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  down: '<path d="M12 5v14M5 12l7 7 7-7"/>',
  left: '<path d="M19 12H5M12 5l-7 7 7 7"/>',
  right: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.500" cy="9.500" r="1.500"/><path d="M21 16l-5-5-9 9"/>',
  video: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5M16 4v5M10 13l5 2.500-5 2.500v-5z"/>',
  export: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/>',
  check: '<path d="M4 12l6 6L20 6"/>',
  close: '<path d="M5 5l14 14M19 5L5 19"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  key: '<path d="M12 3l7 9-7 9-7-9 7-9z"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  pin: '<path d="M9 3h6l-1 6 4 4H6l4-4-1-6z"/><path d="M12 13v8"/>',
  merge: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 20h16"/>',
  wand: '<path d="M4 20L15 9"/><path d="M17 3l.900 2.100L20 6l-2.100.900L17 9l-.900-2.100L14 6l2.100-.900L17 3z"/><path d="M19.500 13l.500 1.500 1.500.500-1.500.500-.500 1.500-.500-1.500-1.500-.500 1.500-.500.500-1.500z"/>',
  flip: '<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 7L3 17h6V7zM15 7l6 10h-6V7z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
  person: '<circle cx="12" cy="4.500" r="2.200"/><path d="M5 9.500l7 1.500 7-1.500M12 11v4.500M12 15.500L8.500 22M12 15.500l3.500 6.500"/>',
  cube: '<path d="M12 2l9 5v10l-9 5-9-5V7l9-5z"/><path d="M3 7l9 5 9-5M12 12v10"/>',
  share: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 12v8h14v-8"/>',
};
export function icon(name, size = 22) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.800" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}
export function ibtn(name, label, onclick, cls = '') {
  return h('button', { class: 'ibtn ' + cls, 'aria-label': label, title: label, html: icon(name), onclick });
}

let toastT;
export function toast(msg, ms = 2200) {
  let t = $('#toast');
  if (!t) document.body.append(t = h('div', { id: 'toast' }));
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}

// Panneau coulissant depuis le bas. Le fond reste visible pour voir le dessin pendant les réglages.
const openSheets = [];
export function sheet({ title, content, onClose, tall = false, modal = false, actions }) {
  const body = h('div', { class: 'sheet-body' });
  const el = h('div', { class: 'sheet' + (tall ? ' tall' : '') },
    h('div', { class: 'sheet-head' },
      h('div', { class: 'sheet-title' }, title || ''),
      h('div', { class: 'sheet-actions' }, actions || []),
      ibtn('close', 'Fermer', () => api.close())),
    body);
  const back = h('div', { class: 'sheet-back' + (modal ? ' modal' : ''), onpointerdown: e => { if (e.target === back) api.close(); } });
  const api = {
    el, body,
    set(c) { body.replaceChildren(...[].concat(c).filter(Boolean)); },
    close() {
      if (!el.isConnected) return;
      back.remove(); el.remove();
      const i = openSheets.indexOf(api); if (i >= 0) openSheets.splice(i, 1);
      onClose?.();
    },
  };
  if (content) api.set(content);
  document.body.append(back, el);
  openSheets.push(api);
  requestAnimationFrame(() => el.classList.add('open'));
  return api;
}
export function closeAllSheets() { [...openSheets].forEach(s => s.close()); }

export function confirmDlg(msg, okLabel = 'OK', danger = false) {
  return new Promise(res => {
    let done = false;
    const fin = v => { if (done) return; done = true; s.close(); res(v); };
    const s = sheet({
      title: msg, modal: true, onClose: () => fin(false),
      content: h('div', { class: 'row end' },
        h('button', { class: 'btn', onclick: () => fin(false) }, 'Annuler'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => fin(true) }, okLabel)),
    });
  });
}
export function promptDlg(title, value = '') {
  return new Promise(res => {
    let done = false;
    const fin = v => { if (done) return; done = true; s.close(); res(v); };
    const inp = h('input', { class: 'input', value, type: 'text' });
    const s = sheet({
      title, modal: true, onClose: () => fin(null),
      content: [inp, h('div', { class: 'row end' },
        h('button', { class: 'btn', onclick: () => fin(null) }, 'Annuler'),
        h('button', { class: 'btn primary', onclick: () => fin(inp.value.trim()) }, 'OK'))],
    });
    setTimeout(() => inp.focus(), 50);
  });
}

// Curseur avec libellé et valeur. `curve` > 1 donne plus de précision sur les petites valeurs.
export function slider({ label, min = 0, max = 1, step = 0.01, value, fmt = v => v, oninput, onchange, curve = 1, compact = false }) {
  const toT = v => Math.pow((v - min) / (max - min), 1 / curve);
  const fromT = t => { const v = min + Math.pow(t, curve) * (max - min); return Math.round(v / step) * step; };
  const val = h('span', { class: 'sl-val' }, fmt(value));
  const inp = h('input', { type: 'range', min: 0, max: 1, step: 0.001, value: toT(value) });
  inp.addEventListener('input', () => { const v = fromT(+inp.value); val.textContent = fmt(v); oninput?.(v); });
  inp.addEventListener('change', () => onchange?.(fromT(+inp.value)));
  const el = h('label', { class: 'slider' + (compact ? ' compact' : '') }, h('span', { class: 'sl-label' }, label), inp, val);
  el.set = v => { inp.value = toT(v); val.textContent = fmt(v); };
  return el;
}

export function segmented(options, value, onchange) {
  const el = h('div', { class: 'seg' });
  const draw = () => el.replaceChildren(...options.map(([v, label]) =>
    h('button', { class: v === value ? 'on' : '', onclick: () => { value = v; draw(); onchange(v); } }, label)));
  draw();
  return el;
}

export function toggle(label, value, onchange) {
  const inp = h('input', { type: 'checkbox', checked: value, onchange: () => onchange(inp.checked) });
  return h('label', { class: 'toggle' }, h('span', {}, label), inp, h('i', {}));
}

export function busy(msg) {
  const txt = h('div', { class: 'busy-txt' }, msg);
  const bar = h('div', { class: 'busy-bar' }, h('i', {}));
  const el = h('div', { class: 'busy' }, h('div', { class: 'busy-box' }, h('div', { class: 'spin' }), txt, bar));
  document.body.append(el);
  return {
    update(m, frac) { if (m) txt.textContent = m; if (frac != null) { bar.classList.add('on'); bar.firstChild.style.width = Math.round(frac * 100) + '%'; } },
    close() { el.remove(); },
  };
}
export const nextPaint = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

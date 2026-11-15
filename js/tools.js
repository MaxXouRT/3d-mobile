// Outils de dessin : pinceaux, gomme, remplissage, pipette, formes, déplacement, caméra + annuler/rétablir.
import { S, emit, saveToolPrefs } from './state.js';
import { toast } from './ui.js';
import { scratch } from './effects.js';
import { compositeFrame, camAt, tickOfFrame } from './render.js';

export const BRUSHES = {
  pen: { name: 'Stylo', desc: 'Trait net et régulier', kind: 'line' },
  ink: { name: 'Plume', desc: 'Pleins et déliés selon la vitesse', kind: 'line', taper: true },
  pencil: { name: 'Crayon', desc: 'Grain de crayon, pour les esquisses', kind: 'stamp', spacing: 0.12, alpha: 0.55 },
  marker: { name: 'Marqueur', desc: 'Aplat semi-transparent', kind: 'line', flow: 0.55 },
  air: { name: 'Aérographe', desc: 'Bords doux, ombres et lumières', kind: 'stamp', spacing: 0.08, alpha: 0.14 },
};

let st = null;
const undoStack = [], redoStack = [];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function cur() {
  const p = S.project, frame = p.frames[S.frameIdx], layer = p.layer(S.layerId);
  return { p, frame, layer };
}
function canDraw(layer) {
  if (!layer) return false;
  if (layer.locked) { toast('Calque verrouillé'); return false; }
  if (!layer.visible) { toast('Calque masqué'); return false; }
  return true;
}
function strokeCanvas(p) { return scratch('stroke', p.cw, p.ch); }
function backupCel(p, cel) {
  const b = scratch('backup', p.cw, p.ch);
  b._ctx.globalCompositeOperation = 'copy'; b._ctx.drawImage(cel.canvas, 0, 0); b._ctx.globalCompositeOperation = 'source-over';
  return b;
}
function grow(bb, x, y, r) {
  if (!bb) return { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
  bb.x0 = Math.min(bb.x0, x - r); bb.y0 = Math.min(bb.y0, y - r); bb.x1 = Math.max(bb.x1, x + r); bb.y1 = Math.max(bb.y1, y + r);
  return bb;
}
function edited(p, cel, frame) { p.markDirty(cel, frame); p.refreshPreview(frame); emit('edited'); }

// ---------- Annuler / rétablir (on ne garde que la zone modifiée) ----------
function pushUndo(p, cel, bb) {
  if (!bb) return;
  const x = clamp(Math.floor(bb.x0) - 2, 0, p.cw), y = clamp(Math.floor(bb.y0) - 2, 0, p.ch);
  const w = clamp(Math.ceil(bb.x1) + 2, 0, p.cw) - x, h = clamp(Math.ceil(bb.y1) + 2, 0, p.ch) - y;
  if (w <= 0 || h <= 0) return;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(scratch('backup', p.cw, p.ch), -x, -y);
  undoStack.push({ cel: cel.id, x, y, w, h, patch: c });
  for (const e of redoStack.splice(0)) e.patch.width = 0;
  let px = 0; for (const e of undoStack) px += e.w * e.h;
  while (undoStack.length > 60 || (px > 36e6 && undoStack.length > 1)) { const e = undoStack.shift(); px -= e.w * e.h; e.patch.width = 0; }
  emit('undo');
}
async function swap(from, to, label) {
  if (st) return;
  commitXform();
  const p = S.project;
  let e;
  while ((e = from.pop()) && !p.cels.has(e.cel)) e.patch.width = 0;
  if (!e) { toast(label); emit('undo'); return; }
  const cel = p.cels.get(e.cel);
  const layer = p.layers.find(l => l.fixed ? l.cel === cel.id : p.frames.some(f => f.cels[l.id] === cel.id));
  let fi = layer?.fixed ? S.frameIdx : p.frames.findIndex(f => layer && f.cels[layer.id] === cel.id);
  if (!layer || fi < 0) { e.patch.width = 0; return; }
  if (fi !== S.frameIdx || !cel.canvas) await S.gotoFrame(fi);
  if (!cel.canvas) return;
  if (S.layerId !== layer.id) { S.layerId = layer.id; emit('layers'); }
  const c = document.createElement('canvas'); c.width = e.w; c.height = e.h;
  c.getContext('2d').drawImage(cel.canvas, -e.x, -e.y);
  cel.canvas._ctx.clearRect(e.x, e.y, e.w, e.h); cel.canvas._ctx.drawImage(e.patch, e.x, e.y);
  e.patch.width = 0; e.patch = c; to.push(e);
  edited(p, cel, p.frames[fi]); emit('undo');
}
export const undo = () => swap(undoStack, redoStack, 'Rien à annuler');
export const redo = () => swap(redoStack, undoStack, 'Rien à rétablir');
export const undoState = () => ({ undo: undoStack.length, redo: redoStack.length });
export function clearUndo() { for (const e of [...undoStack.splice(0), ...redoStack.splice(0)]) e.patch.width = 0; }
// Pour les opérations « tout le celluloïd » faites ailleurs (import, extraction des traits…)
export function snapshot(cel) { const p = S.project; backupCel(p, cel); return () => pushUndo(p, cel, { x0: 0, y0: 0, x1: p.cw, y1: p.ch }); }

// ---------- Pointes de pinceau ----------
const tips = {};
function tip(type, color) {
  const key = type + color; if (tips[key]) return tips[key];
  const n = 64, c = document.createElement('canvas'); c.width = c.height = n; const x = c.getContext('2d');
  if (type === 'air') {
    const g = x.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.5, 'rgba(0,0,0,.45)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, n, n);
  } else {
    const img = x.createImageData(n, n);
    for (let i = 0; i < n * n; i++) {
      const d = Math.hypot(i % n - n / 2 + .5, (i / n | 0) - n / 2 + .5) / (n / 2);
      img.data[i * 4 + 3] = d < 1 ? Math.random() * 255 * Math.min(1, (1 - d) * 3) : 0;
    }
    x.putImageData(img, 0, 0);
  }
  x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, n, n);
  return tips[key] = c;
}

// ---------- Tracé ----------
function beginStroke(pt) {
  const { p, frame, layer } = cur(); if (!canDraw(layer)) return;
  const erase = S.tool === 'eraser', t = S.tools[erase ? 'eraser' : 'brush'];
  const b = erase ? (t.soft ? { kind: 'stamp', spacing: 0.08, alpha: 0.3, tipType: 'air' } : { kind: 'line' }) : { ...BRUSHES[t.type], tipType: t.type };
  const cel = p.celFor(layer, frame); backupCel(p, cel);
  const sc = strokeCanvas(p);
  const ctx = erase ? cel.canvas._ctx : sc._ctx;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!erase) ctx.clearRect(0, 0, p.cw, p.ch);
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.strokeStyle = ctx.fillStyle = erase ? '#000' : S.color;
  ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  ctx.globalAlpha = erase && b.kind === 'line' ? t.opacity : 1;
  st = {
    kind: 'stroke', p, cel, frame, erase, b, t, ctx, start: { x: pt.x, y: pt.y }, sm: { x: pt.x, y: pt.y }, p1: null, mid: null,
    wf: b.taper ? 0.3 : 1, w: t.size, lastT: pt.t, v: 0, rem: 0, bbox: null, moved: false,
    tipImg: b.kind === 'stamp' ? tip(b.tipType, erase ? '#000000' : S.color) : null,
    alphaK: erase ? t.opacity : 1,
  };
}
function stamp(s, x, y, w) {
  const j = s.b.tipType === 'pencil' ? w * 0.08 : 0;
  s.ctx.globalAlpha = s.b.alpha * s.alphaK;
  s.ctx.drawImage(s.tipImg, x - w / 2 + (Math.random() - .5) * j, y - w / 2 + (Math.random() - .5) * j, w, w);
}
function seg(s, a, c, b, w) {
  const ctx = s.ctx;
  if (s.b.kind === 'line') {
    ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.x, c.y, b.x, b.y); ctx.stroke();
  } else {
    const len = Math.hypot(c.x - a.x, c.y - a.y) + Math.hypot(b.x - c.x, b.y - c.y), step = Math.max(0.5, s.b.spacing * w);
    let d = step - s.rem;
    for (; d <= len; d += step) {
      const u = d / len, v = 1 - u;
      stamp(s, v * v * a.x + 2 * v * u * c.x + u * u * b.x, v * v * a.y + 2 * v * u * c.y + u * u * b.y, w);
    }
    s.rem = len - (d - step);
  }
  s.bbox = grow(grow(grow(s.bbox, a.x, a.y, w), c.x, c.y, w), b.x, b.y, w);
}
function strokeMove(pt) {
  const s = st, k = s.erase ? 1 : 1 - s.t.smooth * 0.85;
  s.sm.x += (pt.x - s.sm.x) * k; s.sm.y += (pt.y - s.sm.y) * k;
  const c = { x: s.sm.x, y: s.sm.y }, prev = s.p1 || s.start, d = Math.hypot(c.x - prev.x, c.y - prev.y);
  if (d * S.view.scale < 0.6) return;
  let f = 1;
  if (pt.pen && s.b.flow == null) f = 0.2 + 0.8 * pt.p;
  if (s.b.taper) {
    s.v = d * S.view.scale / Math.max(1, pt.t - s.lastT);
    s.wf += (clamp(1.12 - s.v * 0.3, 0.3, 1) - s.wf) * 0.25; f *= s.wf;
  }
  const w = Math.max(0.5, s.t.size * f), mid = { x: (prev.x + c.x) / 2, y: (prev.y + c.y) / 2 };
  seg(s, s.mid || prev, prev, mid, s.moved ? (s.w + w) / 2 : w);
  s.mid = mid; s.p1 = c; s.w = w; s.lastT = pt.t; s.moved = true;
}
function endStroke(pt) {
  const s = st, { p, cel, ctx } = s;
  if (!s.moved) {
    const w = s.t.size * (pt.pen && s.b.flow == null ? 0.2 + 0.8 * pt.p : 1);
    if (s.b.kind === 'line') { ctx.beginPath(); ctx.arc(s.start.x, s.start.y, w / 2, 0, 7); ctx.fill(); }
    else for (let i = 0; i < 4; i++) stamp(s, s.start.x, s.start.y, w);
    s.bbox = grow(s.bbox, s.start.x, s.start.y, w);
  } else {
    const end = s.b.taper ? s.p1 : { x: pt.x, y: pt.y };
    seg(s, s.mid, s.p1, end, s.w);
    if (s.b.taper && s.b.kind === 'line') {
      // Queue effilée dans la direction du geste.
      const dx = s.p1.x - s.mid.x, dy = s.p1.y - s.mid.y, n = Math.hypot(dx, dy) || 1;
      const L = clamp(s.v * 30, 0.5, 3) * s.w, ux = dx / n, uy = dy / n;
      ctx.beginPath(); ctx.moveTo(end.x - uy * s.w / 2, end.y + ux * s.w / 2); ctx.lineTo(end.x + ux * L, end.y + uy * L);
      ctx.lineTo(end.x + uy * s.w / 2, end.y - ux * s.w / 2); ctx.fill();
      s.bbox = grow(s.bbox, end.x, end.y, L + s.w);
    }
  }
  ctx.restore();
  if (!s.erase) commitBuffer(s, s.t.opacity * (s.b.flow || 1));
  st = null;
  pushUndo(p, cel, s.bbox); edited(p, cel, s.frame);
}
function commitBuffer(s, alpha) {
  const c = s.cel.canvas._ctx, sc = strokeCanvas(s.p);
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = alpha; c.globalCompositeOperation = 'source-over';
  c.drawImage(sc, 0, 0); c.restore();
  sc._ctx.clearRect(0, 0, s.p.cw, s.p.ch);
}

// ---------- Formes ----------
function beginShape(pt) {
  const { p, frame, layer } = cur(); if (!canDraw(layer)) return;
  const cel = p.celFor(layer, frame); backupCel(p, cel);
  st = { kind: 'shape', p, cel, frame, t: S.tools.shape, start: { x: pt.x, y: pt.y }, bbox: null };
  shapeMove(pt);
}
function shapeMove(pt) {
  const s = st, t = s.t, ctx = strokeCanvas(s.p)._ctx, a = s.start;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, s.p.cw, s.p.ch);
  ctx.lineCap = ctx.lineJoin = 'round'; ctx.lineWidth = t.size; ctx.strokeStyle = ctx.fillStyle = S.color;
  ctx.beginPath();
  if (t.kind === 'line') { ctx.moveTo(a.x, a.y); ctx.lineTo(pt.x, pt.y); }
  else if (t.kind === 'rect') ctx.rect(Math.min(a.x, pt.x), Math.min(a.y, pt.y), Math.abs(pt.x - a.x), Math.abs(pt.y - a.y));
  else ctx.ellipse((a.x + pt.x) / 2, (a.y + pt.y) / 2, Math.abs(pt.x - a.x) / 2, Math.abs(pt.y - a.y) / 2, 0, 0, 7);
  if (t.fill && t.kind !== 'line') ctx.fill(); else ctx.stroke();
  ctx.restore();
  s.bbox = grow(grow(null, a.x, a.y, t.size), pt.x, pt.y, t.size);
}

// ---------- Remplissage ----------
function flood(d, w, h, x0, y0, tol) {
  const mask = new Uint8Array(w * h), s = (y0 * w + x0) * 4, r0 = d[s], g0 = d[s + 1], b0 = d[s + 2], a0 = d[s + 3];
  const match = i => {
    const j = i * 4, a = d[j + 3];
    if (Math.abs(a - a0) > tol) return false;
    if (a0 < 8 || a < 8) return true;
    return Math.abs(d[j] - r0) <= tol && Math.abs(d[j + 1] - g0) <= tol && Math.abs(d[j + 2] - b0) <= tol;
  };
  const stack = [x0, y0], bb = { x0, y0, x1: x0, y1: y0 };
  while (stack.length) {
    const y = stack.pop(), x = stack.pop(), row = y * w;
    if (mask[row + x] || !match(row + x)) continue;
    let l = x, r = x;
    while (l > 0 && !mask[row + l - 1] && match(row + l - 1)) l--;
    while (r < w - 1 && !mask[row + r + 1] && match(row + r + 1)) r++;
    for (let k = l; k <= r; k++) mask[row + k] = 1;
    if (l < bb.x0) bb.x0 = l; if (r > bb.x1) bb.x1 = r; if (y < bb.y0) bb.y0 = y; if (y > bb.y1) bb.y1 = y;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      let span = false;
      for (let k = l; k <= r; k++) {
        const j = ny * w + k;
        if (!mask[j] && match(j)) { if (!span) { stack.push(k, ny); span = true; } } else span = false;
      }
    }
  }
  return { mask, bb };
}
function doFill(pt) {
  const { p, frame, layer } = cur(); if (!canDraw(layer)) return;
  const x = Math.floor(pt.x), y = Math.floor(pt.y), w = p.cw, h = p.ch, t = S.tools.fill;
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const cel = p.celFor(layer, frame); backupCel(p, cel);
  const ref = scratch('ref', w, h, { willReadFrequently: true });
  if (t.all) compositeFrame(p, frame, ref._ctx, 1, { fx: false });
  else { ref._ctx.clearRect(0, 0, w, h); ref._ctx.drawImage(cel.canvas, 0, 0); }
  const d = ref._ctx.getImageData(0, 0, w, h).data;
  ref.width = ref.height = 1;
  let { mask, bb } = flood(d, w, h, x, y, t.tol);
  // Déborde légèrement sous les traits pour éviter le liseré blanc.
  for (let e = 0; e < t.expand; e++) {
    const x0 = Math.max(0, bb.x0 - 1), y0 = Math.max(0, bb.y0 - 1), x1 = Math.min(w - 1, bb.x1 + 1), y1 = Math.min(h - 1, bb.y1 + 1);
    const add = [];
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
      const i = yy * w + xx; if (mask[i]) continue;
      if ((xx > 0 && mask[i - 1]) || (xx < w - 1 && mask[i + 1]) || (yy > 0 && mask[i - w]) || (yy < h - 1 && mask[i + w])) add.push(i);
    }
    for (const i of add) mask[i] = 1;
    bb = { x0, y0, x1, y1 };
  }
  const bw = bb.x1 - bb.x0 + 1, bh = bb.y1 - bb.y0 + 1;
  const patch = scratch('fillpatch', bw, bh), img = patch._ctx.createImageData(bw, bh), o = img.data;
  const r = parseInt(S.color.slice(1, 3), 16), g = parseInt(S.color.slice(3, 5), 16), b = parseInt(S.color.slice(5, 7), 16);
  for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) {
    if (!mask[(yy + bb.y0) * w + xx + bb.x0]) continue;
    const j = (yy * bw + xx) * 4; o[j] = r; o[j + 1] = g; o[j + 2] = b; o[j + 3] = 255;
  }
  patch._ctx.putImageData(img, 0, 0);
  cel.canvas._ctx.drawImage(patch, bb.x0, bb.y0);
  patch.width = patch.height = 1;
  pushUndo(p, cel, { x0: bb.x0, y0: bb.y0, x1: bb.x1 + 1, y1: bb.y1 + 1 }); edited(p, cel, frame);
  pushRecent();
}

// ---------- Pipette ----------
function pick(pt) {
  const { p, frame } = cur(), c = scratch('pick', 1, 1, { willReadFrequently: true }), x = c._ctx;
  x.globalAlpha = 1; x.fillStyle = p.bg; x.fillRect(0, 0, 1, 1);
  for (const l of p.layers) {
    const cv = l.visible && p.celOf(l, frame)?.canvas; if (!cv) continue;
    x.globalAlpha = l.opacity; x.drawImage(cv, Math.floor(pt.x), Math.floor(pt.y), 1, 1, 0, 0, 1, 1);
  }
  const d = x.getImageData(0, 0, 1, 1).data;
  setColor('#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join(''), false);
}
export function setColor(c, remember = true) { S.color = c.toLowerCase(); if (remember) pushRecent(); emit('color'); }
export function pushRecent() {
  S.recent = [S.color, ...S.recent.filter(c => c !== S.color)].slice(0, 12); saveToolPrefs(); emit('recent');
}

// ---------- Déplacer / transformer le contenu du calque ----------
export function beginXform() {
  if (S.xform) return true;
  const { p, frame, layer } = cur(); if (!canDraw(layer)) return false;
  const cel = p.celOf(layer, frame);
  if (!cel?.canvas) { toast('Rien à déplacer sur ce calque'); return false; }
  const k = 160 / p.cw, sm = scratch('bb', 160, p.ch * k, { willReadFrequently: true });
  sm._ctx.clearRect(0, 0, sm.width, sm.height); sm._ctx.drawImage(cel.canvas, 0, 0, sm.width, sm.height);
  const d = sm._ctx.getImageData(0, 0, sm.width, sm.height).data;
  let bb = null;
  for (let y = 0; y < sm.height; y++) for (let x = 0; x < sm.width; x++) if (d[(y * sm.width + x) * 4 + 3] > 8) bb = grow(bb, x, y, 0);
  if (!bb) { toast('Rien à déplacer sur ce calque'); return false; }
  S.xform = { cel, frame, tx: 0, ty: 0, scale: 1, rot: 0, flip: 1, cx: (bb.x0 + bb.x1 + 1) / 2 / k, cy: (bb.y0 + bb.y1 + 1) / 2 / k };
  emit('xform');
  return true;
}
export function xformMatrix(ctx, x) {
  ctx.translate(x.cx + x.tx, x.cy + x.ty); ctx.rotate(x.rot); ctx.scale(x.scale * x.flip, x.scale); ctx.translate(-x.cx, -x.cy);
}
export function commitXform() {
  const x = S.xform; if (!x) return;
  S.xform = null; emit('xform');
  if (!x.cel.canvas || (!x.tx && !x.ty && x.scale === 1 && !x.rot && x.flip === 1)) return;
  const p = S.project, b = backupCel(p, x.cel), ctx = x.cel.canvas._ctx;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, p.cw, p.ch);
  ctx.imageSmoothingQuality = 'high'; xformMatrix(ctx, x); ctx.drawImage(b, 0, 0); ctx.restore();
  pushUndo(p, x.cel, { x0: 0, y0: 0, x1: p.cw, y1: p.ch }); edited(p, x.cel, x.frame);
}
export function cancelXform() { S.xform = null; emit('xform'); emit('render'); }

// ---------- Caméra ----------
export function curCam() { const { p, frame } = cur(); return frame.cam ? { ...frame.cam } : camAt(p, tickOfFrame(p, S.frameIdx)); }
export function setCam(patch) {
  const { p, frame } = cur();
  frame.cam = { ...curCam(), ...patch }; p.touch(); emit('cam');
}
export function removeCamKey() { const { p, frame } = cur(); frame.cam = null; p.touch(); emit('cam'); }

// ---------- Entrées (appelées par la zone de dessin) ----------
export function down(pt) {
  if (!S.ready || S.playing || S.preview || st) return;
  switch (S.tool) {
    case 'brush': case 'eraser': beginStroke(pt); break;
    case 'shape': beginShape(pt); break;
    case 'fill': st = { kind: 'fill', pt }; break;
    case 'pipette': st = { kind: 'pick' }; pick(pt); break;
    case 'move': if (beginXform()) st = { kind: 'move', last: pt }; break;
    case 'camera': st = { kind: 'cam', last: pt }; break;
  }
  emit('render');
}
export function move(pt) {
  if (!st) return;
  if (st.kind === 'stroke') strokeMove(pt);
  else if (st.kind === 'shape') shapeMove(pt);
  else if (st.kind === 'pick') pick(pt);
  else if (st.kind === 'move') { S.xform.tx += pt.x - st.last.x; S.xform.ty += pt.y - st.last.y; st.last = pt; }
  else if (st.kind === 'cam') { const c = curCam(); setCam({ x: c.x + pt.x - st.last.x, y: c.y + pt.y - st.last.y }); st.last = pt; }
  emit('render');
}
export function up(pt) {
  if (!st) return;
  const s = st;
  if (s.kind === 'stroke') { endStroke(pt); pushRecentIfDrawn(s); }
  else if (s.kind === 'shape') { st = null; commitBuffer(s, s.t.opacity); pushUndo(s.p, s.cel, s.bbox); edited(s.p, s.cel, s.frame); }
  else { st = null; if (s.kind === 'pick') { pushRecent(); emit('picked'); } else if (s.kind === 'fill') doFill(s.pt); }
  emit('render');
}
function pushRecentIfDrawn(s) { if (!s.erase && S.recent[0] !== S.color) pushRecent(); }
// Un deuxième doigt est arrivé : on abandonne le tracé en cours pour laisser place au zoom.
export function cancel() {
  if (!st) return;
  const s = st; st = null;
  if (s.kind === 'stroke') {
    s.ctx.restore();
    if (s.erase) { const c = s.cel.canvas._ctx; c.save(); c.globalCompositeOperation = 'copy'; c.drawImage(scratch('backup', s.p.cw, s.p.ch), 0, 0); c.restore(); }
    else strokeCanvas(s.p)._ctx.clearRect(0, 0, s.p.cw, s.p.ch);
  } else if (s.kind === 'shape') strokeCanvas(s.p)._ctx.clearRect(0, 0, s.p.cw, s.p.ch);
  emit('render');
}
export const busyStroke = () => !!st;
// Tampon du tracé en cours, à afficher par-dessus le calque actif.
export function liveStroke() {
  if (!st || (st.kind !== 'stroke' && st.kind !== 'shape') || st.erase) return null;
  return { canvas: strokeCanvas(st.p), alpha: st.t.opacity * (st.b?.flow || 1) };
}

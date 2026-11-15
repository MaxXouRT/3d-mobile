// Zone de dessin : affichage de l'espace de travail, gestes tactiles (dessin à un doigt,
// zoom / rotation / déplacement à deux doigts), aperçu du rendu final.
import { S, on, emit } from './state.js';
import * as tools from './tools.js';
import { scratch } from './effects.js';
import { camAt, tickOfFrame, renderOutput, frameAtTick } from './render.js';

let cv, ctx, W = 1, H = 1, dpr = 1, raf = 0;
let onionCache = { key: '', items: [] };

export function initViewport(canvas) {
  cv = canvas; ctx = cv.getContext('2d');
  new ResizeObserver(resize).observe(cv.parentElement);
  resize();
  bindPointers();
  on('render', requestRender);
}
function resize() {
  const r = cv.parentElement.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const first = W === 1;
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const flip = (W > H) !== (r.width > r.height), dx = (r.width - W) / 2, dy = (r.height - H) / 2;
  W = r.width; H = r.height;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  if ((first || flip) && S.project) fitView();
  else { S.view.x += dx; S.view.y += dy; }
  requestRender();
}
export function requestRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }

export function fitView() {
  const p = S.project; if (!p) return;
  const s = Math.min(W / p.cw, H / p.ch) * 0.96;
  S.view = { scale: s, rot: 0, x: (W - p.cw * s) / 2, y: (H - p.ch * s) / 2 };
  requestRender();
}
export function toCanvas(sx, sy) {
  const v = S.view, dx = sx - v.x, dy = sy - v.y, c = Math.cos(-v.rot), s = Math.sin(-v.rot);
  return { x: (dx * c - dy * s) / v.scale, y: (dx * s + dy * c) / v.scale };
}

function onion(p) {
  const o = p.onion, key = [S.frameIdx, p.ver, o.prev, o.next, o.opacity].join(':');
  if (onionCache.key === key) return onionCache.items;
  const items = [];
  const add = (fi, color, alpha, n) => {
    const f = p.frames[fi]; if (!f?.preview || f.stale) return;
    const c = scratch('onion' + n, f.preview.width, f.preview.height), x = c._ctx;
    x.globalCompositeOperation = 'copy'; x.drawImage(f.preview, 0, 0);
    x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
    x.globalCompositeOperation = 'source-over';
    items.push({ c, alpha });
  };
  for (let d = o.prev; d >= 1; d--) add(S.frameIdx - d, '#e5484d', o.opacity * (1 - (d - 1) / (o.prev + 1)), 'p' + d);
  for (let d = o.next; d >= 1; d--) add(S.frameIdx + d, '#2f9e6b', o.opacity * (1 - (d - 1) / (o.next + 1)), 'n' + d);
  onionCache = { key, items };
  return items;
}

function draw() {
  const p = S.project; if (!p || !ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#15161a'; ctx.fillRect(0, 0, W, H);
  if (S.preview) return drawPreview(p);
  const v = S.view, frame = p.frames[S.frameIdx]; if (!frame) return;
  ctx.save();
  ctx.translate(v.x, v.y); ctx.rotate(v.rot); ctx.scale(v.scale, v.scale);
  ctx.fillStyle = p.bg; ctx.fillRect(0, 0, p.cw, p.ch);
  ctx.imageSmoothingEnabled = v.scale * dpr < 4;
  ctx.imageSmoothingQuality = 'medium';
  if (p.onion.on) for (const it of onion(p)) { ctx.globalAlpha = it.alpha; ctx.drawImage(it.c, 0, 0, p.cw, p.ch); }
  const live = tools.liveStroke();
  for (const layer of p.layers) {
    if (!layer.visible) continue;
    const cel = p.celOf(layer, frame), active = layer.id === S.layerId;
    ctx.globalAlpha = layer.opacity; ctx.globalCompositeOperation = layer.blend || 'source-over';
    if (cel?.canvas) {
      if (active && S.xform && S.xform.cel === cel) { ctx.save(); tools.xformMatrix(ctx, S.xform); ctx.drawImage(cel.canvas, 0, 0); ctx.restore(); }
      else ctx.drawImage(cel.canvas, 0, 0);
    }
    if (active && live) { ctx.globalAlpha = layer.opacity * live.alpha; ctx.drawImage(live.canvas, 0, 0); }
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  // Cadre de la caméra : ce qui sera exporté. Le surplus autour reste dessinable.
  const cam = camAt(p, tickOfFrame(p, S.frameIdx)), hw = p.w / 2 / cam.zoom, hh = p.h / 2 / cam.zoom;
  const c = Math.cos(cam.rot), s = Math.sin(cam.rot);
  const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [cam.x + x * c - y * s, cam.y + x * s + y * c]);
  ctx.beginPath(); ctx.rect(0, 0, p.cw, p.ch);
  ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath();
  ctx.fillStyle = 'rgba(20,22,30,.22)'; ctx.fill('evenodd');
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath();
  const camTool = S.tool === 'camera';
  ctx.lineWidth = (camTool ? 2.5 : 1.5) / v.scale; ctx.strokeStyle = camTool ? '#ff8a3d' : 'rgba(255,138,61,.75)';
  if (!frame.cam && camTool) ctx.setLineDash([8 / v.scale, 6 / v.scale]);
  ctx.stroke(); ctx.setLineDash([]);
  ctx.restore();
  if (S.sizeHint && performance.now() < S.sizeHint.until) {
    ctx.beginPath(); ctx.arc(W / 2, H / 2, Math.max(1, S.sizeHint.size * v.scale / 2), 0, 7);
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = '#000'; ctx.stroke();
    setTimeout(requestRender, 60);
  }
}

function drawPreview(p) {
  const k = Math.min(W / p.w, H / p.h), ow = Math.round(p.w * k * dpr), oh = Math.round(p.h * k * dpr);
  const out = scratch('out', ow, oh);
  const f = p.frames[frameAtTick(p, S.tick)];
  renderOutput(p, S.tick, out._ctx, ow, oh, f?.preview && !f.stale ? f.preview : f?.preview);
  ctx.drawImage(out, (W - ow / dpr) / 2, (H - oh / dpr) / 2, ow / dpr, oh / dpr);
}

// ---------- Gestes ----------
function bindPointers() {
  const pts = new Map();
  let drawId = null, g = null, tap = null, mousePan = null;
  const pos = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const toPt = e => { const s = pos(e), c = toCanvas(s.x, s.y); return { x: c.x, y: c.y, p: e.pressure || 0.5, pen: e.pointerType === 'pen', t: e.timeStamp }; };
  const touches = () => [...pts.values()].filter(q => q.type !== 'pen');
  const startGesture = () => {
    const [a, b] = touches(), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    g = { d0: Math.hypot(b.x - a.x, b.y - a.y) || 1, a0: Math.atan2(b.y - a.y, b.x - a.x), v0: { ...S.view }, anchor: toCanvas(mid.x, mid.y), m0: mid };
  };
  cv.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch {}
    const s = pos(e); pts.set(e.pointerId, { ...s, type: e.pointerType, x0: s.x, y0: s.y });
    if (e.pointerType === 'mouse' && e.button !== 0) { mousePan = { ...s, v: { ...S.view } }; return; }
    const tc = touches().length;
    if (e.pointerType === 'pen' || (pts.size === 1)) {
      if (drawId == null && !g) { drawId = e.pointerId; tools.down(toPt(e)); }
      return;
    }
    if (tc >= 2 && (drawId == null || pts.get(drawId)?.type !== 'pen')) {
      if (drawId != null) { tools.cancel(); drawId = null; }
      if (tc === 2) { startGesture(); tap = { n: 2, t: e.timeStamp, moved: false }; }
      else if (tap) tap.n = Math.max(tap.n, tc);
    }
  });
  cv.addEventListener('pointermove', e => {
    const q = pts.get(e.pointerId); if (!q) return;
    const s = pos(e); q.x = s.x; q.y = s.y;
    if (mousePan) { S.view.x = mousePan.v.x + s.x - mousePan.x; S.view.y = mousePan.v.y + s.y - mousePan.y; requestRender(); return; }
    if (e.pointerId === drawId) {
      const evs = e.getCoalescedEvents?.() || [];
      for (const ev of (evs.length ? evs : [e])) tools.move(toPt(ev));
      return;
    }
    if (g && touches().length >= 2) {
      if (tap && Math.hypot(q.x - q.x0, q.y - q.y0) > 10) tap.moved = true;
      const [a, b] = touches(), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const sc = Math.min(40, Math.max(0.03, g.v0.scale * Math.hypot(b.x - a.x, b.y - a.y) / g.d0));
      let rot = g.v0.rot + Math.atan2(b.y - a.y, b.x - a.x) - g.a0;
      const q4 = Math.round(rot / (Math.PI / 2)) * Math.PI / 2;
      if (Math.abs(rot - q4) < 0.07) rot = q4; // aimantation aux angles droits
      const c = Math.cos(rot), sn = Math.sin(rot);
      S.view = { scale: sc, rot, x: mid.x - (g.anchor.x * c - g.anchor.y * sn) * sc, y: mid.y - (g.anchor.x * sn + g.anchor.y * c) * sc };
      requestRender(); emit('view');
    }
  });
  const end = e => {
    const q = pts.get(e.pointerId); if (!q) return;
    pts.delete(e.pointerId);
    if (mousePan) { mousePan = null; return; }
    if (e.pointerId === drawId) { drawId = null; if (e.type === 'pointercancel') tools.cancel(); else tools.up(toPt(e)); return; }
    if (g && touches().length < 2) g = null;
    if (tap && pts.size === 0) {
      if (!tap.moved && e.timeStamp - tap.t < 320) { if (tap.n >= 3) tools.redo(); else tools.undo(); }
      tap = null;
    }
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const s = pos(e), a = toCanvas(s.x, s.y), v = S.view;
    const sc = Math.min(40, Math.max(0.03, v.scale * Math.exp(-e.deltaY * 0.0015)));
    const c = Math.cos(v.rot), sn = Math.sin(v.rot);
    S.view = { scale: sc, rot: v.rot, x: s.x - (a.x * c - a.y * sn) * sc, y: s.y - (a.x * sn + a.y * c) * sc };
    requestRender(); emit('view');
  }, { passive: false });
}

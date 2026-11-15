// Composition d'un frame, caméra et rendu final (ce qui est exporté).
import { applyFx, inRange, scratch, shakeOffset, FX } from './effects.js';

// Dessine tous les calques visibles d'un frame dans ctx, à l'échelle s (espace du canevas, surplus compris).
export function compositeFrame(p, frame, ctx, s, opt = {}) {
  const W = Math.round(p.cw * s), H = Math.round(p.ch * s), fi = p.frames.indexOf(frame);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  for (const layer of p.layers) {
    if (!layer.visible) continue;
    const src = p.celOf(layer, frame)?.canvas; if (!src) continue;
    const fx = opt.fx === false ? [] : p.effects.filter(e => e.on && e.target === layer.id && inRange(e, fi));
    ctx.globalAlpha = layer.opacity; ctx.globalCompositeOperation = layer.blend || 'source-over';
    if (fx.length) {
      const t = scratch('layerfx', W, H); t._ctx.clearRect(0, 0, W, H); t._ctx.drawImage(src, 0, 0, W, H);
      for (const e of fx) applyFx(t, e, { s, tick: fi, prog: 0 });
      ctx.drawImage(t, 0, 0);
    } else ctx.drawImage(src, 0, 0, W, H);
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
}

// --- Temps : chaque frame dure `hold` images (1 = « à la une », 2 = « à la deux »…) ---
export function totalTicks(p) { let n = 0; for (const f of p.frames) n += f.hold; return n; }
export function frameAtTick(p, tick) {
  let n = 0;
  for (let i = 0; i < p.frames.length; i++) { n += p.frames[i].hold; if (tick < n) return i; }
  return p.frames.length - 1;
}
export function tickOfFrame(p, fi) { let n = 0; for (let i = 0; i < fi; i++) n += p.frames[i].hold; return n; }

// --- Caméra : clés posées sur des frames, interpolées image par image ---
export const defaultCam = p => ({ x: p.cw / 2, y: p.ch / 2, zoom: 1, rot: 0 });
export function camAt(p, tick) {
  let t = 0, prev = null, next = null;
  for (const f of p.frames) {
    if (f.cam) { if (t <= tick) prev = { t, c: f.cam }; else { next = { t, c: f.cam }; break; } }
    t += f.hold;
  }
  if (!prev && !next) return defaultCam(p);
  if (!prev) return { ...next.c };
  if (!next) return { ...prev.c };
  let k = (tick - prev.t) / (next.t - prev.t);
  if (p.camEase) k = k * k * (3 - 2 * k);
  const a = prev.c, b = next.c, L = (u, v) => u + (v - u) * k;
  return { x: L(a.x, b.x), y: L(a.y, b.y), zoom: Math.exp(L(Math.log(a.zoom), Math.log(b.zoom))), rot: L(a.rot, b.rot) };
}

// Rendu final d'une image : fond, vue caméra sur `src` (composite du frame), puis effets globaux.
export function renderOutput(p, tick, ctx, outW, outH, src, opt = {}) {
  const fi = frameAtTick(p, tick), k = outW / p.w;
  const fx = opt.fx === false ? [] : p.effects.filter(e => e.on && inRange(e, fi) && (e.target === 'all' || !FX[e.type].layer));
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, outW, outH);
  if (!opt.transparent) { ctx.fillStyle = p.bg; ctx.fillRect(0, 0, outW, outH); }
  const cam = camAt(p, tick);
  for (const e of fx) if (e.type === 'shake') { const o = shakeOffset(e, tick); cam.x += o.x; cam.y += o.y; }
  ctx.translate(outW / 2, outH / 2); ctx.scale(k * cam.zoom, k * cam.zoom); ctx.rotate(-cam.rot); ctx.translate(-cam.x, -cam.y);
  ctx.imageSmoothingQuality = 'high';
  if (src) ctx.drawImage(src, 0, 0, p.cw, p.ch);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const e of fx) {
    if (e.type === 'shake') continue;
    const a = e.from || 1, b = e.to || p.frames.length;
    applyFx(ctx.canvas, e, { s: k, tick, prog: b > a ? Math.min(1, Math.max(0, (fi + 1 - a) / (b - a))) : 1 });
  }
}

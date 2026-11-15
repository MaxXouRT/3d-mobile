// Effets de compositing façon anime. Chaque effet modifie un canvas « en place ».
export const hasFilter = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;

const pool = {};
export function scratch(name, w, h, opts) {
  let c = pool[name];
  if (!c) { c = pool[name] = document.createElement('canvas'); c._ctx = c.getContext('2d', opts); }
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c;
}
export function freeScratch() { for (const k in pool) { pool[k].width = pool[k].height = 1; } }

const R = (label, min, max, step, def, unit = '') => ({ type: 'range', label, min, max, step, def, unit });
const C = (label, def) => ({ type: 'color', label, def });
const O = (label, opts, def) => ({ type: 'select', label, opts, def });

// layer:true → l'effet peut cibler un seul calque ; sinon il s'applique à l'image finale.
export const FX = {
  glow: { name: 'Lueur (bloom)', desc: 'Fait rayonner les zones claires', layer: true, params: { radius: R('Rayon', 2, 80, 1, 24, 'px'), amount: R('Intensité', 0, 1.5, 0.05, 0.6), thresh: R('Seuil', 0, 3, 1, 1) } },
  diffusion: { name: 'Diffusion', desc: 'Voile doux typique des animés', layer: true, params: { radius: R('Rayon', 2, 80, 1, 18, 'px'), amount: R('Intensité', 0, 1, 0.05, 0.4) } },
  blur: { name: 'Flou', desc: 'Profondeur de champ, arrière-plan', layer: true, params: { radius: R('Rayon', 0, 60, 0.5, 6, 'px') } },
  color: { name: 'Couleurs', desc: 'Luminosité, contraste, saturation, teinte', layer: true, params: { bright: R('Luminosité', -100, 100, 1, 0), contrast: R('Contraste', -100, 100, 1, 0), sat: R('Saturation', -100, 100, 1, 0), hue: R('Teinte', -180, 180, 1, 0, '°') } },
  gradient: { name: 'Lumière dégradée', desc: 'Dégradé de couleur par-dessus l’image', params: { c1: C('Couleur 1', '#ffb36b'), c2: C('Couleur 2', '#3b4a9a'), angle: R('Angle', 0, 360, 5, 90, '°'), amount: R('Intensité', 0, 1, 0.05, 0.4), mode: O('Fusion', [['soft-light', 'Lumière douce'], ['overlay', 'Incrustation'], ['screen', 'Écran'], ['multiply', 'Produit'], ['source-over', 'Normal']], 'soft-light') } },
  vignette: { name: 'Vignette', desc: 'Assombrit les bords', params: { amount: R('Intensité', 0, 1, 0.05, 0.5), size: R('Taille', 0.1, 1, 0.05, 0.55) } },
  grain: { name: 'Grain', desc: 'Grain de pellicule animé', params: { amount: R('Intensité', 0, 1, 0.05, 0.25), size: R('Taille', 1, 4, 0.5, 1.5) } },
  chroma: { name: 'Aberration chromatique', desc: 'Décale le rouge et le bleu', params: { offset: R('Décalage', 0, 30, 0.5, 4, 'px') } },
  speed: { name: 'Lignes de vitesse', desc: 'Traits d’action animés', params: { mode: O('Type', [['radial', 'Concentration'], ['horiz', 'Horizontales']], 'radial'), count: R('Nombre', 10, 200, 5, 70), clear: R('Zone libre', 0.1, 0.9, 0.05, 0.45), width: R('Épaisseur', 0.2, 4, 0.1, 1), color: C('Couleur', '#000000'), amount: R('Opacité', 0, 1, 0.05, 0.9) } },
  shake: { name: 'Tremblement caméra', desc: 'Secoue le cadre', params: { amp: R('Amplitude', 0, 80, 1, 12, 'px'), speed: R('Vitesse', 1, 4, 1, 1) } },
  fade: { name: 'Fondu', desc: 'Fondu sur la plage de frames choisie', params: { dir: O('Sens', [['in', 'Ouverture'], ['out', 'Fermeture']], 'in'), color: C('Couleur', '#000000') } },
  letterbox: { name: 'Bandes cinéma', desc: 'Bandes noires haut et bas', params: { size: R('Taille', 0, 30, 1, 10, '%') } },
};

export function newEffect(type) {
  const params = {};
  for (const [k, s] of Object.entries(FX[type].params)) params[k] = s.def;
  return { id: Math.random().toString(36).slice(2, 10), type, on: true, target: 'all', from: 0, to: 0, params };
}
export const inRange = (e, fi) => (!e.from || fi + 1 >= e.from) && (!e.to || fi + 1 <= e.to);

function rng(seed) {
  let a = (seed * 2654435761) >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function shakeOffset(e, tick) {
  const r = rng(1000 + Math.floor(tick / e.params.speed));
  return { x: (r() * 2 - 1) * e.params.amp, y: (r() * 2 - 1) * e.params.amp };
}

function copyOf(canvas, name = 'fxcopy') {
  const c = scratch(name, canvas.width, canvas.height);
  c._ctx.globalCompositeOperation = 'copy'; c._ctx.globalAlpha = 1; c._ctx.drawImage(canvas, 0, 0);
  c._ctx.globalCompositeOperation = 'source-over';
  return c;
}
function blurInto(dst, src, r, w, h) {
  if (r < 0.4) { dst.drawImage(src, 0, 0); return; }
  if (hasFilter) { dst.filter = `blur(${r}px)`; dst.drawImage(src, 0, 0); dst.filter = 'none'; return; }
  // Repli sans ctx.filter (certains Safari) : réduction puis agrandissement lissé.
  const k = Math.max(2, r / 1.2);
  const a = scratch('bl1', Math.ceil(w / k), Math.ceil(h / k)), b = scratch('bl2', Math.ceil(w / k / 2), Math.ceil(h / k / 2));
  for (const c of [a, b]) { c._ctx.imageSmoothingQuality = 'high'; c._ctx.clearRect(0, 0, c.width, c.height); }
  a._ctx.drawImage(src, 0, 0, a.width, a.height);
  b._ctx.drawImage(a, 0, 0, b.width, b.height);
  a._ctx.clearRect(0, 0, a.width, a.height); a._ctx.drawImage(b, 0, 0, a.width, a.height);
  dst.imageSmoothingQuality = 'high';
  dst.drawImage(a, 0, 0, w, h);
}
function colorMatrix(ctx, w, h, p) {
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  const br = 1 + p.bright / 100, co = 1 + p.contrast / 100, sa = 1 + p.sat / 100;
  const a = p.hue * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
  const m = [
    .213 + cs * .787 - sn * .213, .715 - cs * .715 - sn * .715, .072 - cs * .072 + sn * .928,
    .213 - cs * .213 + sn * .143, .715 + cs * .285 + sn * .140, .072 - cs * .072 - sn * .283,
    .213 - cs * .213 - sn * .787, .715 - cs * .715 + sn * .715, .072 + cs * .928 + sn * .072];
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    let r = d[i] * br, g = d[i + 1] * br, b = d[i + 2] * br;
    r = (r - 128) * co + 128; g = (g - 128) * co + 128; b = (b - 128) * co + 128;
    const l = .2126 * r + .7152 * g + .0722 * b;
    r = l + (r - l) * sa; g = l + (g - l) * sa; b = l + (b - l) * sa;
    if (p.hue) { const R2 = m[0] * r + m[1] * g + m[2] * b, G2 = m[3] * r + m[4] * g + m[5] * b, B2 = m[6] * r + m[7] * g + m[8] * b; r = R2; g = G2; b = B2; }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  ctx.putImageData(img, 0, 0);
}
let noiseTile;
function noise() {
  if (noiseTile) return noiseTile;
  const c = noiseTile = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d'), img = x.createImageData(256, 256), r = rng(7);
  for (let i = 0; i < img.data.length; i += 4) { const v = 128 + (r() + r() - 1) * 110; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
  x.putImageData(img, 0, 0);
  return c;
}

// env : s = pixels de sortie par pixel du format, tick, prog (0..1 dans la plage de l'effet)
export function applyFx(canvas, e, env) {
  const ctx = canvas._ctx || (canvas._ctx = canvas.getContext('2d'));
  const w = canvas.width, h = canvas.height, p = e.params, s = env.s;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  switch (e.type) {
    case 'blur': {
      const c = copyOf(canvas); ctx.clearRect(0, 0, w, h); blurInto(ctx, c, p.radius * s, w, h); break;
    }
    case 'glow': case 'diffusion': {
      const c = copyOf(canvas);
      if (e.type === 'glow') {
        c._ctx.globalCompositeOperation = 'multiply';
        for (let i = 0; i < p.thresh; i++) c._ctx.drawImage(c, 0, 0);
        c._ctx.globalCompositeOperation = 'destination-in'; c._ctx.drawImage(canvas, 0, 0);
        c._ctx.globalCompositeOperation = 'source-over';
      }
      const b = scratch('fxblur', w, h); b._ctx.clearRect(0, 0, w, h); blurInto(b._ctx, c, p.radius * s, w, h);
      ctx.globalCompositeOperation = e.type === 'glow' ? 'lighter' : 'screen';
      let a = p.amount;
      while (a > 0) { ctx.globalAlpha = Math.min(1, a); ctx.drawImage(b, 0, 0); a -= 1; }
      break;
    }
    case 'color': {
      if (!p.bright && !p.contrast && !p.sat && !p.hue) break;
      if (hasFilter) {
        const c = copyOf(canvas); ctx.clearRect(0, 0, w, h);
        ctx.filter = `brightness(${1 + p.bright / 100}) contrast(${1 + p.contrast / 100}) saturate(${1 + p.sat / 100}) hue-rotate(${p.hue}deg)`;
        ctx.drawImage(c, 0, 0); ctx.filter = 'none';
      } else colorMatrix(ctx, w, h, p);
      break;
    }
    case 'gradient': {
      const a = p.angle * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a), L = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
      const g = ctx.createLinearGradient(w / 2 - dx * L, h / 2 - dy * L, w / 2 + dx * L, h / 2 + dy * L);
      g.addColorStop(0, p.c1); g.addColorStop(1, p.c2);
      ctx.globalCompositeOperation = p.mode; ctx.globalAlpha = p.amount; ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); break;
    }
    case 'vignette': {
      const rad = Math.hypot(w, h) / 2;
      const g = ctx.createRadialGradient(w / 2, h / 2, rad * p.size, w / 2, h / 2, rad * 1.05);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${p.amount})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); break;
    }
    case 'grain': {
      const r = rng(env.tick + 31), k = Math.max(0.5, p.size * s);
      ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = p.amount;
      ctx.scale(k, k); ctx.translate(-r() * 256, -r() * 256);
      ctx.fillStyle = ctx.createPattern(noise(), 'repeat'); ctx.fillRect(0, 0, w / k + 256, h / k + 256); break;
    }
    case 'chroma': {
      const off = p.offset * s; if (off < 0.2) break;
      const c = copyOf(canvas), t = scratch('fxch', w, h); ctx.clearRect(0, 0, w, h);
      for (const [col, dx] of [['#ff0000', -off], ['#00ff00', 0], ['#0000ff', off]]) {
        const x = t._ctx; x.globalCompositeOperation = 'copy'; x.drawImage(c, dx, 0);
        x.globalCompositeOperation = 'multiply'; x.fillStyle = col; x.fillRect(0, 0, w, h);
        x.globalCompositeOperation = 'destination-in'; x.drawImage(c, dx, 0);
        x.globalCompositeOperation = 'source-over';
        ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(t, 0, 0);
      }
      break;
    }
    case 'speed': {
      const r = rng(Math.floor(env.tick / 2) + 99);
      ctx.fillStyle = p.color; ctx.globalAlpha = p.amount;
      if (p.mode === 'radial') {
        const cx = w / 2, cy = h / 2, rad = Math.hypot(w, h) / 2;
        for (let i = 0; i < p.count; i++) {
          const a = r() * Math.PI * 2, inner = rad * p.clear * (0.75 + r() * 0.6), half = (0.002 + r() * 0.008) * p.width;
          ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
          ctx.lineTo(cx + Math.cos(a - half) * rad * 1.1, cy + Math.sin(a - half) * rad * 1.1);
          ctx.lineTo(cx + Math.cos(a + half) * rad * 1.1, cy + Math.sin(a + half) * rad * 1.1); ctx.fill();
        }
      } else {
        for (let i = 0; i < p.count; i++) {
          const y = r() * h, len = w * (0.2 + r() * 0.7), x = r() * (w + len) - len, th = (1 + r() * 4) * p.width * s;
          if (Math.abs(y - h / 2) < h * p.clear * 0.3 * r()) continue;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y - th / 2); ctx.lineTo(x + len, y + th / 2); ctx.fill();
        }
      }
      break;
    }
    case 'fade': {
      ctx.globalAlpha = p.dir === 'in' ? 1 - env.prog : env.prog; ctx.fillStyle = p.color; ctx.fillRect(0, 0, w, h); break;
    }
    case 'letterbox': {
      const b = h * p.size / 100; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, b); ctx.fillRect(0, h - b, w, b); break;
    }
  }
  ctx.restore();
}

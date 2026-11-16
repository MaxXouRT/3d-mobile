// Extraction automatique des traits d'une image de référence.
// Entrée / sortie : tableaux RGBA. Aucune dépendance au DOM, donc testable hors navigateur.
//
// 1. Traits : un trait est une zone sombre et FINE. On compare l'image à sa « fermeture »
//    morphologique (l'image débarrassée de tout détail sombre plus fin que `thick`). L'écart est
//    ensuite rapporté au contraste local : un trait brun clair sur de la peau ressort autant qu'un
//    trait noir sur du blanc, et le bord d'un trait garde sa transparence d'origine (anti-crénelage).
// 2. Séparations de couleurs : frontières entre deux aplats sans trait (ombres, reflets), mesurées
//    en écart de couleur perçu (espace Lab) pour distinguer aussi deux teintes proches.
// 3. Finition : le masque est agrandi ×2, lissé, re-contrasté puis réduit. Les escaliers
//    disparaissent et le bord reste net.

// Filtre min/max glissant 1D (file monotone, O(n)).
function slide(src, dst, off, stride, len, r, isMax, dq) {
  let head = 0, tail = 0;
  for (let i = 0; i < len + r; i++) {
    if (i < len) {
      const v = src[off + i * stride];
      if (isMax) while (tail > head && src[off + dq[tail - 1] * stride] <= v) tail--;
      else while (tail > head && src[off + dq[tail - 1] * stride] >= v) tail--;
      dq[tail++] = i;
    }
    const o = i - r;
    if (o >= 0) { while (dq[head] < o - r) head++; dst[off + o * stride] = src[off + dq[head] * stride]; }
  }
}
function morph(src, w, h, r, isMax) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h), dq = new Int32Array(Math.max(w, h));
  for (let y = 0; y < h; y++) slide(src, tmp, y * w, 1, w, r, isMax, dq);
  for (let x = 0; x < w; x++) slide(tmp, out, x, w, h, r, isMax, dq);
  return out;
}
// Flou « boîte » en place (somme glissante, O(n) quel que soit le rayon).
function box(a, w, h, r, tmp) {
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w; let s = 0;
    for (let x = -r; x <= r; x++) s += a[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) { tmp[o + x] = s / win; s += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)]; }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) { a[y * w + x] = s / win; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
  }
}
const clamp8 = v => v < 0 ? 0 : v > 255 ? 255 : v;

function luminance(d, n) {
  const lum = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = d[j + 3] / 255;
    lum[i] = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) * a + 255 * (1 - a);
  }
  return lum;
}

// ---------- 1. Traits ----------
function lineMask(lum, w, h, o) {
  const n = w * h, alpha = new Uint8ClampedArray(n);
  const sens = Math.min(100, Math.max(0, o.sens ?? 60)), r = Math.max(1, Math.round(o.thick ?? 6));
  const closed = morph(morph(lum, w, h, r, true), w, h, r, false);
  const hi = morph(lum, w, h, r + 1, true), lo = morph(lum, w, h, r + 1, false), near = morph(lum, w, h, Math.max(2, Math.round(r / 2)), true);
  // contraste minimal pour qu'un détail compte comme un trait
  const floor = 112 - sens * 0.97;
  for (let i = 0; i < n; i++) {
    const l = lum[i], range = Math.max(hi[i] - lo[i], floor);
    let a = ((closed[i] - l) / range - 0.26) / 0.46;
    // Bord d'un aplat sombre (cheveux noirs…) : ce n'est pas un trait fin, mais son contour en est un.
    if (l < 115) { const e = ((near[i] - l) / range - 0.4) / 0.25; if (e > a) a = e; }
    alpha[i] = a * 255;
  }
  if (o.mode === 'dark') {
    // Ajoute les aplats noirs pleins, comme dans le dessin d'origine.
    const Td = (o.dark ?? 40) * 2.2, soft = 14;
    for (let i = 0; i < n; i++) { const a = (Td - lum[i]) / soft * 255; if (a > alpha[i]) alpha[i] = a; }
  }
  return alpha;
}

// ---------- 2. Séparations de couleurs ----------
let labLut;
function toLab(d, n) {
  if (!labLut) { labLut = new Float32Array(256); for (let i = 0; i < 256; i++) { const c = i / 255; labLut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); } }
  const L = new Uint8ClampedArray(n), A = new Uint8ClampedArray(n), B = new Uint8ClampedArray(n);
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const al = d[j + 3] / 255, k = 1 - al;
    const r = labLut[Math.round(d[j] * al + 255 * k)], g = labLut[Math.round(d[j + 1] * al + 255 * k)], b = labLut[Math.round(d[j + 2] * al + 255 * k)];
    const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b), fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    L[i] = (116 * fy - 16) * 2.55; A[i] = 128 + 500 * (fx - fy) * 1.6; B[i] = 128 + 200 * (fy - fz) * 1.6;
  }
  return [L, A, B];
}
function colorEdges(d, w, h, sens, exclude) {
  const n = w * h, lab = toLab(d, n), tmp = new Float32Array(n);
  for (const c of lab) box(c, w, h, 1, tmp); // gomme le bruit de compression
  const [L, A, B] = lab, g = new Float32Array(n), dir = new Uint8Array(n);
  // écart mesuré à 2 pixels de part et d'autre : on capte toute la marche entre deux aplats
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x, w2 = 2 * w;
    const hx = Math.hypot(L[i + 2] - L[i - 2], A[i + 2] - A[i - 2], B[i + 2] - B[i - 2]);
    const vy = Math.hypot(L[i + w2] - L[i - w2], A[i + w2] - A[i - w2], B[i + w2] - B[i - w2]);
    g[i] = Math.max(hx, vy); dir[i] = hx >= vy ? 1 : 0;
  }
  box(g, w, h, 1, tmp); // un seul sommet par frontière (sinon la ligne se dédouble)
  const T = 34 - Math.min(100, Math.max(0, sens)) * 0.3, alpha = new Uint8ClampedArray(n);
  for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) {
    const i = y * w + x, v = g[i];
    if (v < T || (exclude && exclude[i] > 40)) continue;
    // le bord de l'image importée n'est pas une frontière de couleur
    if (d[(i - 3) * 4 + 3] < 128 || d[(i + 3) * 4 + 3] < 128 || d[(i - 3 * w) * 4 + 3] < 128 || d[(i + 3 * w) * 4 + 3] < 128) continue;
    // on ne garde que la crête : la frontière exacte entre les deux couleurs
    const s = dir[i] ? 1 : w;
    if (v < g[i - s] || v <= g[i + s]) continue;
    alpha[i] = 255; if (!alpha[i - s]) alpha[i - s] = 150;
  }
  return alpha;
}

// ---------- Nettoyage : supprime les îlots de moins de `clean` pixels ----------
function cleanMask(alpha, w, h, clean) {
  clean = Math.round(clean); if (!(clean > 1)) return;
  const n = w * h, seen = new Uint8Array(n), stack = new Int32Array(n), comp = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || alpha[s] < 48) continue;
    let sp = 0, big = false; stack[sp++] = s; seen[s] = 1; comp.length = 0;
    while (sp) {
      const i = stack[--sp];
      if (!big) { comp.push(i); if (comp.length >= clean) big = true; }
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!seen[j] && alpha[j] >= 48) { seen[j] = 1; stack[sp++] = j; }
      }
    }
    if (!big) for (const i of comp) alpha[i] = 0;
  }
  for (let i = 0; i < n; i++) if (alpha[i] < 48 && alpha[i] > 0) {
    const x = i % w, y = (i / w) | 0; let ok = false;
    for (let dy = -1; dy <= 1 && !ok; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && alpha[ny * w + nx] >= 48) { ok = true; break; }
    }
    if (!ok) alpha[i] = 0;
  }
}

// ---------- 3. Finition « comme dessiné » ----------
// smooth 0..100 ; weight -50..50 (positif = trait plus gras)
function finish(alpha, w, h, smooth, weight = 0) {
  const r = Math.round(Math.min(100, Math.max(0, smooth)) / 100 * 3 + 0.2);
  if (r < 1) return alpha;
  const W = w * 2, H = h * 2, up = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.max(0, (y + 0.5) / 2 - 0.5), y0 = sy | 0, y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.max(0, (x + 0.5) / 2 - 0.5), x0 = sx | 0, x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
      const a = alpha[y0 * w + x0], b = alpha[y0 * w + x1], c = alpha[y1 * w + x0], d = alpha[y1 * w + x1];
      // léger renfort : un trait d'un pixel doit survivre au flou sans se couper en pointillés
      up[y * W + x] = Math.min(255, ((a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy) * 1.3);
    }
  }
  const tmp = new Float32Array(W * H);
  box(up, W, H, r, tmp); box(up, W, H, r, tmp);
  const cut = 104 - r * 9 - weight * 0.9, gain = 2.2 + r * 0.8, out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 2 * y * W + 2 * x;
    out[y * w + x] = (clamp8((up[i] - cut) * gain + 127) + clamp8((up[i + 1] - cut) * gain + 127) + clamp8((up[i + W] - cut) * gain + 127) + clamp8((up[i + W + 1] - cut) * gain + 127)) / 4;
  }
  return out;
}

function paint(alpha, d, w, h, color, lum) {
  const n = w * h, out = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = alpha[i]; if (!a) continue;
    if (lum) {
      // couleur d'origine : celle du pixel le plus sombre à proximité (le cœur du trait, pas son bord)
      const x = i % w, y = (i / w) | 0; let best = i, bl = lum[i];
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = ny * w + nx; if (lum[k] < bl) { bl = lum[k]; best = k; }
      }
      out[j] = d[best * 4]; out[j + 1] = d[best * 4 + 1]; out[j + 2] = d[best * 4 + 2];
    } else { out[j] = color[0]; out[j + 1] = color[1]; out[j + 2] = color[2]; }
    out[j + 3] = a;
  }
  return out;
}

/**
 * @param {{data:Uint8ClampedArray,width:number,height:number}} img
 * @param {object} o  mode 'lines' | 'dark' | 'edges' ; sens 0..100 ; thick (px) ; dark 0..100 ; clean (px) ;
 *                    smooth 0..100 ; weight -50..50 ; keepColor ; color [r,g,b] ;
 *                    seps (ajouter les séparations de couleurs) ; sepSens 0..100 ; sepColor [r,g,b]
 * @returns {{lines:Uint8ClampedArray, seps:Uint8ClampedArray|null}} RGBA sur fond transparent
 */
export function extract(img, o) {
  const { data: d, width: w, height: h } = img, n = w * h;
  const smooth = o.smooth ?? 40, col = o.color || [0, 0, 0];
  if (o.mode === 'edges') {
    let a = colorEdges(d, w, h, o.sens ?? 60, null);
    cleanMask(a, w, h, o.clean ?? 0); a = finish(a, w, h, Math.max(smooth, 34), o.weight);
    return { lines: paint(a, d, w, h, col, null), seps: null };
  }
  const lum = luminance(d, n);
  let a = lineMask(lum, w, h, o);
  cleanMask(a, w, h, o.clean ?? 0);
  let seps = null;
  if (o.seps) {
    let s = colorEdges(d, w, h, o.sepSens ?? 65, morph(a, w, h, 3, true));
    cleanMask(s, w, h, Math.max(o.clean ?? 0, 6)); s = finish(s, w, h, Math.max(smooth, 34), -8);
    seps = paint(s, d, w, h, o.sepColor || [229, 72, 77], null);
  }
  a = finish(a, w, h, smooth, o.weight);
  return { lines: paint(a, d, w, h, col, o.keepColor ? lum : null), seps };
}
export const extractLines = (img, o) => extract(img, o).lines;

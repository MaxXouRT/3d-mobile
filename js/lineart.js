// Extraction automatique des traits d'une image de référence (au pixel près).
// Entrée / sortie : tableaux RGBA. Aucune dépendance au DOM, donc testable hors navigateur.
//
// Principe du mode « traits » : un trait est une zone sombre et FINE. On calcule une « fermeture »
// morphologique de la luminance (ce que serait l'image si l'on effaçait tout détail sombre plus fin
// que `thick`), puis on la compare à l'image : la différence ne ressort que sur les traits, pas sur
// les grands aplats sombres ni sur les dégradés.

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

/**
 * @param {{data:Uint8ClampedArray,width:number,height:number}} img
 * @param {object} o  mode: 'lines' | 'dark' | 'edges' ; sens 0..100 ; thick (px) ; dark 0..100 ;
 *                    clean (taille mini d'un îlot, px) ; keepColor ; color [r,g,b]
 * @returns {Uint8ClampedArray} RGBA : traits sur fond transparent
 */
export function extractLines(img, o) {
  const { data: d, width: w, height: h } = img, n = w * h;
  const lum = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = d[j + 3] / 255;
    lum[i] = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) * a + 255 * (1 - a);
  }
  const alpha = new Uint8ClampedArray(n);
  const sens = Math.min(100, Math.max(0, o.sens ?? 60));

  if (o.mode === 'edges') {
    // Frontières entre zones de couleur (Sobel sur chaque canal, on garde le plus fort).
    const T = 220 - sens * 2, t0 = T * 0.6, t1 = T * 1.3;
    const px = (x, y, c) => { const j = (y * w + x) * 4, a = d[j + 3] / 255; return d[j + c] * a + 255 * (1 - a); };
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      let m = 0;
      for (let c = 0; c < 3; c++) {
        const gx = px(x + 1, y - 1, c) + 2 * px(x + 1, y, c) + px(x + 1, y + 1, c) - px(x - 1, y - 1, c) - 2 * px(x - 1, y, c) - px(x - 1, y + 1, c);
        const gy = px(x - 1, y + 1, c) + 2 * px(x, y + 1, c) + px(x + 1, y + 1, c) - px(x - 1, y - 1, c) - 2 * px(x, y - 1, c) - px(x + 1, y - 1, c);
        const g = Math.abs(gx) + Math.abs(gy); if (g > m) m = g;
      }
      alpha[y * w + x] = (m / 2 - t0) / (t1 - t0) * 255;
    }
  } else {
    const r = Math.max(1, Math.round(o.thick ?? 6));
    const closed = morph(morph(lum, w, h, r, true), w, h, r, false);
    const T = 130 - sens * 1.18, t0 = T * 0.55, t1 = T * 1.25;
    for (let i = 0; i < n; i++) alpha[i] = (closed[i] - lum[i] - t0) / (t1 - t0) * 255;
    // Un aplat sombre (cheveux noirs…) n'est pas un trait, mais son bord en est un : on garde
    // un liseré de 2 px là où une zone sombre touche une zone nettement plus claire.
    const near = morph(lum, w, h, 2, true);
    for (let i = 0; i < n; i++) {
      if (lum[i] > 110) continue;
      const a = (near[i] - lum[i] - t0 * 1.6) / (t1 - t0) * 255; if (a > alpha[i]) alpha[i] = a;
    }
    if (o.mode === 'dark') {
      // Ajoute les aplats noirs (cheveux, ombres pleines…) comme dans le dessin d'origine.
      const Td = (o.dark ?? 40) * 1.6, soft = 28;
      for (let i = 0; i < n; i++) { const a = (Td - lum[i]) / soft * 255; if (a > alpha[i]) alpha[i] = a; }
    }
  }

  // Nettoyage : supprime les îlots de moins de `clean` pixels (poussières, bruit de compression).
  const clean = Math.round(o.clean ?? 0);
  if (clean > 1) {
    const seen = new Uint8Array(n), stack = new Int32Array(n), comp = [];
    for (let s = 0; s < n; s++) {
      if (seen[s] || alpha[s] < 48) continue;
      let sp = 0; stack[sp++] = s; seen[s] = 1; comp.length = 0;
      let big = false;
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
    // Les pixels faibles isolés (non rattachés à un îlot conservé) disparaissent aussi.
    for (let i = 0; i < n; i++) if (alpha[i] < 48 && alpha[i] > 0) {
      const x = i % w, y = (i / w) | 0; let ok = false;
      for (let dy = -1; dy <= 1 && !ok; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && alpha[ny * w + nx] >= 48) { ok = true; break; }
      }
      if (!ok) alpha[i] = 0;
    }
  }

  const out = new Uint8ClampedArray(n * 4), col = o.color || [0, 0, 0];
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = alpha[i]; if (!a) continue;
    if (o.keepColor) { out[j] = d[j]; out[j + 1] = d[j + 1]; out[j + 2] = d[j + 2]; }
    else { out[j] = col[0]; out[j + 1] = col[1]; out[j + 2] = col[2]; }
    out[j + 3] = a;
  }
  return out;
}

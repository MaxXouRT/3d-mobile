// Panneaux coulissants de l'éditeur : calques, effets, couleur, outil, animation, frame, menu, export, traits.
import { S, emit, saveToolPrefs } from './state.js';
import { h, icon, ibtn, toast, sheet, slider, segmented, toggle, confirmDlg, promptDlg, busy, nextPaint } from './ui.js';
import * as tools from './tools.js';
import { FX, newEffect, scratch } from './effects.js';
import { totalTicks, tickOfFrame } from './render.js';
import { extractLines } from './lineart.js';
import * as io from './io.js';

const pct = v => Math.round(v * 100) + '%';
const BLENDS = [['source-over', 'Normal'], ['multiply', 'Produit'], ['screen', 'Écran'], ['overlay', 'Incrustation'], ['lighter', 'Addition'], ['soft-light', 'Lumière douce'], ['darken', 'Obscurcir'], ['lighten', 'Éclaircir']];
const select = (opts, value, onchange) => h('select', { class: 'input', onchange: e => onchange(e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
const item = (ic, label, onclick, cls = '') => h('button', { class: 'item ' + cls, onclick, html: icon(ic) + `<span>${label}</span>` });

// ---------- Calques ----------
export function layersSheet(api) {
  const p = api.p;
  tools.commitXform();
  const s = sheet({ title: 'Calques', actions: [ibtn('image', 'Importer une image', () => { s.close(); pickFiles('image/*', true, f => io.importImages(f)); }), ibtn('plus', 'Nouveau calque', add, 'accent')] });
  function add() {
    const l = p.makeLayer('Calque ' + (p.layers.length + 1)), i = p.layers.findIndex(x => x.id === S.layerId);
    p.layers.splice(i + 1, 0, l); S.layerId = l.id; p.touch(); emit('layers'); draw();
  }
  async function allFrames(msg, fn) {
    const b = busy(msg);
    try { for (let i = 0; i < p.frames.length; i++) { await fn(p.frames[i], i); b.update(null, (i + 1) / p.frames.length); } }
    finally { b.close(); }
    await api.gotoFrame(S.frameIdx); api.restyle();
  }
  async function dup(l) {
    const n = { ...p.makeLayer(l.name + ' copie'), opacity: l.opacity, blend: l.blend, fixed: l.fixed };
    if (l.fixed) { const c = await p.cloneCel(p.cels.get(l.cel)); n.cel = c?.id || null; }
    p.layers.splice(p.layers.indexOf(l) + 1, 0, n);
    if (!l.fixed) await allFrames('Duplication du calque…', async f => { const c = await p.cloneCel(p.celOf(l, f)); if (c) f.cels[n.id] = c.id; });
    else { await api.gotoFrame(S.frameIdx); api.restyle(); }
    S.layerId = n.id; emit('layers'); draw();
  }
  async function del(l) {
    if (p.layers.length <= 1) { toast('Il faut au moins un calque'); return; }
    if (!await confirmDlg(`Supprimer « ${l.name} » sur tous les frames ?`, 'Supprimer', true)) return;
    if (l.fixed && l.cel) p.dropCel(l.cel);
    for (const f of p.frames) if (f.cels[l.id]) { p.dropCel(f.cels[l.id]); delete f.cels[l.id]; }
    p.effects = p.effects.filter(e => e.target !== l.id);
    const i = p.layers.indexOf(l); p.layers.splice(i, 1);
    S.layerId = p.layers[Math.max(0, i - 1)].id; emit('layers'); api.restyle(); draw();
  }
  async function merge(l) {
    const i = p.layers.indexOf(l), under = p.layers[i - 1];
    if (!under) { toast('Aucun calque en dessous'); return; }
    if (l.fixed || under.fixed) { toast('Détachez d’abord les calques fixes'); return; }
    await allFrames('Fusion…', async (f, fi) => {
      if (!f.cels[l.id]) return;
      await p.loadFrame(fi);
      const up = p.celOf(l, f), lo = p.celFor(under, f), c = lo.canvas._ctx;
      c.save(); c.globalAlpha = l.opacity; c.globalCompositeOperation = l.blend; c.drawImage(up.canvas, 0, 0); c.restore();
      p.markDirty(lo, f); p.dropCel(up.id); delete f.cels[l.id];
    });
    p.layers.splice(i, 1); S.layerId = under.id; tools.clearUndo(); emit('layers'); emit('undo'); api.restyle(); draw();
  }
  async function toggleFixed(l) {
    const f = p.frames[S.frameIdx];
    if (!l.fixed) {
      const others = p.frames.filter(x => x !== f && x.cels[l.id]).length;
      if (others && !await confirmDlg(`Rendre ce calque fixe garde le dessin du frame ${S.frameIdx + 1} et efface celui des ${others} autres frames. Continuer ?`, 'Rendre fixe', true)) return;
      l.cel = f.cels[l.id] || null;
      for (const x of p.frames) { if (x !== f && x.cels[l.id]) p.dropCel(x.cels[l.id]); delete x.cels[l.id]; }
      l.fixed = true;
    } else { if (l.cel) f.cels[l.id] = l.cel; l.cel = null; l.fixed = false; toast('Le dessin reste sur le frame ' + (S.frameIdx + 1)); }
    tools.clearUndo(); emit('undo'); await api.gotoFrame(S.frameIdx); api.restyle(); draw();
  }
  function move(l, d) {
    const i = p.layers.indexOf(l), j = i + d; if (j < 0 || j >= p.layers.length) return;
    p.layers.splice(i, 1); p.layers.splice(j, 0, l); api.restyle(); draw();
  }
  function draw() {
    s.set([...p.layers].reverse().map(l => {
      const sel = l.id === S.layerId;
      const row = h('div', { class: 'layer' + (sel ? ' sel' : '') },
        h('div', { class: 'layer-head', onclick: e => { if (e.target.closest('.ibtn')) return; tools.commitXform(); S.layerId = l.id; emit('layers'); draw(); } },
          ibtn(l.visible ? 'eye' : 'eyeoff', l.visible ? 'Masquer' : 'Afficher', () => { l.visible = !l.visible; api.restyle(); draw(); }, l.visible ? '' : 'dim'),
          h('div', { class: 'layer-name' }, l.name, h('small', {}, [pct(l.opacity), l.fixed && 'fixe', l.locked && 'verrouillé', l.blend !== 'source-over' && BLENDS.find(b => b[0] === l.blend)[1]].filter(Boolean).join(' · '))),
          ibtn(l.locked ? 'lock' : 'unlock', l.locked ? 'Déverrouiller' : 'Verrouiller', () => { l.locked = !l.locked; p.touch(); draw(); }, l.locked ? 'accent' : 'dim')));
      if (sel) row.append(h('div', { class: 'layer-body' },
        slider({ label: 'Opacité', min: 0, max: 1, step: 0.01, value: l.opacity, fmt: pct, oninput: v => { l.opacity = v; api.render(); }, onchange: () => { api.restyle(); } }),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Fusion'), select(BLENDS, l.blend, v => { l.blend = v; api.restyle(); draw(); })),
        h('button', { class: 'btn primary wide', onclick: () => { s.close(); lineartSheet(api, l); }, html: icon('wand', 20) + '<span>Extraire les traits de ce calque</span>' }),
        h('div', { class: 'grid4' },
          item('edit', 'Renommer', async () => { const n = await promptDlg('Nom du calque', l.name); if (n) { l.name = n; p.touch(); draw(); } }),
          item('copy', 'Dupliquer', () => dup(l)),
          item('up', 'Monter', () => move(l, 1)),
          item('down', 'Descendre', () => move(l, -1)),
          item('merge', 'Fusionner ↓', () => merge(l)),
          item('pin', l.fixed ? 'Détacher' : 'Fixe (décor)', () => toggleFixed(l), l.fixed ? 'on' : ''),
          item('eraser', 'Vider', () => { api.clearCel(); }),
          item('trash', 'Supprimer', () => del(l), 'danger'))));
      return row;
    }));
  }
  draw();
}

// ---------- Effets ----------
let fxSheetOpen = false;
export const fxOpen = () => fxSheetOpen;
export function fxSheet(api) {
  const p = api.p;
  tools.commitXform(); api.stop();
  fxSheetOpen = true; S.preview = true; S.tick = tickOfFrame(p, S.frameIdx);
  const changed = e => {
    if (e.target !== 'all' || e._wasLayer) { p.staleAll(); e._wasLayer = undefined; }
    if (S.ready) p.refreshPreview(p.frames[S.frameIdx]);
    p.touch(); api.render();
  };
  const s = sheet({
    title: 'Effets', actions: [ibtn('plus', 'Ajouter un effet', pick, 'accent')],
    onClose: () => { fxSheetOpen = false; S.preview = S.playing; api.render(); api.drawThumb(S.frameIdx); api.pump(); },
  });
  function pick() {
    const ps = sheet({
      title: 'Ajouter un effet', modal: true,
      content: h('div', { class: 'list' }, Object.entries(FX).map(([type, d]) =>
        h('button', { class: 'item big', onclick: () => { const e = newEffect(type); p.effects.push(e); ps.close(); changed(e); draw(e.id); } },
          h('span', {}, h('b', {}, d.name), h('small', {}, d.desc))))),
    });
  }
  function draw(openId) {
    if (!p.effects.length) { s.set(h('p', { class: 'hint' }, 'Aucun effet. Ajoutez une lueur, du grain, des lignes de vitesse… L’aperçu au-dessus montre le rendu final à travers la caméra.')); return; }
    s.set(p.effects.map((e, i) => {
      const d = FX[e.type];
      const body = h('div', { class: 'fx-body' });
      if (d.layer) body.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Appliquer à'),
        select([['all', 'Image entière'], ...p.layers.map(l => [l.id, 'Calque : ' + l.name])], e.target, v => { e._wasLayer = true; e.target = v; changed(e); })));
      for (const [k, sp] of Object.entries(d.params)) {
        if (sp.type === 'range') body.append(slider({ label: sp.label, min: sp.min, max: sp.max, step: sp.step, value: e.params[k], fmt: v => (+v.toFixed(2)) + (sp.unit || ''), oninput: v => { e.params[k] = v; changed(e); } }));
        else if (sp.type === 'color') body.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, sp.label), h('input', { type: 'color', value: e.params[k], oninput: ev => { e.params[k] = ev.target.value; changed(e); } })));
        else body.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, sp.label), select(sp.opts, e.params[k], v => { e.params[k] = v; changed(e); })));
      }
      const num = (key, ph) => h('input', { class: 'input num', type: 'number', min: 1, max: p.frames.length, placeholder: ph, value: e[key] || '', onchange: ev => { e[key] = Math.max(0, parseInt(ev.target.value) || 0); changed(e); } });
      body.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Du frame'), num('from', 'début'), h('span', { class: 'lbl' }, 'au'), num('to', 'fin')),
        h('div', { class: 'row end' },
          i > 0 && h('button', { class: 'btn small', onclick: () => { p.effects.splice(i, 1); p.effects.splice(i - 1, 0, e); changed(e); draw(e.id); } }, 'Avant'),
          h('button', { class: 'btn small danger', onclick: () => { p.effects.splice(i, 1); e._wasLayer = true; changed(e); draw(); } }, 'Supprimer')));
      const det = h('details', { class: 'fx', open: e.id === openId },
        h('summary', {}, h('input', { type: 'checkbox', checked: e.on, 'aria-label': 'Activer', onclick: ev => ev.stopPropagation(), onchange: ev => { e.on = ev.target.checked; e._wasLayer = true; changed(e); } }),
          h('span', {}, d.name), h('small', {}, e.target === 'all' ? '' : (p.layer(e.target)?.name || ''))), body);
      return det;
    }));
  }
  draw();
  api.render();
}

// ---------- Couleur ----------
function hexToHsv(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let hh = 0;
  if (d) hh = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: hh * 60, s: mx ? d / mx : 0, v: mx };
}
function hsvToHex({ h: hh, s, v }) {
  const f = n => { const k = (n + hh / 60) % 6; return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255).toString(16).padStart(2, '0'); };
  return '#' + f(5) + f(3) + f(1);
}
const PALETTE = ['#000000', '#3a3a3a', '#8a8a8a', '#ffffff', '#f6d7c3', '#e8b796', '#b9805a', '#6b4630', '#e5484d', '#f28c28', '#f5c542', '#7bc950', '#22a06b', '#35b8c9', '#3b82f6', '#4f46b8', '#8e4ec6', '#e254a0', '#ffd1dc', '#1b2a49'];
export function colorSheet(api) {
  let hsv = hexToHsv(S.color);
  const sv = h('canvas', { class: 'svpick', width: 300, height: 170 });
  const hue = h('input', { type: 'range', class: 'hue', min: 0, max: 360, step: 1, value: hsv.h, 'aria-label': 'Teinte' });
  const hex = h('input', { class: 'input num', type: 'text', value: S.color, maxLength: 7, 'aria-label': 'Code couleur' });
  const cur = h('div', { class: 'colordot big' });
  const recent = h('div', { class: 'swatches' });
  const paint = () => {
    const x = sv.getContext('2d'), w = sv.width, hh = sv.height;
    x.fillStyle = `hsl(${hsv.h},100%,50%)`; x.fillRect(0, 0, w, hh);
    let g = x.createLinearGradient(0, 0, w, 0); g.addColorStop(0, '#fff'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, w, hh);
    g = x.createLinearGradient(0, 0, 0, hh); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, '#000'); x.fillStyle = g; x.fillRect(0, 0, w, hh);
    x.beginPath(); x.arc(hsv.s * w, (1 - hsv.v) * hh, 8, 0, 7); x.lineWidth = 3; x.strokeStyle = '#fff'; x.stroke(); x.lineWidth = 1; x.strokeStyle = '#000'; x.stroke();
    cur.style.background = S.color;
  };
  const apply = (remember) => { tools.setColor(hsvToHex(hsv), remember); hex.value = S.color; paint(); };
  const sw = c => h('button', { class: 'swatch', style: { background: c }, 'aria-label': c, onclick: () => { tools.setColor(c); hsv = hexToHsv(c); hue.value = hsv.h; hex.value = c; paint(); swatches(); } });
  const swatches = () => recent.replaceChildren(...S.recent.map(sw));
  const drag = e => { const r = sv.getBoundingClientRect(); hsv.s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); hsv.v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)); apply(false); };
  sv.addEventListener('pointerdown', e => { sv.setPointerCapture(e.pointerId); drag(e); });
  sv.addEventListener('pointermove', e => { if (e.buttons || e.pointerType === 'touch') drag(e); });
  sv.addEventListener('pointerup', () => { tools.pushRecent(); swatches(); });
  hue.addEventListener('input', () => { hsv.h = +hue.value; apply(false); });
  hue.addEventListener('change', () => { tools.pushRecent(); swatches(); });
  hex.addEventListener('change', () => { let v = hex.value.trim(); if (!v.startsWith('#')) v = '#' + v; if (/^#[0-9a-f]{6}$/i.test(v)) { tools.setColor(v); hsv = hexToHsv(v); hue.value = hsv.h; paint(); swatches(); } else hex.value = S.color; });
  sheet({
    title: 'Couleur',
    content: [sv, hue, h('div', { class: 'row' }, cur, hex, h('button', { class: 'btn', onclick: () => { api.setTool('pipette'); toast('Touchez le dessin pour prendre une couleur'); }, html: icon('pipette', 18) + '<span>Pipette</span>' })),
      h('div', { class: 'lbl' }, 'Récentes'), recent, h('div', { class: 'lbl' }, 'Palette'), h('div', { class: 'swatches' }, PALETTE.map(sw))],
  });
  paint(); swatches();
}

// ---------- Réglages de l'outil ----------
export function toolSheet(api) {
  const t = S.tools, save = () => { saveToolPrefs(); api.optbar(); };
  const c = [];
  let title = 'Outil';
  if (S.tool === 'brush') {
    title = 'Pinceau';
    const list = h('div', { class: 'list' });
    const draw = () => list.replaceChildren(...Object.entries(tools.BRUSHES).map(([k, b]) =>
      h('button', { class: 'item big' + (t.brush.type === k ? ' on' : ''), onclick: () => { t.brush.type = k; save(); draw(); } }, h('span', {}, h('b', {}, b.name), h('small', {}, b.desc)))));
    draw();
    c.push(list,
      slider({ label: 'Taille', min: 1, max: 300, step: 1, curve: 2.2, value: t.brush.size, fmt: v => v + ' px', oninput: v => { t.brush.size = v; api.hintSize(v); }, onchange: save }),
      slider({ label: 'Opacité', min: 0.05, max: 1, step: 0.01, value: t.brush.opacity, fmt: pct, oninput: v => t.brush.opacity = v, onchange: save }),
      slider({ label: 'Stabilisateur', min: 0, max: 1, step: 0.05, value: t.brush.smooth, fmt: pct, oninput: v => t.brush.smooth = v, onchange: save }),
      h('p', { class: 'hint' }, 'Le stabilisateur lisse les tremblements du doigt. Avec un stylet, la pression fait varier l’épaisseur.'));
  } else if (S.tool === 'eraser') {
    title = 'Gomme';
    c.push(slider({ label: 'Taille', min: 1, max: 400, step: 1, curve: 2.2, value: t.eraser.size, fmt: v => v + ' px', oninput: v => { t.eraser.size = v; api.hintSize(v); }, onchange: save }),
      slider({ label: 'Force', min: 0.05, max: 1, step: 0.01, value: t.eraser.opacity, fmt: pct, oninput: v => t.eraser.opacity = v, onchange: save }),
      toggle('Bords doux', t.eraser.soft, v => { t.eraser.soft = v; save(); }));
  } else if (S.tool === 'fill') {
    title = 'Remplissage';
    c.push(slider({ label: 'Tolérance', min: 0, max: 200, step: 1, value: t.fill.tol, oninput: v => t.fill.tol = v, onchange: save }),
      slider({ label: 'Débord sous les traits', min: 0, max: 6, step: 1, value: t.fill.expand, fmt: v => v + ' px', oninput: v => t.fill.expand = v, onchange: save }),
      toggle('Tenir compte de tous les calques', t.fill.all, v => { t.fill.all = v; save(); }),
      h('p', { class: 'hint' }, 'Pour coloriser : créez un calque sous celui des traits, puis touchez chaque zone. Les traits des autres calques servent de limites.'));
  } else if (S.tool === 'shape') {
    title = 'Formes';
    c.push(segmented([['line', 'Ligne'], ['rect', 'Rectangle'], ['ellipse', 'Ovale']], t.shape.kind, v => { t.shape.kind = v; save(); }),
      slider({ label: 'Épaisseur', min: 1, max: 120, step: 1, curve: 2, value: t.shape.size, fmt: v => v + ' px', oninput: v => t.shape.size = v, onchange: save }),
      slider({ label: 'Opacité', min: 0.05, max: 1, step: 0.01, value: t.shape.opacity, fmt: pct, oninput: v => t.shape.opacity = v, onchange: save }),
      toggle('Forme pleine', t.shape.fill, v => { t.shape.fill = v; save(); }));
  } else if (S.tool === 'move') {
    title = 'Déplacer';
    c.push(h('p', { class: 'hint' }, 'Glissez pour déplacer le dessin du calque sur ce frame. Les curseurs changent sa taille et sa rotation. Validez avec ✓.'));
  } else if (S.tool === 'camera') {
    title = 'Caméra';
    const p = api.p;
    c.push(h('p', { class: 'hint' }, 'Le cadre orange est ce qui sera exporté. Glissez-le, zoomez ou tournez-le : une clé ◆ est posée sur le frame. Entre deux clés, la caméra se déplace toute seule.'),
      toggle('Mouvement adouci (départ et arrivée en douceur)', p.camEase, v => { p.camEase = v; p.touch(); }),
      h('button', { class: 'btn danger', onclick: async () => { if (await confirmDlg('Supprimer toutes les clés caméra ?', 'Supprimer', true)) { p.frames.forEach(f => f.cam = null); p.touch(); api.buildTimeline(); api.optbar(); api.render(); } } }, 'Supprimer toutes les clés'));
  } else { title = 'Pipette'; c.push(h('p', { class: 'hint' }, 'Touchez le dessin pour reprendre sa couleur.')); }
  sheet({ title, content: c });
}

// ---------- Animation (i/s, pelure d'oignon…) ----------
export function animSheet(api) {
  const p = api.p, o = p.onion, ch = () => { p.touch(); api.updateTop(); api.render(); };
  const fps = slider({ label: 'Images / s', min: 1, max: 60, step: 1, value: p.fps, oninput: v => { p.fps = v; ch(); } });
  sheet({
    title: 'Animation',
    content: [fps,
      h('div', { class: 'seg' }, [8, 12, 15, 24, 30].map(v => h('button', { onclick: () => { p.fps = v; fps.set(v); ch(); } }, v))),
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Durée de tous les frames'),
        h('div', { class: 'seg small' }, [1, 2, 3, 4].map(n => h('button', { onclick: () => { p.frames.forEach(f => f.hold = n); p.touch(); api.buildTimeline(); toast(`Chaque dessin dure ${n} image${n > 1 ? 's' : ''}`); } }, '×' + n)))),
      toggle('Lecture en boucle', p.loop, v => { p.loop = v; p.touch(); }),
      h('h3', {}, 'Pelure d’oignon'),
      toggle('Afficher les frames voisins', o.on, v => { o.on = v; ch(); }),
      slider({ label: 'Précédents (rouge)', min: 0, max: 4, step: 1, value: o.prev, oninput: v => { o.prev = v; ch(); } }),
      slider({ label: 'Suivants (vert)', min: 0, max: 4, step: 1, value: o.next, oninput: v => { o.next = v; ch(); } }),
      slider({ label: 'Opacité', min: 0.05, max: 0.9, step: 0.05, value: o.opacity, fmt: pct, oninput: v => { o.opacity = v; ch(); } })],
  });
}

// ---------- Frame ----------
export function frameSheet(api) {
  const p = api.p, f = p.frames[S.frameIdx];
  const lab = h('b', {}, f.hold);
  const s = sheet({
    title: `Frame ${S.frameIdx + 1}`,
    content: [
      h('div', { class: 'row' }, h('span', { class: 'lbl grow' }, 'Durée (en images)'),
        ibtn('down', 'Moins', () => { api.setHold(f.hold - 1); lab.textContent = f.hold; }), lab, ibtn('up', 'Plus', () => { api.setHold(f.hold + 1); lab.textContent = f.hold; })),
      h('div', { class: 'grid4' },
        item('copy', 'Dupliquer', () => { s.close(); api.duplicateFrame(); }),
        item('plus', 'Frame vide', () => { s.close(); api.addFrame(); }),
        item('left', 'Reculer', () => { s.close(); api.moveFrame(-1); }),
        item('right', 'Avancer', () => { s.close(); api.moveFrame(1); }),
        item('eraser', 'Vider le calque', () => { s.close(); api.clearCel(); }),
        item('trash', 'Supprimer', async () => { s.close(); if (await confirmDlg(`Supprimer le frame ${S.frameIdx + 1} ?`, 'Supprimer', true)) api.deleteFrame(); }, 'danger'))],
  });
}

// ---------- Menu ----------
function pickFiles(accept, multiple, cb) {
  const inp = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
  inp.addEventListener('change', () => { if (inp.files.length) cb(inp.files); inp.remove(); });
  document.body.append(inp); inp.click();
}
export function menuSheet(api) {
  const p = api.p;
  tools.commitXform();
  const s = sheet({
    title: p.name,
    content: h('div', { class: 'list' },
      item('image', 'Importer une image (ou plusieurs : séquence)', () => { s.close(); pickFiles('image/*', true, f => io.importImages(f)); }),
      item('video', 'Importer une vidéo image par image', () => { s.close(); pickFiles('video/*', false, f => io.importVideo(f[0])); }),
      item('export', 'Exporter / enregistrer dans la galerie', () => { s.close(); exportSheet(api); }),
      item('fit', 'Recentrer la vue', () => { s.close(); api.fitView(); }),
      item('settings', 'Réglages du projet', () => { s.close(); projectSheet(api); }),
      item('edit', 'Aide : les gestes', () => { s.close(); helpSheet(); })),
  });
}
function projectSheet(api) {
  const p = api.p;
  sheet({
    title: 'Projet',
    content: [
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Nom'), h('input', { class: 'input', value: p.name, onchange: e => { p.name = e.target.value.trim() || p.name; p.touch(); } })),
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Couleur du fond'), h('input', { type: 'color', value: p.bg, oninput: e => { p.bg = e.target.value; p.touch(); api.buildTimeline(); api.render(); } })),
      h('p', { class: 'hint' }, `Format ${p.w} × ${p.h} px · zone de dessin ${p.cw} × ${p.ch} px (surplus ${Math.round(p.surplus * 100)} %). Le projet s’enregistre tout seul sur cet appareil.`)],
  });
}
export function helpSheet() {
  const rows = [
    ['Un doigt', 'dessiner avec l’outil choisi'], ['Deux doigts', 'déplacer, zoomer et tourner la page'], ['Tape à deux doigts', 'annuler'], ['Tape à trois doigts', 'rétablir'],
    ['Toucher l’outil actif', 'ouvrir tous ses réglages'], ['Toucher le frame actif', 'durée, dupliquer, supprimer…'], ['Compteur en haut', 'images par seconde et pelure d’oignon'],
    ['Cadre orange', 'ce que voit la caméra, donc ce qui est exporté ; on peut dessiner autour'],
  ];
  sheet({ title: 'Les gestes', content: h('dl', { class: 'help' }, rows.map(([a, b]) => [h('dt', {}, a), h('dd', {}, b)])) });
}

// ---------- Export ----------
export function exportSheet(api) {
  const p = api.p; api.stop();
  const o = { kind: 'mp4', scale: 1, transparent: false };
  const info = h('p', { class: 'hint' }), tr = h('div', {});
  const upd = () => {
    const n = totalTicks(p), w = Math.round(p.w * o.scale / 2) * 2, hh = Math.round(p.h * o.scale / 2) * 2;
    info.textContent = o.kind === 'png' ? `Image du frame ${S.frameIdx + 1} · ${w} × ${hh} px` : `${n} images · ${(n / p.fps).toFixed(1)} s à ${p.fps} i/s · ${w} × ${hh} px`;
    tr.replaceChildren(...(o.kind === 'png' || o.kind === 'zip' ? [toggle('Fond transparent', o.transparent, v => o.transparent = v)] : []));
  };
  const s = sheet({
    title: 'Exporter',
    content: [
      segmented([['mp4', 'Vidéo'], ['gif', 'GIF'], ['png', 'Image'], ['zip', 'Suite PNG']], o.kind, v => { o.kind = v; if (v === 'gif' && o.scale === 1) o.scale = 0.5; upd(); }),
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Taille'), segmented([[1, '100 %'], [0.5, '50 %'], [0.25, '25 %']], o.scale, v => { o.scale = v; upd(); })),
      tr, info,
      h('button', { class: 'btn primary wide', onclick: go }, 'Exporter')],
  });
  upd();
  async function go() {
    s.close();
    let r;
    try { r = await io.runExport(o.kind, { scale: o.scale, transparent: o.transparent && (o.kind === 'png' || o.kind === 'zip'), tick: tickOfFrame(p, S.frameIdx) }); }
    catch (e) { console.error(e); toast('Export impossible : ' + (e.message || e), 5000); return; }
    const url = URL.createObjectURL(r.blob);
    const view = r.ext === 'mp4' || r.ext === 'webm' ? h('video', { src: url, controls: true, loop: true, muted: true, playsInline: true, autoplay: true, class: 'result' })
      : r.ext === 'zip' ? h('p', { class: 'hint' }, 'Archive ZIP contenant une image PNG par image de l’animation.') : h('img', { src: url, class: 'result', alt: 'Résultat' });
    const media = r.ext !== 'zip';
    sheet({
      title: 'Export terminé', tall: true, onClose: () => URL.revokeObjectURL(url),
      content: [view, h('p', { class: 'hint' }, `${r.name} · ${(r.blob.size / 1048576).toFixed(2)} Mo`),
        h('button', { class: 'btn primary wide', onclick: async () => { const how = await io.saveToGallery(r.blob, r.name); if (how === 'download') toast('Fichier enregistré dans les téléchargements'); }, html: icon('share', 20) + `<span>${media ? 'Enregistrer dans la galerie' : 'Enregistrer / partager'}</span>` }),
        h('button', { class: 'btn wide', onclick: () => { io.download(r.blob, r.name); toast('Fichier enregistré dans les téléchargements'); }, html: icon('export', 20) + '<span>Télécharger le fichier</span>' }),
        media && h('p', { class: 'hint' }, 'Dans la feuille de partage, choisissez « Enregistrer la vidéo / l’image » (iPhone) ou votre application Galerie / Photos (Android).')],
    });
  }
}

// ---------- Extraction automatique des traits ----------
export function lineartSheet(api, layer) {
  const p = api.p, frame = p.frames[S.frameIdx], cel = p.celOf(layer, frame);
  if (!cel?.canvas) { toast('Ce calque est vide sur ce frame. Importez d’abord une image de référence.'); return; }
  const o = { mode: 'lines', sens: 60, thick: 6, dark: 35, clean: 12, keepColor: false, hide: true };
  const k = Math.min(1, 760 / Math.max(p.cw, p.ch)), sw = Math.round(p.cw * k), sh = Math.round(p.ch * k);
  const small = scratch('lasrc', sw, sh, { willReadFrequently: true });
  small._ctx.clearRect(0, 0, sw, sh); small._ctx.imageSmoothingQuality = 'high'; small._ctx.drawImage(cel.canvas, 0, 0, sw, sh);
  const src = small._ctx.getImageData(0, 0, sw, sh);
  // on ne montre que le cadre du format
  const cx = Math.round(p.mx * k), cy = Math.round(p.my * k), cw = Math.round(p.w * k), chh = Math.round(p.h * k);
  const view = h('canvas', { class: 'result', width: cw, height: chh }), vx = view.getContext('2d');
  let compare = false, timer = 0;
  const params = () => ({ ...o, thick: Math.max(1, o.thick * k), clean: o.clean * k * k });
  const render = () => {
    const out = new ImageData(extractLines(src, params()), sw, sh), t = scratch('laout', sw, sh);
    t._ctx.putImageData(out, 0, 0);
    vx.globalAlpha = 1; vx.fillStyle = '#fff'; vx.fillRect(0, 0, cw, chh);
    if (compare) { vx.globalAlpha = 0.45; vx.drawImage(small, -cx, -cy); vx.globalAlpha = 1; }
    vx.drawImage(t, -cx, -cy);
  };
  const soon = () => { clearTimeout(timer); timer = setTimeout(render, 40); };
  const extra = h('div', {});
  const drawExtra = () => extra.replaceChildren(...[
    o.mode !== 'edges' && slider({ label: 'Épaisseur max. des traits', min: 1, max: 24, step: 1, value: o.thick, fmt: v => v + ' px', oninput: v => { o.thick = v; soon(); } }),
    o.mode === 'dark' && slider({ label: 'Aplats noirs', min: 0, max: 100, step: 1, value: o.dark, oninput: v => { o.dark = v; soon(); } }),
  ].filter(Boolean));
  const many = !layer.fixed && p.frames.filter(f => f.cels[layer.id]).length > 1;
  const s = sheet({
    title: 'Extraire les traits', tall: true,
    content: [view,
      segmented([['lines', 'Traits'], ['dark', 'Traits + noirs'], ['edges', 'Contours couleur']], o.mode, v => { o.mode = v; drawExtra(); soon(); }),
      slider({ label: 'Sensibilité', min: 0, max: 100, step: 1, value: o.sens, oninput: v => { o.sens = v; soon(); } }),
      extra,
      slider({ label: 'Nettoyage des poussières', min: 0, max: 200, step: 1, curve: 2, value: o.clean, fmt: v => v + ' px', oninput: v => { o.clean = v; soon(); } }),
      toggle('Garder la couleur d’origine des traits', o.keepColor, v => { o.keepColor = v; soon(); }),
      toggle('Comparer avec la référence', compare, v => { compare = v; soon(); }),
      toggle('Masquer la référence ensuite', o.hide, v => o.hide = v),
      h('button', { class: 'btn primary wide', onclick: () => apply(false) }, 'Créer le calque de traits'),
      many && h('button', { class: 'btn wide', onclick: () => apply(true) }, 'Appliquer à tous les frames du calque'),
      h('p', { class: 'hint' }, '« Traits » ne garde que les lignes fines et sombres. « Traits + noirs » ajoute les zones pleines (cheveux noirs, ombres). « Contours couleur » trace les frontières entre couleurs quand l’image n’a pas de trait.')],
  });
  drawExtra(); render();

  async function apply(all) {
    s.close();
    const b = busy('Extraction des traits…'); await nextPaint();
    try {
      const nl = { ...p.makeLayer('Traits'), fixed: layer.fixed };
      const ref = scratch('ref', p.cw, p.ch, { willReadFrequently: true }), outc = scratch('imp', p.cw, p.ch);
      const list = layer.fixed ? [S.frameIdx] : all ? p.frames.map((f, i) => f.cels[layer.id] ? i : -1).filter(i => i >= 0) : [S.frameIdx];
      for (let n = 0; n < list.length; n++) {
        const fi = list[n], f = p.frames[fi];
        await p.loadFrame(fi);
        const c = p.celOf(layer, f); if (!c?.canvas) continue;
        ref._ctx.clearRect(0, 0, p.cw, p.ch); ref._ctx.drawImage(c.canvas, 0, 0);
        const img = ref._ctx.getImageData(0, 0, p.cw, p.ch);
        outc._ctx.putImageData(new ImageData(extractLines(img, o), p.cw, p.ch), 0, 0);
        const nc = await p.celFromBlob(await new Promise(r => outc.toBlob(r, 'image/png')), false);
        if (nl.fixed) nl.cel = nc.id; else f.cels[nl.id] = nc.id;
        f.stale = true;
        b.update(list.length > 1 ? `Frame ${n + 1} / ${list.length}` : null, (n + 1) / list.length); await nextPaint();
      }
      ref.width = ref.height = outc.width = outc.height = 1;
      p.layers.splice(p.layers.indexOf(layer) + 1, 0, nl);
      if (o.hide) layer.visible = false;
      S.layerId = nl.id;
    } finally { b.close(); }
    await api.gotoFrame(S.frameIdx); emit('layers'); api.restyle();
    toast('Traits extraits sur le calque « Traits ». Ajoutez un calque dessous pour la couleur.', 4000);
  }
}

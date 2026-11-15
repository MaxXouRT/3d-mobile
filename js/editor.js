// Éditeur 2D : barres, timeline, lecture, et câblage entre le modèle et la zone de dessin.
import { S, on, emit, saveToolPrefs } from './state.js';
import { h, $, icon, ibtn, toast, sheet, closeAllSheets, slider, busy, nextPaint } from './ui.js';
import { initViewport, requestRender, fitView } from './viewport.js';
import * as tools from './tools.js';
import { totalTicks, frameAtTick, tickOfFrame } from './render.js';
import { freeScratch } from './effects.js';
import * as panels from './panels.js';

let root, p, exitCb, els = {}, gotoTok = 0, pumping = false, playRaf = 0;

const TOOLS = [
  ['brush', 'brush', 'Pinceau'], ['eraser', 'eraser', 'Gomme'], ['fill', 'bucket', 'Remplir'], ['pipette', 'pipette', 'Pipette'],
  ['shape', 'shape', 'Formes'], ['move', 'move', 'Déplacer'], ['camera', 'camera', 'Caméra'],
];

export async function openEditor(project, container, onExit) {
  p = S.project = project; root = container; exitCb = onExit;
  S.frameIdx = 0; S.layerId = p.layers[p.layers.length - 1].id; S.playing = S.preview = false; S.xform = null; S.tool = 'brush';
  tools.clearUndo();
  build();
  initViewport(els.canvas);
  fitView();
  buildTimeline(); setTool('brush'); updateTop();
  await gotoFrame(0);
  pump();
}

function build() {
  els.canvas = h('canvas', { id: 'view' });
  els.undo = ibtn('undo', 'Annuler', () => tools.undo());
  els.redo = ibtn('redo', 'Rétablir', () => tools.redo());
  els.chip = h('button', { class: 'chip', onclick: () => panels.animSheet(api), 'aria-label': 'Réglages de l’animation' });
  els.onion = ibtn('onion', 'Pelure d’oignon', () => { p.onion.on = !p.onion.on; p.touch(); updateTop(); requestRender(); toast(p.onion.on ? 'Pelure d’oignon activée' : 'Pelure d’oignon désactivée', 1200); });
  els.opt = h('div', { class: 'optbar' });
  els.tools = h('nav', { class: 'toolbar' }, TOOLS.map(([id, ic, label]) =>
    h('button', { class: 'tool', 'data-tool': id, 'aria-label': label, html: icon(ic, 24) + `<span>${label}</span>`, onclick: () => S.tool === id ? panels.toolSheet(api) : setTool(id) })));
  els.play = ibtn('play', 'Lire', () => S.playing ? stop() : play(), 'play');
  els.strip = h('div', { class: 'strip' });
  els.stage = h('div', { class: 'stage' }, els.canvas,
    ibtn('fit', 'Recentrer la vue', () => fitView(), 'fitbtn'),
    els.hint = h('div', { class: 'stage-hint' }));
  root.replaceChildren(h('div', { class: 'editor' },
    h('header', { class: 'topbar' },
      ibtn('back', 'Retour aux projets', exit), els.undo, els.redo, els.chip, els.onion,
      ibtn('fx', 'Effets', () => panels.fxSheet(api)),
      ibtn('layers', 'Calques', () => panels.layersSheet(api)),
      ibtn('menu', 'Menu', () => panels.menuSheet(api))),
    els.stage, els.opt, els.tools,
    h('div', { class: 'timeline' }, els.play, els.strip,
      ibtn('plus', 'Ajouter un frame', () => addFrame(), 'accent'),
      ibtn('menu', 'Options du frame', () => panels.frameSheet(api)))));
}

async function exit() { await leave(); exitCb(); }
// Enregistre et libère le projet sans changer d'écran.
async function leave() {
  stop(); tools.commitXform(); closeAllSheets();
  const b = busy('Enregistrement…');
  try { await p.save(); } finally { b.close(); }
  p.close(); freeScratch(); S.project = null;
}

// ---------- Navigation entre frames ----------
export async function gotoFrame(i) {
  tools.commitXform();
  i = Math.max(0, Math.min(p.frames.length - 1, i));
  const tok = ++gotoTok;
  S.frameIdx = i; S.ready = false; S.tick = tickOfFrame(p, i);
  markSel(); updateTop(); requestRender();
  await p.loadFrame(i, true);
  if (tok !== gotoTok) return;
  S.ready = true;
  const f = p.frames[i];
  if (f.stale) { p.refreshPreview(f); drawThumb(i); }
  optbar(); requestRender();
}
S.gotoFrame = gotoFrame;

// Reconstruit en tâche de fond les aperçus périmés (vignettes, pelure d'oignon, lecture).
async function pump(b) {
  if (pumping) { while (pumping) await new Promise(r => setTimeout(r, 50)); return pump(b); }
  pumping = true;
  try {
    const mine = p;
    for (;;) {
      if (S.project !== mine) return;
      const todo = p.frames.filter(f => f.stale).length;
      if (!todo) break;
      // d'abord les voisins du frame courant
      let i = -1, best = 1e9;
      p.frames.forEach((f, k) => { if (f.stale && Math.abs(k - S.frameIdx) < best) { best = Math.abs(k - S.frameIdx); i = k; } });
      await p.buildPreview(i);
      drawThumb(i); requestRender();
      b?.update(`Préparation des aperçus… (${todo} restants)`);
    }
  } finally { pumping = false; }
}

// ---------- Timeline ----------
function thumbSize() { const th = 40, tw = Math.max(26, Math.min(76, Math.round(th * p.w / p.h))); return [tw, th]; }
function buildTimeline() {
  const [tw, th] = thumbSize();
  els.strip.replaceChildren(...p.frames.map((f, i) => {
    const c = h('canvas', { width: tw * 2, height: th * 2, style: { width: tw + 'px', height: th + 'px' } });
    return h('button', { class: 'thumb', 'aria-label': 'Frame ' + (i + 1), onclick: () => { if (S.playing) stop(); i === S.frameIdx ? panels.frameSheet(api) : gotoFrame(i); } },
      c, h('span', { class: 'num' }, i + 1), h('span', { class: 'badges' }));
  }));
  p.frames.forEach((_, i) => { drawThumb(i); badge(i); });
  markSel();
}
function drawThumb(i) {
  const el = els.strip.children[i], f = p.frames[i]; if (!el || !f) return;
  const c = el.firstChild, x = c.getContext('2d');
  x.fillStyle = p.bg; x.fillRect(0, 0, c.width, c.height);
  if (f.preview && !f.stale) x.drawImage(f.preview, p.mx * p.ps, p.my * p.ps, p.w * p.ps, p.h * p.ps, 0, 0, c.width, c.height);
}
function badge(i) {
  const el = els.strip.children[i], f = p.frames[i]; if (!el) return;
  el.lastChild.innerHTML = (f.hold > 1 ? `<i class="hold">×${f.hold}</i>` : '') + (f.cam ? '<i class="key">◆</i>' : '');
}
function markSel() {
  [...els.strip.children].forEach((el, i) => el.classList.toggle('sel', i === S.frameIdx));
  els.strip.children[S.frameIdx]?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}
function updateTop() {
  els.chip.innerHTML = `<b>${S.frameIdx + 1}</b>/${p.frames.length}<span>${p.fps} i/s</span>`;
  els.onion.classList.toggle('on', p.onion.on);
  const u = tools.undoState(); els.undo.classList.toggle('dim', !u.undo); els.redo.classList.toggle('dim', !u.redo);
}

async function addFrame() {
  if (S.playing) stop();
  p.frames.splice(S.frameIdx + 1, 0, p.makeFrame()); p.touch();
  buildTimeline(); await gotoFrame(S.frameIdx + 1);
}
async function duplicateFrame() {
  tools.commitXform();
  const src = p.frames[S.frameIdx], f = p.makeFrame(); f.hold = src.hold;
  const b = busy('Duplication…');
  try {
    for (const l of p.layers) {
      if (l.fixed) continue;
      const c = await p.cloneCel(p.celOf(l, src)); if (c) f.cels[l.id] = c.id;
    }
  } finally { b.close(); }
  p.frames.splice(S.frameIdx + 1, 0, f); p.touch();
  buildTimeline(); await gotoFrame(S.frameIdx + 1);
}
async function deleteFrame() {
  if (p.frames.length <= 1) { clearCel(); return; }
  tools.commitXform();
  const [f] = p.frames.splice(S.frameIdx, 1);
  for (const id of Object.values(f.cels)) p.dropCel(id);
  p.touch(); buildTimeline(); await gotoFrame(Math.min(S.frameIdx, p.frames.length - 1));
}
async function moveFrame(d) {
  const j = S.frameIdx + d; if (j < 0 || j >= p.frames.length) return;
  tools.commitXform();
  const [f] = p.frames.splice(S.frameIdx, 1); p.frames.splice(j, 0, f);
  p.touch(); buildTimeline(); await gotoFrame(j);
}
function setHold(n) { p.frames[S.frameIdx].hold = Math.max(1, Math.min(48, n)); p.touch(); badge(S.frameIdx); }
function clearCel() {
  tools.commitXform();
  const frame = p.frames[S.frameIdx], layer = p.layer(S.layerId), cel = p.celOf(layer, frame);
  if (!cel?.canvas || layer.locked) return;
  const done = tools.snapshot(cel);
  cel.canvas._ctx.clearRect(0, 0, p.cw, p.ch); done();
  p.markDirty(cel, frame); p.refreshPreview(frame); emit('edited');
}

// ---------- Lecture ----------
async function play() {
  if (S.playing) return;
  tools.commitXform();
  if (p.frames.some(f => f.stale)) { const b = busy('Préparation des aperçus…'); try { await pump(b); } finally { b.close(); } }
  const N = totalTicks(p), fps = p.fps, t0 = performance.now(), start = S.frameIdx >= p.frames.length - 1 ? 0 : tickOfFrame(p, S.frameIdx);
  S.playing = S.preview = true; els.play.innerHTML = icon('pause'); root.firstChild.classList.add('playing');
  let lastF = -1;
  const loop = now => {
    if (!S.playing) return;
    let t = start + Math.floor((now - t0) * fps / 1000);
    if (t >= N) { if (!p.loop) { S.tick = N - 1; stop(); return; } t %= N; }
    S.tick = t;
    const fi = frameAtTick(p, t);
    if (fi !== lastF) { lastF = fi; S.frameIdx = fi; markSel(); updateTop(); }
    requestRender();
    playRaf = requestAnimationFrame(loop);
  };
  playRaf = requestAnimationFrame(loop);
}
function stop() {
  if (!S.playing) return;
  S.playing = false; S.preview = panels.fxOpen(); cancelAnimationFrame(playRaf);
  els.play.innerHTML = icon('play'); root.firstChild.classList.remove('playing');
  gotoFrame(frameAtTick(p, S.tick));
}

// ---------- Outils ----------
function setTool(id) {
  tools.commitXform();
  S.tool = id;
  [...els.tools.children].forEach(b => b.classList.toggle('on', b.dataset.tool === id));
  optbar(); requestRender();
}
function hintSize(size) { S.sizeHint = { size, until: performance.now() + 700 }; requestRender(); }
function colorDot() { return h('button', { class: 'colordot', style: { background: S.color }, 'aria-label': 'Couleur', onclick: () => panels.colorSheet(api) }); }
const pct = v => Math.round(v * 100) + '%';

// Barre d'options : seulement les 2-3 réglages utiles de l'outil courant. Le reste est dans la fiche de l'outil.
function optbar() {
  const t = S.tools, o = [];
  const sv = () => saveToolPrefs();
  if (S.tool === 'brush') o.push(colorDot(),
    slider({ compact: true, label: 'Taille', min: 1, max: 300, step: 1, curve: 2.2, value: t.brush.size, oninput: v => { t.brush.size = v; hintSize(v); }, onchange: sv }),
    slider({ compact: true, label: 'Opacité', min: 0.05, max: 1, step: 0.01, value: t.brush.opacity, fmt: pct, oninput: v => t.brush.opacity = v, onchange: sv }),
    h('button', { class: 'pill', onclick: () => panels.toolSheet(api) }, tools.BRUSHES[t.brush.type].name));
  else if (S.tool === 'eraser') o.push(
    slider({ compact: true, label: 'Taille', min: 1, max: 400, step: 1, curve: 2.2, value: t.eraser.size, oninput: v => { t.eraser.size = v; hintSize(v); }, onchange: sv }),
    slider({ compact: true, label: 'Force', min: 0.05, max: 1, step: 0.01, value: t.eraser.opacity, fmt: pct, oninput: v => t.eraser.opacity = v, onchange: sv }));
  else if (S.tool === 'fill') o.push(colorDot(),
    slider({ compact: true, label: 'Tolérance', min: 0, max: 200, step: 1, value: t.fill.tol, oninput: v => t.fill.tol = v, onchange: sv }),
    h('span', { class: 'opt-hint' }, 'Touchez une zone'));
  else if (S.tool === 'pipette') o.push(colorDot(), h('span', { class: 'opt-hint' }, 'Touchez le dessin pour prendre sa couleur'));
  else if (S.tool === 'shape') o.push(colorDot(),
    h('div', { class: 'seg small' }, [['line', 'Ligne'], ['rect', 'Rect.'], ['ellipse', 'Ovale']].map(([k, l]) =>
      h('button', { class: t.shape.kind === k ? 'on' : '', onclick: () => { t.shape.kind = k; sv(); optbar(); } }, l))),
    slider({ compact: true, label: 'Trait', min: 1, max: 120, step: 1, curve: 2, value: t.shape.size, oninput: v => { t.shape.size = v; hintSize(v); }, onchange: sv }));
  else if (S.tool === 'move') {
    const x = S.xform || { scale: 1, rot: 0 };
    const need = fn => v => { if (tools.beginXform()) { fn(v); requestRender(); } };
    o.push(
      slider({ compact: true, label: 'Taille', min: 0.1, max: 4, step: 0.01, curve: 2, value: x.scale, fmt: pct, oninput: need(v => S.xform.scale = v) }),
      slider({ compact: true, label: 'Rotation', min: -180, max: 180, step: 1, value: Math.round(x.rot * 180 / Math.PI), fmt: v => v + '°', oninput: need(v => S.xform.rot = v * Math.PI / 180) }),
      ibtn('flip', 'Miroir', need(() => S.xform.flip *= -1)));
    if (S.xform) o.push(ibtn('close', 'Annuler le déplacement', () => tools.cancelXform()), ibtn('check', 'Valider', () => tools.commitXform(), 'accent'));
    else o.unshift(h('span', { class: 'opt-hint' }, 'Glissez'));
  } else if (S.tool === 'camera') {
    const c = tools.curCam(), has = !!p.frames[S.frameIdx].cam;
    o.push(
      slider({ compact: true, label: 'Zoom', min: 0.25, max: 6, step: 0.01, curve: 2, value: c.zoom, fmt: v => v.toFixed(2) + '×', oninput: v => tools.setCam({ zoom: v }) }),
      slider({ compact: true, label: 'Rotation', min: -180, max: 180, step: 1, value: Math.round(c.rot * 180 / Math.PI), fmt: v => v + '°', oninput: v => tools.setCam({ rot: v * Math.PI / 180 }) }),
      ibtn('key', has ? 'Supprimer la clé caméra de ce frame' : 'Poser une clé caméra sur ce frame', () => { has ? tools.removeCamKey() : tools.setCam({}); optbar(); }, has ? 'accent' : ''));
  }
  els.opt.replaceChildren(...o);
}

// ---------- Événements du modèle ----------
function listen(e, f) { on(e, (...a) => { if (S.project && S.project === p) f(...a); }); }
function wire() {
  listen('edited', () => { drawThumb(S.frameIdx); updateTop(); if (p.frames.some(f => f.stale)) pump(); requestRender(); });
  listen('undo', updateTop);
  listen('color', () => { if (els.opt.querySelector('.colordot')) els.opt.querySelector('.colordot').style.background = S.color; });
  listen('picked', () => setTool('brush'));
  listen('xform', () => { if (S.tool === 'move') optbar(); });
  let camDrag = 0;
  listen('cam', () => { badge(S.frameIdx); requestRender(); if (S.tool === 'camera' && !tools.busyStroke()) { clearTimeout(camDrag); camDrag = setTimeout(() => { if (!document.activeElement?.matches('input[type=range]')) optbar(); }, 250); } });
  listen('structure', async () => { buildTimeline(); await gotoFrame(S.frameIdx); pump(); });
  listen('layers', () => { optbar(); requestRender(); });
}

// Interface offerte aux panneaux (calques, effets, export…).
const api = {
  get p() { return p; }, gotoFrame, pump, optbar, updateTop, buildTimeline, drawThumb, badge, setTool, fitView, render: requestRender,
  leave, addFrame, duplicateFrame, deleteFrame, moveFrame, setHold, clearCel, play, stop, hintSize,
  // À appeler quand l'apparence de tous les frames change (calque masqué, opacité, effet de calque…).
  restyle() { p.staleAll(); if (S.ready) { p.refreshPreview(p.frames[S.frameIdx]); drawThumb(S.frameIdx); } p.touch(); requestRender(); if (!panels.fxOpen()) pump(); },
};
wire();
window.addEventListener('pagehide', () => S.project?.save());
document.addEventListener('visibilitychange', () => { if (document.hidden) S.project?.save(); });

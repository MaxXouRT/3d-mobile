// Éditeur 3D : scène, import de modèles, pose des os, clés d'animation, caméra, export,
// et envoi de l'animation (ou d'un décor) vers un projet 2D pour décalquer.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { h, icon, ibtn, toast, sheet, closeAllSheets, slider, segmented, toggle, confirmDlg, promptDlg, busy, nextPaint } from './ui.js';
import * as db from './store.js';
import { Project, uid } from './project.js';
import { expandFiles, loadModel, loadVMD, candidates } from './import3d.js';
import * as io from './io.js';
import * as mocap from './mocap.js';

const toBlob = (c, type, q) => new Promise(r => c.toBlob(r, type, q));
const item = (ic, label, onclick, cls = '') => h('button', { class: 'item ' + cls, onclick, html: icon(ic) + `<span>${label}</span>` });
const PRIMS = { box: 'Cube', sphere: 'Sphère', cylinder: 'Cylindre', cone: 'Cône', plane: 'Sol' };
// Personnages livrés avec l'app (dossier models/) : squelette complet, prêts pour la pose et la capture de mouvement.
const BUILTIN = [['mannequin', 'Mannequin'], ['mannequin-femme', 'Mannequin femme']];
const boneName = (b, i) => b.userData.label || b.name || 'Os ' + i;

export function new3dMeta(o) {
  return {
    id: uid(), kind: '3d', name: 'Scène sans titre', w: 1920, h: 1080, fps: 24, len: 48, loop: true, bg: '#2b2e38', grid: true,
    light: 1, lightAz: 35, style: 'normal', fov: 40, objects: [], tracks: {}, cam: [], follow: true, view: null, created: Date.now(), ...o,
  };
}

export async function openEditor3d(P, root, nav) {
  const els = {}, rt = new Map();
  let frame = 0, playing = false, playRaf = 0, sel = { obj: null, bone: null }, mode = 'object', gizmo = 'translate';
  let dirty = false, saveT = 0, needRender = true, alive = true, sw = 1, sh = 1, fr = { x: 0, y: 0, w: 1, h: 1 };
  const undoS = [], redoS = [];

  // ---------- Interface ----------
  els.gl = h('canvas', { class: 'gl' }); els.ov = h('canvas', { class: 'ov' });
  els.undo = ibtn('undo', 'Annuler', () => undo(undoS, redoS));
  els.redo = ibtn('redo', 'Rétablir', () => undo(redoS, undoS));
  els.chip = h('button', { class: 'chip', 'aria-label': 'Réglages de l’animation', onclick: animSheet });
  els.opt = h('div', { class: 'optbar' });
  els.play = ibtn('play', 'Lire', () => playing ? stop() : play(), 'play');
  els.scrub = h('input', { type: 'range', min: 0, max: P.len - 1, step: 1, value: 0, 'aria-label': 'Frame', oninput: () => { if (playing) stop(); setFrame(+els.scrub.value); } });
  els.ticks = h('canvas', { class: 'ticks', height: 10 });
  const TOOLS = [['object', 'cube', 'Objet'], ['pose', 'move', 'Pose'], ['mocap', 'person', 'Filmer'], ['add', 'plus', 'Ajouter'], ['cam', 'camera', 'Caméra'], ['to2d', 'brush', 'Vers la 2D']];
  els.tools = h('nav', { class: 'toolbar' }, TOOLS.map(([id, ic, label]) => h('button', {
    class: 'tool', 'data-tool': id, 'aria-label': label, html: icon(ic, 24) + `<span>${label}</span>`,
    onclick: () => id === 'add' ? addSheet() : id === 'cam' ? camSheet() : id === 'to2d' ? to2dSheet() : id === 'mocap' ? mocapSheet() : setMode(id),
  })));
  root.replaceChildren(h('div', { class: 'editor e3d' },
    h('header', { class: 'topbar' }, ibtn('back', 'Retour aux projets', exit), els.undo, els.redo, els.chip,
      ibtn('layers', 'Objets de la scène', objectsSheet), ibtn('settings', 'Scène et lumière', sceneSheet), ibtn('menu', 'Menu', menuSheet)),
    els.stage = h('div', { class: 'stage' }, els.gl, els.ov), els.opt, els.tools,
    h('div', { class: 'timeline t3d' }, els.play, h('div', { class: 'scrub' }, els.ticks, els.scrub),
      ibtn('left', 'Clé précédente', () => jumpKey(-1)), els.key = ibtn('key', 'Poser ou retirer une clé', toggleKey), ibtn('right', 'Clé suivante', () => jumpKey(1)))));

  // ---------- Scène ----------
  const renderer = new THREE.WebGLRenderer({ canvas: els.gl, antialias: true, alpha: true, preserveDrawingBuffer: true });
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(P.fov, P.w / P.h, 0.05, 500);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x50505c, 1), sun = new THREE.DirectionalLight(0xffffff, 1.6);
  const grid = new THREE.GridHelper(20, 40, 0x6b7080, 0x3d414c);
  const clay = new THREE.MeshStandardMaterial({ color: 0xd9dae0, roughness: 0.85 });
  scene.add(hemi, sun, grid);
  camera.position.set(3, 2.2, 5);
  const orbit = new OrbitControls(camera, els.gl);
  orbit.target.set(0, 1, 0); orbit.enableDamping = false; orbit.addEventListener('change', () => { needRender = true; });
  if (P.view) { camera.position.fromArray(P.view.pos); orbit.target.fromArray(P.view.tgt); }
  orbit.update();
  const tc = new TransformControls(camera, els.gl);
  tc.setSize(1.15); scene.add(tc.getHelper());
  tc.addEventListener('change', () => { needRender = true; });
  tc.addEventListener('dragging-changed', e => {
    orbit.enabled = !e.value;
    if (e.value) pushUndo(); else { const t = target(); if (t) setKey(keyOf(sel), t); }
  });
  function applyScene() {
    scene.background = null; renderer.setClearColor(P.bg, 1);
    hemi.intensity = P.light; sun.intensity = 1.6 * P.light;
    const a = P.lightAz * Math.PI / 180; sun.position.set(Math.sin(a) * 6, 8, Math.cos(a) * 6);
    grid.visible = P.grid; camera.fov = P.fov; camera.updateProjectionMatrix();
    for (const r of rt.values()) r.root.traverse(o => { if (o.isMesh && o.userData.mat) o.material = P.style === 'clay' ? clay : o.userData.mat; });
    needRender = true;
  }

  // La vue occupe tout l'écran ; le cadre du format (ce qui sera exporté) est centré dedans.
  function resize() {
    const r = els.stage.getBoundingClientRect(); if (!r.width || !r.height) return;
    sw = r.width; sh = r.height;
    const k = Math.min(sw / P.w, sh / P.h) * 0.94;
    fr = { w: P.w * k, h: P.h * k }; fr.x = (sw - fr.w) / 2; fr.y = (sh - fr.h) / 2;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setSize(sw, sh, false);
    camera.aspect = P.w / P.h; camera.setViewOffset(fr.w, fr.h, -fr.x, -fr.y, sw, sh); camera.updateProjectionMatrix();
    const d = Math.min(window.devicePixelRatio || 1, 2); els.ov.width = sw * d; els.ov.height = sh * d;
    els.ticks.width = els.ticks.clientWidth * 2 || 600;
    needRender = true; drawTicks();
  }
  const ro = new ResizeObserver(resize); ro.observe(els.stage);

  // ---------- Objets ----------
  function attach(o, r) {
    rt.set(o.id, r); r.root.userData.id = o.id; r.root.visible = o.visible !== false;
    if (r.clips?.length) r.mixer = new THREE.AnimationMixer(r.mesh || r.root.children[0]);
    scene.add(r.root); setClip(o, o.clip ?? -1);
  }
  function makePrim(o) {
    const g = { box: () => new THREE.BoxGeometry(1, 1, 1), sphere: () => new THREE.SphereGeometry(0.5, 32, 20), cylinder: () => new THREE.CylinderGeometry(0.4, 0.4, 1, 32), cone: () => new THREE.ConeGeometry(0.5, 1, 32), plane: () => new THREE.PlaneGeometry(10, 10) }[o.prim]();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.7, side: THREE.DoubleSide }));
    if (o.prim === 'plane') m.rotation.x = -Math.PI / 2; else m.position.y = 0.5;
    m.userData.mat = m.material;
    const root = new THREE.Group(); root.add(m);
    return { root, bones: [], clips: [] };
  }
  function setClip(o, i) {
    const r = rt.get(o.id); o.clip = i;
    if (!r?.mixer) return;
    r.mixer.stopAllAction(); r.action = null;
    if (i >= 0 && r.clips[i]) { r.action = r.mixer.clipAction(r.clips[i]); r.action.play(); }
  }
  async function importFiles(files) {
    const b = busy('Lecture du modèle…'); await nextPaint();
    try {
      const entries = await expandFiles(files);
      const vmd = entries.find(e => /\.vmd$/i.test(e.name));
      if (!candidates(entries).length && vmd) { b.close(); return importVMD(vmd.blob); }
      const r = await loadModel(entries);
      const o = { id: uid(), kind: 'model', name: r.name || 'Modèle', visible: true, clip: r.clips.length ? 0 : -1, mmd: r.mmd };
      await db.putCel(P.id, 'file:' + o.id, entries);
      pushUndo(); P.objects.push(o); attach(o, r); applyScene();
      select(o.id, null); setMode(r.bones.length ? 'pose' : 'object'); touch(); evaluate();
      const extra = [r.bones.length && `${r.bones.length} os`, r.clips.length && `${r.clips.length} animation${r.clips.length > 1 ? 's' : ''}`].filter(Boolean).join(', ');
      toast(`« ${o.name} » importé (${r.format}${extra ? ', ' + extra : ''})`, 3500);
      if (vmd && r.mmd) await importVMD(vmd.blob);
    } catch (e) { console.error(e); toast(e.message || 'Import impossible', 5000); }
    finally { b.close(); }
  }
  async function importVMD(blob) {
    const o = P.objects.find(x => x.id === sel.obj && x.mmd) || P.objects.find(x => x.mmd), r = o && rt.get(o.id);
    if (!r?.mesh) { toast('Un mouvement .vmd s’applique à un modèle MMD (pmx / pmd) : importez-le d’abord'); return; }
    const b = busy('Lecture du mouvement…');
    try {
      const clip = await loadVMD(blob, r.mesh);
      r.clips = [clip]; r.mixer ||= new THREE.AnimationMixer(r.mesh);
      await db.putCel(P.id, 'vmd:' + o.id, blob); o.vmd = true;
      setClip(o, 0);
      const { CCDIKSolver } = await import('three/addons/animation/CCDIKSolver.js');
      const iks = r.mesh.geometry.userData.MMD?.iks; if (iks?.length) r.ik = new CCDIKSolver(r.mesh, iks);
      const n = Math.ceil(clip.duration * P.fps); if (n > P.len) { P.len = Math.min(n, 3000); syncLen(); }
      touch(); evaluate(); toast('Mouvement appliqué à « ' + o.name + ' »');
    } catch (e) { console.error(e); toast('Mouvement illisible'); }
    finally { b.close(); }
  }
  async function addBuiltin(file, name) {
    let blob;
    try { const r = await fetch(new URL(`../models/${file}.glb`, import.meta.url)); if (!r.ok) throw new Error(r.status); blob = await r.blob(); }
    catch (e) { console.error(e); toast('Mannequin indisponible : ouvrez l’app une fois avec Internet pour l’enregistrer sur l’appareil', 5000); return; }
    await importFiles([new File([blob], name + '.glb', { type: 'model/gltf-binary' })]);
  }
  function pickFiles(cb) {
    const inp = h('input', { type: 'file', multiple: true, style: { display: 'none' } });
    inp.addEventListener('change', () => { if (inp.files.length) cb([...inp.files]); inp.remove(); });
    document.body.append(inp); inp.click();
  }

  // ---------- Animation : tout ce qu'on déplace est « clé » sur le frame courant ----------
  const keyOf = s => s.obj ? (s.bone != null ? s.obj + '#' + s.bone : s.obj) : null;
  function targetOf(key) {
    if (!key) return null;
    const [id, bi] = key.split('#'), r = rt.get(id); if (!r) return null;
    return bi != null ? r.bones[+bi] : r.root;
  }
  const target = () => targetOf(keyOf(sel));
  function setKey(key, t) {
    const tr = P.tracks[key] ||= [], k = { f: frame, p: t.position.toArray(), q: t.quaternion.toArray(), s: t.scale.toArray() };
    const i = tr.findIndex(x => x.f === frame);
    if (i >= 0) tr[i] = k; else { tr.push(k); tr.sort((a, b) => a.f - b.f); }
    touch(); drawTicks(); updateTop();
  }
  const ease = k => k * k * (3 - 2 * k);
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), va = new THREE.Vector3(), vb = new THREE.Vector3();
  function sample(tr, f, t) {
    let a = tr[0], b = tr[tr.length - 1];
    if (f <= a.f) b = a; else if (f >= b.f) a = b;
    else for (let i = 0; i < tr.length - 1; i++) if (f >= tr[i].f && f <= tr[i + 1].f) { a = tr[i]; b = tr[i + 1]; break; }
    const k = a === b ? 0 : ease((f - a.f) / (b.f - a.f));
    t.position.copy(va.fromArray(a.p)).lerp(vb.fromArray(b.p), k);
    t.quaternion.copy(qa.fromArray(a.q)).slerp(qb.fromArray(b.q), k);
    t.scale.copy(va.fromArray(a.s)).lerp(vb.fromArray(b.s), k);
  }
  function evaluate(f = frame, forCamera = playing || P.follow) {
    for (const o of P.objects) {
      const r = rt.get(o.id); if (!r) continue;
      if (r.action) { const d = r.action.getClip().duration || 1; r.mixer.setTime((f / P.fps) % d); if (r.ik) { r.mesh.updateMatrixWorld(true); r.ik.update(); } }
      else for (const b of r.bones) { const s = b.userData.rest; b.position.copy(s.p); b.quaternion.copy(s.q); b.scale.copy(s.s); }
      if (!P.tracks[o.id]?.length) { r.root.position.set(0, 0, 0); r.root.quaternion.identity(); r.root.scale.set(1, 1, 1); }
    }
    for (const [key, tr] of Object.entries(P.tracks)) { const t = tr.length && targetOf(key); if (t) sample(tr, f, t); }
    if (forCamera && P.cam.length) {
      const c = P.cam; let a = c[0], b = c[c.length - 1];
      if (f <= a.f) b = a; else if (f >= b.f) a = b;
      else for (let i = 0; i < c.length - 1; i++) if (f >= c[i].f && f <= c[i + 1].f) { a = c[i]; b = c[i + 1]; break; }
      const k = a === b ? 0 : ease((f - a.f) / (b.f - a.f));
      camera.position.fromArray(a.pos).lerp(vb.fromArray(b.pos), k); orbit.target.fromArray(a.tgt).lerp(vb.fromArray(b.tgt), k); orbit.update();
    }
    needRender = true;
  }
  function setFrame(f) { frame = Math.max(0, Math.min(P.len - 1, Math.round(f))); els.scrub.value = frame; evaluate(); updateTop(); }
  function allKeyFrames() {
    const tr = keyOf(sel) && P.tracks[keyOf(sel)];
    const s = new Set((tr?.length ? tr : Object.values(P.tracks).flat()).map(k => k.f)); if (!tr?.length) P.cam.forEach(k => s.add(k.f));
    return [...s].sort((a, b) => a - b);
  }
  function jumpKey(d) {
    const fs = allKeyFrames(), n = d > 0 ? fs.find(f => f > frame) : [...fs].reverse().find(f => f < frame);
    if (n == null) toast(d > 0 ? 'Pas de clé après' : 'Pas de clé avant', 1200); else { if (playing) stop(); setFrame(n); }
  }
  function toggleKey() {
    const key = keyOf(sel), t = target();
    if (!t) { toast('Sélectionnez un objet ou un os'); return; }
    pushUndo();
    const tr = P.tracks[key], i = tr ? tr.findIndex(k => k.f === frame) : -1;
    if (i >= 0) { tr.splice(i, 1); if (!tr.length) delete P.tracks[key]; touch(); evaluate(); drawTicks(); updateTop(); toast('Clé retirée', 1000); }
    else { setKey(key, t); toast('Clé posée au frame ' + (frame + 1), 1000); }
  }
  function play() {
    playing = true; els.play.innerHTML = icon('pause'); tc.detach();
    const t0 = performance.now(), f0 = frame >= P.len - 1 ? 0 : frame;
    const loop = now => {
      if (!playing) return;
      let f = f0 + Math.floor((now - t0) * P.fps / 1000);
      if (f >= P.len) { if (!P.loop) { frame = P.len - 1; stop(); return; } f %= P.len; }
      if (f !== frame) { frame = f; els.scrub.value = f; evaluate(); updateTop(); }
      playRaf = requestAnimationFrame(loop);
    };
    playRaf = requestAnimationFrame(loop);
  }
  function stop() { if (!playing) return; playing = false; cancelAnimationFrame(playRaf); els.play.innerHTML = icon('play'); evaluate(); reattach(); }

  // ---------- Sélection ----------
  function select(obj, bone) { sel = { obj, bone }; reattach(); optbar(); drawTicks(); updateTop(); needRender = true; }
  function reattach() {
    const t = !playing && target();
    if (!t || (mode === 'pose' && sel.bone == null)) { tc.detach(); return; }
    tc.attach(t);
    const m = sel.bone != null && gizmo === 'scale' ? 'rotate' : gizmo;
    tc.setMode(m); tc.setSpace(sel.bone != null || m === 'scale' ? 'local' : 'world');
  }
  function setMode(m) {
    mode = m;
    if (m === 'pose') {
      const r = rt.get(sel.obj);
      if (!r?.bones.length) { const o = P.objects.find(x => rt.get(x.id)?.bones.length); if (o) sel = { obj: o.id, bone: null }; else { toast('Aucun modèle articulé dans la scène. Importez un personnage avec squelette.'); mode = 'object'; } }
      if (mode === 'pose') gizmo = 'rotate';
    } else { sel.bone = null; if (gizmo === 'rotate') gizmo = 'translate'; }
    [...els.tools.children].forEach(b => b.classList.toggle('on', b.dataset.tool === mode));
    select(sel.obj, sel.bone);
  }
  function optbar() {
    const o = P.objects.find(x => x.id === sel.obj), r = o && rt.get(o.id), c = [];
    if (!o) c.push(h('span', { class: 'opt-hint' }, P.objects.length ? 'Touchez un objet pour le sélectionner' : 'Scène vide : touchez « Ajouter » (modèle ou mannequin)'));
    else {
      const bone = sel.bone != null ? r.bones[sel.bone] : null;
      c.push(h('button', { class: 'pill name', onclick: () => mode === 'pose' ? bonesSheet() : objectsSheet() }, bone ? boneName(bone, sel.bone) : mode === 'pose' ? 'Choisir un os…' : o.name));
      if (mode === 'object' || bone) c.push(segmented(bone ? [['rotate', 'Tourner'], ['translate', 'Déplacer']] : [['translate', 'Déplacer'], ['rotate', 'Tourner'], ['scale', 'Taille']], gizmo === 'scale' && bone ? 'rotate' : gizmo, v => { gizmo = v; reattach(); needRender = true; }));
      if (bone) c.push(ibtn('undo', 'Remettre cet os au repos', () => { pushUndo(); delete P.tracks[keyOf(sel)]; touch(); evaluate(); drawTicks(); }));
    }
    els.opt.replaceChildren(...c); els.opt.querySelector('.seg')?.classList.add('small');
  }
  // Tape sur la vue : choisit un os (mode Pose) ou un objet.
  let down = null;
  els.gl.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: e.timeStamp, n: (down?.n || 0) }; });
  els.gl.addEventListener('pointerup', e => {
    if (!down || tc.dragging || playing || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8 || e.timeStamp - down.t > 400) return;
    const rc = els.gl.getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top;
    if (mode === 'pose') {
      const r = rt.get(sel.obj); let best = -1, bd = 26;
      if (r) r.bones.forEach((b, i) => { const s = project(b); if (!s) return; const d = Math.hypot(s.x - x, s.y - y); if (d < bd) { bd = d; best = i; } });
      if (best >= 0) return select(sel.obj, best);
    }
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(x / sw * 2 - 1, -(y / sh) * 2 + 1), camera);
    let hit = null, hd = Infinity; const box = new THREE.Box3(), pt = new THREE.Vector3();
    for (const o of P.objects) {
      const r = rt.get(o.id); if (!r || !r.root.visible) continue;
      if (ray.ray.intersectBox(box.setFromObject(r.root), pt)) { const d = pt.distanceTo(ray.ray.origin); if (d < hd) { hd = d; hit = o; } }
    }
    if (hit) select(hit.id, null); else if (mode === 'object') select(null, null); else select(sel.obj, null);
  });
  const pv = new THREE.Vector3();
  function project(o3) {
    pv.setFromMatrixPosition(o3.matrixWorld).project(camera);
    return pv.z > 1 || pv.z < -1 ? null : { x: (pv.x + 1) / 2 * sw, y: (1 - pv.y) / 2 * sh };
  }

  // ---------- Rendu ----------
  function drawOverlay() {
    const x = els.ov.getContext('2d'), d = els.ov.width / sw;
    x.setTransform(d, 0, 0, d, 0, 0); x.clearRect(0, 0, sw, sh);
    x.beginPath(); x.rect(0, 0, sw, sh); x.rect(fr.x, fr.y, fr.w, fr.h); x.fillStyle = 'rgba(12,13,17,.55)'; x.fill('evenodd');
    x.strokeStyle = 'rgba(255,138,61,.8)'; x.lineWidth = 1.5; x.strokeRect(fr.x, fr.y, fr.w, fr.h);
    if (mode === 'pose' && !playing) {
      const r = rt.get(sel.obj); if (!r) return;
      const rad = r.bones.length > 120 ? 3 : 4.5;
      r.bones.forEach((b, i) => {
        const s = project(b); if (!s) return;
        const on = i === sel.bone, keyed = !!P.tracks[sel.obj + '#' + i];
        x.beginPath(); x.arc(s.x, s.y, on ? rad + 3 : rad, 0, 7);
        x.fillStyle = on ? '#ff8a3d' : keyed ? '#ffd0a8' : 'rgba(255,255,255,.85)'; x.fill();
        x.lineWidth = 1; x.strokeStyle = 'rgba(0,0,0,.7)'; x.stroke();
      });
    }
  }
  function tick() {
    if (!alive) return;
    if (needRender) { needRender = false; renderer.render(scene, camera); drawOverlay(); }
    requestAnimationFrame(tick);
  }
  // Rend une image au format du projet (sans grille ni poignées) et la renvoie dans un canvas 2D.
  const shot = document.createElement('canvas');
  function renderShot(f, w, hh, transparent) {
    evaluate(f, true);
    const g = grid.visible, th = tc.getHelper().visible; grid.visible = false; tc.getHelper().visible = false;
    camera.clearViewOffset(); camera.aspect = w / hh; camera.updateProjectionMatrix();
    renderer.setPixelRatio(1); renderer.setSize(w, hh, false); renderer.setClearColor(P.bg, transparent ? 0 : 1);
    renderer.render(scene, camera);
    if (shot.width !== w || shot.height !== hh) { shot.width = w; shot.height = hh; }
    const x = shot.getContext('2d'); x.clearRect(0, 0, w, hh); x.drawImage(els.gl, 0, 0, w, hh);
    grid.visible = g; tc.getHelper().visible = th; renderer.setClearColor(P.bg, 1);
    return shot;
  }
  function endShots() { resize(); evaluate(); }

  // ---------- Annuler / enregistrer ----------
  const snap = () => JSON.stringify({ tracks: P.tracks, cam: P.cam, objects: P.objects });
  function pushUndo() { undoS.push(snap()); if (undoS.length > 60) undoS.shift(); redoS.length = 0; updateTop(); }
  function undo(from, to) {
    const s = from.pop(); if (!s) { toast(from === undoS ? 'Rien à annuler' : 'Rien à rétablir'); return; }
    to.push(snap()); Object.assign(P, JSON.parse(s));
    for (const [id, r] of rt) { const o = P.objects.find(x => x.id === id); if (o) { if (!r.root.parent) scene.add(r.root); r.root.visible = o.visible !== false; setClip(o, o.clip ?? -1); } else scene.remove(r.root); }
    if (!P.objects.some(o => o.id === sel.obj)) sel = { obj: null, bone: null };
    touch(); evaluate(); select(sel.obj, sel.bone);
  }
  function touch() { dirty = true; clearTimeout(saveT); saveT = setTimeout(save, 1500); }
  async function save() {
    clearTimeout(saveT); if (!dirty) return; dirty = false;
    P.view = { pos: camera.position.toArray(), tgt: orbit.target.toArray() }; P.modified = Date.now();
    try { const s = renderShot(frame, 240, Math.round(240 * P.h / P.w), false); P.thumb = s.toDataURL('image/jpeg', 0.7); endShots(); } catch {}
    await db.putProject(JSON.parse(JSON.stringify(P)));
  }
  async function exit() {
    stop(); closeAllSheets(); dirty = true; await save();
    alive = false; ro.disconnect(); orbit.dispose(); tc.dispose(); renderer.dispose();
    renderer.forceContextLoss?.();
    nav.home();
  }
  function updateTop() {
    els.chip.innerHTML = `<b>${frame + 1}</b>/${P.len}<span>${P.fps} i/s</span>`;
    els.undo.classList.toggle('dim', !undoS.length); els.redo.classList.toggle('dim', !redoS.length);
    const tr = P.tracks[keyOf(sel)]; els.key.classList.toggle('accent', !!tr?.some(k => k.f === frame));
  }
  function syncLen() { els.scrub.max = P.len - 1; if (frame >= P.len) setFrame(P.len - 1); drawTicks(); updateTop(); }
  function drawTicks() {
    const c = els.ticks, x = c.getContext('2d'), w = c.width, pad = 22;
    x.clearRect(0, 0, w, c.height);
    const at = f => pad + (w - 2 * pad) * (P.len > 1 ? f / (P.len - 1) : 0), mine = P.tracks[keyOf(sel)] || [];
    x.fillStyle = '#5d6270'; for (const [k, tr] of Object.entries(P.tracks)) if (tr !== mine) for (const key of tr) x.fillRect(at(key.f) - 1, 4, 2, 6);
    x.fillStyle = '#eceef2'; for (const k of P.cam) x.fillRect(at(k.f) - 1, 0, 2, 4);
    x.fillStyle = '#ff8a3d'; for (const k of mine) { x.beginPath(); x.arc(at(k.f), 5, 4, 0, 7); x.fill(); }
  }

  // ---------- Panneaux ----------
  function addSheet() {
    const s = sheet({
      title: 'Ajouter à la scène',
      content: [
        h('button', { class: 'btn primary wide', onclick: () => { s.close(); pickFiles(importFiles); }, html: icon('export', 20) + '<span>Importer un modèle 3D</span>' }),
        h('p', { class: 'hint' }, 'Formats : glb, gltf, vrm, fbx, pmx / pmd (MMD), obj, dae, stl, ply — ou un zip contenant le modèle et ses textures. Vous pouvez aussi sélectionner le modèle et ses textures ensemble. Un fichier .vmd ajoute un mouvement à un modèle MMD.'),
        h('div', { class: 'lbl' }, 'Personnages prêts à l’emploi'),
        h('div', { class: 'builtins' }, BUILTIN.map(([file, name]) => h('button', { class: 'builtin', onclick: () => { s.close(); addBuiltin(file, name); } },
          h('img', { src: new URL(`../models/${file}.png`, import.meta.url).href, alt: '' }), h('span', {}, name)))),
        h('p', { class: 'hint' }, 'Articulés de la tête aux doigts : posez-les os par os, ou animez-les avec « Filmer ».'),
        h('div', { class: 'lbl' }, 'Formes simples'),
        h('div', { class: 'grid4' }, Object.entries(PRIMS).map(([k, label]) => item(k === 'plane' ? 'fit' : 'cube', label, () => {
          s.close(); pushUndo();
          const o = { id: uid(), kind: 'prim', prim: k, name: label, visible: true, color: k === 'plane' ? '#8f95a3' : '#c9ccd6' };
          P.objects.push(o); attach(o, makePrim(o)); applyScene(); setMode('object'); select(o.id, null); touch();
        })))],
    });
  }
  function objectsSheet() {
    const s = sheet({ title: 'Objets de la scène', actions: [ibtn('plus', 'Ajouter', () => { s.close(); addSheet(); }, 'accent')] });
    const draw = () => s.set(P.objects.length ? P.objects.map(o => {
      const r = rt.get(o.id), on = o.id === sel.obj;
      const row = h('div', { class: 'layer' + (on ? ' sel' : '') }, h('div', { class: 'layer-head', onclick: e => { if (e.target.closest('.ibtn')) return; select(o.id, null); draw(); } },
        ibtn(o.visible !== false ? 'eye' : 'eyeoff', 'Afficher / masquer', () => { o.visible = o.visible === false; r.root.visible = o.visible; touch(); needRender = true; draw(); }, o.visible !== false ? '' : 'dim'),
        h('div', { class: 'layer-name' }, o.name, h('small', {}, o.kind === 'prim' ? 'Forme' : [r?.bones.length ? r.bones.length + ' os' : 'Sans squelette', r?.clips.length && r.clips.length + ' anim.'].filter(Boolean).join(' · ')))));
      if (on) row.append(h('div', { class: 'layer-body' },
        r?.clips.length ? h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Animation du fichier'), h('select', { class: 'input', onchange: e => { pushUndo(); setClip(o, +e.target.value); touch(); evaluate(); } },
          [h('option', { value: -1, selected: o.clip < 0 }, 'Aucune (pose libre)'), ...r.clips.map((c, i) => h('option', { value: i, selected: o.clip === i }, c.name || 'Animation ' + (i + 1)))])) : null,
        o.kind === 'prim' ? h('div', { class: 'row' }, h('span', { class: 'lbl grow' }, 'Couleur'), h('input', { type: 'color', value: o.color, oninput: e => { o.color = e.target.value; r.root.children[0].userData.mat.color.set(o.color); touch(); needRender = true; } })) : null,
        h('div', { class: 'grid4' },
          item('edit', 'Renommer', async () => { const n = await promptDlg('Nom', o.name); if (n) { o.name = n; touch(); draw(); optbar(); } }),
          o.mmd ? item('video', 'Mouvement .vmd', () => { s.close(); pickFiles(f => importVMD(f[0])); }) : null,
          r?.bones.length ? item('person', 'Copier un mouvement filmé', () => { s.close(); select(o.id, sel.obj === o.id ? sel.bone : null); mocapSheet(); }) : null,
          item('undo', 'Effacer ses clés', async () => { if (await confirmDlg(`Effacer toute l’animation de « ${o.name} » ?`, 'Effacer', true)) { pushUndo(); for (const k of Object.keys(P.tracks)) if (k === o.id || k.startsWith(o.id + '#')) delete P.tracks[k]; touch(); evaluate(); drawTicks(); } }),
          item('trash', 'Supprimer', async () => { if (await confirmDlg(`Supprimer « ${o.name} » ?`, 'Supprimer', true)) { pushUndo(); P.objects.splice(P.objects.indexOf(o), 1); scene.remove(r.root); select(null, null); touch(); draw(); } }, 'danger'))));
      return row;
    }) : h('p', { class: 'hint' }, 'La scène est vide. Importez un modèle ou ajoutez une forme.'));
    draw();
  }
  function bonesSheet() {
    const r = rt.get(sel.obj); if (!r) return;
    const q = h('input', { class: 'input', placeholder: 'Chercher un os…' }), list = h('div', { class: 'list' });
    const s = sheet({ title: 'Os du modèle', content: [q, list] });
    const draw = () => {
      const f = q.value.trim().toLowerCase();
      list.replaceChildren(...r.bones.map((b, i) => [b, i]).filter(([b, i]) => !f || boneName(b, i).toLowerCase().includes(f)).slice(0, 300).map(([b, i]) =>
        h('button', { class: 'item' + (i === sel.bone ? ' on' : ''), onclick: () => { s.close(); select(sel.obj, i); } }, h('span', {}, boneName(b, i)), P.tracks[sel.obj + '#' + i] ? h('small', {}, '◆ animé') : null)));
    };
    q.addEventListener('input', draw); draw();
  }
  function camSheet() {
    const has = () => P.cam.some(k => k.f === frame);
    const s = sheet({ title: 'Caméra' });
    const draw = () => s.set([
      h('p', { class: 'hint' }, 'La vue dans le cadre orange est la caméra. Cadrez avec les doigts, puis posez une clé : entre deux clés, la caméra se déplace toute seule.'),
      h('button', { class: 'btn primary wide', onclick: () => { pushUndo(); const k = { f: frame, pos: camera.position.toArray(), tgt: orbit.target.toArray() }, i = P.cam.findIndex(x => x.f === frame); if (i >= 0) P.cam[i] = k; else { P.cam.push(k); P.cam.sort((a, b) => a.f - b.f); } touch(); drawTicks(); draw(); toast('Clé caméra posée au frame ' + (frame + 1), 1200); }, html: icon('key', 20) + `<span>${has() ? 'Remplacer' : 'Poser'} la clé caméra du frame ${frame + 1}</span>` }),
      has() ? h('button', { class: 'btn wide', onclick: () => { pushUndo(); P.cam = P.cam.filter(k => k.f !== frame); touch(); drawTicks(); draw(); } }, 'Retirer cette clé') : null,
      P.cam.length ? h('button', { class: 'btn wide danger', onclick: () => { pushUndo(); P.cam = []; touch(); drawTicks(); draw(); } }, `Supprimer les ${P.cam.length} clés caméra`) : null,
      toggle('Suivre la caméra animée hors lecture', P.follow, v => { P.follow = v; touch(); evaluate(); }),
      slider({ label: 'Angle de champ', min: 15, max: 90, step: 1, value: P.fov, fmt: v => v + '°', oninput: v => { P.fov = v; applyScene(); touch(); } })]);
    draw();
  }
  function sceneSheet() {
    sheet({
      title: 'Scène et lumière',
      content: [
        h('div', { class: 'row' }, h('span', { class: 'lbl grow' }, 'Couleur du fond'), h('input', { type: 'color', value: P.bg, oninput: e => { P.bg = e.target.value; applyScene(); touch(); } })),
        slider({ label: 'Lumière', min: 0.2, max: 2.5, step: 0.05, value: P.light, fmt: v => Math.round(v * 100) + '%', oninput: v => { P.light = v; applyScene(); touch(); } }),
        slider({ label: 'Direction du soleil', min: -180, max: 180, step: 5, value: P.lightAz, fmt: v => v + '°', oninput: v => { P.lightAz = v; applyScene(); touch(); } }),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Rendu'), segmented([['normal', 'Textures'], ['clay', 'Argile (pour décalquer)']], P.style, v => { P.style = v; applyScene(); touch(); })),
        toggle('Grille au sol (jamais exportée)', P.grid, v => { P.grid = v; applyScene(); touch(); })],
    });
  }
  function animSheet() {
    const fps = slider({ label: 'Images / s', min: 1, max: 60, step: 1, value: P.fps, oninput: v => { P.fps = v; touch(); updateTop(); } });
    sheet({
      title: 'Animation',
      content: [fps, h('div', { class: 'seg' }, [8, 12, 15, 24, 30].map(v => h('button', { onclick: () => { P.fps = v; fps.set(v); touch(); updateTop(); } }, v))),
        slider({ label: 'Durée', min: 1, max: 600, step: 1, curve: 2, value: Math.min(600, P.len), fmt: v => `${v} frames · ${(v / P.fps).toFixed(1)} s`, oninput: v => { P.len = v; syncLen(); touch(); } }),
        toggle('Lecture en boucle', P.loop, v => { P.loop = v; touch(); }),
        h('p', { class: 'hint' }, 'Chaque objet ou os que vous déplacez reçoit une clé ◆ sur le frame courant. Changez de frame, déplacez à nouveau : le mouvement entre les deux est calculé.')],
    });
  }
  function menuSheet() {
    const s = sheet({
      title: P.name,
      content: h('div', { class: 'list' },
        item('person', 'Copier un mouvement filmé', () => { s.close(); mocapSheet(); }),
        item('brush', 'Décalquer en 2D / envoyer un décor', () => { s.close(); to2dSheet(); }),
        item('export', 'Exporter la vidéo ou une image', () => { s.close(); exportSheet(); }),
        item('edit', 'Renommer le projet', async () => { s.close(); const n = await promptDlg('Nom du projet', P.name); if (n) { P.name = n; touch(); } }),
        item('fit', 'Recadrer la vue', () => { s.close(); camera.position.set(3, 2.2, 5); orbit.target.set(0, 1, 0); orbit.update(); }),
        item('settings', 'Aide : les gestes', () => {
          s.close();
          sheet({ title: 'Les gestes en 3D', content: h('dl', { class: 'help' }, [['Un doigt', 'tourner autour de la scène'], ['Deux doigts', 'déplacer et zoomer'], ['Toucher', 'sélectionner un objet, ou un os en mode Pose'], ['Poignées colorées', 'déplacer, tourner ou agrandir la sélection'], ['Bouton ◆', 'poser ou retirer une clé sur le frame'], ['Cadre orange', 'ce que voit la caméra, donc ce qui est exporté']].map(([a, b]) => [h('dt', {}, a), h('dd', {}, b)])) });
        })),
    });
  }
  function exportSheet() {
    stop();
    const o = { kind: 'mp4', scale: 1 }, info = h('p', { class: 'hint' });
    const upd = () => { info.textContent = (o.kind === 'png' ? `Image du frame ${frame + 1}` : `${P.len} images · ${(P.len / P.fps).toFixed(1)} s`) + ` · ${Math.round(P.w * o.scale / 2) * 2} × ${Math.round(P.h * o.scale / 2) * 2} px`; };
    const s = sheet({
      title: 'Exporter',
      content: [segmented([['mp4', 'Vidéo'], ['png', 'Image']], o.kind, v => { o.kind = v; upd(); }),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Taille'), segmented([[1, '100 %'], [0.5, '50 %'], [0.25, '25 %']], o.scale, v => { o.scale = v; upd(); })), info,
        h('button', { class: 'btn primary wide', onclick: go }, 'Exporter')],
    });
    upd();
    async function go() {
      s.close();
      const w = Math.max(2, Math.round(P.w * o.scale / 2) * 2), hh = Math.max(2, Math.round(P.h * o.scale / 2) * 2), b = busy('Export…'), keep = frame;
      let r;
      try {
        if (o.kind === 'png') r = { blob: await toBlob(renderShot(frame, w, hh, false), 'image/png'), ext: 'png' };
        else r = await io.encodeVideo(w, hh, P.fps, async push => { for (let i = 0; i < P.len; i++) { await push(renderShot(i, w, hh, false), i); b.update(`Image ${i + 1} / ${P.len}`, (i + 1) / P.len); if (i % 3 === 0) await nextPaint(); } });
      } catch (e) { console.error(e); toast('Export impossible : ' + (e.message || e), 5000); return; }
      finally { b.close(); frame = keep; endShots(); }
      const name = `${io.safeName(P.name)}.${r.ext}`, url = URL.createObjectURL(r.blob);
      sheet({
        title: 'Export terminé', tall: true, onClose: () => URL.revokeObjectURL(url),
        content: [r.ext === 'png' ? h('img', { src: url, class: 'result', alt: 'Résultat' }) : h('video', { src: url, controls: true, loop: true, muted: true, playsInline: true, autoplay: true, class: 'result' }),
          h('p', { class: 'hint' }, `${name} · ${(r.blob.size / 1048576).toFixed(2)} Mo`),
          h('button', { class: 'btn primary wide', onclick: async () => { if (await io.saveToGallery(r.blob, name) === 'download') toast('Fichier enregistré dans les téléchargements'); }, html: icon('share', 20) + '<span>Enregistrer dans la galerie</span>' }),
          h('button', { class: 'btn wide', onclick: () => { io.download(r.blob, name); toast('Fichier enregistré dans les téléchargements'); }, html: icon('export', 20) + '<span>Télécharger le fichier</span>' })],
      });
    }
  }

  // ---------- Capture de mouvement : on se filme, le personnage reproduit le mouvement ----------
  function mocapSheet() {
    stop();
    const chars = P.objects.filter(o => rt.get(o.id)?.bones.length);
    if (!chars.length) { toast('Importez d’abord un personnage avec squelette (glb, vrm, fbx, pmx…) : touchez « Ajouter »', 4000); return; }
    let o = chars.find(x => x.id === sel.obj) || chars[0];
    const s = sheet({
      title: 'Copier un mouvement filmé', tall: true,
      content: [
        h('p', { class: 'hint' }, `Filmez-vous : chaque mouvement de votre corps est reproduit par le personnage, à partir du frame ${frame + 1}. Tout est calculé sur l’appareil, la vidéo n’est envoyée nulle part.`),
        chars.length > 1 ? h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Personnage'), h('select', { class: 'input', onchange: e => { o = chars.find(x => x.id === e.target.value); } }, chars.map(c => h('option', { value: c.id, selected: c === o }, c.name)))) : null,
        h('button', { class: 'btn primary wide', onclick: () => pick(true), html: icon('camera', 20) + '<span>Me filmer</span>' }),
        h('button', { class: 'btn wide', onclick: () => pick(false), html: icon('video', 20) + '<span>Choisir une vidéo</span>' }),
        h('dl', { class: 'help' }, [['Cadre', 'tout le corps dans l’image, pieds compris'], ['Téléphone', 'posé, sans bouger'], ['Lumière', 'bonne, pas de contre-jour'], ['Tenue', 'qui se détache du fond']].map(([a, b]) => [h('dt', {}, a), h('dd', {}, b)])),
        h('p', { class: 'hint' }, 'La première fois, le détecteur de mouvement (24 Mo) est téléchargé puis gardé sur l’appareil.')],
    });
    function pick(cam) {
      const rig = mocap.findRig(rt.get(o.id).bones);
      if (!rig.ok) { toast(`Squelette de « ${o.name} » non reconnu (manque : ${rig.missing.join(', ')})`, 5000); return; }
      const inp = h('input', { type: 'file', accept: 'video/*', style: { display: 'none' } });
      if (cam) inp.setAttribute('capture', 'user');
      inp.addEventListener('change', () => { const f = inp.files[0]; inp.remove(); if (f) { s.close(); mocapOptions(o, f); } });
      document.body.append(inp); inp.click();
    }
  }
  async function mocapOptions(o, file) {
    const v = h('video', { muted: true, playsInline: true, controls: true, preload: 'auto', class: 'result' });
    v.src = URL.createObjectURL(file);
    try { await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; setTimeout(rej, 15000); }); }
    catch { toast('Vidéo illisible sur cet appareil'); URL.revokeObjectURL(v.src); return; }
    const dur = await mocap.videoDuration(v), f0 = frame;
    const opt = { start: 0, len: Math.min(dur, 30), smooth: 'mid', ground: true, mirror: false };
    let started = false;
    const info = h('p', { class: 'hint' });
    const upd = () => {
      const n = Math.max(1, Math.round(opt.len * P.fps));
      info.textContent = `${n} frames (${opt.len.toFixed(1)} s à ${P.fps} i/s), du frame ${f0 + 1} au frame ${f0 + n}.` + (f0 + n > P.len ? ` La scène sera allongée à ${Math.min(3000, f0 + n)} frames.` : '');
    };
    const lenS = slider({ label: 'Durée', min: 0.1, max: Math.max(0.2, Math.min(dur, 60)), step: 0.1, value: opt.len, fmt: x => x.toFixed(1) + ' s', oninput: x => { opt.len = Math.max(0.1, Math.min(x, dur - opt.start)); upd(); } });
    const s = sheet({
      title: 'Copier le mouvement de « ' + o.name + ' »', tall: true, onClose: () => { if (!started) URL.revokeObjectURL(v.src); },
      content: [v,
        slider({ label: 'Début', min: 0, max: Math.max(0.1, dur), step: 0.1, value: 0, fmt: x => x.toFixed(1) + ' s', oninput: x => { opt.start = Math.min(x, Math.max(0, dur - 0.1)); if (opt.len > dur - opt.start) { opt.len = Math.max(0.1, dur - opt.start); lenS.set(opt.len); } v.currentTime = opt.start; upd(); } }),
        lenS,
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Lissage'), segmented([['low', 'Léger'], ['mid', 'Moyen'], ['high', 'Fort']], opt.smooth, x => { opt.smooth = x; })),
        toggle('Pieds posés au sol', opt.ground, x => { opt.ground = x; }),
        toggle('Effet miroir (gauche ↔ droite)', opt.mirror, x => { opt.mirror = x; }),
        info,
        h('button', { class: 'btn primary wide', onclick: () => { started = true; s.close(); runMocap(o, v, opt, f0); } }, 'Copier le mouvement')],
    });
    upd();
  }
  async function runMocap(o, v, opt, f0) {
    v.pause(); v.play().then(() => v.pause()).catch(() => {}); // iOS : une vidéo jamais lue n'affiche pas l'image demandée
    const r = rt.get(o.id), rig = mocap.findRig(r.bones);
    let cancel = false, frames = null;
    const cv = h('canvas', { class: 'mocap-view' }), txt = h('div', { class: 'busy-txt' }, 'Chargement du détecteur de mouvement…'), bar = h('div', { class: 'busy-bar' }, h('i', {}));
    const el = h('div', { class: 'busy' }, h('div', { class: 'busy-box' }, cv, txt, bar,
      h('button', { class: 'btn small', onclick: () => { cancel = true; txt.textContent = 'Arrêt…'; } }, 'Annuler')));
    document.body.append(el);
    const k = Math.min(1, 280 / Math.max(v.videoWidth || 1, v.videoHeight || 1));
    cv.width = Math.round((v.videoWidth || 280) * k); cv.height = Math.round((v.videoHeight || 160) * k);
    const x = cv.getContext('2d');
    try {
      frames = await mocap.track(v, {
        start: opt.start, len: opt.len, fps: P.fps, cancelled: () => cancel,
        onFrame: async (i, n, f) => {
          x.drawImage(v, 0, 0, cv.width, cv.height); mocap.drawSkeleton(x, f, cv.width, cv.height);
          txt.textContent = `Analyse du mouvement : image ${i + 1} / ${n}`;
          bar.classList.add('on'); bar.firstChild.style.width = Math.round((i + 1) / n * 100) + '%';
          if (i % 2 === 0) await nextPaint();
        },
      });
    } catch (e) { console.error(e); toast('Analyse impossible : ' + (e.message || e), 6000); }
    finally { el.remove(); URL.revokeObjectURL(v.src); }
    if (!frames) return;
    if (!frames.some(Boolean)) { toast('Personne n’a été vu dans la vidéo. Filmez tout le corps, bien éclairé.', 5000); return; }
    const { pts, seen } = mocap.prepare(frames, { mirror: opt.mirror, sigma: { low: 0.03, mid: 0.06, high: 0.12 }[opt.smooth] * P.fps });
    const limbs = mocap.limbsFrom(seen, rig);
    if (!limbs.body) { toast('Le corps n’est pas assez visible dans la vidéo pour copier le mouvement.', 5000); return; }
    const b = busy('Transfert du mouvement…'), keys = new Map(), n = pts.length;
    try {
      const solver = mocap.makeSolver(r, rig);
      for (let i = 0; i < n; i++) {
        for (const kf of solver.solve(pts[i], { ...limbs, ground: opt.ground })) {
          const bi = r.bones.indexOf(kf.bone); if (bi < 0) continue;
          let a = keys.get(bi); if (!a) keys.set(bi, a = []);
          a.push({ f: f0 + i, p: kf.p, q: kf.q, s: kf.s });
        }
        if (i % 60 === 59) { b.update(null, (i + 1) / n); await nextPaint(); }
      }
    } catch (e) { console.error(e); toast('Transfert impossible : ' + (e.message || e), 6000); return; }
    finally { b.close(); }
    pushUndo(); setClip(o, -1); // le mouvement filmé remplace l'animation du fichier
    for (const [bi, a] of keys) {
      const key = o.id + '#' + bi, old = (P.tracks[key] || []).filter(kf => kf.f < f0 || kf.f >= f0 + n);
      P.tracks[key] = [...old, ...a].sort((p, q) => p.f - q.f);
    }
    if (f0 + n > P.len) { P.len = Math.min(3000, f0 + n); syncLen(); }
    touch(); select(o.id, null); evaluate(); drawTicks(); updateTop();
    const off = [rig.legs && !limbs.legs.l && !limbs.legs.r && 'jambes', !limbs.head && 'tête'].filter(Boolean);
    toast(`Mouvement copié sur « ${o.name} » : ${n} frames, ${keys.size} os.` + (off.length ? ` Hors champ, non suivis : ${off.join(', ')}.` : ''), 5000);
    setFrame(f0); play();
  }

  // ---------- Vers la 2D ----------
  async function to2dSheet() {
    stop();
    const all = (await db.listProjects()).filter(m => m.kind !== '3d').sort((a, b) => (b.modified || 0) - (a.modified || 0));
    const linked = all.find(m => m.link3d === P.id);
    const o = { what: 'anim', step: P.fps > 15 ? 2 : 1, dest: linked ? linked.id : 'new', alpha: false };
    const info = h('p', { class: 'hint' }), stepRow = h('div', {});
    const upd = () => {
      stepRow.replaceChildren(...(o.what === 'anim' ? [h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Un dessin tous les'), segmented([[1, '1'], [2, '2'], [3, '3'], [4, '4']], o.step, v => { o.step = v; upd(); }), h('span', { class: 'lbl' }, 'frames'))] : []));
      info.textContent = o.what === 'anim'
        ? `${Math.ceil(P.len / o.step)} images de l’animation 3D seront posées sur un calque « Référence 3D », sous vos calques de dessin. Il ne reste qu’à décalquer par-dessus, frame par frame.`
        : `L’image du frame ${frame + 1} devient un calque de décor fixe, visible sur tous les frames du projet 2D.`;
    };
    const s = sheet({
      title: 'Envoyer vers la 2D', tall: true,
      content: [
        segmented([['anim', 'Animation à décalquer'], ['still', 'Décor fixe']], o.what, v => { o.what = v; upd(); }), stepRow,
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Projet 2D'), h('select', { class: 'input', onchange: e => o.dest = e.target.value },
          [h('option', { value: 'new', selected: o.dest === 'new' }, 'Nouveau projet'), ...all.map(m => h('option', { value: m.id, selected: o.dest === m.id }, m.name + (m.link3d === P.id ? ' (lié)' : '')))])),
        toggle('Fond transparent (le personnage seul)', o.alpha, v => o.alpha = v), info,
        h('button', { class: 'btn primary wide', onclick: go }, 'Envoyer et ouvrir en 2D')],
    });
    upd();
    async function go() {
      s.close();
      const b = busy('Rendu de la 3D…'), keep = frame;
      let p2;
      try {
        dirty = true; await save();
        p2 = o.dest === 'new' ? new Project({ name: P.name + ' (2D)', w: P.w, h: P.h, fps: P.fps, surplus: 0.2 }) : await Project.load(o.dest);
        if (!p2) throw new Error('Projet 2D introuvable');
        p2.link3d = P.id;
        const layer = p2.makeLayer(o.what === 'anim' ? 'Référence 3D' : 'Décor 3D');
        if (o.what === 'anim') layer.opacity = 0.6;
        p2.layers.unshift(layer);
        const k = Math.min(p2.w / P.w, p2.h / P.h), dw = Math.round(P.w * k), dh = Math.round(P.h * k);
        const cv = document.createElement('canvas'); cv.width = p2.cw; cv.height = p2.ch; const x = cv.getContext('2d');
        const cel = async f => {
          const s2 = renderShot(f, dw, dh, o.alpha);
          x.clearRect(0, 0, cv.width, cv.height); x.drawImage(s2, p2.mx + (p2.w - dw) / 2, p2.my + (p2.h - dh) / 2);
          return p2.celFromBlob(await toBlob(cv, 'image/webp', 0.92), true);
        };
        if (o.what === 'still') { layer.fixed = true; layer.cel = (await cel(frame)).id; p2.staleAll(); }
        else {
          const n = Math.ceil(P.len / o.step);
          for (let i = 0; i < n; i++) {
            if (!p2.frames[i]) { const f = p2.makeFrame(); f.hold = o.step; p2.frames.push(f); } else if (o.dest === 'new') p2.frames[i].hold = o.step;
            p2.frames[i].cels[layer.id] = (await cel(i * o.step)).id; p2.frames[i].stale = true;
            b.update(`Image ${i + 1} / ${n}`, (i + 1) / n); if (i % 2 === 0) await nextPaint();
          }
        }
        await p2.save();
      } catch (e) { console.error(e); toast('Envoi impossible : ' + (e.message || e), 5000); b.close(); frame = keep; endShots(); return; }
      b.close(); frame = keep; endShots();
      alive = false; ro.disconnect(); orbit.dispose(); tc.dispose(); renderer.dispose(); renderer.forceContextLoss?.();
      nav.open2d(p2.id);
    }
  }

  // ---------- Démarrage ----------
  resize(); applyScene(); updateTop(); optbar(); tick();
  [...els.tools.children].forEach(b => b.classList.toggle('on', b.dataset.tool === mode));
  if (P.objects.length) {
    const b = busy('Chargement de la scène…');
    try {
      for (const o of [...P.objects]) {
        try {
          if (o.kind === 'prim') { attach(o, makePrim(o)); continue; }
          const r = await loadModel(await db.getCel(P.id, 'file:' + o.id));
          if (o.vmd && r.mesh) {
            const vb = await db.getCel(P.id, 'vmd:' + o.id);
            if (vb) { r.clips = [await loadVMD(vb, r.mesh)]; const { CCDIKSolver } = await import('three/addons/animation/CCDIKSolver.js'); const iks = r.mesh.geometry.userData.MMD?.iks; attach(o, r); if (iks?.length) r.ik = new CCDIKSolver(r.mesh, iks); continue; }
          }
          attach(o, r);
        } catch (e) { console.error(e); toast(`« ${o.name} » n’a pas pu être rechargé`); P.objects.splice(P.objects.indexOf(o), 1); }
      }
    } finally { b.close(); }
    applyScene(); evaluate(); drawTicks();
  } else setTimeout(() => alive && toast('Touchez « Ajouter » pour importer un modèle 3D ou prendre un mannequin', 3500), 400);
  window.addEventListener('pagehide', () => alive && save());
  return { importFiles, state: () => ({ frame, sel, mode, objects: P.objects, tracks: P.tracks, rt }) };
}

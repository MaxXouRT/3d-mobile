// Modèle d'un projet 2D : calques, frames, celluloïds (une image par calque et par frame).
// Les celluloïds sont chargés à la demande et libérés quand la mémoire est pleine (important sur mobile).
import * as db from './store.js';
import { compositeFrame } from './render.js';

export const uid = () => Math.random().toString(36).slice(2, 10);
const toBlob = (c, type, q) => new Promise(r => c.toBlob(r, type, q));

export class Project {
  constructor(m) {
    Object.assign(this, {
      id: uid(), name: 'Sans titre', w: 1920, h: 1080, surplus: 0.2, fps: 12, bg: '#ffffff',
      layers: [], frames: [], effects: [], camEase: true, loop: true,
      onion: { on: true, prev: 1, next: 0, opacity: 0.35 }, created: Date.now(),
    }, m);
    this.mx = Math.round(this.w * this.surplus / 2); this.my = Math.round(this.h * this.surplus / 2);
    this.cw = this.w + 2 * this.mx; this.ch = this.h + 2 * this.my;
    this.ps = Math.min(1, 720 / Math.max(this.cw, this.ch)); // échelle des aperçus
    this.cels = new Map(); this.lru = new Map(); this.pins = new Set();
    this.queue = Promise.resolve(); this.dead = []; this.ver = 0;
    const mem = navigator.deviceMemory || 4;
    this.maxLoaded = Math.max(8, Math.floor((mem <= 4 ? 28e6 : 48e6) / (this.cw * this.ch)));
    for (const f of this.frames) { f.stale = true; for (const id of Object.values(f.cels)) this.cels.set(id, { id, saved: true }); }
    for (const l of this.layers) if (l.fixed && l.cel) this.cels.set(l.cel, { id: l.cel, saved: true });
    if (!this.layers.length) { this.layers.push(this.makeLayer('Calque 1')); this.frames.push(this.makeFrame()); }
  }
  static async load(id) { const m = await db.getProject(id); return m ? new Project(m) : null; }

  makeLayer(name) { return { id: uid(), name, visible: true, opacity: 1, blend: 'source-over', locked: false, fixed: false, cel: null }; }
  makeFrame() { return { id: uid(), hold: 1, cels: {}, cam: null, stale: true }; }
  layer(id) { return this.layers.find(l => l.id === id); }
  run(fn) { const r = this.queue.then(fn); this.queue = r.catch(e => console.error(e)); return r; }

  // --- Celluloïds ---
  celOf(layer, frame) { const id = layer.fixed ? layer.cel : frame.cels[layer.id]; return id ? this.cels.get(id) : undefined; }
  newCanvas() { const c = document.createElement('canvas'); c.width = this.cw; c.height = this.ch; c._ctx = c.getContext('2d'); return c; }
  // Crée (si besoin) le celluloïd du calque sur ce frame, prêt à dessiner.
  celFor(layer, frame) {
    let cel = this.celOf(layer, frame);
    if (!cel) {
      cel = { id: uid(), canvas: this.newCanvas() };
      this.cels.set(cel.id, cel);
      if (layer.fixed) layer.cel = cel.id; else frame.cels[layer.id] = cel.id;
      this.lru.set(cel.id, cel); this.pins.add(cel.id);
    }
    return cel;
  }
  async ensure(cel) {
    if (!cel) return;
    if (!cel.canvas) {
      const blob = cel.saved ? await db.getCel(this.id, cel.id) : null;
      const c = this.newCanvas();
      if (blob) { const bmp = await createImageBitmap(blob); c._ctx.drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.(); }
      cel.canvas = c;
    }
    this.lru.delete(cel.id); this.lru.set(cel.id, cel);
  }
  async flush(cel) {
    if (!cel.canvas || !cel.dirty) return;
    cel.dirty = false;
    const blob = await toBlob(cel.canvas, cel.lossy ? 'image/webp' : 'image/png', 0.92);
    await db.putCel(this.id, cel.id, blob); cel.saved = true;
  }
  async trim(keep) {
    for (const [id, cel] of this.lru) {
      if (this.lru.size <= this.maxLoaded) break;
      if (this.pins.has(id) || keep?.has(id)) continue;
      await this.flush(cel);
      if (cel.canvas) { cel.canvas.width = cel.canvas.height = 0; cel.canvas = null; }
      this.lru.delete(id);
    }
  }
  frameCelIds(frame) {
    const ids = new Set();
    for (const l of this.layers) { const id = l.fixed ? l.cel : frame.cels[l.id]; if (id) ids.add(id); }
    return ids;
  }
  // Charge tous les celluloïds d'un frame. current=true : ce frame devient celui qu'on édite.
  loadFrame(i, current = false) {
    return this.run(async () => {
      const f = this.frames[i]; if (!f) return;
      const ids = this.frameCelIds(f);
      if (current) this.pins = ids;
      for (const id of ids) await this.ensure(this.cels.get(id));
      await this.trim(ids);
    });
  }
  markDirty(cel, frame) {
    cel.dirty = true; cel.lossy = false;
    const layer = this.layers.find(l => l.fixed && l.cel === cel.id);
    if (layer) this.frames.forEach(f => f.stale = true); else if (frame) frame.stale = true;
    this.touch();
  }
  dropCel(id) {
    const cel = this.cels.get(id); if (!cel) return;
    if (cel.canvas) cel.canvas.width = cel.canvas.height = 0;
    this.cels.delete(id); this.lru.delete(id); this.pins.delete(id); this.dead.push(id);
  }
  // Copie d'un celluloïd (passe par le stockage pour ne pas saturer la mémoire).
  async cloneCel(cel) {
    if (!cel) return null;
    await this.flush(cel);
    if (!cel.saved) return null;
    const blob = await db.getCel(this.id, cel.id); if (!blob) return null;
    const c = { id: uid(), saved: true, lossy: cel.lossy };
    await db.putCel(this.id, c.id, blob);
    this.cels.set(c.id, c);
    return c;
  }
  // Enregistre une image déjà encodée comme celluloïd (import vidéo / séquence).
  async celFromBlob(blob, lossy) {
    const c = { id: uid(), saved: true, lossy };
    await db.putCel(this.id, c.id, blob);
    this.cels.set(c.id, c);
    return c;
  }

  // --- Aperçus (composite basse résolution de chaque frame : vignettes, pelure d'oignon, lecture) ---
  previewCanvas(f) {
    if (!f.preview) { const c = document.createElement('canvas'); c.width = Math.round(this.cw * this.ps); c.height = Math.round(this.ch * this.ps); c._ctx = c.getContext('2d'); f.preview = c; }
    return f.preview;
  }
  // Synchrone : à utiliser quand les celluloïds du frame sont chargés (frame courant).
  refreshPreview(f) { compositeFrame(this, f, this.previewCanvas(f)._ctx, this.ps); f.stale = false; this.ver++; }
  buildPreview(i) {
    return this.run(async () => {
      const f = this.frames[i]; if (!f || !f.stale) return;
      const ids = this.frameCelIds(f);
      for (const id of ids) await this.ensure(this.cels.get(id));
      this.refreshPreview(f);
      await this.trim(ids);
    });
  }
  staleAll() { this.frames.forEach(f => f.stale = true); }

  // --- Sauvegarde ---
  touch() { this.changed = true; clearTimeout(this.saveT); this.saveT = setTimeout(() => this.save(), 1500); }
  toJSON() {
    const { id, name, w, h, surplus, fps, bg, effects, camEase, loop, onion, created } = this;
    return {
      id, name, w, h, surplus, fps, bg, effects, camEase, loop, onion, created, modified: Date.now(), thumb: this.thumb,
      layers: this.layers,
      frames: this.frames.map(f => ({ id: f.id, hold: f.hold, cels: f.cels, cam: f.cam })),
    };
  }
  save() {
    clearTimeout(this.saveT);
    return this.run(async () => {
      for (const cel of this.cels.values()) if (cel.dirty) await this.flush(cel);
      for (const id of this.dead.splice(0)) await db.delCel(this.id, id);
      const f0 = this.frames[0];
      if (f0?.preview && !f0.stale) {
        const t = document.createElement('canvas'), k = 240 / this.w; t.width = 240; t.height = Math.round(this.h * k);
        const x = t.getContext('2d'); x.fillStyle = this.bg; x.fillRect(0, 0, t.width, t.height);
        x.drawImage(f0.preview, -this.mx * k, -this.my * k, this.cw * k, this.ch * k);
        this.thumb = t.toDataURL('image/jpeg', 0.7);
      }
      await db.putProject(this.toJSON());
      this.changed = false;
    });
  }
  close() { clearTimeout(this.saveT); for (const c of this.cels.values()) if (c.canvas) c.canvas.width = c.canvas.height = 0; }
}

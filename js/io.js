// Import (images, séquences, vidéo image par image) et export (MP4, GIF, PNG, séquence PNG).
import { S, emit } from './state.js';
import { h, sheet, slider, toast, busy, nextPaint } from './ui.js';
import { scratch } from './effects.js';
import { compositeFrame, renderOutput, totalTicks, frameAtTick } from './render.js';

const toBlob = (c, type, q) => new Promise(r => c.toBlob(r, type, q));
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const safeName = s => (s || 'animation').replace(/[^\w\-àâäéèêëîïôöùûüç ]+/gi, '_').trim() || 'animation';

// Place une image dans le cadre du format (centrée, entière), le surplus reste libre.
function drawContain(ctx, p, img, iw, ih) {
  const k = Math.min(p.w / iw, p.h / ih), w = iw * k, hh = ih * k;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, p.mx + (p.w - w) / 2, p.my + (p.h - hh) / 2, w, hh);
}
function addLayerAbove(p, name) {
  const layer = p.makeLayer(name), i = p.layers.findIndex(l => l.id === S.layerId);
  p.layers.splice(i + 1, 0, layer);
  return layer;
}
function frameAt(p, i) { while (p.frames.length <= i) p.frames.push(p.makeFrame()); return p.frames[i]; }

export async function importImages(files) {
  const p = S.project; files = [...files].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  if (files.length === 1) {
    let bmp;
    try { bmp = await createImageBitmap(files[0]); } catch { toast('Image illisible'); return; }
    const layer = addLayerAbove(p, 'Référence'), frame = p.frames[S.frameIdx], cel = p.celFor(layer, frame);
    drawContain(cel.canvas._ctx, p, bmp, bmp.width, bmp.height); bmp.close?.();
    p.markDirty(cel, frame); p.refreshPreview(frame); // enregistré sans perte : la pipette rend les couleurs exactes
    S.layerId = layer.id; emit('layers'); emit('edited');
    toast('Image importée sur un nouveau calque');
    return;
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const b = busy('Import de la séquence…'), layer = addLayerAbove(p, 'Séquence'), tmp = scratch('imp', p.cw, p.ch);
  try {
    for (let i = 0; i < files.length; i++) {
      const bmp = await createImageBitmap(files[i]).catch(() => null); if (!bmp) continue;
      tmp._ctx.clearRect(0, 0, p.cw, p.ch); drawContain(tmp._ctx, p, bmp, bmp.width, bmp.height); bmp.close?.();
      const cel = await p.celFromBlob(await toBlob(tmp, 'image/png'), false), f = frameAt(p, S.frameIdx + i);
      f.cels[layer.id] = cel.id; f.stale = true;
      b.update(`Image ${i + 1} / ${files.length}`, (i + 1) / files.length);
    }
  } finally { b.close(); tmp.width = tmp.height = 1; }
  S.layerId = layer.id; p.touch(); emit('structure');
}

export async function importVideo(file) {
  const p = S.project, v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = URL.createObjectURL(file);
  try {
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = rej; setTimeout(rej, 15000); });
  } catch { toast('Vidéo illisible sur cet appareil'); URL.revokeObjectURL(v.src); return; }
  const dur = isFinite(v.duration) ? v.duration : 10;
  const o = { start: 0, len: Math.min(dur, 3), fps: p.fps };
  const info = h('p', { class: 'hint' });
  const count = () => Math.max(1, Math.round(o.len * o.fps));
  const upd = () => { info.textContent = `${count()} frames seront créés à partir du frame ${S.frameIdx + 1}, sur un nouveau calque.` + (count() > 240 ? ' Beaucoup de frames : l’import sera long.' : ''); };
  upd();
  const go = await new Promise(res => {
    const s = sheet({
      title: 'Importer une vidéo image par image', modal: true, onClose: () => res(false),
      content: [
        slider({ label: 'Début', min: 0, max: Math.max(0.1, dur), step: 0.1, value: 0, fmt: x => x.toFixed(1) + ' s', oninput: x => { o.start = x; o.len = Math.min(o.len, dur - x); upd(); } }),
        slider({ label: 'Durée', min: 0.1, max: Math.max(0.2, Math.min(dur, 30)), step: 0.1, value: o.len, fmt: x => x.toFixed(1) + ' s', oninput: x => { o.len = Math.min(x, dur - o.start); upd(); } }),
        slider({ label: 'Images / s', min: 1, max: Math.max(p.fps, 30), step: 1, value: o.fps, oninput: x => { o.fps = x; upd(); } }),
        info,
        h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: () => { res(true); s.close(); } }, 'Importer')),
      ],
    });
  });
  if (!go) { URL.revokeObjectURL(v.src); return; }
  const n = count(), b = busy('Lecture de la vidéo…'), layer = addLayerAbove(p, 'Vidéo'), tmp = scratch('imp', p.cw, p.ch);
  try {
    await v.play().then(() => v.pause()).catch(() => {});
    for (let i = 0; i < n; i++) {
      const t = Math.min(dur - 0.001, o.start + i / o.fps);
      await new Promise(res => { const done = () => { v.removeEventListener('seeked', done); res(); }; v.addEventListener('seeked', done); v.currentTime = t; setTimeout(done, 4000); });
      tmp._ctx.clearRect(0, 0, p.cw, p.ch); drawContain(tmp._ctx, p, v, v.videoWidth, v.videoHeight);
      const cel = await p.celFromBlob(await toBlob(tmp, 'image/webp', 0.96), true), f = frameAt(p, S.frameIdx + i);
      f.cels[layer.id] = cel.id; f.stale = true;
      b.update(`Frame ${i + 1} / ${n}`, (i + 1) / n);
    }
  } finally { b.close(); tmp.width = tmp.height = 1; URL.revokeObjectURL(v.src); }
  S.layerId = layer.id; p.touch(); emit('structure');
  toast(`${n} frames importés`);
}

// ---------- Export ----------
async function eachTick(p, o, onFrame, b) {
  const even = x => Math.max(2, Math.round(x / 2) * 2);
  const ow = even(p.w * o.scale), oh = even(p.h * o.scale);
  const out = scratch('export', ow, oh, { willReadFrequently: !!o.read }), full = scratch('full', p.cw, p.ch);
  const ticks = o.only != null ? [o.only] : [...Array(totalTicks(p)).keys()];
  let last = -1;
  try {
    for (let i = 0; i < ticks.length; i++) {
      const t = ticks[i], fi = frameAtTick(p, t);
      if (fi !== last) { await p.loadFrame(fi); compositeFrame(p, p.frames[fi], full._ctx, 1); last = fi; }
      renderOutput(p, t, out._ctx, ow, oh, full, { transparent: o.transparent });
      await onFrame(out, i, ticks.length);
      b?.update(`Image ${i + 1} / ${ticks.length}`, (i + 1) / ticks.length);
      if (i % 3 === 0) await nextPaint();
    }
  } finally { full.width = full.height = 1; await S.gotoFrame(S.frameIdx); }
  return { ow, oh, out };
}

async function pickCodec(w, h, fps, bitrate) {
  if (typeof VideoEncoder === 'undefined') return null;
  const big = w * h > 1920 * 1088;
  const list = [
    ['avc', big ? 'avc1.640033' : fps > 30 ? 'avc1.64002a' : 'avc1.640028'], ['avc', 'avc1.4d0028'], ['avc', 'avc1.420028'], ['avc', 'avc1.42001f'], ['avc', 'avc1.640033'],
    ['vp9', 'vp09.00.40.08'], ['av1', 'av01.0.08M.08'],
  ];
  for (const [kind, codec] of list) {
    const cfg = { codec, width: w, height: h, bitrate, framerate: fps };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return { kind, cfg }; } catch {}
  }
  return null;
}

// Encode une vidéo. `run(push)` doit appeler `await push(canvas, i)` pour chaque image, dans l'ordre.
// Utilisé par l'export 2D et par l'export 3D.
export async function encodeVideo(w, hh, fps, run) {
  const bitrate = Math.round(Math.min(40e6, Math.max(1.5e6, w * hh * fps * 0.16)));
  const pc = await pickCodec(w, hh, fps, bitrate);
  if (pc) {
    const { Muxer, ArrayBufferTarget } = await import('../vendor/mp4-muxer.mjs');
    const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: pc.kind, width: w, height: hh, frameRate: fps }, fastStart: 'in-memory' });
    let err = null;
    const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { err = e; } });
    enc.configure(pc.cfg);
    const us = 1e6 / fps;
    await run(async (cv, i) => {
      if (err) throw err;
      const vf = new VideoFrame(cv, { timestamp: Math.round(i * us), duration: Math.round(us) });
      enc.encode(vf, { keyFrame: i % (fps * 2) === 0 }); vf.close();
      while (enc.encodeQueueSize > 3) await sleep(8);
    });
    await enc.flush(); enc.close(); if (err) throw err;
    muxer.finalize();
    return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), ext: 'mp4' };
  }
  // Repli : enregistrement en temps réel d'un canvas.
  if (typeof MediaRecorder === 'undefined') throw new Error('Ce navigateur ne sait pas encoder de vidéo. Essayez le GIF ou la séquence PNG.');
  const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
  const rc = scratch('record', w, hh), stream = rc.captureStream(0), track = stream.getVideoTracks()[0];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate }), chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rc._ctx.fillRect(0, 0, w, hh); rec.start();
  await run(async cv => { rc._ctx.drawImage(cv, 0, 0, w, hh); track.requestFrame?.(); await sleep(1000 / fps); });
  await new Promise(r => { rec.onstop = r; rec.stop(); });
  rc.width = rc.height = 1;
  return { blob: new Blob(chunks, { type: mime.split(';')[0] }), ext: mime.includes('mp4') ? 'mp4' : 'webm' };
}
function exportVideo(p, o, b) {
  const even = x => Math.max(2, Math.round(x / 2) * 2);
  return encodeVideo(even(p.w * o.scale), even(p.h * o.scale), p.fps, push => eachTick(p, o, push, b));
}

async function exportGif(p, o, b) {
  const { GIFEncoder, quantize, applyPalette } = await import('../vendor/gifenc.mjs');
  const gif = GIFEncoder(), delay = 1000 / p.fps;
  await eachTick(p, { ...o, read: true }, async cv => {
    const d = cv._ctx.getImageData(0, 0, cv.width, cv.height).data, pal = quantize(d, 256);
    gif.writeFrame(applyPalette(d, pal), cv.width, cv.height, { palette: pal, delay });
  }, b);
  gif.finish();
  return { blob: new Blob([gif.bytes()], { type: 'image/gif' }), ext: 'gif' };
}

// Archive ZIP minimale (sans compression : les PNG le sont déjà).
let crcT;
function crc32(u8) {
  if (!crcT) { crcT = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c; } }
  let c = -1; for (let i = 0; i < u8.length; i++) c = crcT[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function zip(files) {
  const parts = [], central = []; let off = 0;
  const enc = new TextEncoder();
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), n = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint32(14, crc, true); lh.setUint32(18, n, true); lh.setUint32(22, n, true); lh.setUint16(26, name.length, true);
    parts.push(lh, name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint32(16, crc, true); ch.setUint32(20, n, true); ch.setUint32(24, n, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
    central.push(ch, name);
    off += 30 + name.length + n;
  }
  const csize = central.reduce((a, c) => a + c.byteLength, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, csize, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
async function exportPngSeq(p, o, b) {
  const files = [];
  await eachTick(p, o, async (cv, i) => {
    files.push({ name: `${safeName(p.name)}_${String(i + 1).padStart(4, '0')}.png`, data: new Uint8Array(await (await toBlob(cv, 'image/png')).arrayBuffer()) });
  }, b);
  return { blob: zip(files), ext: 'zip' };
}
async function exportPng(p, o) {
  let blob;
  await eachTick(p, { ...o, only: o.tick }, async cv => { blob = await toBlob(cv, 'image/png'); });
  return { blob, ext: 'png' };
}

export async function runExport(kind, o) {
  const p = S.project, b = busy('Préparation de l’export…');
  try {
    await p.save();
    const fn = { mp4: exportVideo, gif: exportGif, zip: exportPngSeq, png: exportPng }[kind];
    const r = await fn(p, o, b);
    return { ...r, name: `${safeName(p.name)}.${r.ext}` };
  } finally { b.close(); }
}

// Enregistre sur le téléphone : feuille de partage (« Enregistrer la vidéo / l'image » → galerie),
// sinon téléchargement classique (dossier Téléchargements, visible dans la galerie sur Android).
export async function saveToGallery(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'cancel'; }
  }
  download(blob, name); return 'download';
}
export function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

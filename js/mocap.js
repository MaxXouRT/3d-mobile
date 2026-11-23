// Capture de mouvement : une vidéo d'une personne anime les os d'un personnage 3D.
// 1. Détection : MediaPipe Pose (Google, Apache 2.0, copié dans vendor/) donne, pour chaque image, 33 points
//    du corps en 3D (en mètres, centrés sur le bassin). Tout est calculé sur l'appareil, rien n'est envoyé.
// 2. Squelette : les os humains du modèle sont reconnus (VRM, Mixamo, MMD, VRoid, Blender, Unreal, 3ds Max…).
// 3. Transfert : chaque os de membre prend la direction du membre filmé en partant de sa pose de repos ;
//    bassin, torse et tête prennent l'orientation filmée. Les pieds restent posés au sol.
import * as THREE from 'three';

const DIR = new URL('../vendor/mediapipe/', import.meta.url).href;
let detector = null, clock = 0;

export async function loadDetector() {
  if (detector) return detector;
  const { FilesetResolver, PoseLandmarker } = await import('../vendor/mediapipe/vision_bundle.mjs');
  const files = await FilesetResolver.forVisionTasks(DIR + 'wasm');
  const make = delegate => PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: DIR + 'pose_landmarker_full.task', delegate }, runningMode: 'VIDEO', numPoses: 1,
  });
  try { detector = await make('GPU'); } catch (e) { console.warn('Détection sur le GPU impossible, passage au processeur', e); detector = await make('CPU'); }
  return detector;
}

// Durée d'une vidéo (certaines vidéos enregistrées par le navigateur annoncent une durée infinie).
export async function videoDuration(v) {
  if (isFinite(v.duration)) return v.duration;
  await seek(v, 1e7);
  const d = isFinite(v.duration) ? v.duration : v.currentTime || 10;
  await seek(v, 0);
  return d;
}
function seek(v, t) {
  return new Promise(res => {
    const done = () => { v.removeEventListener('seeked', done); clearTimeout(to); res(); };
    v.addEventListener('seeked', done); const to = setTimeout(done, 4000); v.currentTime = t;
  });
}

// Suit le corps image par image. Par image : points 3D (w), visibilité (v), position dans l'image (l), ou null.
export async function track(video, { start = 0, len, fps, onFrame, cancelled }) {
  const det = await loadDetector(), n = Math.max(1, Math.round(len * fps)), out = [], end = video.duration - 0.001;
  for (let i = 0; i < n; i++) {
    if (cancelled?.()) return null;
    await seek(video, Math.min(end, start + i / fps));
    clock += Math.ceil(1000 / fps); // le mode vidéo exige des horodatages croissants
    const r = det.detectForVideo(video, clock), w = r.worldLandmarks?.[0], l = r.landmarks?.[0];
    out.push(w && l ? { w: w.map(p => [p.x, p.y, p.z]), v: l.map(p => p.visibility ?? 1), l: l.map(p => [p.x, p.y]), a: video.videoWidth / video.videoHeight || 1 } : null);
    await onFrame?.(i, n, out[i]);
  }
  return out;
}

// Traits du squelette filmé, pour l'aperçu pendant l'analyse.
const BONES2D = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 31], [24, 26], [26, 28], [28, 32], [7, 0], [0, 8]];
export function drawSkeleton(x, f, w, h) {
  if (!f) return;
  x.lineWidth = Math.max(2, w / 120); x.lineCap = 'round';
  for (const [a, b] of BONES2D) {
    if (f.v[a] < 0.3 || f.v[b] < 0.3) continue;
    x.strokeStyle = a > 10 && a % 2 === b % 2 ? (a % 2 ? '#ff8a3d' : '#5cc8ff') : '#fff'; // gauche orange, droite bleu
    x.beginPath(); x.moveTo(f.l[a][0] * w, f.l[a][1] * h); x.lineTo(f.l[b][0] * w, f.l[b][1] * h); x.stroke();
  }
}

// ---------- Points filmés → repère de three.js, trous bouchés, tremblements lissés ----------
const PAIRS = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
const SWAP = Array.from({ length: 33 }, (_, i) => i); for (const [a, b] of PAIRS) { SWAP[a] = b; SWAP[b] = a; }

// Vu par la caméra, MediaPipe place les membres très précisément (≈5° d'écart) ; il devine bien moins
// la profondeur. Chaque segment de membre garde donc la direction vue à l'image et ne prend de la 3D
// que son inclinaison vers l'avant ou l'arrière (et sa longueur). Mesuré sur une danse : 18° → 16° d'écart moyen.
const LIMBS = [[11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [12, 14], [14, 16], [16, 18], [16, 20], [16, 22],
  [23, 25], [25, 27], [27, 29], [27, 31], [24, 26], [26, 28], [28, 30], [28, 32]];
function refine(f) {
  const w = f.w.map(p => p.slice());
  for (const [a, b] of LIMBS) {
    const d = [f.w[b][0] - f.w[a][0], f.w[b][1] - f.w[a][1], f.w[b][2] - f.w[a][2]], len = Math.hypot(...d), flat = Math.hypot(d[0], d[1]);
    const u = [(f.l[b][0] - f.l[a][0]) * (f.a || 1), f.l[b][1] - f.l[a][1]], un = Math.hypot(...u);
    // Membre pointé vers la caméra : sa direction à l'image n'est pas fiable, on garde la 3D.
    const k = un > 1e-6 && flat > 0.3 * len ? flat / un : 0;
    w[b] = k ? [w[a][0] + u[0] * k, w[a][1] + u[1] * k, w[a][2] + d[2]] : [w[a][0] + d[0], w[a][1] + d[1], w[a][2] + d[2]];
  }
  return w;
}

// MediaPipe : x vers la droite de l'image, y vers le bas, z vers le fond. three.js : y vers le haut, z vers la caméra.
// `seen[j]` : part des images où le point j est bien visible (sert à ignorer un membre hors champ).
export function prepare(frames, { mirror = false, sigma = 1.5 } = {}) {
  const n = frames.length, pts = Array.from({ length: n }, () => new Float32Array(99)), seen = new Float32Array(33);
  const W = frames.map(f => f && (f.l ? refine(f) : f.w));
  for (let j = 0; j < 33; j++) {
    const src = mirror ? SWAP[j] : j, ok = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const f = frames[i]; if (!f || f.v[src] < 0.2) continue;
      const [x, y, z] = W[i][src];
      pts[i][j * 3] = mirror ? -x : x; pts[i][j * 3 + 1] = -y; pts[i][j * 3 + 2] = -z; ok[i] = 1;
      if (f.v[src] > 0.5) seen[j]++;
    }
    seen[j] /= n;
    // Point perdu : on garde sa dernière position connue (ou la première, en début de vidéo).
    let k = -1;
    for (let i = 0; i < n; i++) if (ok[i]) k = i; else if (k >= 0) { pts[i].set(pts[k].subarray(j * 3, j * 3 + 3), j * 3); ok[i] = 2; }
    k = -1;
    for (let i = n - 1; i >= 0; i--) if (ok[i] === 1) k = i; else if (!ok[i] && k >= 0) pts[i].set(pts[k].subarray(j * 3, j * 3 + 3), j * 3);
  }
  if (sigma > 0.2 && n > 2) {
    const r = Math.ceil(sigma * 2.5), wt = Array.from({ length: 2 * r + 1 }, (_, d) => Math.exp(-((d - r) ** 2) / (2 * sigma * sigma)));
    const src = pts.map(p => p.slice());
    for (let i = 0; i < n; i++) {
      const acc = new Float32Array(99); let sw = 0;
      for (let d = -r; d <= r; d++) {
        const q = i + d; if (q < 0 || q >= n) continue;
        const w = wt[d + r], s = src[q]; sw += w;
        for (let c = 0; c < 99; c++) acc[c] += s[c] * w;
      }
      for (let c = 0; c < 99; c++) pts[i][c] = acc[c] / sw;
    }
  }
  return { pts, seen };
}

// ---------- Reconnaissance des os humains ----------
const VRM_LIMB = /^(left|right)(UpperArm|LowerArm|Hand|UpperLeg|LowerLeg|Foot|Toes)$/;
const LIMB = [
  ['toes', /(toes?|toebase|ball|つま先)$/],
  ['foot', /(foot|ankle|足首)$/],
  ['upperLeg', /(upleg|upperleg|thigh)$|^足$/],
  ['lowerLeg', /(lowerleg|calf|shin|knee|ひざ|膝)$/],
  ['leg', /leg$/],
  ['hand', /(hand|wrist|手首)$/],
  ['lowerArm', /(forearm|lowerarm|elbow|ひじ|肘)$/],
  ['upperArm', /(upperarm|uparm|arm|腕)$/],
];
const CENTER = [
  ['hips', /(hips?|pelvis|下半身)$/],
  ['spine', /(spine|chest|torso|abdomen|上半身)\d*$/],
  ['neck', /(neck|首)\d*$/],
  ['head', /(head|頭)$/],
];
const SIDE_TOKEN = /(?:^|[\s_.\-])([lr])(?=$|[\s_.\-])/i;

export function roleOf(bone) {
  const hb = bone.userData.humanBone; // os déclaré par un fichier VRM
  if (hb) {
    const m = VRM_LIMB.exec(hb);
    if (m) return { side: m[1][0], role: m[2][0].toLowerCase() + m[2].slice(1) };
    if (/^(hips|neck|head)$/.test(hb)) return { role: hb };
    if (/^(spine|chest|upperChest)$/.test(hb)) return { role: 'spine' };
    return null;
  }
  const n = (bone.name || '').normalize('NFKC').replace(/^.*[:|]/, '');
  let side = /左/.test(n) ? 'l' : /右/.test(n) ? 'r' : /left/i.test(n) ? 'l' : /right/i.test(n) ? 'r' : SIDE_TOKEN.exec(n)?.[1].toLowerCase() || null;
  const b = n.replace(/[左右]|left|right/gi, '').replace(new RegExp(SIDE_TOKEN.source, 'gi'), '').toLowerCase().replace(/[^a-z0-9぀-ヿ一-鿿]/g, '');
  for (const [role, re] of side ? LIMB : CENTER) if (re.test(b)) return { side, role };
  return null;
}

const depthOf = b => { let d = 0; for (let o = b.parent; o; o = o.parent) d++; return d; };
const isAncestor = (a, b) => { for (let o = b?.parent; o; o = o.parent) if (o === a) return true; return false; };

export function findRig(bones) {
  const found = {}, vrm = bones.some(b => b.userData.humanBone);
  for (const b of bones) {
    if (vrm && !b.userData.humanBone) continue; // VRM : seuls les os déclarés comptent (pas les cheveux ni la jupe)
    const r = roleOf(b); if (!r) continue;
    const k = r.side ? r.side + '.' + r.role : r.role;
    (found[k] ||= []).push(b);
  }
  const pick = k => found[k]?.sort((a, b) => depthOf(a) - depthOf(b))[0] || null;
  const rig = { hips: pick('hips'), neck: pick('neck'), head: pick('head'), l: {}, r: {} };
  for (const s of ['l', 'r']) {
    const g = rig[s];
    for (const role of ['upperArm', 'lowerArm', 'hand', 'upperLeg', 'lowerLeg', 'foot', 'toes']) g[role] = pick(s + '.' + role);
    // « Leg » : jambe entière chez Mixamo (UpLeg + Leg), cuisse ailleurs.
    const leg = pick(s + '.leg');
    if (leg) { if (!g.upperLeg) g.upperLeg = leg; else if (!g.lowerLeg) g.lowerLeg = leg; }
  }
  let spine = (found.spine || []).sort((a, b) => depthOf(a) - depthOf(b));
  const above = rig.neck || rig.head || rig.l.upperArm;
  if (above && spine.some(b => isAncestor(b, above))) spine = spine.filter(b => isAncestor(b, above));
  rig.spine = spine;
  if (!rig.hips && rig.l.upperLeg?.parent?.isBone && rig.l.upperLeg.parent === rig.r.upperLeg?.parent) rig.hips = rig.l.upperLeg.parent;
  // Os à déplacer pour garder les pieds au sol : l'ancêtre commun des jambes et du torse.
  const a = rig.l.upperLeg || rig.hips, b = spine[0] || rig.neck || rig.head;
  let top = rig.hips;
  if (a && b) for (let o = a; o; o = o.parent) if (o === b || isAncestor(o, b)) { if (o.isBone && bones.includes(o)) top = o; break; }
  rig.top = top;
  rig.missing = [!(rig.hips || spine.length) && 'bassin', !(rig.l.upperArm && rig.l.lowerArm) && 'bras gauche', !(rig.r.upperArm && rig.r.lowerArm) && 'bras droit'].filter(Boolean);
  rig.ok = !rig.missing.length;
  rig.legs = !!(rig.l.upperLeg && rig.l.lowerLeg && rig.r.upperLeg && rig.r.lowerLeg);
  return rig;
}

// ---------- Transfert du mouvement ----------
const HEAD_PITCH = 0.16; // le nez est plus bas que les oreilles : la tête filmée « regarde » ~9° trop bas (mesuré).
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _mb = new THREE.Matrix4();
// Repère d'un corps : x vers sa gauche, y vers le haut, z = x × y vers l'avant.
function basis(x, up, out = new THREE.Quaternion()) {
  _x.copy(x).normalize(); _y.copy(up).addScaledVector(_x, -up.dot(_x)).normalize(); _z.crossVectors(_x, _y);
  return out.setFromRotationMatrix(_mb.makeBasis(_x, _y, _z));
}
const mid = (a, b) => a.clone().add(b).multiplyScalar(0.5);

// Prépare le transfert vers un modèle (r : { root, bones }) et renvoie solve(points d'une image).
export function makeSolver(r, rig) {
  const { root, bones } = r, inv = new THREE.Matrix4();
  const toRest = () => {
    for (const b of bones) { const s = b.userData.rest; b.position.copy(s.p); b.quaternion.copy(s.q); b.scale.copy(s.s); }
    root.updateWorldMatrix(true, true); inv.copy(root.matrixWorld).invert();
  };
  // Position / orientation dans le repère du modèle (indépendant de sa place dans la scène).
  const posOf = (o, out = new THREE.Vector3()) => out.setFromMatrixPosition(_m.multiplyMatrices(inv, o.matrixWorld));
  const quatOf = (o, out = new THREE.Quaternion()) => { _m.multiplyMatrices(inv, o.matrixWorld).decompose(_p, out, _s); return out; };
  const tipOf = b => { // direction moyenne vers les os enfants (doigts, orteils)
    const kids = b.children.filter(c => c.isBone); if (!kids.length) return null;
    const p = posOf(b), t = new THREE.Vector3(); for (const c of kids) t.add(posOf(c));
    const d = t.multiplyScalar(1 / kids.length).sub(p); return d.lengthSq() > 1e-10 ? d.normalize() : null;
  };

  toRest();
  const rq = new Map(), P = new Map(), depth = new Map();
  const used = [rig.hips, ...rig.spine, rig.neck, rig.head, rig.top, ...['l', 'r'].flatMap(s => Object.values(rig[s]))].filter(Boolean);
  for (const b of used) { P.set(b, posOf(b)); rq.set(b, quatOf(b)); depth.set(b, depthOf(b)); }
  const dir = (a, b) => a && b ? P.get(b).clone().sub(P.get(a)).normalize() : null;
  const L = rig.l, R = rig.r, sh0 = mid(P.get(L.upperArm), P.get(R.upperArm)), xs0 = P.get(L.upperArm).clone().sub(P.get(R.upperArm));
  const hc0 = rig.legs ? mid(P.get(L.upperLeg), P.get(R.upperLeg)) : P.get(rig.hips || rig.spine[0]);
  const xh0 = rig.legs ? P.get(L.upperLeg).clone().sub(P.get(R.upperLeg)) : xs0;
  const up0 = sh0.clone().sub(hc0);
  const qHips0 = basis(xh0, up0), qChest0 = basis(xs0, up0), qHead0 = basis(xs0, new THREE.Vector3(0, 1, 0));
  // Une personne face à la caméra regarde vers +z ; on la tourne pour qu'elle regarde là où regarde le modèle au repos.
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(qHips0).setY(0);
  const yaw = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), fwd.lengthSq() > 1e-6 ? fwd.normalize() : new THREE.Vector3(0, 0, 1));
  const rest = {};
  for (const s of ['l', 'r']) {
    const g = rig[s];
    rest[s] = { upperArm: dir(g.upperArm, g.lowerArm), lowerArm: dir(g.lowerArm, g.hand), hand: g.hand && tipOf(g.hand),
      upperLeg: dir(g.upperLeg, g.lowerLeg), lowerLeg: dir(g.lowerLeg, g.foot), foot: g.foot && (g.toes ? dir(g.foot, g.toes) : tipOf(g.foot)) };
  }
  const feet = [L.foot, R.foot, L.toes, R.toes].filter(Boolean);
  const ground0 = feet.length ? Math.min(...feet.map(b => P.get(b).y)) : 0;
  const keyed = [...new Set(used)].sort((a, b) => depth.get(a) - depth.get(b));

  const V = Array.from({ length: 33 }, () => new THREE.Vector3());
  const pt = (pts, i) => V[i].set(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]).applyQuaternion(yaw);
  const seg = (a, b) => V[b].clone().sub(V[a]);
  const swing = (parentD, restDir, target, out = new THREE.Quaternion()) => {
    const from = restDir.clone().applyQuaternion(parentD);
    if (target.lengthSq() < 1e-10) return out.copy(parentD);
    return out.setFromUnitVectors(from, target.normalize()).multiply(parentD);
  };
  const pitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -HEAD_PITCH);

  // opts : { arms: {l, r}, legs: {l, r}, head, ground } — membres à suivre et pieds au sol.
  function solve(pts, opts) {
    toRest();
    for (let i = 0; i < 33; i++) pt(pts, i);
    const up = mid(V[11], V[12]).sub(mid(V[23], V[24]));
    const dHips = basis(rig.legs ? seg(24, 23) : seg(12, 11), up).multiply(qHips0.clone().invert());
    const dChest = basis(seg(12, 11), up).multiply(qChest0.clone().invert());
    const D = new Map();
    if (rig.hips) D.set(rig.hips, dHips);
    rig.spine.forEach((b, i) => D.set(b, dHips.clone().slerp(dChest, (i + 1) / rig.spine.length)));
    if (opts.head && (rig.head || rig.neck)) {
      const ex = seg(8, 7), f = V[0].clone().sub(mid(V[7], V[8]));
      const dHead = basis(ex, f.clone().cross(ex)).multiply(pitch).multiply(qHead0.clone().invert());
      if (rig.neck) D.set(rig.neck, rig.head ? dChest.clone().slerp(dHead, 0.5) : dHead);
      if (rig.head) D.set(rig.head, dHead);
    }
    for (const [s, o] of [['l', 0], ['r', 1]]) {
      const g = rig[s], rd = rest[s];
      if (opts.arms[s] && rd.upperArm && rd.lowerArm) {
        const a = swing(dChest, rd.upperArm, seg(11 + o, 13 + o)), b = swing(a, rd.lowerArm, seg(13 + o, 15 + o));
        D.set(g.upperArm, a); D.set(g.lowerArm, b);
        if (rd.hand) D.set(g.hand, swing(b, rd.hand, mid(V[17 + o], V[19 + o]).sub(V[15 + o])));
      }
      if (opts.legs[s] && rd.upperLeg && rd.lowerLeg) {
        const a = swing(dHips, rd.upperLeg, seg(23 + o, 25 + o)), b = swing(a, rd.lowerLeg, seg(25 + o, 27 + o));
        D.set(g.upperLeg, a); D.set(g.lowerLeg, b);
        if (rd.foot) D.set(g.foot, swing(b, rd.foot, seg(27 + o, 31 + o)));
      }
    }
    // Du bassin vers les extrémités : orientation voulue dans le modèle → rotation locale de l'os.
    const pq = new THREE.Quaternion(), out = new Map();
    for (const b of keyed) {
      const d = D.get(b); if (!d) continue;
      const q = d.clone().multiply(rq.get(b)).premultiply(quatOf(b.parent, pq).invert());
      if (![q.x, q.y, q.z, q.w].every(Number.isFinite)) continue;
      b.quaternion.copy(q).normalize(); b.updateMatrixWorld(true); out.set(b, true);
    }
    if (opts.ground && rig.top && feet.length && (opts.legs.l || opts.legs.r)) {
      const dy = ground0 - Math.min(...feet.map(b => posOf(b, _p).y));
      if (Number.isFinite(dy)) {
        const p = posOf(rig.top).add(new THREE.Vector3(0, dy, 0));
        _m.multiplyMatrices(inv, rig.top.parent.matrixWorld).invert();
        rig.top.position.copy(p.applyMatrix4(_m)); rig.top.updateMatrixWorld(true); out.set(rig.top, true);
      }
    }
    return [...out.keys()].map(b => ({ bone: b, p: b.position.toArray(), q: b.quaternion.toArray(), s: b.scale.toArray() }));
  }
  return { solve, toRest, yaw, posOf };
}

// Membres à suivre d'après la vidéo : un membre presque jamais visible (hors champ) garde sa pose.
export function limbsFrom(seen, rig) {
  const avg = (...i) => i.reduce((a, j) => a + seen[j], 0) / i.length;
  return {
    arms: { l: avg(13, 15) > 0.3, r: avg(14, 16) > 0.3 },
    legs: { l: rig.legs && avg(25, 27) > 0.4, r: rig.legs && avg(26, 28) > 0.4 },
    head: avg(0, 7, 8) > 0.4,
    body: avg(11, 12, 23, 24) > 0.2,
  };
}

// Capture de mouvement : une vidéo d'une personne anime les os d'un personnage 3D.
// 1. Détection : MediaPipe Pose (Google, Apache 2.0, copié dans vendor/) donne, pour chaque image, 33 points
//    du corps en 3D (en mètres, centrés sur le bassin). Tout est calculé sur l'appareil, rien n'est envoyé.
// 2. Squelette : les os humains du modèle sont reconnus (VRM, Mixamo, MMD, VRoid, Blender, Unreal, 3ds Max…).
// 3. Transfert : chaque os de membre prend la direction du membre filmé en partant de sa pose de repos ;
//    bassin, torse et tête prennent l'orientation filmée. Les pieds restent posés au sol.
// 4. Doigts : MediaPipe Hands (21 points par main) sur un recadrage agrandi autour de chaque poignet.
// 5. Caméra tenue à la main : seule l'orientation d'ensemble du corps dépend de la caméra ; elle est lissée,
//    la position des membres les uns par rapport aux autres est gardée telle quelle.
import * as THREE from 'three';

const DIR = new URL('../vendor/mediapipe/', import.meta.url).href;
let detector = null, handDet = null, clock = 0;

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

export async function loadHands() {
  if (handDet) return handDet;
  const { FilesetResolver, HandLandmarker } = await import('../vendor/mediapipe/vision_bundle.mjs');
  const files = await FilesetResolver.forVisionTasks(DIR + 'wasm');
  const make = delegate => HandLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: DIR + 'hand_landmarker.task', delegate }, runningMode: 'IMAGE', numHands: 2,
    minHandDetectionConfidence: 0.3, minHandPresenceConfidence: 0.3,
  });
  try { handDet = await make('GPU'); } catch (e) { console.warn('Mains : GPU impossible, passage au processeur', e); handDet = await make('CPU'); }
  return handDet;
}

// Les mains sont petites dans une vidéo en pied : on recadre autour du poignet (repéré par le corps), on agrandit
// ce morceau, puis on y cherche la main dont le poignet tombe au bon endroit. o : 0 main gauche, 1 main droite.
const HC = 224; let hcv = null;
function trackHand(det, video, l, o) {
  if ((l[15 + o].visibility ?? 1) < 0.3) return null;
  const W = video.videoWidth, H = video.videoHeight, P = i => [l[i].x * W, l[i].y * H];
  const w = P(15 + o), e = P(13 + o), k1 = P(17 + o), k2 = P(19 + o);
  const torso = Math.hypot((l[11].x + l[12].x - l[23].x - l[24].x) * W / 2, (l[11].y + l[12].y - l[23].y - l[24].y) * H / 2);
  let ux = (k1[0] + k2[0]) / 2 - w[0], uy = (k1[1] + k2[1]) / 2 - w[1], un = Math.hypot(ux, uy);
  if (un < 1) { ux = w[0] - e[0]; uy = w[1] - e[1]; un = Math.hypot(ux, uy) || 1; }
  const sz = Math.max(1.4 * Math.hypot(w[0] - e[0], w[1] - e[1]), 0.75 * torso, 48);
  const x0 = w[0] + ux / un * sz * 0.3 - sz / 2, y0 = w[1] + uy / un * sz * 0.3 - sz / 2;
  const sx = Math.max(0, x0), sy = Math.max(0, y0), ex = Math.min(W, x0 + sz), ey = Math.min(H, y0 + sz);
  if (ex - sx < 4 || ey - sy < 4) return null;
  if (!hcv) { hcv = document.createElement('canvas'); hcv.width = hcv.height = HC; }
  const c = hcv.getContext('2d'), k = HC / sz;
  c.fillStyle = '#000'; c.fillRect(0, 0, HC, HC);
  c.drawImage(video, sx, sy, ex - sx, ey - sy, (sx - x0) * k, (sy - y0) * k, (ex - sx) * k, (ey - sy) * k);
  const r = det.detect(hcv), wx = (w[0] - x0) / sz, wy = (w[1] - y0) / sz;
  let best = -1, bd = 0.3;
  (r.landmarks || []).forEach((hl, i) => { const d = Math.hypot(hl[0].x - wx, hl[0].y - wy); if (d < bd) { bd = d; best = i; } });
  if (best < 0) return null;
  return { w: r.worldLandmarks[best].map(p => [p.x, p.y, p.z]), l: r.landmarks[best].map(p => [(x0 + p.x * sz) / W, (y0 + p.y * sz) / H]) };
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

// Suit le corps image par image. Par image : points 3D (w), visibilité (v), position dans l'image (l),
// mains [gauche, droite] (h : points 3D et position dans l'image, ou null), ou null si personne n'est vu.
export async function track(video, { start = 0, len, fps, hands = false, onFrame, cancelled }) {
  const det = await loadDetector(), hd = hands ? await loadHands() : null;
  const n = Math.max(1, Math.round(len * fps)), out = [], end = video.duration - 0.001;
  for (let i = 0; i < n; i++) {
    if (cancelled?.()) return null;
    const t = Math.min(end, start + i / fps);
    await seek(video, t);
    // Vidéo qu'on ne peut pas parcourir : on lirait toujours la même image, et le résultat serait faux.
    if (Math.abs(video.currentTime - t) > Math.max(0.25, 2 / fps)) throw new Error('cette vidéo ne se laisse pas parcourir image par image sur cet appareil. Choisissez-la depuis la galerie ou réenregistrez-la.');
    clock += Math.ceil(1000 / fps); // le mode vidéo exige des horodatages croissants
    const r = det.detectForVideo(video, clock), w = r.worldLandmarks?.[0], l = r.landmarks?.[0];
    out.push(w && l ? { w: w.map(p => [p.x, p.y, p.z]), v: l.map(p => p.visibility ?? 1), l: l.map(p => [p.x, p.y]), a: video.videoWidth / video.videoHeight || 1,
      h: hd ? [trackHand(hd, video, l, 0), trackHand(hd, video, l, 1)] : null } : null);
    await onFrame?.(i, n, out[i]);
  }
  return out;
}

// Traits du squelette filmé, pour l'aperçu pendant l'analyse.
const FINGER_LINES = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20], [5, 9, 13, 17]];
const BONES2D = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 31], [24, 26], [26, 28], [28, 32], [7, 0], [0, 8]];
export function drawSkeleton(x, f, w, h) {
  if (!f) return;
  x.lineWidth = Math.max(2, w / 120); x.lineCap = 'round';
  for (const [a, b] of BONES2D) {
    if (f.v[a] < 0.3 || f.v[b] < 0.3) continue;
    x.strokeStyle = a > 10 && a % 2 === b % 2 ? (a % 2 ? '#ff8a3d' : '#5cc8ff') : '#fff'; // gauche orange, droite bleu
    x.beginPath(); x.moveTo(f.l[a][0] * w, f.l[a][1] * h); x.lineTo(f.l[b][0] * w, f.l[b][1] * h); x.stroke();
  }
  x.lineWidth = Math.max(1, w / 260); x.strokeStyle = '#ffd23d';
  for (const hd of f.h || []) if (hd) for (const ch of FINGER_LINES) {
    x.beginPath(); ch.forEach((i, k) => x[k ? 'lineTo' : 'moveTo'](hd.l[i][0] * w, hd.l[i][1] * h)); x.stroke();
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
// `stab` (en images) : lissage de l'orientation d'ensemble du corps, qui seule tremble quand la caméra bouge.
// Renvoie aussi les mains (21 points par image, ou null si jamais vues) et la part des images où chacune est vue.
export function prepare(frames, { mirror = false, sigma = 1.5, stab = 0 } = {}) {
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
  // Mains : une image sans main reprend la plus proche où elle a été vue.
  const hands = {}, handSeen = {};
  for (const [side, o] of [['l', 0], ['r', 1]]) {
    const so = mirror ? 1 - o : o, src = frames.map(f => f?.h?.[so]?.w || null), got = src.filter(Boolean).length;
    handSeen[side] = got / n; hands[side] = null;
    if (!got) continue;
    const first = src.findIndex(Boolean), arr = Array.from({ length: n }, () => new Float32Array(63));
    let last = src[first];
    for (let i = 0; i < n; i++) {
      if (src[i]) last = src[i];
      for (let j = 0; j < 21; j++) { const [x, y, z] = last[j]; arr[i][j * 3] = mirror ? -x : x; arr[i][j * 3 + 1] = -y; arr[i][j * 3 + 2] = -z; }
    }
    hands[side] = arr;
  }
  if (stab > 0.2 && n > 2) stabilize(pts, hands, stab);
  smooth(pts, 99, sigma);
  for (const s of ['l', 'r']) if (hands[s]) smooth(hands[s], 63, sigma);
  return { pts, seen, hands, handSeen };
}

// Lissage gaussien dans le temps de chaque coordonnée.
function smooth(arr, m, sigma) {
  const n = arr.length; if (!(sigma > 0.2) || n < 3) return;
  const r = Math.ceil(sigma * 2.5), wt = Array.from({ length: 2 * r + 1 }, (_, d) => Math.exp(-((d - r) ** 2) / (2 * sigma * sigma)));
  const src = arr.map(p => p.slice());
  for (let i = 0; i < n; i++) {
    const acc = new Float32Array(m); let sw = 0;
    for (let d = -r; d <= r; d++) {
      const q = i + d; if (q < 0 || q >= n) continue;
      const w = wt[d + r], s = src[q]; sw += w;
      for (let c = 0; c < m; c++) acc[c] += s[c] * w;
    }
    for (let c = 0; c < m; c++) arr[i][c] = acc[c] / sw;
  }
}

// Caméra qui bouge : quand elle tourne, tout le corps semble tourner d'un bloc, mais les membres ne bougent pas
// les uns par rapport aux autres. On lisse donc seulement l'orientation d'ensemble (bassin + épaules) dans le temps
// et on fait tourner chaque image de l'écart : les secousses disparaissent, les gestes restent.
function stabilize(pts, hands, sigma) {
  const n = pts.length, V = i => j => new THREE.Vector3(pts[i][j * 3], pts[i][j * 3 + 1], pts[i][j * 3 + 2]);
  const Q = pts.map((_, i) => { const p = V(i); return basis(p(23).sub(p(24)), mid(p(11), p(12)).sub(mid(p(23), p(24)))); });
  for (let i = 1; i < n; i++) if (Q[i].dot(Q[i - 1]) < 0) Q[i].set(-Q[i].x, -Q[i].y, -Q[i].z, -Q[i].w);
  const r = Math.ceil(sigma * 2.5), c = new THREE.Quaternion(), v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    let x = 0, y = 0, z = 0, w = 0;
    for (let d = -r; d <= r; d++) {
      const q = Q[i + d]; if (!q) continue;
      const k = Math.exp(-(d * d) / (2 * sigma * sigma)) * Math.sign(q.dot(Q[i]) || 1);
      x += q.x * k; y += q.y * k; z += q.z * k; w += q.w * k;
    }
    c.set(x, y, z, w).normalize().multiply(Q[i].clone().invert());
    for (let j = 0; j < 33; j++) v.fromArray(pts[i], j * 3).applyQuaternion(c).toArray(pts[i], j * 3);
    for (const s of ['l', 'r']) if (hands[s]) for (let j = 0; j < 21; j++) v.fromArray(hands[s][i], j * 3).applyQuaternion(c).toArray(hands[s][i], j * 3);
  }
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

// Doigts : 3 os par doigt (le pouce part de la paume), du plus proche de la main au bout.
export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'];
const FINGER_RE = { thumb: /(thumb|親指|pollex)/, index: /(index|人指|人差|forefinger|pointer)/, middle: /(middle|中指)/, ring: /(ring|薬指)/, little: /(pinky|pinkie|little|小指)/ };
const VRM_FINGER = /^(?:left|right)(Thumb|Index|Middle|Ring|Little)(?:Metacarpal|Proximal|Intermediate|Distal)$/;
const TIP = /(先|tip|end|nub)\d*$/;
function fingersOf(hand, bones) {
  const out = {}; if (!hand) return out;
  const under = bones.filter(b => isAncestor(hand, b));
  const byTag = {}, byName = {}, tips = {};
  for (const b of under) {
    const m = VRM_FINGER.exec(b.userData.humanBone || ''); if (m) (byTag[m[1].toLowerCase()] ||= []).push(b);
    const n = (b.name || '').normalize('NFKC').toLowerCase(), f = FINGERS.find(k => FINGER_RE[k].test(n));
    if (f) (TIP.test(n) ? (tips[f] ||= []) : (byName[f] ||= [])).push(b);
  }
  const src = Object.keys(byTag).length ? byTag : byName;
  for (const f of FINGERS) {
    const chain = (src[f] || []).sort((a, b) => depthOf(a) - depthOf(b)); if (!chain.length) continue;
    const bones3 = chain.slice(0, 3), last = bones3.at(-1);
    const tip = chain[3] || (tips[f] || []).sort((a, b) => depthOf(a) - depthOf(b))[0] || last.children.find(c => c.isBone) || null;
    out[f] = { bones: bones3, tip };
  }
  return out;
}
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
  rig.fingers = { l: fingersOf(rig.l.hand, bones), r: fingersOf(rig.r.hand, bones) };
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
// Repère d'une main : vers les doigts, vers l'index, normale de la paume.
function handBasis(w, idx, pinky, out = new THREE.Quaternion()) {
  _x.copy(idx).add(pinky).multiplyScalar(0.5).sub(w).normalize();
  _y.copy(idx).sub(pinky); _y.addScaledVector(_x, -_y.dot(_x)).normalize(); _z.crossVectors(_x, _y);
  return out.setFromRotationMatrix(_mb.makeBasis(_x, _y, _z));
}
const FSEG = { thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], little: [17, 18, 19, 20] };

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
  // Doigts : directions au repos, et repère de la main (poignet, base de l'index, base de l'auriculaire).
  const fwd0 = new THREE.Vector3(0, 0, 1).applyQuaternion(qHips0);
  const fing = { l: {}, r: {} }, hand0 = {};
  for (const s of ['l', 'r']) {
    let F = rig.fingers?.[s] || {};
    const hb = rig[s].hand;
    if (hb && !Object.keys(F).length) { // noms inconnus : les chaînes qui partent de la main, la plus en avant étant le pouce
      const chains = hb.children.filter(c => c.isBone).map(c => { const ch = [c]; while (ch.length < 4 && ch.at(-1).children.some(x => x.isBone)) ch.push(ch.at(-1).children.find(x => x.isBone)); return ch; }).filter(ch => ch.length >= 2);
      if (chains.length === 5) {
        chains.sort((a, b) => posOf(b.at(-1)).sub(posOf(hb)).dot(fwd0) - posOf(a.at(-1)).sub(posOf(hb)).dot(fwd0));
        F = Object.fromEntries(FINGERS.map((f, i) => [f, { bones: chains[i].slice(0, 3), tip: chains[i][3] || null }]));
        rig.fingers[s] = F;
      }
    }
    for (const f of FINGERS) {
      const c = F[f]; if (!c?.bones.length) continue;
      const pos = c.bones.map(b => posOf(b)), tip = c.tip && posOf(c.tip), dirs = [];
      for (let k = 0; k < pos.length; k++) {
        const nx = pos[k + 1] || tip;
        dirs.push(nx ? nx.clone().sub(pos[k]).normalize() : k ? dirs[k - 1].clone() : pos[0].clone().sub(posOf(hb)).normalize());
      }
      for (const b of c.bones) { rq.set(b, quatOf(b)); depth.set(b, depthOf(b)); used.push(b); }
      fing[s][f] = { bones: c.bones, dirs };
    }
    if (hb && fing[s].index && fing[s].little) hand0[s] = handBasis(posOf(hb), posOf(fing[s].index.bones[0]), posOf(fing[s].little.bones[0])).invert();
  }
  const feet = [L.foot, R.foot, L.toes, R.toes].filter(Boolean);
  const ground0 = feet.length ? Math.min(...feet.map(b => P.get(b).y)) : 0;
  const keyed = () => [...new Set(used)].sort((a, b) => depth.get(a) - depth.get(b));

  const V = Array.from({ length: 33 }, () => new THREE.Vector3());
  const pt = (pts, i) => V[i].set(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]).applyQuaternion(yaw);
  const seg = (a, b) => V[b].clone().sub(V[a]);
  const swing = (parentD, restDir, target, out = new THREE.Quaternion()) => {
    const from = restDir.clone().applyQuaternion(parentD);
    if (target.lengthSq() < 1e-10) return out.copy(parentD);
    return out.setFromUnitVectors(from, target.normalize()).multiply(parentD);
  };
  const pitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -HEAD_PITCH);
  const HV = Array.from({ length: 21 }, () => new THREE.Vector3()), order = keyed();

  // Main filmée : orientation complète de la main (une part de sa torsion passe dans l'avant-bras pour ne pas
  // tordre le poignet), puis chaque phalange prend la direction filmée.
  function solveHand(s, H, poseDir, b, D) {
    if (!hand0[s]) return null;
    for (let j = 0; j < 21; j++) HV[j].set(H[j * 3], H[j * 3 + 1], H[j * 3 + 2]).applyQuaternion(yaw);
    const fwdH = mid(HV[5], HV[17]).sub(HV[0]);
    if (poseDir.lengthSq() > 1e-10 && fwdH.angleTo(poseDir) > 1.8) return null; // main incohérente avec le bras : ignorée
    const full = handBasis(HV[0], HV[5], HV[17]).multiply(hand0[s]);
    const axis = rest[s].lowerArm.clone().applyQuaternion(b).normalize(), rel = full.clone().multiply(b.clone().invert());
    const k = axis.dot(_p.set(rel.x, rel.y, rel.z)), tw = new THREE.Quaternion(axis.x * k, axis.y * k, axis.z * k, rel.w).normalize();
    b.premultiply(new THREE.Quaternion().slerp(tw, 0.5));
    for (const f of FINGERS) {
      const F = fing[s][f]; if (!F) continue;
      const seq = FSEG[f], m = F.bones.length; let parent = full;
      F.bones.forEach((bone, k2) => { const i = 3 - m + k2, d = swing(parent, F.dirs[k2], HV[seq[i + 1]].clone().sub(HV[seq[i]])); D.set(bone, d); parent = d; });
    }
    return full;
  }

  // opts : { arms: {l, r}, legs: {l, r}, head, ground, fingers: {l, r} } — membres à suivre et pieds au sol.
  // hands : { l, r } points de la main pour cette image (prepare), ou absent.
  function solve(pts, opts, hands) {
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
        const poseDir = mid(V[17 + o], V[19 + o]).sub(V[15 + o]);
        const full = opts.fingers?.[s] && hands?.[s] && solveHand(s, hands[s], poseDir, b, D);
        D.set(g.upperArm, a); D.set(g.lowerArm, b);
        if (full) D.set(g.hand, full); else if (rd.hand) D.set(g.hand, swing(b, rd.hand, poseDir));
      }
      if (opts.legs[s] && rd.upperLeg && rd.lowerLeg) {
        const a = swing(dHips, rd.upperLeg, seg(23 + o, 25 + o)), b = swing(a, rd.lowerLeg, seg(25 + o, 27 + o));
        D.set(g.upperLeg, a); D.set(g.lowerLeg, b);
        if (rd.foot) D.set(g.foot, swing(b, rd.foot, seg(27 + o, 31 + o)));
      }
    }
    // Du bassin vers les extrémités : orientation voulue dans le modèle → rotation locale de l'os.
    const pq = new THREE.Quaternion(), out = new Map();
    for (const b of order) {
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
export function limbsFrom(seen, rig, handSeen = {}) {
  const avg = (...i) => i.reduce((a, j) => a + seen[j], 0) / i.length;
  const hasF = s => Object.keys(rig.fingers?.[s] || {}).length > 0;
  return {
    fingers: { l: hasF('l') && handSeen.l > 0.2, r: hasF('r') && handSeen.r > 0.2 },
    arms: { l: avg(13, 15) > 0.3, r: avg(14, 16) > 0.3 },
    legs: { l: rig.legs && avg(25, 27) > 0.4, r: rig.legs && avg(26, 28) > 0.4 },
    head: avg(0, 7, 8) > 0.4,
    body: avg(11, 12, 23, 24) > 0.2,
  };
}

// Physique des cheveux et des vêtements (« os à ressort »).
// Chaque os d'une mèche, d'une jupe ou d'un ruban porte une pointe qui a de l'inertie, tombe sous la gravité,
// revient doucement vers sa forme d'origine et ne traverse pas le corps (sphères et capsules de collision).
// Algorithme des ressorts VRM (VRMC_springBone). Le résultat est « cuit » en clés, frame par frame : la lecture,
// l'export et l'envoi vers la 2D le montrent tel quel.
// Réglages pris dans le fichier quand il en a (VRM 0 / 1, corps rigides MMD), sinon devinés d'après le nom des os.
import * as THREE from 'three';

const HAIR = /(hair|kami|髪|ponytail|twintail|bangs|ahoge|アホ毛|もみあげ)/i;
const CLOTH = /(skirt|スカート|dress|robe|cloth|coat|cape|cloak|マント|scarf|マフラー|ribbon|リボン|necktie|ネクタイ|sleeve|袖|frill|hood|フード|tassel|tail|尻尾|しっぽ|feather|wing|羽)/i;
const SOFT = /(breast|bust|oppai|乳)/i;
const SECONDARY = /(^|[_\s.])sec([_\s.]|$)|swing|spring|揺れ/i;
const SKIP = /(ik|twist|捩|target|pole|ctrl|control)/i;
const PRESET = { // valeurs « VRM » (mètres pour un personnage d'1,6 m)
  hair: { stiffness: 0.8, drag: 0.35, gravity: 0.25, radius: 0.02 },
  cloth: { stiffness: 1.1, drag: 0.4, gravity: 0.4, radius: 0.025 },
  soft: { stiffness: 3, drag: 0.6, gravity: 0.05, radius: 0.02 },
  other: { stiffness: 1.2, drag: 0.4, gravity: 0.2, radius: 0.02 },
};
const kindOf = n => HAIR.test(n) ? 'hair' : SOFT.test(n) ? 'soft' : CLOTH.test(n) ? 'cloth' : 'other';
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const worldScale = o => { o.matrixWorld.decompose(_v, _q, _s); return (_s.x + _s.y + _s.z) / 3; };
const restPose = r => {
  for (const b of r.bones) { const s = b.userData.rest; b.position.copy(s.p); b.quaternion.copy(s.q); b.scale.copy(s.s); }
  r.root.updateWorldMatrix(true, true);
};

// Os à ressort et collisions d'un modèle. `rig` : squelette humain reconnu (mocap.findRig), ou null.
// Renvoie null si le modèle n'a rien qui puisse bouger tout seul.
export function findSprings(r, rig) {
  restPose(r);
  const box = new THREE.Box3().setFromObject(r.root), H = Math.max(1e-3, box.max.y - box.min.y), S = H / 1.6;
  const human = new Set(rig ? [rig.hips, rig.neck, rig.head, rig.top, ...rig.spine, ...['l', 'r'].flatMap(s => [...Object.values(rig[s]), ...Object.values(rig.fingers?.[s] || {}).flatMap(F => [...F.bones, F.tip])])].filter(Boolean) : []);
  const colliders = [], joints = [];
  const addCollider = (bone, a, b, radius) => { // a, b : points « monde » au repos ; rayon « monde »
    const inv = bone.matrixWorld.clone().invert();
    colliders.push({ bone, a: a.clone().applyMatrix4(inv), b: b ? b.clone().applyMatrix4(inv) : null, radius });
  };
  const wpos = o => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
  const addJoint = (bone, tail, p, scale, cols) => {
    if (!bone || human.has(bone)) return;
    // Pointe : l'os enfant, sinon le prolongement de l'os.
    let local;
    if (tail) local = tail.position.clone();
    else {
      const d = bone.position.clone().applyQuaternion(bone.quaternion.clone().invert());
      local = d.lengthSq() > 1e-12 ? d.normalize().multiplyScalar(bone.position.length() * 0.7) : new THREE.Vector3(0, 0.05, 0);
    }
    if (local.lengthSq() < 1e-12) return;
    joints.push({ bone, local, stiffness: p.stiffness * S, drag: p.drag, gravity: p.gravity * S, dir: new THREE.Vector3(...(p.gravityDir || [0, -1, 0])).normalize(), radius: (p.radius || 0) * scale, cols });
  };
  const sp = r.springs;
  let source = null;
  if (sp?.kind === 'vrm1' || sp?.kind === 'vrm0') {
    source = 'vrm';
    for (const c of sp.colliders) {
      if (!c.node) { colliders.push(null); continue; }
      colliders.push({ bone: c.node, a: new THREE.Vector3(...c.offset), b: c.tail ? new THREE.Vector3(...c.tail) : null, radius: c.radius * worldScale(c.node) });
    }
    for (const ch of sp.chains) {
      const cols = ch.colliders.filter(i => colliders[i]);
      if (ch.joints) { // VRM 1 : liste explicite ; le dernier os ne sert que de pointe
        for (let i = 0; i < ch.joints.length - 1; i++) { const j = ch.joints[i]; if (j.node) addJoint(j.node, ch.joints[i + 1].node, j, worldScale(j.node), cols); }
        const last = ch.joints.at(-1); if (last?.node && ch.joints.length === 1) addJoint(last.node, null, last, worldScale(last.node), cols);
      } else if (ch.root) { // VRM 0 : la racine et tous ses descendants
        ch.root.traverse(o => { if (o.isBone) addJoint(o, o.children.find(c => c.isBone) || null, ch.params, worldScale(o), cols); });
      }
    }
  } else if (r.mesh?.geometry?.userData?.MMD?.rigidBodies?.length) {
    source = 'mmd';
    const mmd = r.mesh.geometry.userData.MMD, bones = r.mesh.skeleton.bones, sc = worldScale(r.mesh);
    const dyn = new Set(mmd.rigidBodies.filter(b => b.type !== 0 && b.boneIndex >= 0).map(b => bones[b.boneIndex]));
    for (const rb of mmd.rigidBodies) {
      if (rb.type !== 0 || rb.boneIndex < 0) continue;
      const bone = bones[rb.boneIndex], c = wpos(bone).add(new THREE.Vector3(...rb.position).multiplyScalar(sc));
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rb.rotation, 'YXZ'));
      if (rb.shapeType === 2) { // capsule le long de son axe Y
        const half = new THREE.Vector3(0, rb.height * sc / 2, 0).applyQuaternion(q);
        addCollider(bone, c.clone().sub(half), c.clone().add(half), rb.width * sc);
      } else if (rb.shapeType === 1) { // boîte : capsule sur sa plus grande dimension
        const e = [rb.width, rb.height, rb.depth], k = e.indexOf(Math.max(...e)), ax = new THREE.Vector3().setComponent(k, Math.max(0, e[k] - Math.min(...e)) * sc).applyQuaternion(q);
        addCollider(bone, c.clone().sub(ax), c.clone().add(ax), [...e].sort((x, y) => x - y)[1] * sc);
      } else addCollider(bone, c, null, rb.width * sc);
    }
    const all = colliders.map((_, i) => i);
    for (const bone of [...dyn].sort((a, b) => depth(a) - depth(b))) {
      const tail = bone.children.find(c => c.isBone && dyn.has(c)) || bone.children.find(c => c.isBone) || null;
      addJoint(bone, tail, PRESET[kindOf(bone.name)], S, all);
    }
  } else {
    // Sans données : os dont le nom évoque des cheveux, un vêtement, une queue…
    const pick = b => !human.has(b) && !SKIP.test(b.name) && (HAIR.test(b.name) || CLOTH.test(b.name) || SOFT.test(b.name) || SECONDARY.test(b.name));
    const chosen = r.bones.filter(pick);
    if (chosen.length) {
      source = 'noms';
      autoColliders(rig, H, addCollider, wpos);
      const all = colliders.map((_, i) => i);
      for (const bone of chosen.sort((a, b) => depth(a) - depth(b))) addJoint(bone, bone.children.find(c => c.isBone) || null, PRESET[kindOf(bone.name + ' ' + (bone.parent?.name || ''))], S, all);
    }
  }
  if (!joints.length) return null;
  // Une pointe qui démarre déjà dans une collision (racine de jupe dans le bassin…) ignore cette collision.
  for (const j of joints) {
    const t = j.local.clone().applyMatrix4(j.bone.matrixWorld);
    j.cols = j.cols.filter(i => { const c = colliders[i]; return c && dist(t, c) > c.radius + j.radius; });
    j.q0 = j.bone.quaternion.clone(); j.axis = j.local.clone().normalize();
    j.len = t.distanceTo(wpos(j.bone));
  }
  joints.sort((a, b) => depth(a.bone) - depth(b.bone));
  return { joints, colliders, source, hair: joints.filter(j => kindOf(j.bone.name) === 'hair').length };
}
const depth = o => { let d = 0; for (let p = o.parent; p; p = p.parent) d++; return d; };

function autoColliders(rig, H, add, wpos) {
  if (!rig) return;
  const P = b => b && wpos(b), up = new THREE.Vector3(0, 1, 0);
  if (rig.head) add(rig.head, P(rig.head).addScaledVector(up, 0.055 * H), null, 0.065 * H);
  if (rig.neck && rig.head) add(rig.neck, P(rig.neck), P(rig.head), 0.035 * H);
  if (rig.hips) add(rig.hips, P(rig.hips), null, 0.09 * H);
  for (const b of rig.spine) add(b, P(b), null, 0.085 * H);
  for (const s of ['l', 'r']) {
    const g = rig[s], cap = (a, b, k) => a && b && add(a, P(a), P(b), k * H);
    cap(g.upperLeg, g.lowerLeg, 0.055); cap(g.lowerLeg, g.foot, 0.04); cap(g.upperArm, g.lowerArm, 0.035); cap(g.lowerArm, g.hand, 0.03);
  }
}

// Distance d'un point à une collision (sphère, ou capsule entre a et b), dans l'état courant.
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _ab = new THREE.Vector3();
function closest(p, c, out) {
  _a.copy(c.a).applyMatrix4(c.bone.matrixWorld);
  if (!c.b) return out.copy(_a);
  _b.copy(c.b).applyMatrix4(c.bone.matrixWorld); _ab.subVectors(_b, _a);
  const t = Math.max(0, Math.min(1, _w.subVectors(p, _a).dot(_ab) / Math.max(1e-12, _ab.lengthSq())));
  return out.copy(_a).addScaledVector(_ab, t);
}
const _c = new THREE.Vector3();
const dist = (p, c) => p.distanceTo(closest(p, c, _c));

// Simulation pas à pas ; `evaluate(f)` pose le corps (clés, animation du fichier) au frame f, éventuellement fractionnaire.
export async function bake(r, spec, { len, fps, evaluate, onProgress }) {
  const { joints, colliders } = spec, K = Math.max(1, Math.ceil(60 / fps)), dt = 1 / (fps * K);
  const pq = new THREE.Quaternion(), rest = new THREE.Vector3(), next = new THREE.Vector3(), head = new THREE.Vector3(), to = new THREE.Vector3(), cp = new THREE.Vector3();
  const pose = f => { evaluate(f); r.root.updateWorldMatrix(true, true); };
  const start = () => { for (const j of joints) { j.cur = j.local.clone().applyMatrix4(j.bone.matrixWorld); j.prev = j.cur.clone(); } };
  function step(h) {
    for (const j of joints) {
      const b = j.bone;
      b.parent.getWorldQuaternion(pq);
      head.setFromMatrixPosition(b.matrixWorld);
      rest.copy(j.axis).applyQuaternion(_q.copy(pq).multiply(j.q0));             // direction de repos dans la pose actuelle
      next.copy(j.cur).addScaledVector(_w.subVectors(j.cur, j.prev), 1 - j.drag)   // inertie
        .addScaledVector(rest, j.stiffness * h)                                    // retour vers la forme d'origine
        .addScaledVector(j.dir, j.gravity * h);                                    // gravité
      next.sub(head).setLength(j.len).add(head);
      for (const i of j.cols) { // ne pas traverser le corps
        const c = colliders[i], p = closest(next, c, cp), d = next.distanceTo(p), m = c.radius + j.radius;
        if (d < m) { if (d > 1e-9) next.sub(p).multiplyScalar(m / d).add(p); next.sub(head).setLength(j.len).add(head); }
      }
      if (!Number.isFinite(next.x + next.y + next.z)) next.copy(rest).multiplyScalar(j.len).add(head);
      j.prev.copy(j.cur); j.cur.copy(next);
      to.subVectors(next, head).normalize();
      const qw = new THREE.Quaternion().setFromUnitVectors(rest, to).multiply(_q.copy(pq).multiply(j.q0));
      b.quaternion.copy(pq.invert().multiply(qw)).normalize(); b.updateMatrixWorld(true);
    }
  }
  const out = new Map(joints.map(j => [j.bone, []]));
  const record = f => { for (const j of joints) out.get(j.bone).push({ f, q: j.bone.quaternion.toArray().map(x => +x.toFixed(5)) }); };
  pose(0); start();
  for (let i = 0; i < 90; i++) { pose(0); step(1 / 60); } // mise en place : cheveux et tissus retombent avant la première image
  record(0);
  for (let f = 1; f < len; f++) {
    for (let k = 1; k <= K; k++) { pose(f - 1 + k / K); step(dt); }
    record(f);
    if (f % 20 === 0) await onProgress?.(f / len);
  }
  return out;
}

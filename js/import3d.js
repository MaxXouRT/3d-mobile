// Import de modèles 3D : glb / gltf / vrm, fbx, pmx / pmd (MMD), obj (+mtl), dae, stl, ply,
// seuls, accompagnés de leurs textures, ou dans une archive zip.
import * as THREE from 'three';
import { unzipSync } from 'three/addons/libs/fflate.module.js';

// Du plus riche (textures, squelette, animations) au plus simple.
export const FORMATS = ['glb', 'vrm', 'gltf', 'fbx', 'pmx', 'pmd', 'dae', 'obj', 'stl', 'ply'];
const BASE = 'assets:/';
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp', gif: 'image/gif', webp: 'image/webp' };
const ext = n => (n.split('.').pop() || '').toLowerCase();
const norm = p => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+/g, '/').toLowerCase();

// Les zip de modèles MMD ont souvent des noms de fichiers en Shift-JIS : on les redécode.
function fixName(name) {
  if (!/[\u0080-ÿ]/.test(name)) return name;
  const bytes = Uint8Array.from(name, c => c.charCodeAt(0) & 255);
  for (const enc of ['utf-8', 'shift_jis', 'gbk']) {
    try { return new TextDecoder(enc, { fatal: true }).decode(bytes); } catch {}
  }
  return name;
}

// Liste de fichiers (du sélecteur) → entrées { name, blob }, archives zip dépliées.
export async function expandFiles(files) {
  const out = [];
  for (const f of files) {
    if (ext(f.name) === 'zip') {
      const z = unzipSync(new Uint8Array(await f.arrayBuffer()));
      for (const [path, data] of Object.entries(z)) {
        if (path.endsWith('/') || path.startsWith('__MACOSX') || !data.length) continue;
        const name = fixName(path);
        out.push({ name, blob: new Blob([data], { type: MIME[ext(name)] || '' }) });
      }
    } else out.push({ name: f.name, blob: f });
  }
  return out;
}

export const candidates = entries => entries.filter(e => FORMATS.includes(ext(e.name)))
  .sort((a, b) => FORMATS.indexOf(ext(a.name)) - FORMATS.indexOf(ext(b.name)) || b.blob.size - a.blob.size);

// Charge le meilleur modèle trouvé ; si un format échoue, essaie le suivant.
export async function loadModel(entries) {
  const list = candidates(entries);
  if (!list.length) throw new Error('Aucun modèle 3D reconnu (formats : ' + FORMATS.join(', ') + ')');
  let last;
  for (const c of list) {
    try { return await loadOne(c, entries); } catch (e) { console.warn('Import impossible :', c.name, e); last = e; }
  }
  throw new Error(`Modèle illisible (${last?.message || last})`);
}

function makeManager(model, entries) {
  const urls = new Map(), made = [];
  const dir = norm(model.name).split('/').slice(0, -1).join('/');
  const byPath = new Map(entries.map(e => [norm(e.name), e]));
  const find = p => {
    if (byPath.has(p)) return byPath.get(p);
    if (dir && byPath.has(dir + '/' + p)) return byPath.get(dir + '/' + p);
    const base = p.split('/').pop();
    let hit = null;
    for (const [k, e] of byPath) { if (k.endsWith('/' + p)) return e; if (!hit && k.split('/').pop() === base) hit = e; }
    return hit;
  };
  const urlOf = e => { if (!urls.has(e)) { const u = URL.createObjectURL(e.blob); urls.set(e, u); made.push(u); } return urls.get(e); };
  const m = new THREE.LoadingManager();
  m.setURLModifier(url => {
    if (/^(blob|data):/.test(url)) return url;
    let p = url.replace(/^assets:\/+/, '').replace(/^[a-z]+:\/\/[^/]+\//i, '');
    try { p = decodeURIComponent(p); } catch {}
    const e = find(norm(p));
    // Texture absente de l'archive : image vide plutôt qu'une erreur réseau.
    return e ? urlOf(e) : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  });
  setTimeout(() => made.forEach(u => URL.revokeObjectURL(u)), 120000);
  return { m, urlOf };
}

async function loadOne(model, entries) {
  const { m, urlOf } = makeManager(model, entries), url = urlOf(model), x = ext(model.name);
  const load = (loader, u = url) => new Promise((res, rej) => loader.load(u, res, undefined, e => rej(e instanceof Error ? e : new Error(e?.message || 'lecture impossible'))));
  let obj, clips = [], mmd = false;
  if (x === 'glb' || x === 'gltf' || x === 'vrm') {
    const [{ GLTFLoader }, { DRACOLoader }, { MeshoptDecoder }] = await Promise.all([import('three/addons/loaders/GLTFLoader.js'), import('three/addons/loaders/DRACOLoader.js'), import('three/addons/libs/meshopt_decoder.module.js')]);
    const l = new GLTFLoader(m).setResourcePath(BASE);
    l.setDRACOLoader(new DRACOLoader().setDecoderPath(new URL('../vendor/three/addons/libs/draco/', import.meta.url).href));
    l.setMeshoptDecoder(MeshoptDecoder);
    const g = await load(l); obj = g.scene; clips = g.animations || [];
    tagHumanoid(g);
  } else if (x === 'fbx') {
    const [{ FBXLoader }, { TGALoader }] = await Promise.all([import('three/addons/loaders/FBXLoader.js'), import('three/addons/loaders/TGALoader.js')]);
    m.addHandler(/\.tga$/i, new TGALoader(m));
    obj = await load(new FBXLoader(m).setResourcePath(BASE)); clips = obj.animations || [];
  } else if (x === 'pmx' || x === 'pmd') {
    const { MMDLoader } = await import('three/addons/loaders/MMDLoader.js');
    obj = await load(new MMDLoader(m).setResourcePath(BASE)); mmd = true;
  } else if (x === 'dae') {
    const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
    const c = await load(new ColladaLoader(m).setResourcePath(BASE)); obj = c.scene; clips = c.scene.animations || [];
  } else if (x === 'obj') {
    const [{ OBJLoader }, { MTLLoader }] = await Promise.all([import('three/addons/loaders/OBJLoader.js'), import('three/addons/loaders/MTLLoader.js')]);
    const l = new OBJLoader(m), stem = norm(model.name).replace(/\.obj$/, '');
    const mtl = entries.find(e => norm(e.name) === stem + '.mtl') || entries.find(e => ext(e.name) === 'mtl');
    if (mtl) { try { const mats = await load(new MTLLoader(m).setResourcePath(BASE), urlOf(mtl)); mats.preload(); l.setMaterials(mats); } catch (e) { console.warn(e); } }
    obj = await load(l);
  } else {
    const mod = x === 'stl' ? await import('three/addons/loaders/STLLoader.js') : await import('three/addons/loaders/PLYLoader.js');
    const geo = await load(new (mod.STLLoader || mod.PLYLoader)(m));
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0xb9bdc9, roughness: 0.7, vertexColors: !!geo.attributes.color });
    obj = geo.index || geo.attributes.normal ? new THREE.Mesh(geo, mat) : new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.01, vertexColors: !!geo.attributes.color }));
    obj.rotation.x = -Math.PI / 2; // ces fichiers ont en général l'axe Z vers le haut
  }
  if (!obj) throw new Error('fichier vide');

  // Normalisation : ~2 unités de haut, posé sur le sol, centré.
  const holder = new THREE.Group(); holder.add(obj); holder.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3()), max = Math.max(size.x, size.y, size.z);
  if (!isFinite(max) || max <= 0) throw new Error('modèle sans géométrie');
  holder.scale.setScalar(2 / max); holder.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  holder.position.set(-c.x, -box.min.y, -c.z);
  const root = new THREE.Group(); root.add(holder);

  const bones = [];
  root.traverse(o => {
    if (o.isSkinnedMesh) { o.frustumCulled = false; for (const b of o.skeleton.bones) if (!bones.includes(b)) bones.push(b); }
    if (o.isMesh) {
      o.userData.mat = o.material;
      // Un modèle MMD sans expressions laisse des listes de morphs vides qui font échouer le shader.
      const ma = o.geometry?.morphAttributes; if (ma) for (const k of Object.keys(ma)) if (!ma[k].length) delete ma[k];
    }
  });
  for (const b of bones) b.userData.rest = { p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() };
  return { root, bones, clips, mmd, mesh: mmd ? obj : null, format: x, name: model.name.split('/').pop().replace(/\.[^.]+$/, '') };
}

// VRM (0.x et 1.0) : le fichier déclare lui-même ses os humains (hips, leftUpperArm…). Sert à la capture de mouvement.
function tagHumanoid(g) {
  const ex = g.parser?.json?.extensions || {}, hb = ex.VRMC_vrm?.humanoid?.humanBones || ex.VRM?.humanoid?.humanBones;
  if (!hb) return;
  const byNode = new Map(Array.isArray(hb) ? hb.map(b => [b.node, b.bone]) : Object.entries(hb).map(([k, v]) => [v.node, k]));
  g.scene.traverse(o => { const n = g.parser.associations.get(o)?.nodes; if (byNode.has(n)) o.userData.humanBone = byNode.get(n); });
}

// Mouvement MMD (.vmd) appliqué à un modèle pmx / pmd.
export async function loadVMD(blob, mesh) {
  const { MMDLoader } = await import('three/addons/loaders/MMDLoader.js');
  const url = URL.createObjectURL(blob);
  try { return await new Promise((res, rej) => new MMDLoader().loadAnimation(url, mesh, res, undefined, rej)); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
}

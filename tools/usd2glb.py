# Convertit un mannequin USD/USDZ (UsdSkel, squelette type Mixamo) en GLB animable.
# Usage : pip install usd-core numpy ; unzip modele.usdz -d tmp ;
#         python3 tools/usd2glb.py tmp/scene.usdc models/nom.glb "Nom affiché"
# Les os, anonymes dans le fichier (n6, n7…), sont reconnus par la forme du squelette et renommés
# en français ; chaque os humain reçoit extras.humanBone (noms VRM) pour la capture de mouvement.
import sys, json, struct
import numpy as np
from pxr import Usd, UsdGeom, UsdSkel, UsdShade

src, dst, title = sys.argv[1], sys.argv[2], sys.argv[3]
st = Usd.Stage.Open(src); mpu = UsdGeom.GetStageMetersPerUnit(st); T = Usd.TimeCode.Default()
rootp = next(p for p in st.Traverse() if p.GetTypeName() == 'SkelRoot')
cache = UsdSkel.Cache(); root = UsdSkel.Root(rootp); cache.Populate(root, Usd.PrimDefaultPredicate)
binding = cache.ComputeSkelBindings(root, Usd.PrimDefaultPredicate)[0]
skel = binding.GetSkeleton(); sk = cache.GetSkelQuery(skel); sq = binding.GetSkinningTargets()[0]
assert sq.GetJointMapper() is None or sq.GetJointMapper().IsNull(), 'ordre des os propre au maillage non géré'
L2W = np.array(UsdGeom.Xformable(skel.GetPrim()).ComputeLocalToWorldTransform(T))
S = np.diag([mpu, mpu, mpu, 1.0])

# ---------- Squelette : transformations « monde » au repos, sans échelle ----------
paths = [str(j) for j in sk.GetJointOrder()]
n = len(paths)
parent = [paths.index(p.rsplit('/', 1)[0]) if '/' in p else -1 for p in paths]
kids = [[c for c in range(n) if parent[c] == j] for j in range(n)]
world = []
for m in skel.GetBindTransformsAttr().Get():
    M = np.array(m) @ L2W @ S                 # convention USD : vecteur ligne, v' = v · M
    R = M[:3, :3]; U, _, Vt = np.linalg.svd(R); R = U @ Vt
    W = np.eye(4); W[:3, :3] = R; W[3, :3] = M[3, :3]
    world.append(W)
pos = np.array([W[3, :3] for W in world])

# ---------- Reconnaissance des os (squelette en T, face à +Z, gauche du personnage vers +X) ----------
role = [None] * n
def chain(j):
    out = [j]
    while len(kids[out[-1]]) == 1: out.append(kids[out[-1]][0])
    return out
hips = parent.index(-1); role[hips] = 'hips'
up = [c for c in kids[hips] if pos[c][1] > pos[hips][1]]
legs = [c for c in kids[hips] if c not in up]
assert len(up) == 1 and len(legs) == 2, 'bassin inattendu'
spine = chain(up[0])                            # jusqu'à l'os qui porte le cou et les deux épaules
top = spine[-1]
assert len(kids[top]) == 3, 'haut du torse inattendu'
assert len(spine) <= 3, 'colonne inattendue'
for j, r in zip(spine, ['spine', 'chest', 'upperChest']): role[j] = r
neck = [c for c in kids[top] if abs(pos[c][0]) < 1e-3][0]
nh = chain(neck); role[nh[0]] = 'neck'
if len(nh) > 1: role[nh[1]] = 'head'
FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little']
for side, sgn in (('left', 1), ('right', -1)):
    sh = [c for c in kids[top] if c != neck and np.sign(pos[c][0]) == sgn][0]
    arm = chain(sh)                             # épaule, bras, avant-bras, main
    assert len(arm) == 4, 'bras inattendu'
    for j, r in zip(arm, ['Shoulder', 'UpperArm', 'LowerArm', 'Hand']): role[j] = side + r
    fingers = sorted(kids[arm[-1]], key=lambda c: -pos[chain(c)[-1]][2])   # du plus en avant (pouce) au plus en arrière
    for f, name in zip(fingers, FINGERS):
        for j, r in zip(chain(f), ['Metacarpal', 'Proximal', 'Distal'] if name == 'Thumb' else ['Proximal', 'Intermediate', 'Distal']): role[j] = side + name + r
    leg = [c for c in legs if np.sign(pos[c][0]) == sgn][0]
    lc = chain(leg); assert len(lc) >= 3, 'jambe inattendue'
    for j, r in zip(lc, ['UpperLeg', 'LowerLeg', 'Foot', 'Toes']): role[j] = side + r

FR = {'hips': 'Bassin', 'spine': 'Ventre', 'chest': 'Poitrine', 'upperChest': 'Haut du torse', 'neck': 'Cou', 'head': 'Tête',
      'Shoulder': 'Épaule', 'UpperArm': 'Bras', 'LowerArm': 'Avant-bras', 'Hand': 'Main', 'UpperLeg': 'Cuisse', 'LowerLeg': 'Jambe',
      'Foot': 'Pied', 'Toes': 'Orteils', 'Thumb': 'Pouce', 'Index': 'Index', 'Middle': 'Majeur', 'Ring': 'Annulaire', 'Little': 'Auriculaire'}
def fr(r):
    if r in FR: return FR[r]
    side = 'G' if r.startswith('left') else 'D'; b = r[4:] if side == 'G' else r[5:]
    if b in FR: return f'{FR[b]} {side}'
    for f in FINGERS:
        if b.startswith(f):
            k = {'Metacarpal': 1, 'Proximal': 1, 'Intermediate': 2, 'Distal': 3}[b[len(f):]]
            if f == 'Thumb': k = {'Metacarpal': 1, 'Proximal': 2, 'Distal': 3}[b[len(f):]]
            return f'{FR[f]} {side} {k}'
    return r
assert all(role), [paths[i] for i in range(n) if not role[i]]
names = [fr(r) for r in role]

# ---------- Maillage ----------
mesh = UsdGeom.Mesh(sq.GetPrim())
G = np.array(sq.GetGeomBindTransform()) @ L2W @ S
P = np.array(mesh.GetPointsAttr().Get(), dtype=np.float64)
P = (np.c_[P, np.ones(len(P))] @ G)[:, :3]
Nr = np.array(mesh.GetNormalsAttr().Get(), dtype=np.float64)
assert mesh.GetNormalsInterpolation() == 'vertex' and len(Nr) == len(P)
Nr = Nr @ np.linalg.inv(G[:3, :3]).T
Nr /= np.linalg.norm(Nr, axis=1, keepdims=True)
counts = np.array(mesh.GetFaceVertexCountsAttr().Get()); idx = np.array(mesh.GetFaceVertexIndicesAttr().Get())
tris, o = [], 0
for c in counts:
    f = idx[o:o + c]; o += c
    for k in range(1, c - 1): tris.append((f[0], f[k], f[k + 1]))
tris = np.array(tris, dtype=np.uint32)
if mesh.GetOrientationAttr().Get() == 'leftHanded': tris = tris[:, [0, 2, 1]]
ji, jw = sq.ComputeJointInfluences(T)
k = sq.GetNumInfluencesPerComponent()
ji = np.array(ji).reshape(-1, k); jw = np.array(jw, dtype=np.float64).reshape(-1, k)
order = np.argsort(-jw, axis=1)[:, :4]
ji = np.take_along_axis(ji, order, 1); jw = np.take_along_axis(jw, order, 1)
if ji.shape[1] < 4: ji = np.pad(ji, ((0, 0), (0, 4 - ji.shape[1]))); jw = np.pad(jw, ((0, 0), (0, 4 - jw.shape[1])))
jw /= jw.sum(1, keepdims=True)
# Poids en octets normalisés dont la somme fait exactement 255.
wq = np.floor(jw * 255).astype(np.int32); wq[:, 0] += 255 - wq.sum(1)
ji[wq == 0] = 0

mat = UsdShade.MaterialBindingAPI(mesh.GetPrim()).ComputeBoundMaterial()[0]
color, rough = [0.82, 0.8, 0.77], 0.6
if mat:
    sh = mat.ComputeSurfaceSource()[0]
    if sh:
        c = sh.GetInput('diffuseColor'); r = sh.GetInput('roughness')
        if c and c.Get() is not None: color = [min(0.85, float(x)) for x in c.Get()]
        if r and r.Get() is not None: rough = max(0.45, float(r.Get()))

# ---------- Écriture du GLB ----------
bin_, views, accs = bytearray(), [], []
def add(arr, comp, typ, target=None, normalized=False, minmax=False):
    while len(bin_) % 4: bin_.append(0)
    b = arr.tobytes(); views.append({'buffer': 0, 'byteOffset': len(bin_), 'byteLength': len(b), **({'target': target} if target else {})}); bin_.extend(b)
    a = {'bufferView': len(views) - 1, 'componentType': comp, 'count': len(arr), 'type': typ}
    if normalized: a['normalized'] = True
    if minmax: a['min'] = arr.min(0).tolist(); a['max'] = arr.max(0).tolist()
    accs.append(a); return len(accs) - 1
A_POS = add(P.astype(np.float32), 5126, 'VEC3', 34962, minmax=True)
A_NRM = add(Nr.astype(np.float32), 5126, 'VEC3', 34962)
A_JNT = add(ji.astype(np.uint8 if n < 256 else np.uint16), 5121 if n < 256 else 5123, 'VEC4', 34962)
A_WGT = add(wq.astype(np.uint8), 5121, 'VEC4', 34962, normalized=True)
A_IDX = add(tris.reshape(-1).astype(np.uint16 if len(P) < 65536 else np.uint32), 5123 if len(P) < 65536 else 5125, 'SCALAR', 34963)
# inverse(W) rangé ligne par ligne = matrice glTF (convention colonne) rangée colonne par colonne
A_IBM = add(np.stack([np.linalg.inv(W) for W in world]).astype(np.float32).reshape(-1, 16), 5126, 'MAT4')

def quat(R):  # matrice de rotation (convention colonne) → quaternion x, y, z, w
    m = R; t = np.trace(m)
    if t > 0: s = np.sqrt(t + 1) * 2; return [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, s / 4]
    i = int(np.argmax(np.diag(m))); j, k = (i + 1) % 3, (i + 2) % 3
    s = np.sqrt(1 + m[i, i] - m[j, j] - m[k, k]) * 2; q = [0, 0, 0, 0]
    q[i] = s / 4; q[j] = (m[j, i] + m[i, j]) / s; q[k] = (m[k, i] + m[i, k]) / s; q[3] = (m[k, j] - m[j, k]) / s; return q
nodes = []
for j in range(n):
    Lr = world[j] @ np.linalg.inv(world[parent[j]]) if parent[j] >= 0 else world[j]   # local (lignes)
    Lc = Lr.T                                                                         # local (colonnes, glTF)
    nd = {'name': names[j], 'translation': [round(float(x), 6) for x in Lc[:3, 3]], 'rotation': [round(float(x), 7) for x in quat(Lc[:3, :3])], 'extras': {'humanBone': role[j], 'label': names[j]}}
    if kids[j]: nd['children'] = kids[j]
    nodes.append(nd)
mesh_node = len(nodes); nodes.append({'name': title, 'mesh': 0, 'skin': 0})
root_node = len(nodes); nodes.append({'name': title + ' (squelette)', 'children': [hips, mesh_node]})
gltf = {
    'asset': {'version': '2.0', 'generator': 'Celluloïd usd2glb'},
    'scene': 0, 'scenes': [{'nodes': [root_node]}], 'nodes': nodes,
    'meshes': [{'name': title, 'primitives': [{'attributes': {'POSITION': A_POS, 'NORMAL': A_NRM, 'JOINTS_0': A_JNT, 'WEIGHTS_0': A_WGT}, 'indices': A_IDX, 'material': 0}]}],
    'materials': [{'name': title, 'pbrMetallicRoughness': {'baseColorFactor': color + [1], 'metallicFactor': 0, 'roughnessFactor': rough}}],
    'skins': [{'name': title, 'joints': list(range(n)), 'inverseBindMatrices': A_IBM, 'skeleton': hips}],
    'accessors': accs, 'bufferViews': views, 'buffers': [{'byteLength': len(bin_)}],
}
js = json.dumps(gltf, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
js += b' ' * ((4 - len(js) % 4) % 4)
while len(bin_) % 4: bin_.append(0)
with open(dst, 'wb') as f:
    f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bin_)))
    f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
    f.write(struct.pack('<II', len(bin_), 0x004E4942)); f.write(bin_)
print(f'{dst}: {len(P)} sommets, {len(tris)} triangles, {n} os, {(12 + 16 + len(js) + len(bin_)) / 1024:.0f} Ko, couleur {color}, rugosité {rough:.2f}')
print('  ', ', '.join(f'{names[j]}={role[j]}' for j in range(n) if 'Proximal' not in role[j] and 'Intermediate' not in role[j] and 'Distal' not in role[j] and 'Metacarpal' not in role[j]))

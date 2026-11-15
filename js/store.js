// Stockage local (IndexedDB) : métadonnées des projets + images des celluloïds.
let dbp = null;
function open() {
  return dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('anim2d', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('projects', { keyPath: 'id' });
      r.result.createObjectStore('cels');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const rq = fn(t.objectStore(store));
    t.oncomplete = () => res(rq?.result);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
export const listProjects = () => tx('projects', 'readonly', s => s.getAll());
export const getProject = id => tx('projects', 'readonly', s => s.get(id));
export const putProject = meta => tx('projects', 'readwrite', s => s.put(meta));
export const getCel = (pid, cid) => tx('cels', 'readonly', s => s.get(pid + '/' + cid));
export const putCel = (pid, cid, blob) => tx('cels', 'readwrite', s => s.put(blob, pid + '/' + cid));
export const delCel = (pid, cid) => tx('cels', 'readwrite', s => s.delete(pid + '/' + cid));
export async function deleteProject(pid) {
  await tx('cels', 'readwrite', s => s.delete(IDBKeyRange.bound(pid + '/', pid + '/￿')));
  await tx('projects', 'readwrite', s => s.delete(pid));
}

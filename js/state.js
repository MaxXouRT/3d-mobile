// État partagé de l'éditeur + mini bus d'événements.
const saved = (() => { try { return JSON.parse(localStorage.getItem('anim2d.tools') || 'null'); } catch { return null; } })();

export const S = {
  project: null,
  frameIdx: 0,
  layerId: null,
  tool: 'brush',
  color: saved?.color || '#111111',
  recent: saved?.recent || ['#111111', '#ffffff', '#e5484d', '#3b82f6', '#22c55e', '#f5c542'],
  playing: false,
  preview: false,   // affiche le rendu final (caméra + effets) au lieu de l'espace de travail
  tick: 0,
  ready: false,     // les celluloïds du frame courant sont chargés
  view: { x: 0, y: 0, scale: 1, rot: 0 },
  xform: null,      // transformation en cours (outil Déplacer)
  sizeHint: null,
  tools: Object.assign({
    brush: { type: 'pen', size: 8, opacity: 1, smooth: 0.4 },
    eraser: { size: 40, opacity: 1, soft: false },
    fill: { tol: 60, expand: 1, all: true },
    shape: { kind: 'line', size: 6, opacity: 1, fill: false },
  }, saved?.tools || {}),
};

export function saveToolPrefs() {
  try { localStorage.setItem('anim2d.tools', JSON.stringify({ color: S.color, recent: S.recent, tools: S.tools })); } catch {}
}

const L = {};
export const on = (e, f) => { (L[e] ??= []).push(f); };
export const emit = (e, ...a) => { (L[e] || []).forEach(f => f(...a)); };

// Accueil : choix 2D / 3D, liste des projets, création d'un projet.
import { h, $, icon, ibtn, toast, sheet, segmented, confirmDlg, busy } from './ui.js';
import * as db from './store.js';
import { Project } from './project.js';
import { openEditor } from './editor.js';

const app = $('#app');
const FORMATS = [['1920x1080', '16:9 HD', 1920, 1080], ['1280x720', '16:9 léger', 1280, 720], ['1080x1920', '9:16 vertical', 1080, 1920], ['1080x1080', 'Carré', 1080, 1080], ['1440x1080', '4:3', 1440, 1080]];

async function home() {
  let projects = [];
  try { projects = (await db.listProjects()).sort((a, b) => (b.modified || 0) - (a.modified || 0)); } catch (e) { console.error(e); }
  const list = projects.length
    ? h('div', { class: 'projects' }, projects.map(m => h('div', { class: 'project' },
      h('button', { class: 'project-open', onclick: () => m.kind === '3d' ? open3d(m.id) : open(m.id) },
        m.thumb ? h('img', { src: m.thumb, alt: '' }) : h('div', { class: 'noimg' }),
        h('span', {}, h('b', {}, m.name), h('small', {}, `${m.kind === '3d' ? '3D' : '2D'} · ${m.w} × ${m.h} · ${m.kind === '3d' ? m.len : m.frames.length} frames · ${m.fps} i/s`))),
      ibtn('trash', 'Supprimer le projet', async () => { if (await confirmDlg(`Supprimer définitivement « ${m.name} » ?`, 'Supprimer', true)) { await db.deleteProject(m.id); home(); } }, 'dim'))))
    : h('p', { class: 'hint' }, 'Aucun projet pour l’instant. Choisissez « Animation 2D » ou « Animation 3D » pour commencer.');
  app.replaceChildren(h('main', { class: 'home' },
    h('h1', {}, 'Celluloïd'), h('p', { class: 'tagline' }, 'Studio d’animation de poche'),
    h('div', { class: 'modes' },
      h('button', { class: 'mode m2d', onclick: () => newProject('2d'), html: icon('brush', 30) + '<b>Animation 2D</b><small>Dessin, calques, caméra, effets</small>' }),
      h('button', { class: 'mode m3d', onclick: () => newProject('3d'), html: icon('cube', 30) + '<b>Animation 3D</b><small>Modèles, pose, caméra, décalque 2D</small>' })),
    h('h2', {}, 'Mes projets'), list));
}

function newProject(kind) {
  const is3d = kind === '3d';
  const o = { name: '', fmt: '1920x1080', w: 1920, h: 1080, fps: is3d ? 24 : 12, surplus: 0.2, bg: '#ffffff' };
  const cw = h('input', { class: 'input num', type: 'number', min: 16, max: 4096, value: 1920 }), chh = h('input', { class: 'input num', type: 'number', min: 16, max: 4096, value: 1080 });
  const custom = h('div', { class: 'row', hidden: true }, h('span', { class: 'lbl' }, 'Largeur'), cw, h('span', { class: 'lbl' }, 'Hauteur'), chh);
  const name = h('input', { class: 'input', placeholder: 'Nom du projet', maxLength: 60 });
  const s = sheet({
    title: is3d ? 'Nouveau projet 3D' : 'Nouveau projet 2D', tall: true, modal: true,
    content: [name,
      h('div', { class: 'lbl' }, 'Format'),
      h('div', { class: 'formats' }, [...FORMATS, ['custom', 'Sur mesure']].map(([id, label, w, hh]) =>
        h('button', { class: 'format' + (id === o.fmt ? ' on' : ''), onclick: e => { o.fmt = id; custom.hidden = id !== 'custom'; e.currentTarget.parentElement.querySelectorAll('.format').forEach(b => b.classList.toggle('on', b === e.currentTarget)); } },
          h('b', {}, label), h('small', {}, w ? `${w} × ${hh}` : 'L × H')))),
      custom,
      h('div', { class: 'lbl' }, 'Images par seconde'),
      segmented([[8, '8'], [12, '12'], [15, '15'], [24, '24'], [30, '30']], o.fps, v => o.fps = v),
      ...(is3d ? [] : [
        h('div', { class: 'lbl' }, 'Surplus autour du cadre'),
        segmented([[0, 'Aucun'], [0.2, '20 %'], [0.5, '50 %'], [1, '100 %']], o.surplus, v => o.surplus = v),
        h('p', { class: 'hint' }, 'Le surplus est une marge dessinable autour du cadre : la caméra peut s’y déplacer pour faire des travellings. Plus il est grand, plus le projet pèse en mémoire.'),
        h('div', { class: 'row' }, h('span', { class: 'lbl grow' }, 'Couleur du fond'), h('input', { type: 'color', value: o.bg, oninput: e => o.bg = e.target.value }))]),
      h('button', {
        class: 'btn primary wide', onclick: async () => {
          let w = 1920, hh = 1080;
          if (o.fmt === 'custom') { w = Math.round(+cw.value); hh = Math.round(+chh.value); if (!(w >= 16 && hh >= 16 && w <= 4096 && hh <= 4096)) { toast('Dimensions entre 16 et 4096 px'); return; } }
          else { const f = FORMATS.find(f => f[0] === o.fmt); w = f[2]; hh = f[3]; }
          if (is3d) { const m = await new3dMeta({ name: name.value.trim() || 'Scène sans titre', w, h: hh, fps: o.fps, len: o.fps * 2 }); await db.putProject(m); s.close(); return open3d(m.id); }
          if (w * (1 + o.surplus) * hh * (1 + o.surplus) > 16e6) { toast('Format + surplus trop grand pour un téléphone : réduisez l’un des deux'); return; }
          const p = new Project({ name: name.value.trim() || 'Animation sans titre', w, h: hh, fps: o.fps, surplus: o.surplus, bg: o.bg });
          await p.save(); s.close(); openEditor(p, app, home);
        },
      }, 'Créer')],
  });
}

// La 3D (three.js) n'est chargée que lorsqu'on ouvre un projet 3D.
async function new3dMeta(o) { return (await import('./editor3d.js')).new3dMeta(o); }
async function open3d(id) {
  const m = await db.getProject(id);
  if (!m) { toast('Projet introuvable'); return home(); }
  const b = busy('Ouverture de la 3D…');
  try { const { openEditor3d } = await import('./editor3d.js'); window.editor3d = await openEditor3d(m, app, nav); }
  catch (e) { console.error(e); toast('La 3D ne peut pas démarrer sur cet appareil'); home(); }
  finally { b.close(); }
}
const nav = window.appNav = { home, open2d: id => open(id), open3d };

async function open(id) {
  const p = await Project.load(id);
  if (!p) { toast('Projet introuvable'); return home(); }
  openEditor(p, app, home);
}

home();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
navigator.storage?.persist?.().catch(() => {});

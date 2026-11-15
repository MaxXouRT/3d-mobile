# Celluloïd — studio d'animation de poche

Application mobile d'animation (web-app installable, sans serveur). L'accueil propose **Animation 2D** et **Animation 3D**.

## Ce que fait la partie 2D

- **Dessin** : stylo, plume, crayon, marqueur, aérographe, gomme (dure ou douce), pot de peinture, pipette, formes, taille / opacité / stabilisateur, pression du stylet.
- **Calques** : opacité, mode de fusion, masquer, verrouiller, renommer, dupliquer, fusionner, réordonner, calque « fixe » (décor commun à tous les frames).
- **Extraction des traits** : sur un calque de référence, récupère automatiquement les traits au pixel près sur un nouveau calque (modes *Traits*, *Traits + noirs*, *Contours couleur*). Il reste à colorier dessous au pot de peinture.
- **Frames** : ajout, duplication, déplacement, durée de chaque dessin, images par seconde, pelure d'oignon réglable, lecture en boucle.
- **Surplus et caméra** : la zone de dessin déborde du format choisi ; une caméra à clés (position, zoom, rotation) se déplace dans ce surplus.
- **Effets** : lueur, diffusion, flou, couleurs, lumière dégradée, vignette, grain, aberration chromatique, lignes de vitesse, tremblement, fondu, bandes cinéma — sur l'image entière ou sur un calque, sur une plage de frames.
- **Import** : image, séquence d'images, vidéo image par image.
- **Export** : vidéo MP4, GIF, image PNG, suite de PNG (ZIP), puis enregistrement dans la galerie via la feuille de partage du téléphone.

Gestes : un doigt dessine ; deux doigts déplacent, zooment et tournent la page ; tape à deux doigts = annuler, à trois doigts = rétablir.

## Ce que fait la partie 3D

- **Import de modèles** : glb, gltf, vrm, fbx, pmx / pmd (MMD), obj (+mtl), dae, stl, ply, seuls, avec leurs textures, ou dans un zip (le format le plus riche du zip est choisi ; s'il est illisible, le suivant est essayé). Mouvements MMD `.vmd`.
- **Pose et animation** : sélection d'un objet ou d'un os en le touchant, poignées déplacer / tourner / taille, une clé est posée automatiquement sur le frame courant, interpolation entre les clés, animations contenues dans le fichier.
- **Caméra** : la vue dans le cadre est la caméra ; clés de caméra interpolées.
- **Scène** : formes simples, fond, lumière, rendu « argile ».
- **Export** : vidéo MP4 ou image PNG.
- **Vers la 2D** : envoie l'animation 3D image par image sur un calque « Référence 3D » d'un projet 2D pour décalquer, ou une image comme décor fixe. Le projet 2D garde un lien pour revenir à la scène 3D.

## Lancer

Aucune compilation. Servir le dossier en HTTP puis ouvrir la page :

```sh
python3 -m http.server 8000   # puis http://localhost:8000
```

Sur téléphone : publier le dépôt avec GitHub Pages (le workflow `.github/workflows/pages.yml` est prêt ; activer *Settings → Pages → Source : GitHub Actions*), ouvrir l'adresse, puis « Ajouter à l'écran d'accueil ».

## Organisation du code

| Fichier | Rôle |
| --- | --- |
| `js/main.js` | accueil, création de projet |
| `js/project.js`, `js/store.js` | modèle (calques, frames, celluloïds), mémoire, sauvegarde IndexedDB |
| `js/viewport.js` | zone de dessin et gestes tactiles |
| `js/tools.js` | pinceaux, gomme, remplissage, déplacement, caméra, annuler / rétablir |
| `js/render.js`, `js/effects.js` | composition, caméra, effets, rendu final |
| `js/lineart.js` | extraction des traits |
| `js/io.js` | import et export |
| `js/editor.js`, `js/panels.js`, `js/ui.js` | interface |
| `js/editor3d.js`, `js/import3d.js` | éditeur 3D, import des modèles |
| `vendor/` | mp4-muxer, gifenc, three.js (licence MIT) |

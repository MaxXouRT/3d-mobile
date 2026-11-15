# Celluloïd — studio d'animation de poche

Application mobile d'animation (web-app installable, sans serveur). L'accueil propose **Animation 2D** ; l'**Animation 3D** est réservée pour plus tard.

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
| `vendor/` | mp4-muxer et gifenc (licence MIT) |

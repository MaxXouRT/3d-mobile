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

- **Personnages prêts à l'emploi** : un mannequin et un mannequin femme, livrés avec l'app (« Ajouter » → un toucher). Articulés de la tête aux doigts (52 os aux noms en français), ils marchent hors ligne.
- **Import de modèles** : glb, gltf, vrm, fbx, pmx / pmd (MMD), obj (+mtl), dae, stl, ply, seuls, avec leurs textures, ou dans un zip (le format le plus riche du zip est choisi ; s'il est illisible, le suivant est essayé). Mouvements MMD `.vmd`.
- **Filmer (capture de mouvement)** : on se filme (ou on choisit une vidéo) et le personnage reproduit le mouvement, une clé par frame, à partir du frame courant. Les points du corps sont détectés sur l'appareil par MediaPipe Pose ; les os humains sont reconnus automatiquement (VRM, Mixamo, MMD, VRoid, Blender, Unreal, 3ds Max) ; options : début et durée, lissage, pieds posés au sol, effet miroir. Un membre hors champ garde sa pose. La première utilisation télécharge les détecteurs (32 Mo), gardés ensuite sur l'appareil.
  - **Doigts** : MediaPipe Hands sur un recadrage agrandi autour de chaque poignet ; chaque phalange suit la vidéo, la main prend aussi sa rotation (paume vers le haut ou le bas), dont une part passe dans l'avant-bras.
  - **Caméra tenue à la main** : seule l'orientation d'ensemble du corps dépend de la caméra ; elle est lissée dans le temps, les gestes des membres restent intacts.
  - **Cheveux et vêtements** : os à ressort (inertie, gravité, retour à la forme, collisions avec le corps), réglages lus dans le fichier (VRM 0/1, corps rigides MMD) ou devinés d'après le nom des os (hair, skirt, 髪, スカート…). Calculés après la capture, ou à la demande (Objets → « Cheveux et vêtements ») pour toute animation, puis enregistrés en clés.
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
| `js/mocap.js` | capture de mouvement : détection du corps et des mains, stabilisation, reconnaissance du squelette, transfert sur les os |
| `js/physics.js` | cheveux et vêtements : os à ressort et collisions, calculés puis enregistrés en clés |
| `models/` | mannequins livrés avec l'app (GLB + vignettes) |
| `tools/usd2glb.py` | convertit un mannequin USDZ (squelette type Mixamo) en GLB pour `models/` |
| `vendor/` | mp4-muxer, gifenc, three.js (licence MIT), MediaPipe Tasks Vision + modèles Pose « full » et Hands (licence Apache 2.0) |

### Précision de la capture de mouvement

Mesurée sur une vidéo de danse dont on connaît le vrai mouvement : le transfert sur le squelette est exact (0° d'écart sur 7 personnages de types différents) ; l'écart restant vient de la détection d'une seule caméra, précise dans le plan de l'image (≈5°) mais approximative en profondeur. Écart médian : tibias 8–11°, cuisses 14–15°, avant-bras ≈26°, bras 34–44°. Les mouvements faits de face ou de profil passent donc mieux que ceux dirigés vers la caméra.

Doigts (vidéo en pied, 720 × 1280, mains d'environ 50 px) : écart moyen de pliure 10° (pouce) à 27° (index), contre 46 à 81° si les doigts restaient immobiles. Caméra secouée (±2°) : le tremblement du personnage retombe de 1,25 à 0,49 °/image², autant qu'avec une caméra fixe (0,51).

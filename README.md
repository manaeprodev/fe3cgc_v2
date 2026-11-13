# Fire Emblem Three Crowns : Grand Conquests

Jeu de conquête de territoires, en PWA mobile. Serveur Node sans dépendance (SQLite intégré), interface en JavaScript pur, sans étape de build.

## Lancer

```bash
node server.js
```

Puis ouvrir http://localhost:3000 (port modifiable avec la variable `PORT`). Node 22.13 ou plus récent.

Pour installer l'app sur un téléphone, le site doit être servi en **HTTPS** (obligatoire pour une PWA, sauf sur `localhost`).

## Sécurité et mise en ligne

Protections en place dans `server.js` :

- **En-têtes de sécurité** sur toutes les réponses, dont une CSP : la page ne charge scripts, images et données que depuis ce serveur, et ne peut pas être affichée dans une iframe. Conséquence : pas de script en ligne ni de ressource venant d'un autre site (police, image, bibliothèque) sans modifier la constante `CSP`.
- **Vérification de l'origine** : toute requête qui modifie des données est refusée si elle vient d'un autre site.
- **Limites de débit par IP** : 600 requêtes par minute toutes routes confondues, 120 par minute sur l'API, 10 par 10 minutes sur la connexion et l'inscription (constante `LIMITS`).
- **Blocage de compte** : après 5 mots de passe faux sur un même email, le compte est bloqué 15 minutes, d'où que viennent les essais (constantes `LOCK_FAILS`, `LOCK_MINUTES`).

À régler au moment de la mise en ligne, par variables d'environnement :

| Variable | Rôle |
|---|---|
| `TRUST_PROXY` | Nombre de proxys placés devant le serveur. Mettre `1` derrière un hébergeur ou un reverse proxy, sinon tous les joueurs partagent la même IP et se bloquent entre eux. Laisser à `0` en accès direct, sinon l'IP peut être falsifiée. |
| `ALLOWED_ORIGINS` | Origines supplémentaires autorisées à appeler l'API, séparées par des virgules. Inutile si le jeu est servi par ce serveur. |
| `PORT` | Port d'écoute (3000 par défaut). |

Le serveur parle HTTP : il doit être placé derrière HTTPS (hébergeur ou reverse proxy). Il ajoute alors de lui-même l'en-tête HSTS et le cookie de session passe en `Secure`.

Reste à faire avant une vraie ouverture au public : la vérification des adresses email, et faire constater par le serveur (et non par l'app) les actions qui donnent des récompenses de mission.

## Où mettre les images

Tout est dans `public/assets/`. Les fichiers actuels sont provisoires : remplace-les en gardant le même nom.

| Quoi | Emplacement | Nom | Format conseillé |
|---|---|---|---|
| Carte | `public/assets/map/` | `map.svg` | SVG rectangulaire, `viewBox="0 0 1600 900"` |
| Logos de faction | `public/assets/factions/` | `rouge.svg`, `bleue.svg`, `jaune.svg`, `violette.svg` | carré, SVG ou PNG 256 px |
| Avatars | `public/assets/avatars/` | noms libres | PNG, JPG, WEBP ou SVG, n'importe quelles proportions |
| Icône de l'app | `public/assets/icons/` | `icon-192.png`, `icon-512.png`, `icon.svg` | carré |
| Icônes de classe | `public/assets/classes/` | l'identifiant de la classe : `myrmidon.svg`, `pegasus-knight.svg`… | carré, pixel art (affiché sans lissage) |
| Icônes d'interface | `public/assets/ui/` | `gold.svg` (pièces d'or), `renown.svg` (étoile), `bell.svg` (cloche), `missions.svg` (parchemin) | carré, SVG |

- **Avatars** : tout fichier image déposé dans le dossier est proposé automatiquement à la création du personnage, par ordre alphabétique. Ils sont recadrés en carré à l'affichage (centrés).
- **Avatars bloqués** : ils sont dans le même dossier, mais déclarés dans `game.json` sous `avatars.locked`. `{ "file": "shop-01.svg", "unlock": "gold", "price": 600 }` se débloque en l'achetant ; `{ "file": "mission-01.svg", "unlock": "mission" }` se gagne avec une mission dont la récompense contient `"avatar": "mission-01.svg"`. Un fichier non déclaré est libre. Les avatars provisoires bloqués s'appellent `mission-01.svg` à `mission-08.svg` et `shop-01.svg` à `shop-06.svg`.
- **Autre format ou autre nom** (ex. logo en `.png`) : change le chemin dans `public/config/game.json`.

## Langues

L'app est multilingue (français et anglais pour l'instant). Le joueur choisit sa langue avec le sélecteur en haut de chaque écran ; au premier lancement, l'app prend la langue du téléphone si elle est disponible. Le choix est mémorisé sur l'appareil et sur le compte (colonne `users.lang`).

- **Textes de l'interface** (boutons, titres, erreurs, notifications) : `public/i18n/fr.json` et `public/i18n/en.json`, mêmes clés dans chaque fichier. Une clé absente retombe sur la langue par défaut.
- **Contenu du jeu** (factions, classes, règles, missions, territoires) : dans `public/config/game.json`, chaque texte s'écrit `{ "fr": "…", "en": "…" }`. Une simple chaîne fonctionne aussi et s'affiche telle quelle dans toutes les langues.

Pour ajouter une langue : copier `public/i18n/fr.json` sous le nouveau code (ex. `es.json`), le traduire, ajouter la langue à `languages` dans `game.json`, compléter les textes `{ … }` de la config, et ajouter le fichier à la liste `SHELL` de `public/sw.js`.

Le serveur ne renvoie aucun texte : il renvoie des codes d'erreur (clés `error.<code>`) et des notifications sous forme de type et paramètres (clés `notif.<type>.title` et `.body`).

## Régler le jeu : `public/config/game.json`

- `languages`, `defaultLang` : langues proposées et langue par défaut.

- `factions` : nom, couleur, logo et **courte description** de chaque faction. `"secret": true` cache la faction derrière le bouton secret.
- `classes` : classes de départ (identifiant, nom, description).
- `map.width` / `map.height` : dimensions du `viewBox` de la carte. À modifier si ta carte n'est pas en 1600 × 900.
- `map.territories` : liste des territoires, avec `id`, `name` et les coordonnées `x`, `y` exprimées dans le repère du `viewBox` de la carte.

- `player` : or de départ (`startGold`), xp nécessaire pour la renommée 1 (`renownBaseXp`) et multiplicateur par niveau (`renownGrowth`, 1.1 = +10 %).
- `rules` : sections des règles du jeu (`title`, `text`), affichées par le bouton « Règles du jeu » du menu.
- `missions` : liste des missions, voir ci-dessous.

Redémarre le serveur après une modification de ce fichier.

### Classes

- `classTiers` : les rangs, dans l'ordre (base, intermédiaire, avancée, maître, légendaire). Chaque rang fixe la renommée minimale (`renown`) et le prix en or (`cost`) pour prendre une classe de ce rang. Un rang sans prix (`null`) est verrouillé, et un rang sans classe n'est pas affiché : c'est le cas du rang légendaire pour l'instant.
- `classes` : chaque classe a un `id`, un rang (`tier`), ses prérequis (`requires`, une seule des classes listées suffit), un nom, une description et une icône.

Règles appliquées par le serveur (`POST /api/class`) :

- à la création du personnage, seules les classes du premier rang sont proposées ;
- pour prendre une classe, la classe actuelle doit figurer dans ses prérequis, et le joueur doit avoir la renommée et l'or du rang visé (un Pegasus Knight peut donc passer directement Falcon Knight au tarif des classes de Maître) ;
- on peut revenir à n'importe quelle classe de base depuis n'importe quelle classe, au tarif du premier rang (renommée 1, 400 or).

Pour ajouter des classes légendaires : renseigner `renown` et `cost` du rang `legendary`, puis ajouter les classes avec `"tier": "legendary"` et leurs prérequis. Elles apparaîtront dans l'arbre et dans les règles sans autre changement. Chaque changement de classe est enregistré dans la table `class_changes`.

### Renommée

La renommée est un niveau calculé à partir de l'xp cumulée du joueur : 100 xp pour le niveau 1, puis chaque niveau coûte 10 % de plus que le précédent (110, 121, 133…).

### Missions

```json
{
  "id": "regles",
  "title": "Connaître les règles",
  "description": "Ouvre les règles du jeu depuis le menu.",
  "condition": { "type": "event", "event": "rules_read", "count": 1 },
  "rewards": { "gold": 100, "xp": 50 }
}
```

Conditions possibles :

| `type` | Paramètres | Remplie quand |
|---|---|---|
| `event` | `event`, `count` (1 par défaut) | le joueur a fait l'action `count` fois |
| `renown` | `level` | le joueur atteint ce niveau de renommée |
| `gold` | `amount` | le joueur possède au moins cet or |

Actions (`event`) déjà émises par le jeu : `character_created`, `rules_read`, `territory_viewed`. Quand une mission est accomplie, le joueur reçoit une notification et récupère sa récompense dans l'écran Missions. Ne change pas l'`id` d'une mission déjà en ligne : c'est lui qui mémorise qui l'a terminée.

## Base de données

Fichier SQLite `data/conquete.db`, créé au premier lancement.

| Table | Contenu |
|---|---|
| `users` | email, mot de passe haché (scrypt + sel), dates de création et de dernière connexion |
| `characters` | pseudo, anniversaire, classe, avatar, faction, or (`gold`), expérience (`xp`) |
| `notifications` | notifications de chaque joueur, lues ou non |
| `mission_progress` | missions accomplies et récompenses récupérées |
| `unlocked_avatars` | avatars débloqués par chaque joueur (achat ou mission) |
| `class_changes` | journal des changements de classe |
| `player_events` | compteurs d'actions du joueur, utilisés par les missions |
| `sessions` | sessions ouvertes (jeton haché, expiration à 30 jours, IP, navigateur) |
| `login_events` | journal de chaque inscription, connexion (réussie ou non) et déconnexion |
| `territories` | faction qui contrôle chaque territoire |

## Structure

```
server.js              serveur HTTP, API, base de données
public/index.html      page unique
public/js/app.js       toute l'interface
public/css/style.css   styles
public/config/game.json  factions, classes, carte, territoires
public/assets/         images
public/sw.js, manifest.webmanifest   partie PWA
```

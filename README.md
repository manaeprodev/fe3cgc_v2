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
| Fond de carte | `public/assets/map/` | `fodlan.jpg` | image 1800 × 1350 (mêmes proportions que les contours) |
| Logos de faction | `public/assets/factions/` | `rouge.svg`, `bleue.svg`, `jaune.svg`, `violette.svg` | carré, SVG ou PNG 256 px |
| Avatars | `public/assets/avatars/` | noms libres | PNG, JPG, WEBP ou SVG, n'importe quelles proportions |
| Icône de l'app | `public/assets/icons/` | `icon-192.png`, `icon-512.png`, `icon.svg` | carré |
| Icônes de classe | `public/assets/classes/` | l'identifiant de la classe : `myrmidon.webp`, `pegasus-knight.webp`… (`legendary/` : images des classes légendaires à venir) | carré, WebP |
| Icônes d'interface | `public/assets/ui/` | `gold.svg` (pièces d'or), `renown.svg` (étoile), `bell.svg` (cloche), `missions.svg` (parchemin) | carré, SVG |

- **Avatars** : tout fichier image déposé dans le dossier est proposé automatiquement à la création du personnage, par ordre alphabétique. Ils sont recadrés en carré à l'affichage (centrés).

Compteurs des missions spéciales (table `player_events`, comptés par le serveur) : `serpents_repelled`, `gold_spent` (tout l'or dépensé : achats, renforts, retours, téléportation, changements de classe), `gather`, `battalion`, `enemy_move`, `solo_attacks` / `solo_defenses` (victoire en étant le seul à avoir agi dans son camp), `atk_streak` / `def_streak` et leurs `best_…` (séries de victoires), et en fin de campagne `campaigns_won`, `campaigns_conquest` (victoire par conquête totale), `campaigns_mvp` (meilleur score de la faction gagnante), `campaigns_top3` et `campaigns_flawless` (aucune mort pendant la campagne : `campaign_scores.deaths`).
- **Avatars** : `public/assets/avatars/avatar_N.webp`, déclarés dans `game.json` sous `avatars`. `free` : les avatars libres (proposés à la création et changeables à tout moment), dans l'ordre d'affichage. `locked` : `{ "file": "avatar_20.webp", "unlock": "gold", "price": 400 }` s'achète ; `{ "file": "avatar_12.webp", "unlock": "mission" }` se gagne. `special` : les missions spéciales, qui débloquent automatiquement un avatar quand un compteur du joueur atteint `count` (`stat`) ou quand il a une distinction (`distinction`). Un fichier absent de ces listes n'est pas proposé. Les images sont carrées à l'affichage (recadrées, jamais déformées, visage en haut). Au démarrage, les anciens avatars provisoires sont remplacés par un avatar libre et leurs achats remboursés.
- **Autre format ou autre nom** (ex. logo en `.png`) : change le chemin dans `public/config/game.json`.

## Langues

L'app est multilingue (français et anglais pour l'instant). Le joueur choisit sa langue avec le sélecteur en haut de chaque écran ; au premier lancement, l'app prend la langue du téléphone si elle est disponible. Le choix est mémorisé sur l'appareil et sur le compte (colonne `users.lang`).

- **Textes de l'interface** (boutons, titres, erreurs, notifications) : `public/i18n/fr.json` et `public/i18n/en.json`, mêmes clés dans chaque fichier. Une clé absente retombe sur la langue par défaut.
- **Contenu du jeu** (factions, classes, règles, missions, territoires) : dans `public/config/game.json`, chaque texte s'écrit `{ "fr": "…", "en": "…" }`. Une simple chaîne fonctionne aussi et s'affiche telle quelle dans toutes les langues.

Pour ajouter une langue : copier `public/i18n/fr.json` sous le nouveau code (ex. `es.json`), le traduire, ajouter la langue à `languages` dans `game.json`, compléter les textes `{ … }` de la config, et ajouter le fichier à la liste `SHELL` de `public/sw.js`.

Le serveur ne renvoie aucun texte : il renvoie des codes d'erreur (clés `error.<code>`) et des notifications sous forme de type et paramètres (clés `notif.<type>.title` et `.body`).


**Accord des verbes** : une faction est au pluriel (« Les Aigles de jais attaquent ») ou au singulier (« L'Église de Seiros attaque ») selon sa langue. Le champ `plural` d'une faction dans `game.json` donne le nombre par langue (`{ "fr": false, "en": false }` pour l'Église, `{ "en": false }` pour The Golden Deer) ; sans lui, la faction est au pluriel. Les textes dont une faction est le sujet ont deux variantes : `journal.territory_taken` et `journal.territory_taken.pl`. Pour une nouvelle phrase de ce type, ajouter la variante `.pl` dans chaque langue et appeler `numKey` côté app.
## Régler le jeu : `public/config/game.json`

- `languages`, `defaultLang` : langues proposées et langue par défaut.

- `factions` : nom, couleur, logo et **courte description** de chaque faction. `"secret": true` cache la faction derrière le bouton secret. `"npc": true` en fait une faction non jouable : elle peut contrôler des territoires mais aucun joueur ne peut la rejoindre (l'Église de Seiros, logo `eglise.svg`).
- `classes` : classes de départ (identifiant, nom, description).
- La carte n'est pas dans ce fichier mais dans `public/config/map.json`, voir ci-dessous.

- `player` : or de départ (`startGold`), xp nécessaire pour la renommée 1 (`renownBaseXp`) et multiplicateur par niveau (`renownGrowth`, 1.1 = +10 %).
- `rules` : sections des règles du jeu (`title`, `text`), affichées par le bouton « Règles du jeu » du menu.
- `missions` : liste des missions, voir ci-dessous.

Redémarre le serveur après une modification de ce fichier.

### Carte : `public/config/map.json`

- `image`, `width`, `height` : fond de carte et dimensions du repère (1800 × 1350).
- `territories` : un territoire par ligne, avec
  - `id` et `name` (une chaîne, ou `{ "fr": "…", "en": "…" }`) ;
  - `faction` : la faction qui contrôle le territoire au départ (`null` = neutre). Elle n'est appliquée qu'à la création du territoire en base ; ensuite c'est la base qui fait foi ;
  - `path` : le contour, repris tel quel du fichier Inkscape d'origine (attribut `d` du tracé) ;
  - `x`, `y` : le centre du territoire ;
  - `neighbors` : les `id` des territoires voisins. Il suffit qu'un des deux cite l'autre pour qu'ils soient voisins.

Les voisins ont été calculés à partir des contours (frontière commune d'au moins 14 px) : ils se corrigent à la main dans ce fichier, par exemple pour relier une île par la mer. L'état du jeu (quelle faction contrôle quel territoire) est en base, table `territories` ; un territoire retiré de `map.json` est retiré de la base au redémarrage.

Dans l'app, la carte est un SVG : chaque territoire est cliquable, coloré selon sa faction, et sa sélection met ses voisins en évidence. Le serveur expose `areNeighbors(a, b)` pour les futures règles d'attaque.

### Campagne : clé `campaign` de `game.json`, moteur dans `campaign.js`

Le temps est découpé en tours (`turnMinutes`, 10 minutes). Un joueur gagne 1 action par tour jusqu'à `maxActions` (6).

- **Se déplacer** vers un territoire voisin : 1 action. On n'entre sur un territoire qui n'est pas à sa faction que s'il touche un territoire de sa faction (ou sa base, voir `homeBases`).
- **Défendre** (territoire allié) : renforce la défense de la bataille en cours, ou pose une garnison qui compte si une bataille démarre dans les `battleTurns` tours.
- **Récolter** (territoire allié, hors bataille) : rapporte `gather.gold` et `gather.xp`.
- **Attaquer** (territoire ennemi ou neutre) : lance une bataille de `battleTurns` tours, ou renforce celle de sa faction. Les joueurs de la faction attaquée sont prévenus.

Chances de l'attaque = force des attaquants / (attaquants + défense), bornées par `minChance` et `maxChance`. Chaque action Attaquer ou Défendre ajoute la force du joueur : `tierPower` selon le rang de sa classe, augmentée de `renownPower` par niveau de renommée. La défense part de `baseDefense` × importance du territoire (`importance` dans `map.json`), plus `npcDefense` pour une faction non jouable (c'est ce qui rend Garreg-Mach dur à prendre).

À la fin de la bataille, un tirage décide. Attaque réussie : le territoire change de faction, les attaquants touchent `attackRewards` × importance, et les défenseurs présents ont `retreatTurns` tours pour se replier sur un territoire allié, sinon ils tombent jusqu'à la fin de la campagne. Attaque ratée : les défenseurs touchent `defenseRewards` × importance.

- `capitals` : territoire d'apparition de chaque faction. `homeBases` : base d'une faction sans territoire (Garreg-Mach pour les Loups de cendre), qui lui sert d'appui sans qu'elle le contrôle.
- `annex` : territoires annexes, conquérables mais ignorés pour la victoire.
- `boss` : à chaque tour, la faction `boss.faction` a `chancePerTurn` chances (0,07 = 7 %) de lancer une attaque de force `power` × importance sur un territoire au hasard (au plus `max` à la fois). Si elle gagne, le territoire lui appartient. `quietHours` (`from` inclus, `to` exclu, en heures, avec son fuseau `timezone`) interdit toute apparition pendant la nuit : de minuit à 6 h, heure de Paris. Les batailles déjà commencées continuent, et le fuseau est fixé dans la config pour que la nuit ne dépende pas du serveur qui héberge le jeu. `TEST_HOUR` force l'heure pour les tests.
- Fin de campagne : une faction jouable tient tous les territoires non annexes, ou il ne reste des joueurs en vie que dans une seule faction. `points` fixe les points gagnés ; ils s'ajoutent dans la table `faction_points`. La carte est ensuite remise à son état de départ et une nouvelle campagne commence.

Autres réglages de `campaign` :

- `cadenceGold` : or gagné par la première action de chaque tour (bonus de régularité).
- `hire` : renfort payé en or, sans action. Fortification sur son territoire, bataillon (« Battalion ») dans une attaque de sa faction ; `gold` le prix, `power` la force ajoutée, `perBattle` le maximum par joueur et par bataille.
- `revive.gold` : prix du retour en jeu d'un joueur tombé. Il peut aussi sacrifier un niveau de renommée, ou demander à un allié de payer (les demandes apparaissent dans le Journal de sa faction). Il réapparaît dans sa capitale si sa faction la tient, sinon sur un de ses territoires au hasard.
- Une faction qui perd son dernier territoire est hors jeu jusqu'à la fin de la campagne ; ses joueurs ne peuvent plus revenir. La campagne se termine quand, parmi les factions qui ont des joueurs, une seule reste en jeu.
- `ranking` : points de classement par action de combat (`combat`), par bataille gagnée (`victory`) et par récolte (`gather`) ; `rewards` est l'or donné aux premiers à la fin de la campagne.
- Appel à l'aide : gratuit, une fois par joueur et par bataille ; il prévient toute la faction.
- `exile` : quand sa faction est hors jeu, un joueur tombé peut s'exiler sous la bannière d'une autre faction jusqu'à la fin de la campagne (route `POST /api/exile`, choix dans l'onglet Journal). Il réapparaît dans la capitale de cette faction et combat pour elle, mais ses gains d'or et d'expérience sont multipliés par `rewardMultiplier` (0,75 = 25 % de moins). Qui peut accueillir un exilé :
  - avec `trailingOnly`, les factions jouables qui ne tiennent pas le plus de territoires (toutes, s'il n'y a pas d'autre choix) ;
  - `alwaysOpen` : les factions qui acceptent des exilés même en tête (les Loups de cendre) ;
  - `npcHosts` : les factions non jouables qui en accueillent tant qu'elles tiennent un territoire (l'Église de Seiros). Si elle perd Garreg-Mach, ses exilés tombent et choisissent une autre bannière.
  Si la bannière d'adoption tombe à son tour, l'exilé peut en choisir une autre.
- `defeat.consolationGold` : prime d'or donnée aux membres d'une faction qui tombe, à condition d'avoir marqué au moins un point au classement de la campagne. Ils reçoivent aussi la distinction `veteran` ; ceux qui ont défendu son dernier territoire reçoivent `last_stand`.

Les distinctions sont déclarées dans la clé `distinctions` de `game.json` (nom, description, avatar exclusif débloqué). Elles s'affichent dans le menu, avec leur nombre quand on les a obtenues plusieurs fois, dans la table `distinctions`.
- `underdogs` : avantages d'une faction en infériorité, par identifiant de faction (les Loups de cendre) :
  - `neverOut` : jamais hors jeu, même sans territoire ;
  - `autoRetreat` : si son territoire tombe, le joueur se replie aussitôt dans la base de sa faction (`homeBases`) ;
  - `freeRevive` : retour en jeu gratuit ;
  - `outnumberedMax` : force du petit nombre. Chaque action de combat est multipliée par (moyenne des effectifs des autres factions qui ont des joueurs) / (effectif de la faction), entre 1 et ce plafond ;
  - `rewardMultiplier` : or et expérience multipliés sur les conquêtes ;
  - `pointsMultiplier` : points de faction multipliés par territoire tenu en fin de campagne.

Le journal du monde (onglet Journal, `GET /api/journal`) liste les derniers événements : attaques, territoires pris, attaques repoussées, appels à l'aide, factions hors jeu, fins de campagne.

Tables : `campaigns`, `faction_points`, `player_state` (position, actions, état), `battles`, `contributions` (actions de combat et renforts), `world_events` (journal), `battle_rallies`, `campaign_scores` (classement).

Variables d'environnement pour tester : `TURN_SECONDS` (durée d'un tour), `TEST_ROLL` (tirage forcé, 0 = attaque réussie), `BOSS_CHANCE`, `CADENCE_GOLD`, `TEST_DAY` (jour forcé pour les missions du jour), `TEST_HOUR` (heure forcée pour les heures calmes), `TEST_MOVE_ROLL` (tirage forcé du déplacement gratuit, entre 0 et 1), `DATA_DIR` (base séparée).

### Contre-attaque : clé `campaign.counter`

Quand une attaque d'une faction jouable échoue contre une autre faction jouable, le territoire défendu devient insaisissable pendant `minutes` minutes de jeu (240 = 4 h, ramenées à la durée d'un tour comme le reste) : `POST /api/act` refuse alors l'attaque (`untouchable`) et les mini-boss l'évitent. Pendant ce temps, la faction qui a défendu gagne `attackBonus` % de puissance d'attaque sur les territoires ennemis voisins du territoire défendu (bonus fixé à l'ouverture de la bataille). Les Serpents des Ténèbres et l'Église de Seiros ne déclenchent rien. Exception : `campaign.guardians` (`{ "violette": "eglise" }`) permet aux Loups de cendre de défendre comme leur territoire (défendre, fortifier, appel à l'aide) un territoire de l'Église attaqué ; s'ils y ont participé et que l'attaque échoue, la défense leur est créditée (`battles.credit`) : le territoire devient insaisissable et ce sont eux qui gagnent le bonus de contre-attaque, porté à `counter.factionBonus.violette` (40 %). L'état de contre-attaque s'appelle « On Fire! » dans l'interface. Le serveur le déduit des batailles terminées (`battles`), sans table dédiée.

### Mises à jour : clé `patches` de `game.json`

Les notes de patch, la plus récente en premier : `id`, `date`, `title`, `intro`, `sections` (titre et liste de phrases), chaque texte en `{ fr, en }`. Le premier `id` est la « dernière mise à jour » ; `users.patch_seen` retient celle que chaque joueur a lue (`POST /api/patch/seen`), et `GET /api/me` renvoie `patch: { latest, seen }` : une pastille s'affiche sur le menu tant qu'ils diffèrent. Un nouveau compte part avec la dernière mise à jour déjà lue. Pour publier un patch, ajouter une entrée en tête de la liste.

### Joueurs sur la carte

`GET /api/map` renvoie pour chaque territoire `occupants` (pseudo, avatar, faction, classe, renommée, `me`, `retreating`) et `players` (comptes par faction), en ne listant que les joueurs visibles. Une faction marquée `"hiddenAtBase": true` dans `campaign.underdogs` (les Loups de cendre, base : Garreg-Mach) est invisible sur sa base tant qu'un de ses membres n'y attaque ni n'y défend (bataille en cours ou garnison posée), sauf pour le joueur lui-même ; le serveur ne les envoie pas du tout. Sur la carte, les territoires insaisissables affichent un bouclier doré qui brille (`untouchableUntil`), ceux où une contre-offensive est possible pour la faction du joueur un bouclier brisé (`counter`), et jusqu'à 3 pastilles d'avatar aux couleurs de la faction, plus une pastille « + » au-delà. Le détail des présents est dans le panneau sous la carte.

### Missions du jour : clé `daily` de `game.json`, code dans `daily.js`

Chaque mission compte une action de jeu sur la journée : `gather` (récolter), `combat` (attaquer ou défendre), `move` (se déplacer), `battle_won` (bataille gagnée). Les missions d'exil (clé `exileMissions`, réservées aux joueurs dont la faction est hors jeu) comptent `journal_read` (consulter le journal), `exile_join` (s'exiler) et `exile_combat` (action de combat en exil). Tant qu'un joueur est tombé et que sa faction est hors jeu, sa série de jours est gelée. Ces actions sont constatées par le serveur, pas déclarées par l'app. Récupérer au moins une mission par jour fait grandir la série ; chaque jour de série ajoute `streakBonus` (10 %) d'or aux récompenses, jusqu'à `maxStreak` jours. Les missions classiques (`missions`) peuvent utiliser les mêmes actions dans leur condition `event`.

### Classes

- `classTiers` : les rangs, dans l'ordre (base, intermédiaire, avancée, maître, légendaire). Chaque rang fixe la renommée minimale (`renown`) et le prix en or (`cost`) pour prendre une classe de ce rang. Un rang sans prix (`null`) est verrouillé, et un rang sans classe n'est pas affiché : c'est le cas du rang légendaire pour l'instant.
- `classes` : chaque classe a un `id`, un rang (`tier`), ses prérequis (`requires`, une seule des classes listées suffit), un nom, une description et une icône.

Règles appliquées par le serveur (`POST /api/class`) :

- à la création du personnage, seules les classes du premier rang sont proposées ;
- pour prendre une classe, la classe actuelle doit figurer dans ses prérequis, et le joueur doit avoir la renommée et l'or du rang visé (un Pegasus Knight peut donc passer directement Falcon Knight au tarif des classes de Maître) ;
- on peut revenir à n'importe quelle classe de base depuis n'importe quelle classe, au tarif du premier rang (renommée 1, 400 or).

### Effets de classe

Chaque classe porte une liste `effects` (et un texte `effectText` pour l'affichage, où `{c:id}` devient le nom de la classe). Le joueur garde les effets de **toutes les classes de sa lignée** (`characters.class_path`) : en évoluant, il ajoute la classe à sa lignée ; en revenant à une classe de base, la lignée repart de cette classe. Le calcul est dans `effects.js`, l'application dans `campaign.js` (`battleDetail` pour la puissance, `resolveBattle` pour les gains).

Types d'effets : `power` (bonus d'attaque ou de défense), `streak` (Combattant), `aura` (alliés sur place ou voisins, filtrés par lignée), `debuff` (affaiblit les ennemis, un même effet ne compte qu'une fois), `steal`, `goldBonus`, `xpBonus`, `conquestGold`, `renownPerWin`, `freeMove`, `retreat`, `sniper`, `fortifyCost`, `fortifyPower`, `actionStock`, `darkMage`, `outnumbered`, `perAlly`, `perEnemy`, `warMaster`, `holyKnight`, `teleport`, `reach` (Gremory : ses auras portent plus loin), `auraBoost` (Gremory : renfort de son aura sur place), `conquests` (Paladin noir : % par territoire pris ou défense réussie de sa faction dans la campagne), `enemyMove` (Paladin noir : rejoint sans action une bataille de sa faction sur un territoire ennemi voisin, une fois par bataille, table `battle_free_moves`). Plafonds : `campaign.classEffects.auraCap` (25 %), série du Combattant (20 %), Érudit mortel (30 %), Chevalier archer (50 %).

La téléportation de l'Évêque noir (`POST /api/teleport`) coûte de l'or, aucune action, et divise les récompenses par deux pour les actions suivantes.

Une classe peut aussi demander un exploit en plus, avec `"unlock": { "event": "serpents_repelled", "count": 3 }` : le serveur compte les attaques des Serpents des Ténèbres repoussées par le joueur (il faut avoir défendu le territoire attaqué) et refuse le changement de classe tant que le compte n'y est pas. Dark Mage demande 3 attaques repoussées, Dark Bishop 15. Le texte affiché est la clé `unlock.<event>` des fichiers de langue, et le compteur est dans `stats` de `GET /api/me`.

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
| `characters` | pseudo, anniversaire, classe, lignée de classes (`class_path`), avatar, faction, or (`gold`), expérience (`xp`) |
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

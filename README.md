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

Le temps est découpé en tours (`turnMinutes`, 10 minutes). Un joueur gagne 1 action par tour jusqu'à `maxActions` (8).

- **Se déplacer** vers un territoire voisin : 1 action. On n'entre sur un territoire qui n'est pas à sa faction que s'il touche un territoire de sa faction (ou sa base, voir `homeBases`).
- **Défendre** (territoire allié) : renforce la défense de la bataille en cours, ou pose une garnison qui compte si une bataille démarre dans les `battleTurns` tours.
- **Récolter** (territoire allié, hors bataille) : rapporte `gather.gold` et `gather.xp`.
- **Attaquer** (territoire ennemi ou neutre) : lance une bataille de `battleTurns` tours, ou renforce celle de sa faction. Les joueurs de la faction attaquée sont prévenus.

Chances de l'attaque = force des attaquants / (attaquants + défense), bornées par `minChance` et `maxChance`. Chaque action Attaquer ou Défendre ajoute la force du joueur : `tierPower` selon le rang de sa classe, augmentée de `renownPower` par niveau de renommée. La défense part de `baseDefense` × importance du territoire (`importance` dans `map.json`), plus `npcDefense` pour une faction non jouable (c'est ce qui rend Garreg-Mach dur à prendre).

À la fin de la bataille, un tirage décide. Attaque réussie : le territoire change de faction, les attaquants touchent `attackRewards` × importance, et les défenseurs présents ont `retreatTurns` tours pour se replier sur un territoire allié, sinon ils tombent jusqu'à la fin de la campagne. Attaque ratée : les défenseurs touchent `defenseRewards` × importance, et les attaquants restés sur place doivent à leur tour se replier dans les `retreatTurns` tours, sinon ils tombent. Leur retour en jeu coûte alors `revive.attackerMultiplier` fois le prix normal (or, renommée ou aide d'un allié, colonne `fall_mult` de `player_state`).

- `capitals` : territoire d'apparition de chaque faction. `homeBases` : base d'une faction sans territoire (Garreg-Mach pour les Loups de cendre), qui lui sert d'appui sans qu'elle le contrôle.
- `annex` : territoires annexes, conquérables mais ignorés pour la victoire.
- `boss` : à chaque tour, la faction `boss.faction` a `chancePerTurn` chances (0,04 = 4 %) de lancer une attaque de force `power` × importance sur un territoire au hasard (au plus `max` à la fois). Si elle gagne, le territoire lui appartient. `quietHours` (`from` inclus, `to` exclu, en heures, avec son fuseau `timezone`) interdit toute apparition pendant la nuit : de minuit à 6 h, heure de Paris. Les batailles déjà commencées continuent, et le fuseau est fixé dans la config pour que la nuit ne dépende pas du serveur qui héberge le jeu. `TEST_HOUR` force l'heure pour les tests.
- Fin de campagne : une faction jouable tient tous les territoires non annexes, il ne reste des joueurs en vie que dans une seule faction, ou l'heure de fin programmée est passée (voir plus bas). Les points gagnés s'ajoutent dans la table `faction_points`. La carte est ensuite remise à son état de départ, les généraux reprennent leur poste et une nouvelle campagne commence.

### Cycle de campagne, fin programmée et points : clés `schedule`, `finale`, `points`, `season`

- `schedule` : `{ weekday, hour, minute, reopenHour, timezone }`, par défaut le mardi (2) à minuit, soit la nuit du lundi au mardi, heure de Paris, et réouverture le jour même à 4 h (`reopenDayOffset` jours après la clôture). Trois phases (champ `campaign.phase` de la carte) :
  - `open` : jeu normal ;
  - `closing` (clôture, dès l'heure de fin) : plus aucune attaque (joueurs, généraux sortis en campagne, Serpents), on peut se déplacer, récolter, construire ; les combats en cours se terminent ;
  - `break` (pause) : dès le dernier combat terminé, la fin de campagne est calculée (points, résultats, titres) et plus aucune action n'est possible jusqu'à la réouverture (`reset_at`). La carte, les généraux et les Serpents sont alors remis à zéro et la campagne suivante commence.
  Une campagne en cours quand la fonction a été activée ne compte qu'à partir de ce moment (meta `schedule_from`). `TEST_END_AT` (heure de clôture) et `TEST_RESET_AT` (réouverture), en millisecondes, les fixent pour les tests. Les fins par conquête totale ou élimination restent immédiates.
- La faction qui a le plus de points l'emporte (égalité : pas de vainqueur), avec `points.win` en plus. Points de chaque faction (`finale`) :
  - `territory` par territoire tenu (× `pointsMultiplier` d'une faction `underdogs`) ;
  - `mapBonus` : palier de part de la carte conquise (`pct`, `points`), le plus haut atteint ;
  - `survivor` par membre encore en jeu, hors exilés ;
  - `activityRatio` × la somme des scores gagnés par les membres hors exil (colonne `faction_score` de `campaign_scores`) ;
  - `capitalOwn` pour sa capitale tenue, `capitalEnemy` par capitale d'une autre faction tenue ;
  - l'objectif de la semaine atteint (voir plus bas) ;
  - `efficiency`, seulement pour les factions `underdogs` avec `efficiency: true` (Loups de cendre) : `attackWon` par attaque remportée, `defenseWon` par défense réussie (créditée à la faction, y compris à l'Église), et `lowDeaths` (`max` points, réduits à zéro à `deathsPerPlayer` morts par joueur) ;
  - ×(1 + `generals.serpents.pointsBonus`) pour la faction qui a abattu le dernier général des Serpents.
- Un exilé garde un score personnel mais ne rapporte rien à une faction (ni à la sienne ni à celle qu'il rejoint). `finale.exile.gold` : prime d'or de fin de campagne pour un exilé qui s'est battu.
- Chaque participant (au moins un point de classement, ou un combat d'exil) reçoit un résultat (table `campaign_results`, champ `result` de `/api/me`) montré dans une fenêtre jusqu'à `POST /api/campaign/seen`.
- **Saisons** (`season.campaigns`, 4 par défaut) : à la fin de la dernière campagne d'une saison, les points des factions sont additionnés (table `seasons`) ; le meilleur trio de joueurs reçoit `season_champion`, les participants de la faction victorieuse `season_victor`. Le meilleur joueur de chaque campagne reçoit `campaign_mvp`. `GET /api/pantheon` donne les campagnes passées (podium, vainqueur), la saison en cours et les saisons terminées.

### Repli manqué : blessure plutôt que mort

Après une bataille perdue ou un territoire perdu, les joueurs présents ont `retreatTurns` tours (36 = 6 h) pour se replier gratuitement. Sans repli à temps, ils ne sont plus privés de jeu : `woundPlayer` les renvoie à leur capitale, leur prélève `revive.gold` (× `revive.attackerMultiplier` après une attaque ratée, plus l'amende de l'Archer d'élite), vide leur stock d'actions et divise leurs gains pendant `wound.actions` actions. Une faction tombée garde la mort et l'exil.

### Victoire écrasante : clé `decisive`

Au-delà de `decisive` (0,8, soit 4 contre 1) du rapport attaque / (attaque + défense), l'issue est certaine : pas de tirage (`battle.decisive` = `win` ou `lose`). Les chances de l'attaque reçoivent aussi l'aide des alliés (`battles.help`).

### Soutiens entre joueurs et ordres aux généraux (patch 2.0)

- **Relations entre joueurs** (`relations.players`) : table `player_relations` (une ligne par paire, `a < b`), plafonnée à `maxLevel` (A+). Offrandes `gifts` (le cadeau sur place a son délai par paire, `cooldownMinutes`), journal `player_gifts` pour « Dire merci » (`thanks` : `pct` % des points, au moins `min`, dans les `hours` heures ; `POST /api/relations/thanks`, état exposé dans `/api/notifications`). Routes `GET /api/relations/player?pseudo=` et `POST /api/relations/player/gift`.
- **Bonus** : dans `battleDetail`, chaque joueur gagne `bonus.values[niveau]` % par partenaire du même camp qui agit du même côté de la bataille, `bonus.capPct` au total ; avec les PV, `bonus.heal[niveau]` s'ajoute aux soins entre eux. Liste des bonus : `playerSupport`.
- **Proches** : `closest` dans `/api/profile` (les `players.closest` relations les plus fortes, généraux et joueurs ; pour un général, ses joueurs les plus proches).
- **Ordres** (`generals.orders`) : dès `minLevel` de soutien avec un général vivant de son camp (ni seigneur, ni Église, ni indépendant), `POST /api/general/order` (`kind` : `attack`, `defend` ou `move`, `target`, ou `cancel`). Table `general_orders` (un ordre par général). L'IA (`runOrder`) passe la défense du territoire d'origine en premier, puis marche vers la cible (1 action par tour), attaque ou défend, et termine l'ordre (notification `general_order` : `done`, `held`, `expired`, `failed`). Un ordre dure au plus `maxHours` heures ; défendre tient le territoire jusque-là.

### Points de vie et prime de renommée (patch 2.0)

- **Points de vie** (`campaign.hp`) : `player_state.hp` et `generals.hp` stockent une fraction des PV max (1 = pleine santé), donc changer de classe garde le pourcentage. PV max : `max[palier]`, plus `sturdy.bonus` ou `frail.bonus` selon la classe. Activation : `start: "season"` pose la meta `hp_from` à la première campagne d'une nouvelle saison (`start: "now"` active tout de suite) ; `HP_ON=1` ou `0` force l'état pour les tests (`0` dans `tests/run.js`).
- **Pertes** : à la résolution d'une bataille, chaque joueur et chaque général qui y a agi perd `loss.*` points (victoire, victoire écrasante, défaite ; attaque ou défense). Un joueur à 0 PV passe par `woundPlayer` (notification `fallen_hp`) et revient à `koReturnPct` % ; un général à 0 PV meurt d'épuisement (journal `general_exhausted`), sauf les seigneurs, Rhea et l'Immaculée, qui restent à 1 PV.
- **Malus** : `malus` (sous 50 % : -10 %, sous 25 % : -20 %) multiplie la puissance de chaque action de combat dans `battleDetail` ; il apparaît dans les profils (`hpLow`).
- **Régénération** : `hpTick`, une fois par minute au plus (meta `hp_tick`) : `regen.perHour`, ou `regen.alliedPerHour` sur un territoire allié sans bataille, plus `hpRegen` × niveau de l'Infirmerie (`build.specs.infirmary`, construite seulement avec les PV), multiplié par `overdriveFactor` pendant l'Overdrive.
- **Soins** : `/api/act` `heal` (1 action, `heal[classe]` points à un allié présent, joueur ou `g:<général>`, ou `selfFactor` sur soi ; `healXp` de renommée pour un allié) et `vial` (`vial.gold` contre `vial.hp`, `vial.perDay` par jour, colonnes `vial_day` et `vial_n`). Les généraux soigneurs soignent l'allié le plus blessé sous `generals.healBelowPct`, une fois par tour, et aucun général ne part en sortie sous `generals.sortieMinPct`.
- **Prime de renommée** (`player.levelUpGold`) : `grant` paie `levelUpGold × niveau` pour chaque niveau franchi (réduite pour un exilé), notification `renown_gold` ; `LEVEL_UP_GOLD=0` la coupe pour les autres suites de tests.

### Overdrive, exil, profils (patch 1.7)

- **Overdrive** (`campaign.overdrive`) : les `hours` (24) dernières heures avant la clôture, chaque joueur en jeu non exilé reçoit `base` (attaque, actions max, attaque contre Garreg-Mach, points de faction) ; une faction minoritaire (moins de territoires que la moyenne des factions en jeu) reçoit `plus` (avec `gold` et `xp` fixes à chaque gain d'action : récolte, conquête, défense, général). Notification `overdrive` / `overdrive_plus` au début (meta `overdrive:<campagne>`), push de type `overdrive` reporté à la fin des heures calmes (table `push_pending`). `OVERDRIVE_HOURS` le règle pour les tests (0 dans `tests/run.js`).
- **Exil** : le malus `exile.rewardMultiplier` passe par `rewardMods` et s'applique à toutes les sources de gains (sauf la prime d'exil), et aux actions offertes par les missions.
- **Profils** : `/api/profile` renvoie `mods`, la liste des bonus et malus actifs (classes, soutiens, avantages de faction, capacité du seigneur, capitale perdue, exil, gains réduits, repli, Overdrive).
- **Relations** : `compliment` (1 action, +1) et `present` (gratuit, +10, sur le territoire du général, une fois par heure : table `gift_cooldowns`).
- **Généraux indépendants** : ils défendent leur territoire quel qu'en soit le maître et tombent avec lui.

### Relations avec les généraux (patch 1.6)

- Table `relations (user_id, gid, points)` : permanente, jamais effacée entre les campagnes.
- `GET /api/relations` : généraux vivants alliés au camp du joueur (sa faction, ou sa faction d'exil), puis ceux de cette faction morts, captifs, en sommeil ou passés ailleurs (`state`), avec points et niveau ; `sWith` = général au niveau S.
- `POST /api/relations/gift { general, kind: 'flower' | 'letter' }` : réglages `relations.gifts` (1 action, 50 or, +5 ; 1 action, 200 or, +25), seulement pour un général vivant allié (`not_allied`). Niveaux `relations.levels` (C 250 … S 2000) ; un seul général au niveau S, les autres plafonnent à S − 1 (`support_s_taken`).
- Les bonus de soutien ne sont pas encore définis.

### Église de Seiros (patch 1.6)

- **Garnison** : Rhea (seigneur de l'Église, `generals.lords.eglise`) et ses chevaliers (faction `eglise`, maison `garreg-mach`) défendent Garreg-Mach ; Rhea ne le quitte pas et le défend sans dépenser d'action.
- **Croisade** (`generals.church.crusade`) : quand une faction tient `start` (45 %) des territoires hors annexes, meta `crusade` = faction, notification `crusade_declared` ; jusqu'à `sorties` chevaliers sortent (au moins `garrison` restent) et attaquent ses territoires les plus proches en traversant toute la carte. Levée sous `end` (38 %), ou si Rhea n'est plus à Garreg-Mach.
- **L'Immaculée** (`generals.church.awakening`, général `immaculate`) : Garreg-Mach conquis, Rhea passe `dormant` et l'Immaculée lance un assaut sur Garreg-Mach (puissance `power` × importance × coef), puis un toutes les `waveGapHours` heures (pas pendant les heures calmes), plus des raids sur un voisin (`raidChance` par tour). Un assaut réussi rend Garreg-Mach à l'Église et Rhea revient ; `waves` assauts repoussés l'abattent (Rhea meurt), et la faction qui tient Garreg-Mach gagne `pointsBonus` (meta `immac:<faction>`). État dans la meta `immaculate`, affiché via `church` sur `/api/map`.
- Tests : `TEST_RAID_ROLL` fixe le tirage des raids.

### Engagement, seigneurs, exil (patch 1.5)

- **Rester pour combattre** : `POST /api/move` et `/api/teleport` refusent de quitter un territoire où le joueur a des actions de combat en cours (bataille ouverte ou garnison) avec l'erreur `engaged`, sauf avec `leave: true` : ses actions y sont alors annulées, sans remboursement. Un général qui se déplace perd aussi ses actions en cours ; engagé dans un combat, il reste jusqu'à sa fin.
- **Seigneurs** (`generals.lords`) : immobiles dans leur capitale tant qu'ils la tiennent, ils la défendent sans dépenser d'action et ne meurent pas tant qu'un autre général (vivant ou captif) reste sous leur bannière ; vaincus, ils se replient auprès d'un allié. Capitale perdue : meta `retake:<faction>`, notification `lord_rally`, et tous les généraux de la faction marchent sur elle. Yuri suit la même règle mais retourne à Garreg-Mach.
- **Capitale** : `capital.perTerritory` × territoires de la faction s'ajoute à la défense de sa capitale d'origine tant qu'elle la tient (`capitalBonus` sur la carte).
- **Exil** : `exile.rewardMultiplier` 0,5 ; un exilé n'a ni capacité de seigneur, ni avantages `underdogs`, ni bonus de contre-attaque propre à sa faction d'adoption.
- **Énergie** : `rewards.actions` d'une mission ajoute des actions au-delà du maximum ; au-dessus du maximum la réserve ne se recharge plus.
- **Profils** : `GET /api/profile?pseudo=` ou `?general=`.
- **Bugs** : `POST /api/bug` (500 caractères, 3 par heure), table `bug_reports`, envoi par mail via `mailer.js` si `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` et `BUG_REPORT_TO` sont définis (Gmail : port 465 et mot de passe d'application). Les signalements apparaissent aussi sur `/admin.html`.
- **Confirmation d'email** : dès que l'envoi de mails est configuré (variables SMTP), un nouveau compte reçoit un code à 6 chiffres (30 minutes, 5 essais, renvoi après une minute, table `email_codes`) et doit le saisir (`POST /api/verify`, `/api/verify/resend`) avant de créer son personnage. Les comptes existants restent valides (`users.email_verified`). `EMAIL_VERIFY=0` coupe la confirmation.
- **Notifications** : `campaign_ending` à tous `endWarningHours` heures avant la clôture (aussi en push), `lord_ability` à tous (dans l'app).

### Capitales, constructions, seigneurs, objectifs, signalements

- `capitals` : une faction qui a perdu sa capitale perd `capital.lossPct` % de puissance tant qu'elle ne l'a pas reprise. La couronne s'affiche sur la carte.
- `build` : `{ maxLevel, costs, specs }`. Action `build` (1 action + or, hors bataille) : une spécialité par territoire (`fortress` : `defensePct`, `market` : `goldPct`, `academy` : `xpPct`, par niveau), détruite à la conquête (table `territory_builds`).
- `lords` et `gauge` : chaque faction a un seigneur dont la capacité (`ability.effect` : `power` côté attaque, défense ou les deux, ou `hireCost`) se déclenche pour `ability.minutes` quand la jauge atteint `gauge.max` (metas `gauge:<faction>` et `buff:<faction>`). Chaque action de combat ajoute `perAction`, chaque bataille gagnée `perWin`.
- `objectives` : liste d'objectifs de faction (`type` : `conquests`, `defenses`, `generals`, `annex`, `capital`, `pct`, `hold`), un tiré par faction et par campagne (tables `faction_objectives`, `faction_progress`). Atteint, il rapporte `points` à la faction et `gold` à ses participants.
- `pings` : signalements de faction (`kinds`, `minutes`, `cooldownSeconds`, `max`), route `POST /api/ping`, un signalement actif par joueur.

### Suivi, tutoriel, notifications

- **Suivi économique** : table `metrics_daily` (or gagné par source, or dépensé par poste, actions, batailles, chutes) et `metrics_active` (joueurs actifs par jour). `GET /api/admin/metrics?days=14` (en-tête `x-admin-token` égal à la variable `ADMIN_TOKEN` ; absent = route invisible) et la page `/admin.html`.
- **Tutoriel** (`tutorial.steps`, `tutorial.rewards`) : étapes cochées d'après les événements réels du joueur ; `POST /api/tutorial/claim` et `/api/tutorial/dismiss`.
- **Notifications push** (`push.js`, clé `push` facultative) : Web Push sans dépendance (clés VAPID dans `DATA_DIR/vapid.json`, chiffrement aes128gcm). Types : territoire attaqué, repli nécessaire, appel à l'aide, résultat de campagne, général à juger, réserve d'actions pleine. Garde-fous : un délai par type (`cooldownMinutes`), 6 messages par jour (`dailyMax`), jamais la nuit (`quiet`), réglage par type pour le joueur, adresses de services push connus seulement (`PUSH_ALLOW_ANY=1` pour les tests). `VAPID_SUBJECT` fixe le contact. Sur iPhone, l'app doit d'abord être installée sur l'écran d'accueil.
- **Tests** : `npm test` (ou `node tests/run.js [motif]`) lance les suites de `tests/`, chacune sur son propre serveur et sa base jetable.

### Missions de campagne et réactions du journal

- `campaign.missions` : objectifs remis à zéro à chaque campagne (tables `campaign_mission_progress` et `campaign_mission_claims`), au format des autres missions (`condition: { event, count }`, `rewards`). Événements comptés par le serveur pour les joueurs qui ont agi dans la bataille : `conquest`, `defense`, `garreg_conquest` (territoire `keyTerritory`), `retake` (territoire d'origine de sa faction repris), `annex_conquest`, `general` (général vaincu), `spare` (général épargné). Route de récupération : `POST /api/missions/campaign/claim` ; l'état est dans `campaignMissions` de `GET /api/missions`.
- `campaign.reactions` : le Journal propose des réactions à l'action d'un allié, jamais à la sienne, une fois par joueur et par événement (table `journal_reactions`, route `POST /api/journal/react`) : `cheer` (territoire pris ou défendu par sa faction, sans y avoir combattu) donne `cheerXp` xp ; `support` (attaque d'un allié encore en cours) donne `supportGold` or à l'allié qui l'a lancée ; `help` (appel à l'aide d'un allié, bataille en cours) ajoute `helpPct` point de chances à son camp (colonne `battles.help`).
- Les fenêtres de game over (joueur tombé, faction tombée) s'ouvrent une fois par chute, d'après `campaignId`, `deaths` et `factionOut` du joueur (mémorisé sur l'appareil).

### Généraux : clé `generals` de `game.json`

Personnages non joueurs, dirigés par l'IA du serveur (tables `generals`, `general_contribs`, `general_verdicts`). Leur liste est `generals.roster` : `id`, `name`, `faction` (vide = indépendant), `home` (territoire d'origine), `path` (lignée de classes, avec les classes légendaires `npc: true` réservées aux seigneurs), `coef` (puissance et importance), `spare` (factions qui peuvent l'épargner) et `avatar`.

- Au début de chaque campagne ils se placent sur leur territoire d'origine, avec `generals.actions` actions (4) qui se rechargent d'une par tour.
- **Équilibrage et lissage** : une faction dont la médiane est sous la moyenne des factions voit ses généraux relevés de `level.balance` × l'écart ; le niveau de chaque faction évolue de `level.smoothing` vers sa cible chaque minute (meta `glvl`), sans saut.
- **Niveau de renommée** : médiane des niveaux des joueurs actifs de leur faction (`level.activeDays`, 7 jours ; à défaut tous ses membres ; tous les joueurs pour un indépendant) × (`level.base` + `level.perCoef` × `coef`), au moins `level.min`. Leur puissance suit la classe finale et ce niveau, avec les effets de leur lignée.
- **Défense** : quand leur territoire d'origine est attaqué (même par les Serpents), ils s'y rendent s'ils ont assez d'actions et le défendent, une fois par bataille. Les Loups de cendre défendent Garreg-Mach.
- **Sorties** : seulement après une première conquête sur la carte. Une fois par tour, `attackChance` de chances de partir vers un territoire ennemi voisin (ou de rejoindre l'attaque de leur faction), avec au plus `maxSorties` sorties en cours ; le tour suivant ils attaquent une seule fois, sinon ils rentrent. Les indépendants ne sortent pas.
- **Défaite** : le général du camp perdant est vaincu, de même que tout général du camp vaincu qui se trouve sur un territoire conquis ou dont c'est la maison (jamais de fantôme ni de général sans maison). Ses vainqueurs reçoivent `reward.gold` et `reward.xp` × `coef`. Il meurt, sauf s'il est épargnable : pas encore épargné (`spared`) et la faction victorieuse figure dans `spare`. Les vainqueurs qui ont agi dans la bataille ont alors `verdictTurns` tours pour l'épargner (il rejoint leur faction, garde son territoire d'origine et le défend toujours) ou le faire mourir (route `POST /api/general/verdict`) ; sans décision il meurt. Un général épargné qui est vaincu meurt.
- **Serpents** (`generals.serpents`) : chaque raid a `chance` de chances d'être mené par un général de la faction `serpents` (force du raid × `coef`). `finalBoss` ne vient qu'une fois les autres tombés, à coup sûr. Quand il tombe, les Serpents ne reviennent plus de la campagne (meta `serpents_gone`) et la faction qui l'a abattu a `pointsBonus` de points en plus.
- Les généraux apparaissent dans la liste des présents d'un territoire ; ceux des factions `hiddenAtBase` restent cachés sur leur base tant qu'ils n'y combattent pas. `TEST_NO_GENERALS` les désactive, `TEST_GEN_ROLL`, `GEN_ATTACK_CHANCE` et `GENERAL_CHANCE` règlent leur hasard pour les tests.

Autres réglages de `campaign` :

- `cadenceGold` : or gagné par la première action de chaque tour (bonus de régularité).
- `hire` : renfort payé en or, sans action. Fortification sur son territoire, bataillon (« Battalion ») dans une attaque de sa faction ; `gold` le prix, `power` la force ajoutée, `perBattle` le maximum par joueur et par bataille.
- `revive.gold` : prix du retour en jeu d'un joueur tombé (`attackerMultiplier` : coefficient après une attaque ratée). Il peut aussi sacrifier un niveau de renommée, ou demander à un allié de payer (les demandes apparaissent dans le Journal de sa faction). Il réapparaît dans sa capitale si sa faction la tient, sinon sur un de ses territoires au hasard.
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

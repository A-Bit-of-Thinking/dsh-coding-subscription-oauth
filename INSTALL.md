# Installation du fork / Fork installation

Ce guide concerne **ce fork**, compatible avec **DSH 0.2.0-rc.2**. English overview: [README.md](README.md). Nom/identifiant conservés : paquet `dsh-coding-subscription-oauth@0.8.5`, plugin Cordis `llm-grok-build-oauth`, routes HTTP `/plugins/dsh-grok-build/*`.

## Avant d'installer

- Vérifiez le **noyau DSH**, pas seulement la version de l'enveloppe desktop. Le BOM exact est dans [compatibility/dsh-bom.json](compatibility/dsh-bom.json).
- Node doit satisfaire `^22.19.0 || >=24`. Pour la CLI, utilisez le runtime choisi par votre hôte ; l'application desktop dispose de son propre runtime.
- Ne confondez pas **la source GitHub du fork** avec **le paquet npm original**. La même version `0.8.5` ne prouve pas que vous avez le fork.
- Conservez une sauvegarde privée du profil et de ses identifiants avant une mise à jour. Ne publiez jamais cette sauvegarde.
- Ne supprimez pas les fichiers d'authentification ni la configuration pour « nettoyer » l'installation.

## Application officielle de bureau

Le profil desktop est géré par l'application Electron. La CLI DSH refuse de le modifier directement.

1. Ouvrez le gestionnaire de plugins de l'application.
2. Si une source locale ou Git est proposée, choisissez le dossier **construit** de ce dépôt ou `github:A-Bit-of-Thinking/dsh-coding-subscription-oauth`.
3. Si l'installateur refuse Git avec `EALLOWGIT` (npm 12), ne changez pas globalement sa politique : utilisez une source locale construite si cette interface la supporte. Sinon, arrêtez ici et employez un installateur adapté au runtime hôte, avec l'application fermée. **Ce dépôt ne contient pas encore d'installateur desktop universel.**
4. Après installation, redémarrez vous-même l'application existante, puis vérifiez le statut et les modèles dans les paramètres.

N'écrivez pas à la main dans les dépendances du profil pendant que l'application tourne. Un build dans le dépôt ne met pas à jour automatiquement le plugin installé. Sans watcher de développement actif, aucune mise à jour visuelle à chaud n'est garantie.

## Profil web autonome (CLI)

Ces commandes visent un **profil web distinct**, pas le profil desktop :

```bash
# Depuis une copie construite et revue du fork :
dsh plugin --profile web add .

# Alternative si le gestionnaire hôte accepte les dépendances Git :
dsh plugin --profile web add github:A-Bit-of-Thinking/dsh-coding-subscription-oauth
```

Pour une installation reproductible, épinglez la source à un commit revu avec la syntaxe acceptée par votre gestionnaire, plutôt que de supposer qu'une branche ou un cache est à jour. Vérifiez le commit résolu et les artefacts réellement installés. Le nom npm sans source Git installe l'original.

Redémarrez ensuite **le processus web existant** via son gestionnaire habituel. Ne lancez pas un deuxième serveur pour tenter de mettre à jour le premier.

## Construire et contrôler une source locale

```bash
pnpm install --frozen-lockfile
pnpm run check:next
pnpm run check
npm pack --dry-run --json --ignore-scripts
```

`pnpm run check` reconstruit `lib/` depuis `src/` puis teste. Les installations Git consomment les artefacts suivis : une modification de source non reconstruite ne suffit pas. Relisez le diff et le contenu du paquet avant toute publication ; aucune commande `npm publish` n'est nécessaire pour installer localement.

## Vérifier après installation

- Le plugin se charge sans erreur de BOM/peerDependencies.
- Dans **Paramètres → Coding OAuth / Comptes et modèles**, le statut des services est lisible.
- Les routes OAuth non authentifiées restent absentes du sélecteur ; les routes connectées sont marquées `(OAuth)`.
- Les modèles ajoutés par le fork sont présents dans les fournisseurs correspondants ; ils doivent aussi être sélectionnés si une liste personnalisée est utilisée.
- Les capacités se lisent et les modifications autorisées se sauvegardent. Les révisions évitent d'écraser une modification concurrente.
- Le modèle par défaut existant n'est pas changé par l'installation.

Un statut de configuration réussie n'est pas une preuve d'inférence. Testez vous-même un modèle uniquement si vous souhaitez consommer le quota de ce compte.

## Capacités et coûts

Toutes les options sont désactivées par défaut. Codex recherche/quota/images/Fast utilisent des endpoints privés de l'abonnement, susceptibles de changer. Fast n'est disponible qu'après confirmation `priority` par un catalogue récent.

Grok Imagine exige une **clé API `XAI_API_KEY` séparée** dans le service de credentials DSH. Ce n'est pas inclus dans l'OAuth Grok et une facturation API peut s'appliquer. Les éditions d'images Codex restent limitées aux pièces jointes possédées par la session.

Sur DSH 0.2, les valeurs de `capabilities` sont des champs live de la configuration du plugin. L'API interne conserve le nom logique `coding-subscription-oauth`, mais n'exige pas de recréer manuellement une ancienne section `settings.yaml`.

## OpenCode Go

Configurez Go dans sa carte **Comptes et modèles**. Il utilise une référence de clé locale et le fournisseur isolé `coding-opencode-go`. Le mode interne n'a pas besoin de la passerelle.

Pour les clients externes, activez explicitement la passerelle puis utilisez `coding-opencode-go/<model-id>` avec le bon protocole et une identité stable de conversation. La clé locale de la passerelle n'est pas la clé Go. Les configurations historiques doivent passer par l'aperçu/confirmation de migration, pas par un remplacement aveugle du fournisseur natif.

## Accès distant et sécurité

Les routes de gestion vérifient le pair, le Host, l'origine et le contexte de requête. Les écritures JSON restent bornées et protégées. Ne désactivez pas ces contrôles pour faire fonctionner un navigateur distant.

- Préférez un tunnel SSH vers le port loopback existant.
- Un proxy HTTPS exige la configuration explicite `ownerRequest.trustedProxy` : pairs autorisés, origines exactes, preuve du propriétaire et jeton CSRF. Ces valeurs doivent rester privées.
- La révélation/rotation de la clé passerelle n'est autorisée qu'en mode d'accès `loopback`.
- OAuth navigateur : si le retour localhost ne peut pas atteindre l'hôte, utilisez le code de dispositif quand il est disponible, ou collez le code/l'URL de retour dans la **carte d'autorisation**, jamais dans le chat.

## Mettre à jour / revenir en arrière

Réinstallez depuis la source voulue, puis redémarrez une seule fois l'application/processus existant. Vérifiez la compatibilité exacte du noyau avant chaque mise à jour. Pour revenir en arrière, utilisez le commit ou paquet précédent **compatible**, sans effacer identifiants, sélections ou configuration. Une mise à jour npm générique peut remplacer ce fork par l'original : vérifiez la provenance proposée.

Le partage de runtime avec `dsh-hub-oauth-gateway` est une fonction héritée. La compatibilité de ce fork seul ne certifie pas le Hub ni `dsh-agy` sous DSH 0.2 ; validez séparément ces combinaisons. Le core partagé est une dépendance npm, pas un plugin à ajouter séparément.

## Diagnostic rapide

| Problème | Vérification |
| --- | --- |
| Plugin incompatible au démarrage | Version noyau et BOM ; source réellement installée |
| Dépôt modifié mais interface inchangée | `lib/` reconstruit, réinstallation faite, redémarrage utilisateur |
| Modèle récent absent | Source/commit du fork, sélection enregistrée, service connecté |
| Conflit de capacités | Rechargez les valeurs, puis refaites la modification |
| 401/403 du fournisseur | Abonnement, expiration/reconnexion, réseau ; pas de remplacement arbitraire par une API key |
| Go « configuré » mais appel refusé | Protocole, modèle, régions autorisées, quota ; la configuration ne garantit pas l'accès |
| Route en double | Deux plugins OAuth concurrents ; retirez uniquement la déclaration de plugin choisie, pas les credentials |

Les scripts `smoke:deployed` effectuent des appels réels, créent des sessions et peuvent manipuler des réglages : ce ne sont pas des tests hors ligne à lancer sur un profil partagé. Préférez les tests unitaires et un environnement isolé.

Utilisez uniquement vos comptes autorisés et vérifiez les conditions du fournisseur. Voir [README.fr.md](README.fr.md) et [CONTRIBUTING.md](CONTRIBUTING.md).

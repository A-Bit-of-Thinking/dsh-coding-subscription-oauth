# Maintenance du fork — DSH 0.2.0-rc.2

Ce document est **public** : uniquement du contexte technique reproductible, aucun profil d'utilisateur, chemin personnel, credential ou journal réel. Les enquêtes privées restent dans `docs/local/` (ignoré par Git).

## Identité et provenance

- Fork : [A-Bit-of-Thinking/dsh-coding-subscription-oauth](https://github.com/A-Bit-of-Thinking/dsh-coding-subscription-oauth).
- Amont : [lninghaha/dsh-coding-subscription-oauth](https://github.com/lninghaha/dsh-coding-subscription-oauth), base `ef93a2f` / tag `v0.8.5`.
- Branche de maintenance : `main`. L'ancien nom de branche de rebasage n'est pas une instruction de checkout.
- Paquet : `dsh-coding-subscription-oauth@0.8.5` ; version conservée, **pas une nouvelle publication npm**. Identifiez le build par sa source et son commit.
- Identifiant Cordis et routes conservés pour ne pas casser les comptes existants.

Pour installer le fork, lire [INSTALL.md](INSTALL.md). Les scripts propres à une machine ne sont ni livrés ni supposés disponibles ici.

## Frontières de travail

1. Lire [AGENTS.md](AGENTS.md), contrôler `git status` au début et à la fin.
2. Préserver les modifications existantes. Aucun nettoyage destructif, publication npm, force-push ou redémarrage d'un profil partagé sans demande explicite.
3. Distinguer corrections fonctionnelles demandées et pistes d'architecture à discuter. Ne pas implémenter une étude d'autodétection comme si elle avait été approuvée.
4. Tester avec mocks ou un DSH home isolé. Ne pas lancer de login, d'inférence payante ou de mutation de comptes sur le profil réel pour une revue de code.
5. Ne jamais commiter une sauvegarde, un rapport privé, une capture de vrai compte ou une configuration locale. `.gitignore` ne protège pas les fichiers déjà suivis ni l'historique.

## Compatibilité exacte

Le noyau cible est **0.2.0-rc.2** : `cordis` 4.0.4, `schemastery` 3.18.4, `pi-ai` 0.87.1 et React 18.3.1. Une autre version est un candidat à tester, pas une compatibilité garantie.

Les trois sources de BOM doivent rester cohérentes :

1. [package.json](package.json) — `dsh.compatibility.bom` et dépendances.
2. [src/compatibility.ts](src/compatibility.ts) — `DSH_EXACT_BOM`.
3. [compatibility/dsh-bom.json](compatibility/dsh-bom.json) — matrice vérifiée.

`pnpm run check:bom` vérifie cette cohérence. Sous pnpm 11, l'override pi-ai doit aussi rester dans [pnpm-workspace.yaml](pnpm-workspace.yaml), même si `package.json` le reprend pour d'autres outils.

### Contrats à revoir lors d'une montée DSH/pi-ai

- Les arguments `ToolCall.arguments` sont du JSON strict ; conserver le filtrage du gateway.
- Le contexte provider-facing pi-ai est normalisé/branded ; les tests de transport utilisent `normalizeContext()`.
- `piProvider` est optionnel ; éviter les champs explicitement `undefined` avec `exactOptionalPropertyTypes`.
- La politique d'images de l'adaptateur hôte change : vérifier dimensions, bytes, offload et limites base64, pas seulement le typecheck.
- Les capabilities ne dépendent plus d'un `settings.register()` dans DSH 0.2 : les forms dérivent du `Config` volatile du plugin. Écrire seulement les champs de capacités dans l'entrée propriétaire, avec révision hôte, sans remplacer proxy/gateway/ownerRequest.
- L'absence d'un service optionnel doit rester une dégradation explicite, pas une lecture Cordis hors scope ou un faux succès.

Les notes historiques du premier rebasage sont dans [REBASE-NOTES.md](REBASE-NOTES.md).

## Catalogue de modèles

[src/model-additions.ts](src/model-additions.ts) complète le catalogue statique pi-ai. Le branchement dans [src/oauth-providers.ts](src/oauth-providers.ts) est partagé entre catalogue de session et fournisseur de requête : un ajout doit survivre à la sélection des modèles jusqu'au transport.

Ajouts relus du fork : `gpt-6.1-sol`, `claude-sonnet-5-5`, `claude-haiku-5-5`.

### Ajouter un modèle

1. Vérifier ID exact, protocole et disponibilité abonnement séparément de la disponibilité API.
2. Vérifier contexte, sortie, modalités, paramètres de sampling et efforts à la source officielle. `extends` copie aussi `compat`, les prix et limites d'image : ne pas confondre héritage de code et preuve documentaire.
3. Déclarer les valeurs différentes et les contraintes de transport. L'ID déjà connu est surchargé ; le modèle de base manquant produit un diagnostic.
4. Tester le vrai catalogue, le filtrage de sélection et le payload avec un `fetch` simulé. Ne pas envoyer un token réel pour prouver le câblage.
5. Construire `lib/`, relire le diff et la liste du paquet.

### Haiku 5.5

Sources officielles : [présentation](https://platform.claude.com/docs/en/models/haiku-5-5/overview.md), [migration](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide), [effort](https://platform.claude.com/docs/en/build-with-claude/effort).

ID `claude-haiku-5-5`, contexte 1M, sortie 128K, efforts low/medium/high/xhigh/max. Thinking adaptatif, pas `budget_tokens` hérité de Haiku 4.5. Sampling personnalisé omis. Sans effort explicite, laisser le défaut fournisseur plutôt qu'envoyer `thinking: disabled` arbitrairement.

La grille API possède un palier à 100K tokens. Le modèle pi-ai ne sait pas représenter ce palier : les estimations du fork utilisent le tarif supérieur, conservateur pour les longs prompts. Elles ne représentent pas la facturation d'un abonnement OAuth. Les limites d'image héritées restent conservatrices ; aucune extension non vérifiée.

### Autodétection : étude seulement

Grok interroge déjà un catalogue live. Le module Codex de capacités lit déjà `backend-api/codex/models`, mais n'exploite que les IDs/service tiers pour Fast, pas des modèles complets. `OAuthProviderSession` conserve un instantané du catalogue pi-ai + ajouts.

Récupérer un nouvel ID ne fournit pas forcément le protocole, contexte, tokenizer, prix ou efforts ; ne pas cloner aveuglément le modèle voisin. Toute détection/notification/mise à jour reste une proposition à valider, pas une fonctionnalité implémentée.

## Construction et tests

```bash
pnpm install --frozen-lockfile
pnpm run check:next
pnpm run check
npm pack --dry-run --json --ignore-scripts
```

`src/` est l'unique source runtime. `lib/` est généré, suivi par Git et nécessaire aux installs Git. Le build passe par `.next/lib`, puis promotion/vérification ; ne pas modifier les artefacts directement.

Si pnpm n'est pas dans PATH, utilisez le Node et le script pnpm fournis par l'hôte, avec des chemins résolus localement — jamais un chemin personnel figé dans ce document. Les commandes des scripts npm nécessitent aussi le bon Node dans PATH.

Un test unitaire vert n'est pas une preuve d'autorisation d'un compte ni un E2E navigateur. Les scripts `smoke:deployed` sont des tests réels à examiner avant usage. Le test combiné avec Hub/Antigravity exige une compatibilité séparée.

## Publication et confidentialité Git

- Ne pas publier ce fork sous le nom npm de l'amont par défaut. Toute publication/renumérotation est une décision du mainteneur.
- Conserver [LICENSE](LICENSE), [NOTICE](NOTICE) et l'attribution amont.
- Configurer une adresse Git `noreply` avant les contributions publiques, puis vérifier auteur **et** committer avant push.
- Nettoyer le fichier courant ne retire pas ses anciennes versions. Toute réécriture d'historique public exige une décision explicite et un plan pour les branches/tags/forks/caches.

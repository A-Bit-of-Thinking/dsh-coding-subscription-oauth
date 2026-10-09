# dsh-coding-subscription-oauth

Utilisez vos abonnements de programmation dans [DeepSeek Harness](https://github.com/deepseek-ai/dsh) : comptes OAuth, sélection des modèles, fonctions facultatives et passerelle locale.

**Ce dépôt est un fork communautaire, pas la version npm originale.** Il cible précisément **DSH 0.2.0-rc.2**. Le nom et la version du paquet restent `dsh-coding-subscription-oauth@0.8.5` pour remplacer l'ancien plugin : c'est le dépôt et le commit installé qui distinguent ce fork.

[English](README.md) · [Installation](INSTALL.md) · [Maintenance](HANDOFF.md) · [Historique](CHANGELOG.md)

## Ce qui change dans ce fork

- Compatibilité avec le noyau et le client DSH 0.2.0-rc.2 : `cordis` 4.0.4, `schemastery` 3.18.4, `pi-ai` 0.87.1.
- Ajouts relus : **GPT-6.1 Sol, Claude Sonnet 5.5 et Claude Haiku 5.5**, dans [`src/model-additions.ts`](src/model-additions.ts), sans attendre une publication de pi-ai. Haiku utilise le thinking adaptatif ; les estimations API retiennent son palier de contexte long, conservateur. **Ce n'est pas une détection automatique.**
- Services connectés en premier, sans nouveau design d'épinglage ; carte OpenCode Go repliée par défaut, comme les autres résumés de comptes.
- Raccordement des capacités au système de configuration actuel de DSH, avec maintien du contrat historique pour les anciennes intégrations.

Un modèle présent dans la liste n'est pas une garantie d'accès : le fournisseur et votre formule d'abonnement décident de sa disponibilité réelle.

## Services

| Service | Route DSH | Connexion |
| --- | --- | --- |
| Grok Build | `grok-build` | OAuth de l'abonnement |
| Codex | `codex-oauth` | OAuth de l'abonnement ChatGPT |
| Claude Code | `claude-code-oauth` | OAuth de l'abonnement Claude |
| Kimi Code | `kimi-code-oauth` | OAuth de l'abonnement Kimi |
| OpenCode Go | `coding-opencode-go` | Référence de clé distincte dans DSH |

`codex-oauth-fast` est facultatif et n'apparaît que si un catalogue récent du compte autorise le traitement prioritaire. Google Antigravity dépend du **plugin séparé** `dsh-agy` ; la compatibilité de ce fork ne certifie pas celle de ce plugin externe. Son statut « Not installed » indique que l'adapter `agy` n'est pas visible (adapter absent/inactif ou listing échoué), pas qu'une connexion Google manque.

## Installer la bonne version

Prérequis : **DSH 0.2.0-rc.2**, Node **^22.19.0 ou >=24**. Une autre version de DSH doit être vérifiée séparément.

### Application de bureau

Passez par le gestionnaire de plugins de l'application, avec ce dépôt ou un dossier construit comme source si le gestionnaire l'accepte. Le profil desktop appartient à Electron : ne le modifiez pas par la CLI et ne remplacez pas ses dépendances pendant que l'application tourne. La limitation des dépendances Git et les alternatives sont expliquées dans [INSTALL.md](INSTALL.md).

### Profil web indépendant

Depuis ce dépôt, une fois `lib/` reconstruit et vérifié :

```bash
dsh plugin --profile web add .
```

Si le gestionnaire de paquets de votre hôte accepte les sources Git :

```bash
dsh plugin --profile web add github:A-Bit-of-Thinking/dsh-coding-subscription-oauth
```

**Installer `dsh-coding-subscription-oauth@0.8.5` depuis npm installe l'original, pas ce fork.** npm 12 peut refuser les dépendances Git (`EALLOWGIT`). Ne désactivez pas cette protection globalement : utilisez une source locale construite, ou un installateur hôte compatible pnpm, puis vérifiez la provenance. Ce dépôt ne fournit ni publication npm propre au fork, ni installateur Windows universel.

Après installation, redémarrez vous-même **l'application ou le processus existant**. Ouvrez ensuite **Paramètres → Coding OAuth / Comptes et modèles**. Les routes et les fichiers d'authentification restent inchangés ; le plugin ne choisit pas votre modèle par défaut.

## Comptes et modèles

- Les services connectés passent avant les autres, dans un ordre stable.
- Dépliez une carte pour gérer les comptes, les modèles et les options avancées.
- Les cases de sélection constituent un brouillon ; **Appliquer** enregistre l'ensemble, y compris une sélection volontairement vide.
- Le bouton **Pull** des CLI officielles copie les identifiants vers le plugin après aperçu, vérification des conflits et confirmation. La découverte est en lecture seule : les fichiers des CLI officielles ne sont jamais modifiés.
- Grok dispose d'un catalogue en direct. Codex, Claude et Kimi utilisent surtout pi-ai et les ajouts relus du fork ; les nouveaux identifiants ne sont pas importés automatiquement.
- Les métadonnées de découverte Grok sont validées et liées à un slot de compte local. Changer/importer les identifiants invalide la découverte, pas les choix de modèles ; la déconnexion conserve son comportement de retour à la sélection par défaut. Les caches v1–v3 ne restaurent que les choix et ne sont pas réécrits à la lecture. La date de découverte n'est pas un TTL. Au-delà du budget du cache, seuls les choix sont persistés : le catalogue live reste en mémoire et sera redécouvert après redémarrage.
- Une connexion présente localement peut être expirée ou révoquée côté fournisseur ; une reconnexion peut être nécessaire.

## Fonctions facultatives

Toutes ces options sont **désactivées par défaut** et prennent effet sans redémarrage :

| Fonction | Condition ou limite |
| --- | --- |
| Recherche Codex | Compte connecté ; endpoint privé ; sélectionner `codex-oauth-search` dans le service web hôte |
| Quotas Codex | Compte Codex connecté ; format fournisseur susceptible de changer |
| Création et édition d'images Codex | Compte connecté ; édition limitée aux pièces jointes appartenant à la session actuelle |
| Images depuis un autre modèle | Option supplémentaire explicite ; mêmes contrôles Codex/session/propriété |
| Codex Fast | Catalogue récent autorisant `priority` ; aucune promesse de latence |
| Grok Imagine images et vidéos | **Clé API `XAI_API_KEY` distincte**, pas l'OAuth Grok ; facturation API possible |

Limites : 1–20 résultats de recherche, 1–4 images, conservation des vidéos de 1 heure à 7 jours. Les endpoints privés de Codex ne sont pas une API publique garantie : un interrupteur activé ne promet pas que le service répondra. En cas de modification concurrente, les révisions protègent contre l'écrasement silencieux.

## OpenCode Go et passerelle

OpenCode Go fonctionne dans DSH sans activer la passerelle. Le fournisseur isolé `coding-opencode-go` ne remplace pas le fournisseur natif `opencode-go`. Dans sa carte, configurez une référence de clé et les modèles/protocoles correspondants.

La passerelle locale est un serveur séparé, **désactivé par défaut**, compatible Chat Completions, Responses et Messages. Pour Go, les outils externes utilisent `coding-opencode-go/<model-id>` avec un identifiant stable de conversation et le bon protocole. La clé Bearer locale de la passerelle et celle du fournisseur sont **distinctes**. Relisez les aperçus de migration avant de remplacer une ancienne configuration.

N'exposez pas DSH ou la passerelle comme relais public. L'affichage et la rotation de la clé restent limités à l'accès local ; l'accès distant aux paramètres exige un tunnel SSH ou la politique stricte de proxy authentifié décrite dans [INSTALL.md](INSTALL.md).

## Confidentialité et limites

- Ne publiez ni identifiants, ni journaux réels, ni captures avec comptes, ni chemins propres à votre ordinateur. Les tokens OAuth restent dans les fichiers d'authentification locaux, pas dans le chat ou les réponses publiques de statut.
- Écritures atomiques, verrous et modes de fichiers restrictifs sont employés ; sous Windows, les modes POSIX ne garantissent pas à eux seuls les permissions ACL.
- Les recherches privées vont dans `docs/local/`, ignoré par Git et exclu du paquet.
- Utilisez uniquement des comptes et endpoints autorisés. L'accès à un abonnement par un client tiers peut être incompatible avec les conditions du fournisseur ou entraîner des restrictions. Aucun contournement d'accès, partage public ou revente de quota n'est proposé.

## Développement

```bash
pnpm install --frozen-lockfile
pnpm run check:next
pnpm run check
npm pack --dry-run --json --ignore-scripts
```

`src/` est la source ; `lib/` est généré et suivi par Git pour les installations depuis le dépôt. Ne modifiez jamais les fichiers générés à la main. Les tests DSH doivent utiliser un environnement isolé, pas le profil d'un utilisateur. Voir [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) et [HANDOFF.md](HANDOFF.md).

Les autres traductions sont conservées comme documents historiques de l'amont, pas comme guides d'installation actuels. Les anciens visuels représentent l'interface de l'amont, pas une capture validée de ce build.

## Origine et licence

Fork de [lninghaha/dsh-coding-subscription-oauth](https://github.com/lninghaha/dsh-coding-subscription-oauth), avec attribution conservée. [Apache-2.0](LICENSE) · [NOTICE](NOTICE). Certaines parties proviennent de [dsh-xai](https://github.com/MirDie/dsh-xai).

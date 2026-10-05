# HANDOFF — fork de `dsh-coding-subscription-oauth` pour DSH 0.2.0-rc.2

> Document destiné à la **prochaine session IA** qui reprendra ce dépôt.
> Écrit le 4 octobre 2026. Langue : français (Korayl travaille en français).

---

## 1. Pourquoi ce fork existe

`dsh-coding-subscription-oauth` est un plugin DeepSeek Harness qui apporte des routes
LLM par **abonnement** (OAuth) au lieu de clés API payantes :

| Route | Fournisseur | Authentification |
|---|---|---|
| `grok-build` | xAI SuperGrok / X Premium | OAuth |
| `codex-oauth` (+ `codex-oauth-fast`) | ChatGPT Plus/Pro | OAuth |
| `kimi-code-oauth` | Kimi Code | OAuth |
| `claude-code-oauth` | Claude Pro/Max | OAuth |
| `agy` | Google Antigravity | paquet séparé `dsh-agy` |

**Le problème** : l'amont (`lninghaha/dsh-coding-subscription-oauth`, dernier tag `v0.8.5`)
fige des versions **exactes** contre un noyau DSH ancien. Le noyau officiel actuel
(`0.2.0-rc.2`) refuse ces paquets au démarrage :

```
dsh: skipping profile bundle "dsh-coding-subscription-oauth":
     Plugin … is incompatible with dsh 0.2.0-rc.2: peerDependencies {…}
```

Résultat concret : la route LLM n'est jamais enregistrée, et le modèle par défaut de
Korayl (`openrouter1` / `@preset/dsh-ds-v4-flash-deepseek`) ne se résout plus.

**Ce fork** rebase le plugin sur le noyau officiel.

---

## 2. État actuel

| | |
|---|---|
| Dépôt local | `C:\Users\Korayl\Desktop\GitHub\dsh-coding-subscription-oauth` |
| Branche de travail | `rebase/dsh-0.2.0-rc.2` |
| Amont | `lninghaha/dsh-coding-subscription-oauth`, commit `ef93a2f`, tag `v0.8.5` |
| Noyau cible | DeepSeek Harness **0.2.0-rc.2** (cordis 4.0.4, schemastery 3.18.4, pi-ai 0.87.1) |
| Version du paquet | **0.8.5** (non renumérotée — voir §7) |

### Vérifications passées

| Étape | Résultat |
|---|---|
| Barrière BOM (`pnpm run check:bom`) | `verified exact DSH BOM (18 packages)` |
| `pnpm run typecheck` | 0 erreur |
| `pnpm run test` | 61 fichiers, 593 réussis, 5 ignorés, **0 échec** |
| `pnpm run lint` | 176 fichiers, 0 erreur (9 infos préexistantes) |
| `pnpm run release:build` | `promoted and verified …\lib (140 files)` |

---

## 3. Ce qui a été modifié (et pourquoi)

### 3.1 Versions — trois fichiers doivent rester cohérents

`build/verify-dsh-bom.mjs` **exige** que ces trois sources soient identiques. Si vous en
changez une, changez les trois, sinon le build échoue avec un message explicite.

1. `package.json` → `dsh.compatibility.bom`, `peerDependencies`, `devDependencies`, `overrides`
2. `src/compatibility.ts` → constante `DSH_EXACT_BOM`
3. `compatibility/dsh-bom.json` → bloc `verified.packages` (+ `verified.id` / `dshVersion`)

**Piège** : sous pnpm 11, les `overrides` de `package.json` sont **ignorés** ; ils sont lus
depuis `pnpm-workspace.yaml`. Les deux emplacements ont été alignés.

### 3.2 Ruptures d'API réelles rencontrées

Quatre ruptures, toutes corrigées. Elles se reproduiront à chaque montée de version :
**c'est la liste à vérifier en premier.**

#### a. `ToolCall.arguments` durci en `JsonObject` (pi-ai 0.84 → 0.87)

```
0.84.2 : arguments: Record<string, any>
0.87.1 : arguments: JsonObject        // { [key: string]: JsonValue }
```

→ `src/gateway-backend.ts` : `parseToolArguments()` renvoie un `JsonObject` garanti via
`toJsonObject()`, qui écarte les entrées non-JSON (le gateway parse du JSON client non
fiable). Le repli historique `{ value }` est conservé à l'identique.

#### b. Le contexte fournisseur est marqué (`TranscriptContext`)

```
0.84.2 : StreamFunction = (model, context: Context, …) => …
0.87.1 : StreamFunction = (model, context: TranscriptContext, …) => …
```

`TranscriptContext` est un type marqué que **seul `normalizeContext()` peut produire**.
Un `Context` brut ne peut plus atteindre le fournisseur par accident.
→ tests : `normalizeContext({ messages: [] })`.

#### c. `exactOptionalPropertyTypes` sur `piProvider`

`ResolvedPiAiProviderProfile.piProvider` est optionnel. La clé doit être **omise**, pas
porter un `undefined` explicite.
→ `src/adapter.ts` : `...(piProvider === undefined ? {} : { piProvider })`.

#### d. Le noyau applique désormais un plafond d'images ⚠️ le plus important

L'ancien `dsh-llm-pi-ai` (0.1.1-rc.2) n'avait **aucune** vérification :

```
0.1.1-rc.2 : 'pi-ai request images exceed' → absent
             requiredImageOffload           → absent
             base64Length                   → 0 occurrence
0.2.0-rc.2 : les trois présents
```

Le nouveau noyau additionne les octets de chaque image via `base64Length(bytes)` et
refuse la requête au-delà de `maxRequestImageBytes` (20 Mio par défaut).

**Second changement dans la même zone** — la cible passée à `readImageRequest` a changé :

```
0.1.1-rc.2 : { maxPixels, maxBytes }
0.2.0-rc.2 : { width, height, maxBytes }
```

→ `tests/adapter.spec.ts` : la fixture renvoie un `RequestImageAttachment` complet
(`variantId`, `attachment`, `data`, `mediaType`, `bytes`, `width`, `height`, `depth`,
`space`, `hasAlpha`) et l'assertion attend `{ width, height, maxBytes }`.

**Sans ces champs, `base64Length(undefined)` vaut `NaN` et le test échoue sur le garde-fou.**

---

## 4. Procédure de rebasage pour une nouvelle version de DSH

À refaire quand DeepSeek publie un nouveau noyau. Remplacer `X.Y.Z` par la version cible.

### Étape 1 — Identifier les versions du noyau cible

Le noyau officiel est **dans l'application**, pas sur npm. Deux sources :

```powershell
# 1. version du noyau
Get-Content "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar" # via l'extracteur ci-dessous
# 2. versions exactes de chaque paquet
#    -> lire resources\app.asar\package.json (dsh-llm, cordis…) et dsh/package.json
```

Un extracteur d'asar minimal est disponible dans le workspace Deepseek Harness
(`.tmp-asar.mjs`, mode `list` ou lecture d'un fichier) :

```powershell
node .tmp-asar.mjs "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar" "dsh/package.json"
```

### Étape 2 — Vérifier que les cibles existent sur npm

```powershell
npm view "@deepseek-ai/dsh-llm@X.Y.Z" version
npm view "@earendil-works/pi-ai@A.B.C" version
```

Toutes les cibles doivent répondre. `@deepseek-ai/dsh-client-web` et
`@earendil-works/pi-ai` sont les deux qu'on oublie.

### Étape 3 — Mettre à jour les trois fichiers de versions

Voir §3.1. Puis :

```powershell
node build/verify-dsh-bom.mjs      # doit afficher : verified exact DSH BOM (N packages)
```

### Étape 4 — Installer et laisser le typecheck révéler les ruptures

```powershell
# pnpm embarqué par l'application officielle (aucune installation système requise)
$pnpm = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\pnpm\bin\pnpm.mjs"
node $pnpm install
node $pnpm run typecheck
```

**C'est ici que se trouvent les vraies ruptures.** Corriger une par une, puis relancer.

### Étape 5 — Tests, lint, build

```powershell
node $pnpm run test
node $pnpm run lint
node $pnpm run release:build       # régénère lib/ (140 fichiers, suivis par git)
```

### Étape 6 — Comparer les surfaces d'API si un symbole a disparu

Si le typecheck signale un symbole `pi-ai` introuvable, comparer les deux versions :

```powershell
# extraire les deux versions et comparer les .d.ts
npm pack '@earendil-works/pi-ai@<ancienne>' ; npm pack '@earendil-works/pi-ai@<nouvelle>'
# puis chercher chaque symbole importé par src/
```

Le 4 octobre 2026, **les 23 symboles `pi-ai` utilisés ont tous survécu** à la montée
0.84.2 → 0.87.1. La surface d'export est stable ; seul `./utils/*` s'est ajouté.

---

## 5. Installation du plugin

### ⚠️ Contrainte majeure

Le **profil `desktop` est géré exclusivement par l'application Electron**. Le CLI refuse :

```
dsh --profile desktop … → error: profile "desktop" is managed exclusively by the Electron application
```

L'installation se fait donc **depuis l'interface de l'application officielle**
(gestionnaire de plugins / marché), pas en ligne de commande.

### Prérequis absolu

Le noyau de l'application qui reçoit le plugin doit être **0.2.0-rc.2** (ou la version
pour laquelle le fork a été rebasé). Installer ce fork dans une application au noyau
`0.1.5-rc.2` **échouera** : les `peerDependencies` déclarées sont `0.2.0-rc.2`.

### Méthode

1. L'application officielle DeepSeek Harness doit être lancée.
2. Ouvrir le gestionnaire de plugins.
3. Installer depuis l'URL du dépôt (ou depuis un chemin local).
4. Redémarrer l'application pour que l'arbre de plugins soit recomposé.

### Vérification après installation

- La route doit apparaître dans le sélecteur de modèle, suffixée `(OAuth)`.
- Seules les routes **effectivement authentifiées** exposent des modèles.
- Si le fournisseur `openrouter1` disparaît, c'est le symptôme d'un arbre de plugins cassé.

---

## 6. Pièges déjà rencontrés — ne pas les redécouvrir

| Piège | Détail |
|---|---|
| **Deux noyaux sur un même `DSH_HOME`** | Lancer un second noyau pendant que l'application tourne peut casser l'arbre de plugins à chaud (`patchReload: live`). Utiliser un `DSH_HOME` isolé pour tout test. |
| **`pnpm` absent du PATH** | Le pnpm système n'existe pas ; utiliser celui embarqué par l'application officielle (`resources\runtime\pnpm\bin\pnpm.mjs`). Les mises à jour du marché ont échoué deux fois pour cette raison le 4 octobre. |
| **`overrides` ignorés** | Sous pnpm 11, les overrides de `package.json` ne sont pas lus : ils vivent dans `pnpm-workspace.yaml`. |
| **Ne pas toucher `node_modules` d'un profil vivant** | Un renommage de dossier dans `profiles\desktop\node_modules` pendant que l'app tourne casse son arbre de plugins. Lecture seule. |
| **`lib/` est suivi par git** | 140 fichiers. Il **faut** lancer `release:build` avant de commiter, sinon le dépôt publie un build obsolète. |
| **Le client est compilé contre `dsh-client-web`** | La version est vérifiée au build (`built … against dsh-client-web X`). |

---

## 7. Points ouverts

1. **Version du paquet non renumérotée** — reste `0.8.5`, identique à l'amont. Pour
   distinguer le fork, envisager `0.9.0` (ou un suffixe `-fork.1`).
2. **Non testé en conditions réelles** — les 593 tests valident la logique contre des
   fixtures, pas contre le noyau officiel en fonctionnement. Le premier chargement réel
   reste à faire, et c'est lui qui validera définitivement le rebasage.
3. **Catalogue de modèles** — le plan initial prévoyait de mettre à jour le catalogue et
   la lecture en direct des `reasoning_efforts` (apparition de modèles récents comme
   `grok-4.6` en `xhigh`). **Non traité dans ce rebasage** : celui-ci s'est limité à la
   compatibilité. À reprendre si Korayl constate des modèles manquants.

---

## 8. Commandes utiles (récapitulatif)

```powershell
$repo = "$env:USERPROFILE\Desktop\GitHub\dsh-coding-subscription-oauth"
$pnpm = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\pnpm\bin\pnpm.mjs"
Set-Location $repo

node build/verify-dsh-bom.mjs     # cohérence des 3 fichiers de versions
node $pnpm run typecheck          # ruptures d'API
node $pnpm run test               # suite complète
node $pnpm run lint               # biome
node $pnpm run release:build      # régénère lib/
```

---

## 9. Contexte Korayl

- Ne connaît pas GitHub : **le guider pas à pas**, une seule étape à la fois, avec
  confirmation avant de continuer. Préférer **GitHub Desktop** au terminal.
- Travaille en français ; réponses longues et structurées appréciées.
- Exige de la **prudence sur sa configuration vivante** (`~\.dsh`, `settings.yaml`,
  `node_modules` du profil) tant que les applications tournent : lecture seule par défaut.
- L'ancienne application (fork `anywhere-labs`, noyau `0.1.5-rc.2`) est toujours installée
  et **il ne veut pas encore la désinstaller**.

# Rebasage de `dsh-coding-subscription-oauth` sur DSH 0.2.0-rc.2

**Branche** : `rebase/dsh-0.2.0-rc.2`
**Dépôt local** : `C:\Users\Korayl\Desktop\GitHub\dsh-coding-subscription-oauth`
**Amont** : `lninghaha/dsh-coding-subscription-oauth`, commit `ef93a2f` (tag `v0.8.5`, 15/09/2026)
**Objectif** : rendre le plugin compatible avec le noyau DeepSeek Harness `0.2.0-rc.2` (application officielle)

---

## 1. Pourquoi le plugin est incompatible

Son `package.json` fige **des versions exactes** contre un noyau ancien :

| Paquet | Déclaré par le plugin | Noyau officiel 0.2.0-rc.2 |
|---|---|---|
| `@deepseek-ai/cordis` | `4.0.1` | `4.0.4` |
| `@deepseek-ai/dsh-llm` | `0.1.1-rc.2` | `0.2.0-rc.2` |
| `@deepseek-ai/dsh-llm-pi-ai` | `0.1.1-rc.2` | `0.2.0-rc.2` |
| `@deepseek-ai/dsh-settings` | `0.1.1-rc.2` | `0.2.0-rc.2` |
| … (10 paquets `@deepseek-ai` au total) | `0.1.1-rc.2` | `0.2.0-rc.2` |
| `@deepseek-ai/schemastery` | `3.18.1` | `3.18.4` |
| `@earendil-works/pi-ai` | `0.84.2` | `0.87.1` |

Le noyau officiel refuse ces paquets au démarrage (`skipping profile bundle … is incompatible with dsh 0.2.0-rc.2`), donc la route LLM n'est jamais enregistrée et le modèle par défaut ne se résout plus.

---

## 2. Bonne nouvelle n°1 — toutes les cibles existent sur npm

Vérifié le 4 octobre 2026 : les **16 paquets** de la liste BOM sont publiés en `0.2.0-rc.2` (et `cordis` en `4.0.4`, `schemastery` en `3.18.4`, `pi-ai` en `0.87.1`). Aucune dépendance manquante, donc aucun blocage mécanique.

---

## 3. Bonne nouvelle n°2 — la surface d'API `pi-ai` est stable

C'est le risque principal : le plugin importe **23 symboles** depuis `@earendil-works/pi-ai` (via 23 instructions `import`). Comparaison exhaustive des fichiers de déclaration `0.84.2` vs `0.87.1` :

```
anthropicProvider      ok        Model               ok
Api                    ok        MutableModels       ok
ApiKeyAuth             ok        OAuthCredential     ok
AuthEvent              ok        openaiCodexProvider ok
AuthInteraction        ok        openAIResponsesApi  ok
AuthPrompt             ok        Provider            ok
createModels           ok        ThinkingLevel       ok
createProvider         ok        ThinkingLevelMap    ok
Credential             ok        Tool                ok
CredentialInfo         ok        xaiProvider         ok
CredentialStore        ok
kimiCodingProvider     ok
Message                ok
```

**Aucun symbole perdu.** Les points d'entrée du paquet sont également stables — seul `./utils/*` s'**ajoute** en 0.87.1, rien ne disparaît.

---

## 4. Bonne nouvelle n°3 — l'adaptateur hôte est défensif

`src/dsh-host-adapter.ts` ne dépend pas de types exacts : il teste la **présence de fonctions** à l'exécution (`typeof candidate[method] === "function"`) et déclare des diagnostics `missing` / `incompatible` / `available`. Les services sondés sont :

| Service | Méthode testée |
|---|---|
| `webServer` | `register` |
| `settings` | `register` |
| `credentials` | `resolve` |
| `llm` | `registerAdapter` |
| `ownerRequestPolicy` | `authorize`, `diagnostics` |

C'est une conception qui pardonne les écarts de version. Le plugin signale la dégradation au lieu de planter.

---

## 5. Nature du travail restant

Le rebasage est donc **principalement déclaratif** (versions), avec un risque résiduel sur les signatures de types :

1. **Mettre à jour les 3 fichiers de versions** — `package.json` (bloc `dsh.compatibility.bom`, `peerDependencies`, `devDependencies`, `overrides`), `src/compatibility.ts` (constante `DSH_EXACT_BOM`), `compatibility/dsh-bom.json` (bloc `verified` + nouvelle entrée `candidates`).
2. **Laisser la barrière BOM faire son travail** — `build/verify-dsh-bom.mjs` exige que les trois fichiers soient cohérents ; c'est un excellent filet de sécurité.
3. **Typecheck** — c'est là que se révèlent les vraies ruptures de signature.
4. **Corriger** ce que le typecheck signale, puis relancer tests et build.

---

## 7. Ruptures réelles trouvées et corrigées

Le rebasage a révélé **quatre ruptures concrètes**, toutes corrigées :

### 7.1 `ToolCall.arguments` durci en `JsonObject` (pi-ai 0.87.1)

```
0.84.2 : arguments: Record<string, any>
0.87.1 : arguments: JsonObject        // { [key: string]: JsonValue }
```

`src/gateway-backend.ts` : `parseToolArguments` renvoie désormais un `JsonObject` garanti, via un nouveau `toJsonObject()` qui filtre les entrées non-JSON (le gateway parse du JSON client non fiable). Le repli historique `{ value }` est conservé à l'identique.

### 7.2 Le contexte fournisseur est marqué (`TranscriptContext`)

```
0.84.2 : StreamFunction = (model, context: Context, options?) => …
0.87.1 : StreamFunction = (model, context: TranscriptContext, options?) => …
```

`TranscriptContext` est un type marqué que **seul `normalizeContext()` peut produire**. Corrigé dans `tests/oauth-providers.spec.ts` par l'appel officiel `normalizeContext({ messages: [] })`.

### 7.3 `exactOptionalPropertyTypes` sur `piProvider`

`ResolvedPiAiProviderProfile.piProvider` est optionnel ; le noyau active `exactOptionalPropertyTypes`. `src/adapter.ts` omet désormais la clé au lieu de porter un `undefined` explicite.

### 7.4 Le noyau applique désormais un plafond d'images (0.1.1-rc.2 → 0.2.0-rc.2)

**C'est la rupture la plus significative.** L'ancien `dsh-llm-pi-ai` n'avait **aucune** vérification :

```
0.1.1-rc.2 : 'pi-ai request images exceed' → absent
             requiredImageOffload           → absent
             base64Length                   → 0 occurrence
0.2.0-rc.2 : les trois présents
```

Le nouveau noyau additionne les octets de chaque image via `base64Length(bytes)` et refuse la requête si le total dépasse `maxRequestImageBytes` (20 Mio par défaut).

Second changement dans la même zone : la cible passée à `readImageRequest` a changé de forme.

```
0.1.1-rc.2 : { maxPixels, maxBytes }
0.2.0-rc.2 : { width, height, maxBytes }
```

`tests/adapter.spec.ts` a été aligné : la fixture `readImageRequest` renvoie désormais un `RequestImageAttachment` complet (`bytes`, `width`, `height`, `depth`, `space`, `hasAlpha`, `variantId`), et l'assertion de politique attend `{ width, height, maxBytes }`.

---

## 8. Résultat

| Étape | Résultat |
|---|---|
| Barrière BOM | `verified exact DSH BOM (18 packages)` |
| `typecheck` | **0 erreur** |
| `test` | **61 fichiers, 593 réussis, 5 ignorés, 0 échec** |
| `lint` (biome) | 176 fichiers, 0 erreur (9 infos préexistantes) |
| `release:build` | `promoted and verified …\lib (140 files)` |
| Client compilé contre | `dsh-client-web 0.2.0-rc.2` |

Le bundle final ne contient plus **aucune** trace de `0.1.1-rc.2` ni de `cordis 4.0.1`.

---

## 9. Fichiers modifiés

| Fichier | Nature |
|---|---|
| `package.json` | versions (BOM, peers, dev, overrides) |
| `pnpm-workspace.yaml` | override `pi-ai` → 0.87.1 (pnpm 11 lit les overrides ici) |
| `pnpm-lock.yaml` | régénéré |
| `src/compatibility.ts` | constante `DSH_EXACT_BOM` |
| `compatibility/dsh-bom.json` | bloc `verified` + candidats |
| `src/adapter.ts` | 1 ligne + commentaire (7.3) |
| `src/gateway-backend.ts` | `JsonObject` + `toJsonObject` (7.1) |
| `tests/adapter.spec.ts` | fixture image + assertion de politique (7.4) |
| `tests/oauth-providers.spec.ts` | `normalizeContext` (7.2) |

**Aucun changement de comportement fonctionnel** : les corrections portent sur des frontières de types et des fixtures de test, à l'exception du filtrage des arguments d'outil non-JSON (7.1), qui est un durcissement de sécurité aligné sur le nouveau contrat.

---

## 6. Ce qui n'est PAS touché

- La logique OAuth, les routes, le gateway, le catalogue de modèles : aucun changement de comportement prévu.
- Le fork reste sur la branche `rebase/dsh-0.2.0-rc.2`, `main` intacte.
- Aucune modification du profil DSH réel de Korayl pendant ce travail.

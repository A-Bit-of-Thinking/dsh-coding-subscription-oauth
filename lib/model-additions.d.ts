/**
 * Modele ajoutes a la main au catalogue des abonnements.
 * @module dsh-coding-subscription-oauth/model-additions
 *
 * ---------------------------------------------------------------------------
 *  A L'ATTENTION DE L'IA QUI METTRA CE DEPOT A JOUR
 * ---------------------------------------------------------------------------
 *
 *  POURQUOI CE FICHIER EXISTE
 *  Le catalogue de modeles vient de `@earendil-works/pi-ai`, qui le stocke en
 *  JSON statique et ne le met a jour qu'a ses propres publications. Un modele
 *  sorti chez OpenAI ou Anthropic n'est donc visible ici qu'apres une nouvelle
 *  version de pi-ai. Ce fichier permet de le rendre disponible TOUT DE SUITE,
 *  sans attendre pi-ai.
 *
 *  COMMENT AJOUTER UN MODELE
 *  1. Ajoutez une entree dans le tableau du bon fournisseur, ci-dessous.
 *  2. Utilisez `extends` pour heriter d'un modele connu de la meme famille :
 *     toutes ses caracteristiques (fenetre de contexte, tokens max, niveaux de
 *     raisonnement, compatibilite, limites d'image, cout) sont recopiees, et
 *     vous ne precisez que ce qui change.
 *  3. Lancez `node $pnpm run typecheck`, puis `test`, puis `release:build`.
 *  4. Commitez et poussez. L'utilisateur reinstalle avec son script.
 *
 *  EXEMPLE — un nouveau modele Codex identique a `gpt-6-sol` :
 *
 *      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", extends: "gpt-6-sol" }
 *
 *  EXEMPLE — un modele qui change aussi sa fenetre de contexte :
 *
 *      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5",
 *        extends: "claude-sonnet-5", contextWindow: 2_000_000 }
 *
 *  POINTS DE VIGILANCE
 *  - `extends` doit nommer un modele EXISTANT du meme fournisseur. S'il est
 *    introuvable, l'entree est ignoree (et le test le signale).
 *  - Pour un modele sans equivalent connu, omettez `extends` et fournissez
 *    l'entree complete (`api`, `provider`, `baseUrl`, `reasoning`, `input`,
 *    `cost`, `contextWindow`, `maxTokens`). Recopiez celle d'un modele voisin.
 *  - Une entree dont l'`id` existe deja REMPLACE celle du catalogue pi-ai.
 *    C'est le moyen de corriger une metadonnee erronee.
 *  - Verifiez les valeurs a la source officielle. Ne devinez pas une fenetre de
 *    contexte ni un niveau de raisonnement : une valeur fausse produit des
 *    erreurs de requete difficiles a diagnostiquer.
 *  - Apres un `pnpm add` qui remonte pi-ai, re-verifiez si ces entrees sont
 *    devenues inutiles : pi-ai les fournit peut-etre desormais nativement.
 */
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
/** Identifiants pi-ai des fournisseurs. Ne pas modifier. */
export declare const MODEL_ADDITION_PROVIDERS: Readonly<{
    codex: "openai-codex";
    claude: "anthropic";
    kimi: "kimi-coding";
}>;
/**
 * Une entree d'ajout. `id` est requis ; tous les autres champs de `Model` sont
 * optionnels et ne servent qu'a surcharger l'heritage.
 */
export interface ModelAddition extends Partial<Model<Api>> {
    readonly id: string;
    /** Id d'un modele existant dont heriter. Absent = entree complete requise. */
    readonly extends?: string;
}
/**
 * Les modeles ajoutes, par identifiant pi-ai de fournisseur.
 *
 * AJOUTEZ VOS ENTREES ICI. Un tableau vide est sans effet : le catalogue pi-ai
 * est alors utilise tel quel, a l'identique.
 *
 * Volontairement non gele : le test de cablage remplace une entree le temps
 * d'une assertion, puis la restaure.
 */
export declare const MODEL_ADDITIONS: Record<string, readonly ModelAddition[]>;
export interface ModelAdditionDiagnostic {
    readonly id: string;
    readonly providerId: string;
    readonly reason: string;
}
export interface ResolvedModelAdditions {
    readonly models: readonly Model<Api>[];
    readonly diagnostics: readonly ModelAdditionDiagnostic[];
}
/**
 * Resout les ajouts d'un fournisseur contre son catalogue.
 *
 * Chaque entree est fusionnee avec son modele de reference (si `extends` est
 * present), puis validee. Une entree inexploitable est ecartee avec un
 * diagnostic plutot que de faire echouer le chargement du plugin : un catalogue
 * de modeles incomplet doit rester utilisable.
 *
 * @param providerId - identifiant pi-ai du fournisseur.
 * @param catalog - catalogue actuel, servant de source pour `extends`.
 * @param additions - table des ajouts ; `MODEL_ADDITIONS` par defaut (injectable en test).
 * @returns les modeles ajoutes et les diagnostics des entrees ecartees.
 */
export declare function resolveModelAdditions(providerId: string, catalog: readonly Model<Api>[], additions?: Readonly<Record<string, readonly ModelAddition[]>>): ResolvedModelAdditions;
/**
 * Enveloppe un fournisseur pi-ai pour y ajouter les modeles de ce fichier.
 *
 * Les ajouts remplacent une entree de meme `id` et s'ajoutent a la fin sinon,
 * de sorte que l'ordre du catalogue d'origine reste stable pour l'interface.
 * Sans ajout configure, le fournisseur est retourne tel quel.
 *
 * @param provider - fournisseur pi-ai d'origine.
 * @param providerId - identifiant pi-ai du fournisseur.
 * @param additions - table des ajouts ; `MODEL_ADDITIONS` par defaut (injectable en test).
 * @returns le fournisseur, augmente le cas echeant.
 */
export declare function withModelAdditions(provider: Provider<Api>, providerId: string, additions?: Readonly<Record<string, readonly ModelAddition[]>>): Provider<Api>;
//# sourceMappingURL=model-additions.d.ts.map
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
export const MODEL_ADDITION_PROVIDERS = Object.freeze({
	codex: "openai-codex",
	claude: "anthropic",
	kimi: "kimi-coding",
});

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
export const MODEL_ADDITIONS: Record<string, readonly ModelAddition[]> = {
	[MODEL_ADDITION_PROVIDERS.codex]: [
		{
			id: "gpt-6.1-sol",
			name: "GPT-6.1 Sol",
			extends: "gpt-6-sol",
			/**
			 * OpenAI documente explicitement, pour ce modele precis, que « none »
			 * et « minimal » ne sont PAS supportes, alors que le catalogue pi-ai
			 * de `gpt-6-sol` mappe `off` vers « none ». Envoyer « none » a ce
			 * slug risquerait un 400.
			 *
			 * `off: null` signifie « propose, mais n'envoie rien » : c'est la
			 * convention deja utilisee dans ce depot pour un modele incapable de
			 * desactiver son raisonnement (voir `grokBuildReasoningMap`). Le
			 * modele retombe alors sur son effort par defaut (medium), sans
			 * qu'aucune requete ne puisse echouer.
			 *
			 * `minimal` reste mappe vers « low », qui est supporte.
			 *
			 * FENETRE DE CONTEXTE — heritee a 272 000, volontairement.
			 * La page API publique d'OpenAI annonce 1 050 000, mais le backend
			 * Codex OAuth (chatgpt.com/backend-api), celui que ce plugin
			 * utilise, annonce 272 000 — la valeur que pi-ai retient pour TOUS
			 * les modeles Codex. Un agent tiers a mesure en direct, le
			 * 2026-09-29, que ~918 000 tokens d'entree passent et que ~931 000
			 * sont refuses : la vraie limite est proche des 922 000 annonces par
			 * la page modele, pas des 272 000.
			 *
			 * On garde 272 000 parce que (1) c'est ce que le backend annonce,
			 * (2) cela ne peut jamais faire echouer une requete, et (3) un
			 * contexte plus large fait consommer l'abonnement BEAUCOUP plus vite.
			 * Pour l'activer deliberement, ajouter `contextWindow: 900_000` ici.
			 *
			 * Tarifs : herites, et ils correspondent EXACTEMENT a la grille
			 * publiee pour gpt-6.1-sol (entree 2 $, sortie 10 $, ecriture de
			 * cache 2,5 $ par million ; palier a 272 000 tokens doubles).
			 */
			thinkingLevelMap: {
				off: null,
				minimal: "low",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
		},
	],
	[MODEL_ADDITION_PROVIDERS.claude]: [
		{
			id: "claude-sonnet-5-5",
			name: "Claude Sonnet 5.5",
			extends: "claude-sonnet-5",
			/**
			 * FENETRE DE CONTEXTE ET SORTIE — heritees, et VERIFIEES.
			 * La fiche modele officielle (Amazon Bedrock, modele lance le
			 * 2026-09-28) annonce exactement 1M de contexte et 128K de sortie,
			 * soit les valeurs que pi-ai declare deja pour `claude-sonnet-5`.
			 * Entrees texte + image : identiques. Rien a surcharger.
			 *
			 * NIVEAUX DE RAISONNEMENT — surcharges.
			 * La meme fiche annonce « adaptive thinking » actif par defaut et un
			 * effort configurable de low a max. L'entree pi-ai de
			 * `claude-sonnet-5` n'expose que xhigh et max, ce qui priverait
			 * l'utilisateur des niveaux intermediaires.
			 *
			 * La table ci-dessous reprend celle de `claude-opus-5-5`, le Claude
			 * le plus recent du catalogue et de la meme generation : c'est la
			 * convention en vigueur, et les valeurs de cablage « low »,
			 * « medium » et « high » y sont deja utilisees avec succes.
			 * `minimal` est declare `null` : le normalisateur l'ecarte, donc le
			 * niveau n'est pas propose, conformement a la fiche.
			 */
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
		},
	],
	[MODEL_ADDITION_PROVIDERS.kimi]: [],
};

/** Champs indispensables pour qu'un modele sans heritage soit exploitable. */
const REQUIRED_ON_STANDALONE: readonly (keyof Model<Api>)[] = [
	"api",
	"provider",
	"baseUrl",
	"reasoning",
	"input",
	"cost",
	"contextWindow",
	"maxTokens",
];

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
export function resolveModelAdditions(
	providerId: string,
	catalog: readonly Model<Api>[],
	additions: Readonly<Record<string, readonly ModelAddition[]>> = MODEL_ADDITIONS,
): ResolvedModelAdditions {
	const declared = additions[providerId];
	if (declared === undefined || declared.length === 0) return { models: [], diagnostics: [] };

	const known = new Map<string, Model<Api>>(catalog.map((model) => [model.id, model]));
	const models: Model<Api>[] = [];
	const diagnostics: ModelAdditionDiagnostic[] = [];

	for (const addition of declared) {
		const { extends: baseId, ...overrides } = addition;
		if (typeof addition.id !== "string" || addition.id.trim() === "") {
			diagnostics.push({ id: "<sans id>", providerId, reason: "id manquant" });
			continue;
		}

		if (baseId === undefined) {
			const missing = REQUIRED_ON_STANDALONE.filter((field) => overrides[field] === undefined);
			if (missing.length > 0) {
				diagnostics.push({
					id: addition.id,
					providerId,
					reason: `sans 'extends', ces champs sont obligatoires : ${missing.join(", ")}`,
				});
				continue;
			}
			const standalone = { ...overrides, id: addition.id } as Model<Api>;
			known.set(standalone.id, standalone);
			models.push(standalone);
			continue;
		}

		const base = known.get(baseId);
		if (base === undefined) {
			diagnostics.push({
				id: addition.id,
				providerId,
				reason: `'extends: ${baseId}' ne correspond a aucun modele connu de ce fournisseur`,
			});
			continue;
		}
		const merged = { ...base, ...overrides, id: addition.id } as Model<Api>;
		known.set(merged.id, merged);
		models.push(merged);
	}

	return { models, diagnostics };
}

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
export function withModelAdditions(
	provider: Provider<Api>,
	providerId: string,
	additions: Readonly<Record<string, readonly ModelAddition[]>> = MODEL_ADDITIONS,
): Provider<Api> {
	const declared = additions[providerId];
	if (declared === undefined || declared.length === 0) return provider;

	return {
		...provider,
		getModels: () => {
			const catalog = provider.getModels();
			const { models } = resolveModelAdditions(providerId, catalog, additions);
			if (models.length === 0) return catalog;
			const merged = new Map<string, Model<Api>>(catalog.map((model) => [model.id, model]));
			for (const model of models) merged.set(model.id, model);
			return [...merged.values()];
		},
	};
}

import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { describe, expect, it } from "vitest";
import {
	MODEL_ADDITION_PROVIDERS,
	MODEL_ADDITIONS,
	type ModelAddition,
	resolveModelAdditions,
	withModelAdditions,
} from "../src/model-additions.ts";
import { CLAUDE_CODE_OAUTH_PROVIDER, CODEX_OAUTH_PROVIDER } from "../src/oauth-providers.ts";

/** Un modele de catalogue complet, servant de reference a `extends`. */
function referenceModel(id: string): Model<Api> {
	return {
		id,
		name: `Modele ${id}`,
		api: "openai-codex-responses",
		provider: MODEL_ADDITION_PROVIDERS.codex,
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	} as unknown as Model<Api>;
}

function fakeProvider(models: readonly Model<Api>[]): Provider<Api> {
	return { id: MODEL_ADDITION_PROVIDERS.codex, getModels: () => models } as unknown as Provider<Api>;
}

const CODEX = MODEL_ADDITION_PROVIDERS.codex;

function additionsOf(entries: readonly ModelAddition[]) {
	return { [CODEX]: entries } as Readonly<Record<string, readonly ModelAddition[]>>;
}

describe("resolveModelAdditions", () => {
	it("ne produit rien quand aucun ajout n'est declare", () => {
		const resolved = resolveModelAdditions(CODEX, [referenceModel("gpt-6-sol")], {});
		expect(resolved.models).toEqual([]);
		expect(resolved.diagnostics).toEqual([]);
	});

	it("herite de toutes les caracteristiques du modele de reference", () => {
		const base = referenceModel("gpt-6-sol");
		const resolved = resolveModelAdditions(
			CODEX,
			[base],
			additionsOf([{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", extends: "gpt-6-sol" }]),
		);

		expect(resolved.diagnostics).toEqual([]);
		expect(resolved.models).toHaveLength(1);
		const added = resolved.models[0]!;
		expect(added.id).toBe("gpt-6.1-sol");
		expect(added.name).toBe("GPT-6.1 Sol");
		// Tout le reste est recopie du modele de reference.
		expect(added.api).toBe(base.api);
		expect(added.provider).toBe(base.provider);
		expect(added.baseUrl).toBe(base.baseUrl);
		expect(added.reasoning).toBe(base.reasoning);
		expect(added.input).toEqual(base.input);
		expect(added.cost).toEqual(base.cost);
		expect(added.contextWindow).toBe(base.contextWindow);
		expect(added.maxTokens).toBe(base.maxTokens);
	});

	it("laisse surcharger un champ herite", () => {
		const resolved = resolveModelAdditions(
			CODEX,
			[referenceModel("gpt-6-sol")],
			additionsOf([{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", extends: "gpt-6-sol", contextWindow: 1_000_000 }]),
		);

		expect(resolved.models[0]?.contextWindow).toBe(1_000_000);
		// Les champs non surcharges restent herites.
		expect(resolved.models[0]?.maxTokens).toBe(128_000);
	});

	it("permet d'enchainer les heritages dans l'ordre de declaration", () => {
		const resolved = resolveModelAdditions(
			CODEX,
			[referenceModel("gpt-6-sol")],
			additionsOf([
				{ id: "gpt-6.1-sol", extends: "gpt-6-sol", name: "GPT-6.1 Sol" },
				{ id: "gpt-6.2-sol", extends: "gpt-6.1-sol", name: "GPT-6.2 Sol" },
			]),
		);

		expect(resolved.diagnostics).toEqual([]);
		expect(resolved.models.map((model) => model.id)).toEqual(["gpt-6.1-sol", "gpt-6.2-sol"]);
		expect(resolved.models[1]?.contextWindow).toBe(272_000);
	});

	it("ecarte un heritage introuvable avec un diagnostic exploitable", () => {
		const resolved = resolveModelAdditions(
			CODEX,
			[referenceModel("gpt-6-sol")],
			additionsOf([{ id: "gpt-9-sol", extends: "gpt-9-inexistant" }]),
		);

		expect(resolved.models).toEqual([]);
		expect(resolved.diagnostics).toHaveLength(1);
		expect(resolved.diagnostics[0]?.id).toBe("gpt-9-sol");
		expect(resolved.diagnostics[0]?.reason).toContain("gpt-9-inexistant");
	});

	it("exige les champs obligatoires pour une entree sans heritage", () => {
		const resolved = resolveModelAdditions(CODEX, [], additionsOf([{ id: "modele-incomplet", name: "Incomplet" }]));

		expect(resolved.models).toEqual([]);
		expect(resolved.diagnostics[0]?.reason).toContain("extends");
	});

	it("accepte une entree complete sans heritage", () => {
		const standalone = referenceModel("modele-complet");
		const resolved = resolveModelAdditions(CODEX, [], additionsOf([standalone as ModelAddition]));

		expect(resolved.diagnostics).toEqual([]);
		expect(resolved.models).toHaveLength(1);
		expect(resolved.models[0]?.id).toBe("modele-complet");
	});

	it("ecarte une entree sans identifiant", () => {
		const resolved = resolveModelAdditions(CODEX, [], additionsOf([{ id: "   " } as unknown as ModelAddition]));

		expect(resolved.models).toEqual([]);
		expect(resolved.diagnostics[0]?.reason).toBe("id manquant");
	});

	it("ne touche pas aux autres fournisseurs", () => {
		const resolved = resolveModelAdditions(
			MODEL_ADDITION_PROVIDERS.claude,
			[referenceModel("gpt-6-sol")],
			additionsOf([{ id: "gpt-6.1-sol", extends: "gpt-6-sol" }]),
		);

		expect(resolved.models).toEqual([]);
		expect(resolved.diagnostics).toEqual([]);
	});
});

describe("validation du modele final", () => {
	const invalidCases: { label: string; overrides: Record<string, unknown>; field: string }[] = [
		{ label: "provider d'un autre fournisseur", overrides: { provider: "anthropic" }, field: "provider" },
		{ label: "reasoning numerique", overrides: { reasoning: 1 }, field: "reasoning" },
		{ label: "reasoning null", overrides: { reasoning: null }, field: "reasoning" },
		{ label: "reasoning absent", overrides: { reasoning: undefined }, field: "reasoning" },
		{ label: "cost null", overrides: { cost: null }, field: "cost" },
		{ label: "cost non objet", overrides: { cost: "gratuit" }, field: "cost" },
		{ label: "cost tableau", overrides: { cost: [] }, field: "cost" },
	];
	for (const field of ["id", "name", "api", "provider", "baseUrl"]) {
		for (const value of ["", " \t\n", null, undefined, 42]) {
			invalidCases.push({ label: `${field}=${String(value)}`, overrides: { [field]: value }, field });
		}
	}
	for (const field of ["contextWindow", "maxTokens"]) {
		for (const value of [
			0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			"128000",
			null,
			undefined,
		]) {
			invalidCases.push({ label: `${field}=${String(value)}`, overrides: { [field]: value }, field });
		}
	}
	for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
		for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "0", null, undefined]) {
			invalidCases.push({
				label: `cost.${field}=${String(value)}`,
				overrides: { cost: { ...referenceModel("base").cost, [field]: value } },
				field: `cost.${field}`,
			});
		}
	}
	for (const input of [[], ["text", "audio"], ["video"], [null], new Array(1), "text", null, undefined]) {
		invalidCases.push({ label: `input=${JSON.stringify(input)}`, overrides: { input }, field: "input" });
	}

	describe.each(["standalone", "heritage"] as const)("%s", (mode) => {
		it.each(invalidCases)("ecarte $label avec un diagnostic structure", ({ overrides, field }) => {
			const entry = {
				...(mode === "standalone" ? referenceModel("ajout-invalide") : { id: "ajout-invalide", extends: "base" }),
				...overrides,
			} as unknown as ModelAddition;
			const resolved = resolveModelAdditions(CODEX, [referenceModel("base")], additionsOf([entry]));

			expect(resolved.models).toEqual([]);
			expect(resolved.diagnostics).toHaveLength(1);
			expect(resolved.diagnostics[0]).toMatchObject({
				id: typeof entry.id === "string" && entry.id.trim() !== "" ? entry.id : "<sans id>",
				providerId: CODEX,
			});
			expect(resolved.diagnostics[0]?.reason).toContain(field);
		});

		it.each([{ input: ["text"] }, { input: ["text", "image"] }, { input: ["image"] }])(
			"accepte les modalites $input, tarifs nuls et limites independantes",
			({ input }) => {
				const entry = {
					...(mode === "standalone" ? referenceModel("valide") : { id: "valide", extends: "base" }),
					api: "custom-api",
					reasoning: false,
					input,
					contextWindow: 100,
					maxTokens: 200,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					thinkingLevelMap: { off: null, minimal: null, high: "high" },
				} as ModelAddition;
				const resolved = resolveModelAdditions(CODEX, [referenceModel("base")], additionsOf([entry]));

				expect(resolved.diagnostics).toEqual([]);
				expect(resolved.models).toHaveLength(1);
				const { extends: _baseId, ...expected } = entry;
				expect(resolved.models[0]).toMatchObject(expected);
				expect(resolved.models[0]).not.toHaveProperty("extends");
			},
		);
	});

	it("valide aussi les valeurs heritees du catalogue sans rejeter la baseline", () => {
		const base = { ...referenceModel("base"), cost: { input: -1, output: 2, cacheRead: 0, cacheWrite: 0 } };
		const resolved = resolveModelAdditions(CODEX, [base], additionsOf([{ id: "ajout", extends: "base" }]));

		expect(resolved.models).toEqual([]);
		expect(resolved.diagnostics[0]?.reason).toContain("cost.input");
		expect(
			withModelAdditions(fakeProvider([base]), CODEX, additionsOf([{ id: "ajout", extends: "base" }])).getModels(),
		).toEqual([base]);
	});

	it("ne publie pas un ajout invalide comme source d'heritage", () => {
		const resolved = resolveModelAdditions(
			CODEX,
			[referenceModel("base")],
			additionsOf([
				{ id: "invalide", extends: "base", contextWindow: -1 },
				{ id: "enfant", extends: "invalide", contextWindow: 100 },
				{ id: "valide", extends: "base" },
			]),
		);

		expect(resolved.models.map((model) => model.id)).toEqual(["valide"]);
		expect(resolved.diagnostics.map((diagnostic) => diagnostic.id)).toEqual(["invalide", "enfant"]);
	});

	it("un override invalide ne remplace ni la baseline ni la source d'un heritage suivant", () => {
		const base = referenceModel("base");
		Object.freeze(base.cost);
		Object.freeze(base.input);
		Object.freeze(base);
		const catalog = Object.freeze([base, referenceModel("autre")]);
		const entries = Object.freeze([
			Object.freeze({ id: "base", extends: "base", maxTokens: 0 }),
			Object.freeze({ id: "enfant", extends: "base", thinkingLevelMap: Object.freeze({ off: null, high: "high" }) }),
			Object.freeze({ id: "autre", extends: "autre", name: "Nom corrige" }),
		]);
		const snapshot = structuredClone({ catalog, entries });
		const resolved = resolveModelAdditions(CODEX, catalog, additionsOf(entries));
		const models = withModelAdditions(fakeProvider(catalog), CODEX, additionsOf(entries)).getModels();

		expect(resolved.diagnostics).toEqual([
			{ id: "base", providerId: CODEX, reason: "maxTokens doit etre un nombre fini strictement positif" },
		]);
		expect(models.map((model) => model.id)).toEqual(["base", "autre", "enfant"]);
		expect(models[0]).toBe(base);
		expect(models[1]?.name).toBe("Nom corrige");
		expect(models[2]?.maxTokens).toBe(base.maxTokens);
		expect(models[2]?.thinkingLevelMap?.off).toBeNull();
		expect({ catalog, entries }).toEqual(snapshot);
	});
});

describe("withModelAdditions", () => {
	it("retourne le fournisseur inchange sans ajout configure", () => {
		const provider = fakeProvider([referenceModel("gpt-6-sol")]);
		expect(withModelAdditions(provider, CODEX, {})).toBe(provider);
	});

	it("ajoute le modele a la fin du catalogue", () => {
		const provider = fakeProvider([referenceModel("gpt-6-sol")]);
		const wrapped = withModelAdditions(
			provider,
			CODEX,
			additionsOf([{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", extends: "gpt-6-sol" }]),
		);

		expect(wrapped.getModels().map((model) => model.id)).toEqual(["gpt-6-sol", "gpt-6.1-sol"]);
	});

	it("remplace une entree de catalogue de meme identifiant, sans la dupliquer", () => {
		const provider = fakeProvider([referenceModel("gpt-6-sol")]);
		const wrapped = withModelAdditions(
			provider,
			CODEX,
			additionsOf([{ id: "gpt-6-sol", name: "Nom corrige", extends: "gpt-6-sol", maxTokens: 256_000 }]),
		);

		const models = wrapped.getModels();
		expect(models).toHaveLength(1);
		expect(models[0]?.name).toBe("Nom corrige");
		expect(models[0]?.maxTokens).toBe(256_000);
	});

	it("laisse le catalogue d'origine intact", () => {
		const original = [referenceModel("gpt-6-sol")];
		const provider = fakeProvider(original);
		const wrapped = withModelAdditions(provider, CODEX, additionsOf([{ id: "gpt-6.1-sol", extends: "gpt-6-sol" }]));

		wrapped.getModels();
		expect(original).toHaveLength(1);
		expect(provider.getModels()).toHaveLength(1);
	});

	it("n'ajoute rien quand toutes les entrees sont ecartees", () => {
		const provider = fakeProvider([referenceModel("gpt-6-sol")]);
		const wrapped = withModelAdditions(provider, CODEX, additionsOf([{ id: "x", extends: "inconnu" }]));

		expect(wrapped.getModels().map((model) => model.id)).toEqual(["gpt-6-sol"]);
	});
});

/**
 * Cablage reel : ces tests passent par les fabriques que le plugin utilise
 * vraiment, avec le vrai catalogue pi-ai et la vraie table MODEL_ADDITIONS.
 * Ils echouent si le cablage dans oauth-providers.ts saute.
 */
describe("cablage dans les fournisseurs OAuth", () => {
	function withTemporaryAdditions(providerId: string, entries: readonly ModelAddition[], run: () => void): void {
		const previous: readonly ModelAddition[] = MODEL_ADDITIONS[providerId] ?? [];
		MODEL_ADDITIONS[providerId] = entries;
		try {
			run();
		} finally {
			MODEL_ADDITIONS[providerId] = previous;
		}
	}

	it("sans ajout configure, le catalogue Codex reste exactement celui de pi-ai", () => {
		withTemporaryAdditions(CODEX, [], () => {
			const models = CODEX_OAUTH_PROVIDER.providerFactory().getModels();
			const ids = models.map((model) => model.id);
			expect(ids.length).toBeGreaterThan(0);
			expect(ids).toContain("gpt-6-sol");
			expect(ids).not.toContain("gpt-6.1-sol");
		});
	});

	it("un ajout Codex herite apparait dans le catalogue du fournisseur reel", () => {
		withTemporaryAdditions(CODEX, [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", extends: "gpt-6-sol" }], () => {
			const models = CODEX_OAUTH_PROVIDER.providerFactory().getModels();
			const ids = models.map((model) => model.id);
			expect(ids).toContain("gpt-6-sol");
			expect(ids).toContain("gpt-6.1-sol");

			const added = models.find((model) => model.id === "gpt-6.1-sol");
			const base = models.find((model) => model.id === "gpt-6-sol");
			expect(added?.name).toBe("GPT-6.1 Sol");
			// L'heritage a bien recopie les metadonnees du modele de reference.
			expect(added?.contextWindow).toBe(base?.contextWindow);
			expect(added?.api).toBe(base?.api);
			expect(added?.provider).toBe(base?.provider);
		});
	});

	it("un ajout Claude herite apparait dans le catalogue du fournisseur reel", () => {
		withTemporaryAdditions(
			MODEL_ADDITION_PROVIDERS.claude,
			[{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", extends: "claude-sonnet-5" }],
			() => {
				const models = CLAUDE_CODE_OAUTH_PROVIDER.providerFactory().getModels();
				const ids = models.map((model) => model.id);
				expect(ids).toContain("claude-sonnet-5");
				expect(ids).toContain("claude-sonnet-5-5");
			},
		);
	});

	it("restaure la table apres chaque test", () => {
		const codex = MODEL_ADDITIONS[CODEX] ?? [];
		const claude = MODEL_ADDITIONS[MODEL_ADDITION_PROVIDERS.claude] ?? [];
		expect(codex.map((entry) => entry.id)).toEqual(["gpt-6.1-sol"]);
		expect(claude.map((entry) => entry.id)).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
	});
});

/**
 * Les entrees livrees. Elles doivent rester resolvables contre le vrai
 * catalogue : si pi-ai renomme ou retire un modele de reference, ces tests
 * echouent et signalent qu'une entree est devenue orpheline.
 */
describe("entrees livrees", () => {
	it("gpt-6.1-sol herite de gpt-6-sol et survit au catalogue reel", () => {
		const models = CODEX_OAUTH_PROVIDER.providerFactory().getModels();
		const added = models.find((model) => model.id === "gpt-6.1-sol");
		const base = models.find((model) => model.id === "gpt-6-sol");

		expect(base).toBeDefined();
		expect(added).toBeDefined();
		expect(added?.name).toBe("GPT-6.1 Sol");
		expect(added?.api).toBe("openai-codex-responses");
		expect(added?.provider).toBe(MODEL_ADDITION_PROVIDERS.codex);
		expect(added?.input).toEqual(["text", "image"]);
		expect(added?.maxTokens).toBe(128_000);

		// La fenetre est volontairement celle que le backend Codex annonce.
		expect(added?.contextWindow).toBe(272_000);

		// « none » n'est pas supporte par ce slug : off doit valoir null.
		const levels = added?.thinkingLevelMap as Record<string, unknown> | undefined;
		expect(levels?.off).toBeNull();
		expect(levels?.xhigh).toBe("xhigh");
		expect(levels?.max).toBe("max");
	});

	it("claude-sonnet-5-5 herite de claude-sonnet-5 avec 1M de contexte", () => {
		const models = CLAUDE_CODE_OAUTH_PROVIDER.providerFactory().getModels();
		const added = models.find((model) => model.id === "claude-sonnet-5-5");

		expect(added).toBeDefined();
		expect(added?.name).toBe("Claude Sonnet 5.5");
		expect(added?.api).toBe("anthropic-messages");
		expect(added?.provider).toBe(MODEL_ADDITION_PROVIDERS.claude);
		expect(added?.input).toEqual(["text", "image"]);
		// Valeurs confirmees par la fiche modele officielle.
		expect(added?.contextWindow).toBe(1_000_000);
		expect(added?.maxTokens).toBe(128_000);

		const levels = added?.thinkingLevelMap as Record<string, unknown> | undefined;
		expect(levels?.off).toBeNull();
		expect(levels?.low).toBe("low");
		expect(levels?.medium).toBe("medium");
		expect(levels?.high).toBe("high");
		expect(levels?.xhigh).toBe("xhigh");
		expect(levels?.max).toBe("max");
	});

	it("aucune entree livree n'est ecartee", () => {
		const catalogs: Readonly<Record<string, readonly Model<Api>[]>> = {
			[CODEX]: openaiCodexProvider().getModels(),
			[MODEL_ADDITION_PROVIDERS.claude]: anthropicProvider().getModels(),
			[MODEL_ADDITION_PROVIDERS.kimi]: kimiCodingProvider().getModels(),
		};

		for (const providerId of Object.keys(MODEL_ADDITIONS)) {
			const catalog = catalogs[providerId];
			expect(catalog, `catalogue brut de ${providerId}`).toBeDefined();
			const { models, diagnostics } = resolveModelAdditions(providerId, catalog!);
			expect(diagnostics).toEqual([]);
			expect(models.map((model) => model.id)).toEqual(MODEL_ADDITIONS[providerId]?.map((entry) => entry.id));
		}
	});
});

import type { Api, Model, Provider } from "@earendil-works/pi-ai";
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
		const codexCatalog = CODEX_OAUTH_PROVIDER.providerFactory().getModels();
		const claudeCatalog = CLAUDE_CODE_OAUTH_PROVIDER.providerFactory().getModels();

		for (const [providerId, catalog] of [
			[CODEX, codexCatalog],
			[MODEL_ADDITION_PROVIDERS.claude, claudeCatalog],
		] as const) {
			const { models, diagnostics } = resolveModelAdditions(providerId, catalog);
			expect(diagnostics).toEqual([]);
			expect(models).toHaveLength(MODEL_ADDITIONS[providerId]?.length ?? 0);
		}
	});
});

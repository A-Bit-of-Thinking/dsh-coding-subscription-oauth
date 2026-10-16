/** A registrar behaving like dsh-llm: provider names are snapshotted at registration and at `replace` only. */
import type { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { vi } from "vitest";

export function createHostLikeRegistrar(initial: Readonly<Record<string, LlmAdapter>> = {}) {
	const registered = new Map<string, LlmAdapter>(Object.entries(initial));
	/** route -> provider.name as the host would list it (never re-read by itself). */
	const hostNames = new Map<string, string>();
	/** route -> the `replace` spy of the registration owning it. */
	const replaces = new Map<string, ReturnType<typeof vi.fn<(routes: string[]) => void>>>();
	const register = vi.fn((routes: string[], adapter: LlmAdapter) => {
		let owned: string[] = [];
		const publish = (next: string[]): void => {
			// Validate first (like dsh-llm): providerInfo may throw, leaving the current routes untouched.
			const names = next.map((route) => [route, adapter.providerInfo(route).name] as const);
			for (const route of owned) {
				if (registered.get(route) === adapter) registered.delete(route);
				hostNames.delete(route);
			}
			owned = [...next];
			for (const [route, name] of names) {
				registered.set(route, adapter);
				hostNames.set(route, name);
			}
		};
		publish(routes);
		const replace = vi.fn((next: string[]) => publish(next));
		for (const route of routes) replaces.set(route, replace);
		return Object.assign(() => publish([]), { replace });
	});
	return { register, registered, hostNames, replaces };
}

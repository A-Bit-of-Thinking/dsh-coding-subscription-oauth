/** Registers the quota button on the host composer dock (slot `conversation.composer.dock`, list, per session). */

import { QuotaDock } from "./components/QuotaDock.tsx";
import type { SlotsApi } from "./dshClientAdapter.ts";
import type { GrokBuildSettingsInjected } from "./types.ts";

export const QUOTA_DOCK_SLOT = "conversation.composer.dock";

/**
 * Same mechanism as the other slots. A host without this slot (or with a different contract) must not
 * break the plugin: any failure is swallowed and the dock is simply absent.
 */
export function registerQuotaDock(slots: SlotsApi, t: GrokBuildSettingsInjected["t"]): () => void {
	try {
		return slots.inject(QUOTA_DOCK_SLOT, () => {
			try {
				return slots.register(
					{
						name: QUOTA_DOCK_SLOT,
						id: "coding-oauth-quotas",
						order: 50,
						locale: "settings.grok-build",
						inject: (): GrokBuildSettingsInjected => ({ t }),
					},
					QuotaDock,
				);
			} catch {
				return undefined;
			}
		});
	} catch {
		return () => undefined;
	}
}

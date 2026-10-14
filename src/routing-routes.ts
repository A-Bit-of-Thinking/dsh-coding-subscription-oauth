/** Owner-only, secret-free status and explicit quota refresh for fixed account routes. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AccountRoutingRuntime } from "./account-runtime.ts";
import type { CapabilityRouteContext } from "./capability-routes.ts";
import { readJsonRequest, requestErrorStatus } from "./http-json.ts";
import { CODING_OAUTH_API_BASE } from "./ids.ts";
import type { RoutingConfig } from "./routing-config.ts";
import { routingPolicySnapshot } from "./routing-guidance.ts";
import { type RoutingSettingsController, RoutingSettingsError } from "./routing-settings.ts";
import { LOOPBACK_OWNER_REQUEST_POLICY, type OwnerRequestPolicy } from "./web-origin.ts";
import { registerWebRouteSetupAtomically } from "./web-routes.ts";

export const ROUTING_STATUS_PATH = `${CODING_OAUTH_API_BASE}/routing`;
export const ROUTING_USAGE_PATH = `${CODING_OAUTH_API_BASE}/routing/usage`;
export const ROUTING_SETTINGS_PATH = `${CODING_OAUTH_API_BASE}/routing/settings`;

export interface RoutingRouteOptions {
	readonly current: () => RoutingConfig;
	readonly accounts: AccountRoutingRuntime;
	readonly settings: RoutingSettingsController;
	readonly ownerRequestPolicy?: OwnerRequestPolicy;
}

/** Status for display: flags, policy validity only (never the policy text), routes and quotas. */
export function publicRoutingStatus(options: Pick<RoutingRouteOptions, "current" | "accounts">) {
	const config = options.current();
	return {
		flags: {
			enabled: config.enabled,
			usageEnabled: config.usageEnabled,
			guidanceEnabled: config.guidanceEnabled,
			enforcePolicy: config.enforcePolicy,
		},
		policy: { state: routingPolicySnapshot(config).state },
		...options.accounts.snapshot(),
	};
}

function json(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	res.end(JSON.stringify(value));
}

async function handle(req: IncomingMessage, res: ServerResponse, options: RoutingRouteOptions, refresh: boolean) {
	const policy = options.ownerRequestPolicy ?? LOOPBACK_OWNER_REQUEST_POLICY;
	if (req.method !== (refresh ? "POST" : "GET")) return json(res, 405, { error: "method not allowed" });
	if (!policy.authorize(req).authorized) return json(res, 403, { error: "forbidden" });
	try {
		if (refresh) {
			if (!options.current().usageEnabled) return json(res, 404, { error: "disabled" });
			const body: unknown = await readJsonRequest(req);
			const requested =
				typeof body === "object" && body !== null && !Array.isArray(body)
					? (body as { route?: unknown }).route
					: undefined;
			// A present but malformed route is a client error, never "refresh every account".
			if (requested !== undefined && (typeof requested !== "string" || requested.length > 200)) {
				return json(res, 400, { error: "invalid route" });
			}
			await options.accounts.refreshUsage(requested);
		}
		json(res, 200, publicRoutingStatus(options));
	} catch (error) {
		const status = requestErrorStatus(error, 0);
		json(res, status === 0 ? 400 : status, { error: "request failed" });
	}
}

/** Owner-only read/write of the routing options. Unlike the status route, this returns the owner's own policy text. */
async function handleSettings(req: IncomingMessage, res: ServerResponse, options: RoutingRouteOptions) {
	const policy = options.ownerRequestPolicy ?? LOOPBACK_OWNER_REQUEST_POLICY;
	if (req.method !== "GET" && req.method !== "PATCH") return json(res, 405, { error: "method not allowed" });
	if (!policy.authorize(req).authorized) return json(res, 403, { error: "forbidden" });
	try {
		if (req.method === "GET") return json(res, 200, options.settings.snapshot());
		const body: unknown = await readJsonRequest(req);
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return json(res, 400, { error: "invalid request" });
		}
		const { expectedRevision, patch } = body as { expectedRevision?: unknown; patch?: unknown };
		if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision)) {
			return json(res, 400, { error: "invalid request" });
		}
		return json(res, 200, await options.settings.patch(patch, expectedRevision));
	} catch (error) {
		if (error instanceof RoutingSettingsError) return json(res, error.status, { error: error.code, code: error.code });
		const status = requestErrorStatus(error, 0);
		json(res, status === 0 ? 500 : status, { error: "request failed" });
	}
}
export function registerRoutingRoutes(ctx: CapabilityRouteContext, options: RoutingRouteOptions): void {
	ctx.effect(
		() =>
			registerWebRouteSetupAtomically(ctx.webServer, (webServer) => {
				webServer.register({
					kind: "exact",
					path: ROUTING_STATUS_PATH,
					handler: (req, res) => handle(req, res, options, false),
				});
				webServer.register({
					kind: "exact",
					path: ROUTING_SETTINGS_PATH,
					handler: (req, res) => handleSettings(req, res, options),
				});
				webServer.register({
					kind: "exact",
					path: ROUTING_USAGE_PATH,
					handler: (req, res) => handle(req, res, options, true),
				});
			}),
		"coding-oauth: account routing status routes",
	);
}

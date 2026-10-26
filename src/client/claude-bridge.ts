/** Top-level navigation avoids cross-origin requests to the user's local helper. */
export const CLAUDE_BRIDGE_ORIGIN = "http://127.0.0.1:53700";

export function claudeBridgeLaunchUrl(authUrl: string, remoteOrigin: string): string {
	const challenge = new URL(authUrl);
	if (
		challenge.origin !== "https://claude.ai" ||
		challenge.pathname !== "/oauth/authorize" ||
		challenge.searchParams.get("redirect_uri") !== "http://localhost:53692/callback" ||
		challenge.searchParams.get("state") === null
	) {
		throw new Error("The local bridge requires a Claude browser authorization challenge.");
	}
	const url = new URL("/start", CLAUDE_BRIDGE_ORIGIN);
	url.hash = new URLSearchParams({ authUrl: challenge.href, remoteOrigin: new URL(remoteOrigin).origin }).toString();
	return url.href;
}

/** Preserve only the DSH origin when HTTPS navigates to the loopback helper. */
export function navigateClaudeBridge(popup: Window, popupName: string, destination: string): void {
	const link = document.createElement("a");
	link.href = destination;
	link.target = popupName;
	link.referrerPolicy = "origin";
	link.hidden = true;
	document.body.append(link);
	try {
		link.click();
	} finally {
		link.remove();
		popup.opener = null;
	}
}

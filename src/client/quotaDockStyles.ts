/**
 * Scoped styles for the composer quota dock. Every selector is prefixed `dsh-coding-oauth-quota-*`.
 * Rules mirror the host's ContextMeter trigger/panel and use only host theme variables (light + dark).
 */

const STYLE_ID = "dsh-coding-oauth-quota-dock-styles";

export const QUOTA_DOCK_CSS = `
.dsh-coding-oauth-quota-trigger {
  display: inline-flex; flex: none; align-items: center; gap: 6px; padding: 1px 8px;
  border: none; border-radius: var(--dsw-radius-sm); background: transparent;
  color: var(--dsw-alias-label-tertiary); font-family: inherit;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  font-variant-numeric: tabular-nums; white-space: nowrap; cursor: pointer;
}
.dsh-coding-oauth-quota-trigger:hover,
.dsh-coding-oauth-quota-trigger[aria-expanded="true"] {
  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary);
}
.dsh-coding-oauth-quota-trigger:focus-visible,
.dsh-coding-oauth-quota-panel button:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px;
}
.dsh-coding-oauth-quota-trigger[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.dsh-coding-oauth-quota-trigger[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.dsh-coding-oauth-quota-trigger[data-stale="true"] { opacity: 0.65; font-style: italic; }
.dsh-coding-oauth-quota-panel {
  position: fixed; z-index: 1100; box-sizing: border-box; width: min(320px, 100vw - 16px);
  max-height: min(70vh, 560px); overflow: auto; padding: 12px; border: 0;
  border-radius: var(--dsw-radius-lg); background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent); color: var(--dsw-alias-label-secondary);
  font-size: 12px; line-height: 20px; cursor: default;
}
.dsh-coding-oauth-quota-panel[data-minimized="true"] { overflow: hidden; }
.dsh-coding-oauth-quota-header { display: flex; align-items: center; gap: 6px; }
.dsh-coding-oauth-quota-title {
  margin: 0; flex: 1 1 auto; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500;
}
.dsh-coding-oauth-quota-icon {
  display: inline-grid; place-items: center; width: 24px; height: 24px; padding: 0; border: none;
  border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: 14px; line-height: 1; cursor: pointer;
}
.dsh-coding-oauth-quota-icon:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-coding-oauth-quota-body { display: flex; flex-direction: column; gap: 12px; margin-top: 10px; }
.dsh-coding-oauth-quota-account { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.dsh-coding-oauth-quota-list { display: flex; flex-direction: column; gap: 12px; margin: 0; padding: 0; list-style: none; }
.dsh-coding-oauth-quota-name { color: var(--dsw-alias-label-primary); font-weight: 500; overflow-wrap: anywhere; }
.dsh-coding-oauth-quota-default { margin-left: 4px; color: var(--dsw-alias-label-tertiary); font-weight: 400; }
.dsh-coding-oauth-quota-message { margin: 0; color: var(--dsw-alias-label-secondary); }
.dsh-coding-oauth-quota-message[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.dsh-coding-oauth-quota-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-coding-oauth-quota-button {
  min-height: 26px; padding: 2px 10px; border: 1px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; cursor: pointer;
}
.dsh-coding-oauth-quota-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-coding-oauth-quota-button:disabled { opacity: 0.6; cursor: default; }
@media (prefers-reduced-motion: reduce) {
  .dsh-coding-oauth-quota-panel, .dsh-coding-oauth-quota-panel * { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
`;

let injected = false;

export function ensureQuotaDockStyles(): void {
	if (injected || typeof document === "undefined") return;
	if (document.getElementById(STYLE_ID) === null) {
		const style = document.createElement("style");
		style.id = STYLE_ID;
		style.textContent = QUOTA_DOCK_CSS;
		document.head.appendChild(style);
	}
	injected = true;
}

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
.dsh-coding-oauth-quota-panel button:focus-visible,
.dsh-coding-oauth-quota-header:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px;
}
.dsh-coding-oauth-quota-accounts { display: grid; gap: 10px; }
.dsh-coding-oauth-quota-account {
  min-width: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-interactive-bg-hover); padding: 13px;
}
.dsh-coding-oauth-quota-account-toggle {
  display: flex; align-items: center; gap: 5px; width: 100%; padding: 0; border: 0;
  background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-weight: 500;
  text-align: left; cursor: pointer; font-size: 14px;
}
.dsh-coding-oauth-quota-chevron { flex: none; transition: transform 0.15s ease; }
.dsh-coding-oauth-quota-account-toggle[aria-expanded="true"] .dsh-coding-oauth-quota-chevron { transform: rotate(90deg); }
.dsh-coding-oauth-quota-account > div:not([hidden]) { margin-top: 12px; }
.dsh-coding-oauth-quota-panel {
  position: fixed; z-index: 1100; box-sizing: border-box; width: min(360px, 100vw - 16px);
  display: flex; flex-direction: column;
  height: min(80vh, 560px); overflow: visible; padding: 12px; border: 0;
  border-radius: var(--dsw-radius-lg); background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent); color: var(--dsw-alias-label-secondary);
  font-size: 13px; line-height: 20px; cursor: default;
}
.dsh-coding-oauth-quota-panel[data-minimized="true"] { overflow: hidden; }
.dsh-coding-oauth-quota-header { display: flex; flex: none; align-items: center; gap: 6px; touch-action: none; cursor: grab; user-select: none; }
.dsh-coding-oauth-quota-panel[data-dragging="true"] { user-select: none; }
.dsh-coding-oauth-quota-panel[data-dragging="true"] .dsh-coding-oauth-quota-header { cursor: grabbing; }
.dsh-coding-oauth-quota-title {
  margin: 0; flex: 1 1 auto; color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 500;
}
.dsh-coding-oauth-quota-icon {
  display: inline-grid; place-items: center; width: 24px; height: 24px; padding: 0; border: none;
  border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: 14px; line-height: 1; cursor: pointer;
}
.dsh-coding-oauth-quota-icon:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-coding-oauth-quota-body { display: flex; flex-direction: column; gap: 14px; margin-top: 12px; min-height: 0; overflow-y: auto; flex: 1 1 auto; }
.dsh-coding-oauth-quota-name { color: var(--dsw-alias-label-primary); font-weight: 500; overflow-wrap: anywhere; }
.dsh-coding-oauth-quota-default { margin-left: 4px; color: var(--dsw-alias-label-tertiary); font-weight: 400; }
.dsh-coding-oauth-quota-message { margin: 0; color: var(--dsw-alias-label-secondary); }
.dsh-coding-oauth-quota-message[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.dsh-coding-oauth-quota-actions { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-coding-oauth-quota-actions > button { flex: none; }
.dsh-coding-oauth-quota-schedule { min-width: 0; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-coding-oauth-quota-body[hidden] { display: none; }
.dsh-coding-oauth-quota-button {
  min-height: 26px; padding: 2px 10px; border: 1px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; cursor: pointer;
}
.dsh-coding-oauth-quota-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-coding-oauth-quota-button:disabled { opacity: 0.6; cursor: default; }
.dsh-coding-oauth-quota-resize { position: absolute; touch-action: none; z-index: 2; }
.dsh-coding-oauth-quota-resize[data-edge="n"], .dsh-coding-oauth-quota-resize[data-edge="s"] { left: 8px; right: 8px; height: 8px; cursor: ns-resize; }
.dsh-coding-oauth-quota-resize[data-edge="n"] { top: 0; }
.dsh-coding-oauth-quota-resize[data-edge="s"] { bottom: 0; }
.dsh-coding-oauth-quota-resize[data-edge="e"], .dsh-coding-oauth-quota-resize[data-edge="w"] { top: 8px; bottom: 8px; width: 8px; cursor: ew-resize; }
.dsh-coding-oauth-quota-resize[data-edge="e"] { right: 0; }
.dsh-coding-oauth-quota-resize[data-edge="w"] { left: 0; }
.dsh-coding-oauth-quota-resize[data-edge="ne"], .dsh-coding-oauth-quota-resize[data-edge="nw"], .dsh-coding-oauth-quota-resize[data-edge="se"], .dsh-coding-oauth-quota-resize[data-edge="sw"] { width: 8px; height: 8px; }
.dsh-coding-oauth-quota-resize[data-edge="ne"] { right: 0; top: 0; cursor: nesw-resize; }
.dsh-coding-oauth-quota-resize[data-edge="nw"] { left: 0; top: 0; cursor: nwse-resize; }
.dsh-coding-oauth-quota-resize[data-edge="se"] { right: 0; bottom: 0; cursor: nwse-resize; }
.dsh-coding-oauth-quota-resize[data-edge="sw"] { left: 0; bottom: 0; cursor: nesw-resize; }
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

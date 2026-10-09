# dsh-coding-subscription-oauth

Coding subscriptions in [DeepSeek Harness](https://github.com/deepseek-ai/dsh): OAuth accounts, model selection, optional capabilities and a local gateway.

**This is a community fork, not the upstream npm release.** It targets the exact **DSH 0.2.0-rc.2** runtime. The package name and version remain `dsh-coding-subscription-oauth@0.8.5` for replacement compatibility; use the repository/commit to identify this build.

[Français](README.fr.md) · [Installation](INSTALL.md) · [Maintenance](HANDOFF.md) · [Changelog](CHANGELOG.md)

## What this fork changes

- Rebased host/client dependencies and adapter contracts onto DSH 0.2.0-rc.2 (`cordis` 4.0.4, `schemastery` 3.18.4, `pi-ai` 0.87.1).
- Reviewed additions include **GPT-6.1 Sol, Claude Sonnet 5.5 and Claude Haiku 5.5**, in [`src/model-additions.ts`](src/model-additions.ts), without waiting for a pi-ai release. Haiku uses adaptive thinking; API cost estimates use its conservative long-context tier. This is **not automatic model discovery**.
- Connected accounts appear first, preserving the existing compact card design. OpenCode Go starts collapsed rather than occupying the first screen with its connection form.
- Capability settings use the modern host configuration surface while retaining the legacy controller contract for older integrations.

Availability is still decided by the provider and your plan: listing a model is not proof that an account can use it.

## Providers

| Service | DSH route | Authentication |
| --- | --- | --- |
| Grok Build | `grok-build` | Subscription OAuth |
| Codex | `codex-oauth` | ChatGPT subscription OAuth |
| Claude Code | `claude-code-oauth` | Claude subscription OAuth |
| Kimi Code | `kimi-code-oauth` | Kimi subscription OAuth |
| OpenCode Go | `coding-opencode-go` | Separate DSH credential reference |

`codex-oauth-fast` is optional and appears only when a fresh account catalog explicitly permits priority processing. Google Antigravity requires the **separate** `dsh-agy` plugin; this fork's BOM does not certify that plugin's compatibility. Its “Not installed” status means the `agy` adapter is not visible (including inactive adapters or listing failures), not that a Google login is missing.

## Install the fork, not the original package

Requires **DSH 0.2.0-rc.2** and Node **^22.19.0 or >=24**. Other DSH releases need their own compatibility check.

For the **desktop app**, use its plugin manager, with this repository/local checkout as the source if the manager supports it. The desktop profile is managed by Electron: do not use CLI commands to modify it or edit its dependencies while the app is running. See [INSTALL.md](INSTALL.md) for the package-manager limitation and fallback.

For a separately managed **web profile**, after reviewing the built checkout:

```bash
# Run from this repository, after building lib/.
dsh plugin --profile web add .
```

Git-source installation, where supported by the host's package manager:

```bash
dsh plugin --profile web add github:A-Bit-of-Thinking/dsh-coding-subscription-oauth
```

**`dsh plugin add dsh-coding-subscription-oauth@0.8.5` from npm installs the original release, not this fork.** npm 12 can refuse Git dependencies (`EALLOWGIT`); do not disable this protection globally. Use a built local source or a host installer supporting pnpm, and verify what was actually installed. There is no fork-specific npm release or installer shipped here.

After installation, restart the **existing** application/process yourself. Then open **Settings → Coding OAuth / Accounts & Models** and sign in. OAuth credentials and route IDs are retained; the plugin does not choose your default model.

## Accounts and models

- Compact summaries first; expand a card to manage models, accounts or advanced capabilities.
- Connected services are sorted before disconnected ones, with stable order within each group.
- Model checkboxes form a draft: **Apply** saves the selection, including an explicitly empty selection.
- Official CLI credential discovery is read-only. **Pull** is an explicit one-way copy with preview, conflict checks and overwrite confirmation. Official CLI files are never edited.
- Grok has a live model catalog. Codex/Claude/Kimi primarily use pi-ai plus reviewed additions; new IDs are not automatically imported.
- Grok's validated discovery metadata is scoped to a local account slot. Switching/importing credentials discards discoveries, not model choices; signing out still resets selection to defaults. Legacy v1–v3 caches restore choices only, without being rewritten on read. Discovery time is not a TTL. Above the cache budget, choices are saved without discovery metadata; the live catalog remains in memory and is fetched again after restart.
- A credential's local presence does not guarantee upstream acceptance; expired/revoked authorization may require reconnection.

## Optional capabilities

Everything below is **off by default** and applies live when enabled:

| Capability | Requirement / limitation |
| --- | --- |
| Codex search | Signed-in Codex; private endpoint; select `codex-oauth-search` in the host web service |
| Codex usage/quota | Signed-in Codex; provider response can change |
| Codex image generation/editing | Signed-in Codex; edits restricted to attachments owned by the current session |
| Images from non-Codex model routes | Explicit extra opt-in; same Codex/session/ownership checks |
| Codex Fast | Fresh catalog with `priority` eligibility; no latency guarantee |
| Grok Imagine images/video | **Separate `XAI_API_KEY`**, not Grok OAuth; API billing may apply |

Limits: 1–20 search results, 1–4 images, video retention 1 hour–7 days. Private Codex endpoints are not a supported public API: enabling a switch does not guarantee provider availability. Capability writes use revision checks; concurrent changes cause a conflict and reload rather than a silent overwrite.

## OpenCode Go and the gateway

Go can be used inside DSH without enabling the gateway. It uses the isolated provider `coding-opencode-go`, not the DSH-native `opencode-go` slot. Configure a credential reference and select compatible models/protocols in its Accounts card.

The local gateway is a **separate, default-off** server. It supports `/v1/chat/completions`, `/v1/responses` and `/v1/messages`. External Go clients use `coding-opencode-go/<model-id>` with a stable session identifier and the matching protocol. The gateway's local Bearer key is **not** the upstream Go credential. Review migration prompts before changing legacy configuration.

Never expose DSH or the gateway as an unauthenticated public relay. Key reveal/rotation remain loopback-only; remote Settings must use an SSH tunnel or the strict owner-authenticated proxy policy described in [INSTALL.md](INSTALL.md).

## Privacy and safety

- OAuth tokens stay in local credential stores, not chat or public status responses. Do not publish credentials, logs, account identifiers, real screenshots or machine-specific paths.
- Owner-only file modes, atomic writes and file locks are used; on Windows, POSIX mode bits alone are **not** a complete ACL guarantee.
- Private investigations belong in Git-ignored `docs/local/`; they are not shipped in the package.
- Use only accounts/endpoints you own or are authorized to use. Subscription access through a third-party client may conflict with provider terms or trigger account restrictions. No quota resale, shared public relay or access-control bypass is supported.

## Development

```bash
pnpm install --frozen-lockfile
pnpm run check:next
pnpm run check                 # rebuilds committed lib/ and runs tests
npm pack --dry-run --json --ignore-scripts
```

`src/` is the runtime source; `lib/` is generated and committed for Git installs. Never edit it manually. Tests must use an isolated DSH home, never a live user's profile. See [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) and [HANDOFF.md](HANDOFF.md).

The other language READMEs are retained as **historical upstream translations**, not current installation guides. English and [French](README.fr.md) are maintained for this fork. Older screenshots illustrate upstream layouts, not a verified screenshot of this build.

## Upstream and license

Derived from [lninghaha/dsh-coding-subscription-oauth](https://github.com/lninghaha/dsh-coding-subscription-oauth), with attribution retained. [Apache-2.0](LICENSE) · [NOTICE](NOTICE). Some components derive from [dsh-xai](https://github.com/MirDie/dsh-xai).

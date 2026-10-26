# Remote Claude sign-in with the local callback bridge

The default bridge receives Claude's localhost callback and automatically returns it to your configured DSH website. Your authenticated DSH webpage submits the callback through its existing login API. Remote DSH validates OAuth state and PKCE, exchanges credentials, and stores them. This mode needs Node.js on your browser's computer; it needs no SSH, Google Cloud login, or VM access.

## First-time setup

Use Node.js `^22.19.0 || >=24` and a package build containing `dsh-claude-bridge`. For an unpublished development build, verify the checkout, pack it, and install its tarball globally:

```bash
pnpm install --frozen-lockfile
pnpm run check
npm pack --ignore-scripts
npm install --global ./dsh-coding-subscription-oauth-VERSION.tgz
```

Replace `VERSION` with the version of the generated tarball. Use a stable package and Node installation if you will install the macOS background service.

Start a foreground helper with your exact DSH HTTPS origin:

```bash
dsh-claude-bridge run --origin https://example.com
```

Replace `https://example.com` with the website where you use DSH. The origin must have no path, query, credentials, or fragment. Other websites cannot start a login through this configured helper. Keep `run` active during sign-in; Ctrl+C or SIGTERM cancels pending startup/discovery and closes its own listeners.

## Start automatically on macOS

After verifying the foreground helper, stop it with Ctrl+C and install the background helper once:

```bash
dsh-claude-bridge install --origin https://example.com
```

This starts a per-user LaunchAgent immediately and again when you log in. Before reporting success, installation checks the local helper's service identity, protocol, and configured origin and transport fingerprint for up to five seconds. An unavailable or stale helper produces an error with uninstall/reinstall guidance; installation leaves existing processes and its owned file available for diagnosis. Helper readiness is separate from Claude credential exchange.

The file has mode `0600` and label `io.dsh.claude-callback-bridge`. It records absolute Node and CLI paths, connection arguments, and your executable `PATH`; it does not copy the rest of your environment or store account credentials.

Repeating an identical installation is safe. A conflicting file or configuration is preserved. If macOS already has the service label registered without this helper's owned LaunchAgent file, installation refuses before creating a file or starting that service; inspect the existing registration first. To change an owned installation, uninstall it and install the intended configuration. Do not overwrite an unrelated LaunchAgent. Starting the local helper does not require a DSH restart. On other systems, use the foreground `run` command.

## Upgrade the macOS background helper

Stop the owned background helper before upgrading the global package, then install it again with the intended options:

```bash
dsh-claude-bridge uninstall
npm install --global ./dsh-coding-subscription-oauth-VERSION.tgz
dsh-claude-bridge install --origin https://example.com
```

Replace `VERSION` with the reviewed package version and use your DSH origin. Include your SSH or GCP options again if you use forwarding. Updating package files alone does not reload an already running Node process. Uninstalling first releases the owned helper; installing afterward starts the new package and verifies its local readiness. Stop a separately started foreground helper with Ctrl+C before this sequence.

## Default sign-in flow

1. In remote DSH, choose the local bridge sign-in option. Confirmed browser reauthorization of an existing Claude account uses the same bridge and preserves the selected account target.
2. The browser navigates to `http://127.0.0.1:53700/start`. The helper checks the configured DSH origin and pending Claude challenge. This is a top-level navigation, not a cross-origin browser fetch.
3. The helper opens its localhost callback receiver at port `53692` before opening Claude.
4. Authorize with Claude. Its callback reaches the local receiver, which checks that it belongs to the pending attempt.
5. The helper returns your browser to the exact configured DSH origin with the callback in a URL fragment. The authenticated DSH page consumes the fragment and automatically submits the callback with its pending login-operation ID, without reading or copying your clipboard. DSH checks that operation before consuming the callback, so an old return cannot replace a newer authorization.
6. DSH completes credential exchange and storage. The return page reports success only when signed-in status includes the completion receipt for this same login attempt. Keep DSH Settings open to see the final account state.

The callback fragment stays in the browser and is not sent in the initial website HTTP request. DSH removes it after consuming it. The helper does not receive your DSH browser cookies or store Claude tokens.

A received callback or a browser return does not prove that credential exchange and storage succeeded. Automatic completion requires signed-in status with a matching operation receipt and no operation error; an older account that remains signed in after failure or cancellation is insufficient. The DSH server and client must both support these receipts. The return page observes the matching login for up to 60 seconds. It retries transient status-read failures before submission and revalidates the pending challenge. After a lost or ambiguous submission acknowledgement, including a 5xx response or manual submission winning the race, it continues observing the same attempt without submitting the callback again. If its first successful status read finds an already signed-in account without a pending challenge, it cannot correlate the callback and reports an unconfirmed result without submitting again. If confirmation takes longer, it also reports an unconfirmed result rather than an exchange failure; check the original DSH account status before starting another attempt. A pending helper attempt expires after five minutes; existing authenticated accounts are independent of a pending attempt.

## Optional SSH or Google Cloud forwarding

If you already have access to the machine running DSH, the helper can forward the callback directly to its native callback listener instead of returning it through the browser. Configure exactly one transport and the same machine that generated the DSH challenge.

For SSH, first connect interactively to your SSH alias, verify its identity, and configure key authentication. The helper does not accept new host keys or bypass host-key checks.

```bash
ssh dsh-example
dsh-claude-bridge run --origin https://example.com --ssh-host dsh-example
```

For Google Cloud IAP, install the Google Cloud CLI, authenticate it yourself, and verify access to the selected instance:

```bash
gcloud compute ssh example-vm --project example-project --zone us-central1-a --tunnel-through-iap
dsh-claude-bridge run --origin https://example.com --gcp-instance example-vm --gcp-project example-project --gcp-zone us-central1-a
```

If you do not know the instance name, use automatic discovery:

```bash
dsh-claude-bridge run --origin https://example.com --gcp-instance auto --gcp-project example-project
```

Discovery uses your already active `gcloud` account. It requires exactly one running instance in the configured project with label `workload=devbox` and `owner-email` metadata matching that account, and derives its name and zone without displaying the inventory. The helper does not switch accounts, authenticate, grant access, or change IAM. The same options work with `install`; discovery runs when the helper starts.

Forwarding readiness is bounded to 30 seconds. Native callback HTTP `200` means delivery, not successful credential exchange. DSH's final account status remains authoritative. Optional forwarding uses local port `53694` temporarily, in addition to the callback receiver and helper control listener.

## Failures and fallback

- **Local port occupied:** stop the other foreground bridge or callback helper and retry. This helper does not terminate unrelated processes. Its control listener uses port `53700`; an active Claude callback uses port `53692`.
- **Default browser return cannot complete:** remain signed in to the configured DSH website and retry a fresh attempt. Token exchange errors appear in DSH rather than being reported as a successful connection.
- **Optional SSH or IAP fails:** verify access interactively first, or reinstall the default origin-only mode. Google Cloud authentication and VM permissions are unnecessary for the default flow.
- **Expired or canceled attempt:** start a fresh login and use its own authorization page. The local callback receiver has a bounded lifetime.
- **Sign-out still completing:** wait for it to finish before starting another sign-in. A concurrent request receives a conflict and is not queued. If the plugin was disposed while a request was pending, reload DSH after the plugin is available before retrying.
- **Sign-in cancellation still completing:** wait for native cancellation to finish before retrying. DSH rejects a concurrent retry instead of returning the canceled authorization page.
- **Helper unavailable:** use the existing browser sign-in fallback. Copy the complete Claude callback address and paste it into DSH; DSH validates and submits it automatically.

## Remove the macOS background helper

```bash
dsh-claude-bridge uninstall
```

This unloads and removes only its owned LaunchAgent. Other LaunchAgents, SSH/GCP configuration, the DSH service, and provider credentials are preserved. Stop a separately started foreground `run` process with Ctrl+C.

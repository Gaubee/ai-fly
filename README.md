# ai-fly

Peer-to-peer network bridge with AI-ready presets, built on [OpenDWeb](https://github.com/jixoai/opendweb).

Share any HTTP/WebSocket upstream (ollama / vllm / LM Studio, an internal gateway, or a keyed third-party API) with friends over an invite-based fabric. Consumers get plain endpoints on `127.0.0.1` — point agents' base URLs (or any WS client) at them. No root certificates, no system-level interception, no proxy.

```
Consumer machine                         Provider machine
Agent ──► http://127.0.0.1:11434/…       ollama :11434 (or any HTTP/WS upstream)
       ──► ws://127.0.0.1:11434/…            ▲   provider engine
           consumer engine                   │   match set + lifecycle hooks (auth/headers)
               │  AUTH keyring / catalog     │   quotas (per key)
               └────── OpenDWeb fabric ──────┘   (identity / invites / QUIC + relay)
```

- **Two-layer credentials.** `dweb1.` invite tokens admit *devices* (fabric layer);
  `sk-aifly-` keys grant *group* access (app layer). Keys are device-independent —
  revoke a key to cut every holder, revoke a token to eject one device. Share links
  bundle one of each for first-time onboarding.
- **Groups & services.** Providers define services (upstream + rewrite + display
  domains), group them, and issue multiple keys per group. Same-named services in
  different groups stay distinct (routing is always by serviceId).
- **Streaming-first.** SSE relays chunk-by-chunk; WebSocket upgrades pass through as
  a bidirectional byte channel (OpenAI Responses API WS works).
- **Credentials never cross the wire** in either direction: provider keys live in
  `$env` indirection; consumer-side auth headers are stripped at the protocol layer.
- **Full-disclosure, minus secrets.** Consumers see each service's complete rule
  (upstream, rewrites, domains) on expand; injected credential values render as `●`.

**Status: M1 + M2 (engine + product).** The headless engine landed with the
`net-fly-core` change; `m2-productize` added the OpenTray desktop shell
(tray + window + one-time token UI), the Web UI (Dashboard / share wizard /
connect wizard / advanced), the AI preset library (curated providers +
models.dev long tail), and agent config writers (codex / claude-code /
cursor / cline / continue). Proxy mode is permanently out of scope (TLS makes
credential injection impossible without MITM).

```bash
# Provider
ai-fly serve   --upstream http://127.0.0.1:11434   # run + manage services/groups
ai-fly service stop ollama                         # pause exposure (catalog drops it, config kept)
ai-fly service start ollama                        # resume; consumers see it again
ai-fly key     issue --group friends                # sk-aifly-… keys
ai-fly share   --group friends --ttl 30m            # aifly1.… link (token + key)

# Consumer
ai-fly import  <link> --run                        # join + keyring + start gateway
ai-fly key     add <sk-aifly-…> --provider <id>    # bare key into an existing ring
ai-fly services                                     # list services across groups (state + ports)
ai-fly services stop <provider>                     # stop ALL of a provider's services (revivable)
ai-fly services stop <provider> <service>           # stop one service's local listener (live)
ai-fly services rm <provider>                       # remove the whole provider (= forget: keyring + fabric identity)
ai-fly services start <provider> [<service>]        # re-enable (per-service stops persist across ring stops)
ai-fly status  --verbose                            # ports, providers, service details
```

Service lifecycle: a stopped provider service disappears from the consumer catalog
(local listener closes, in-flight requests abort, requests get 404); a stopped
consumer service is "removed but revivable" — the provider's catalog sync still
updates the entry, it just never re-materializes a local port until you start it
back. The running gateway daemon picks these changes up live (keyring watch); the
dashboard's port table exposes the same start/stop/remove actions.

## Request lifecycle (hooks v2)

Every service runs a four-stage pipeline around the upstream call:

`onRequestBearerAuthentication (1) -> onRequestHeaders (2) -> onRequest (3) -> onResponse (4)`

- `service.auth` (stage 1) — Authorization header source: `{secret: <name>}`,
  `{script: <name>, args?}` or `{literal: <value>}` (literals accept `$env:<VAR>` /
  `$secret:<name>` indirection, resolved per request), plus `bearer: false` to drop
  the default `Bearer ` prefix.
- `service.headers` (stage 2) — `remove: [...]`, `set: {name: literal}` and an
  optional whole-stage `script: {name, args?}` returning `{set?, remove?}` (script
  output wins over the declared set).
- `service.request` (stage 3) — takes over the outbound call entirely; ctx is
  `{url, method, headers, body, signal}`, returns `{status, headers, body?}`.
- `service.response` (stage 4) — post-processes the response; ctx is
  `{status, headers, body, signal}`, returns `{status?, headers?, body?}`.

Hook scripts export one function per stage they implement — the export name is the
stage name. Builtin library: `codex` (reads `$CODEX_HOME/auth.json`, falling back to
`~/.codex/auth.json` — read-only, ai-fly never writes credential files; set
`CODEX_HOME` when your `~/.codex` holds a different Codex CLI config), plus `env` /
`file` / `secret` bridges for stage 1.
All stage fns receive `{homedir, args, secrets, env}`; stages 1-2 additionally get
the request-level `{method, path, headers}`. Returned streams (3/4 bodies) are
cancelled when the engine aborts the request.

```bash
# --secret -> auth = {secret: mykey}; --headers-script -> stage-2 whole-stage
# script; --request-script/--response-script -> stage 3/4 bindings
ai-fly service add myapi --upstream https://api.example.com --match suffix:api.example.com \
  --secret mykey \
  --header-set x-org=acme --header-remove x-internal \
  --headers-script hdrfix \
  --request-script mock-up --response-script log
ai-fly hooks list                                 # stage matrix per script
ai-fly hooks run codex --stage onRequestBearerAuthentication
```

**Breaking changes (hooks-lifecycle v2)**

- Old hook scripts must be rewritten, not just renamed: export names changed
  (`authHeader` -> `onRequestBearerAuthentication`, etc.) and the runtime contract
  is new — request-scoped ctx, 3/4 object return shapes, stream cancellation.
- v1 `services.json` (pre-`version: 2`) is invalid: the store enters a legacy
  read-only state (`ai-fly service list` and `status --verbose` show the stale
  names); remove them with `ai-fly service remove <name>`, then re-add services
  to rebuild a clean v2 store (groups and share keys are not carried over).
- The v1 string form `--hooks "<script>"` became an object slot in preset mode:
  `--hooks <name>` binds one whole-script lifecycle (see below), mutually
  exclusive with per-stage flags; `--secret` fills `auth.secret`; `--header-set`
  values accept literals and `$env:`/`$secret:` references only (per-header hook
  objects are gone — bind a stage script with `--headers-script` instead).

## Lifecycle binding modes & rust-fetch

Lifecycle config has two **mutually exclusive** modes (Owner ruling 2026-09-15):

- **custom** — pick per-stage scripts or inline config (auth secret/literal,
  header set/remove, …). The default.
- **preset** — bind one hook-js with `hooks: {script}` (CLI `--hooks <name>`);
  the script's stage exports form the whole lifecycle. Stages without an export
  fall back to defaults (stage 3 unbound = js-backend-fetch — the current JS
  runtime backend's fetch, Node/Deno/Bun alike).

The `codex` preset runs in preset mode: the built-in `codex` script provides the
complete lifecycle — ① auth token from `$CODEX_HOME/auth.json` (falling back to
`~/.codex/auth.json`, read-only), ② the codex CLI header set (`chatgpt-account-id`,
`originator`, `openai-beta`, user-agent), ③ outbound via the **rust-fetch** sidecar.
Launch e.g. `CODEX_HOME=~/.ai-fly/codex-home pnpm app:dev` to keep that credential
copy fully isolated from your own `~/.codex`.

`rust-fetch` (rustls TLS + HTTP/2, a client stack distinct from
js-backend-fetch) replaces the outbound HTTPS call — empirical A/B against
chatgpt.com: GET /rate_limits via js-backend-fetch → 403 (Cloudflare, 0/13
historically) vs rust-fetch → 404 (passes CF, reaches the backend); POST
/responses with a real subscription → 200 + SSE through the full pipeline.

Build & install the sidecar (not shipped in the repo) — **required before the
codex preset can serve**; without it every request fails with a masked
`hook_failed` (the daemon logs a one-line install hint to its stderr):

```bash
pnpm sidecar:install   # cargo build --release + copy to ~/.aifly/sidecars/rust-fetch/
# or point AIFLY_RUST_FETCH_BIN at the binary when starting the daemon
```

Bind it per service (custom mode, stage 3 only) with `--request-script
rust-fetch` (or the stage-3 selector in the WebUI); the codex preset carries it
automatically. Per-request process spawn (no pooling yet); env proxies
(HTTPS_PROXY/…) follow the Rust stack's defaults. stdio protocol is frozen in
`openspec/changes/rust-fetch-sidecar`.

## Development

```bash
pnpm install
pnpm test        # vitest (unit) + node --test (integration/e2e)
pnpm typecheck   # tsc --noEmit (strict)
pnpm build       # tsdown -> dist/ai-fly.js
pnpm dev         # tsx src/bin.ts
```

Node >= 20. License: MIT OR Apache-2.0. The fabric dependency
`@jixo/opendweb-client-sdk` ships native binaries for darwin-arm64 and win32-x64
(no Linux yet).

### Local link development against the opendweb kernel

The consumer/provider data plane rides the opendweb session-continuity kernel
(`Fabric.openSession` / `fetchHttp` / `serveHttp`; the aifly envelope wire
protocol is retired). While iterating against the opendweb workspace, link the
SDK instead of installing from the registry:

```bash
# one-time, inside the opendweb workspace
cd /path/to/opendweb/packages/client-sdk && npm link

# then in this repo (replaces the registry install with a symlink)
npm link @jixo/opendweb-client-sdk
```

Notes:

- Do **not** run `pnpm install` in this repo while the link is in place — it
  resolves the symlink back to the registry version. Add new dependencies in a
  separate step and re-link afterwards.
- `test/e2e/kernel-migration.test.mjs` is the real-kernel acceptance suite
  (dual in-process fabrics + serveHttp/fetchHttp; SSE mid-stream resume, dead
  semantics, provider restart, WS tunnel). It runs via
  `node --import tsx --test --test-force-exit ...` (the native runtime keeps
  the event loop alive; force-exit is required, mirroring the SDK's own test
  script).
- The `package.json` version stays on the published semver (`^0.5.0` line once
  the dual-release milestone lands); the link is a dev-time override only.

## Manual regression checklist

Desktop-shell behaviors that automated suites do not cover. Run before any
release build. Dev form takes **two terminals**: `pnpm webui:dev` (vite on
127.0.0.1:5190, proxying `/ws` and the token gate to the UI daemon) AND
`pnpm app:dev` (tray + window; the window loads the vite entry). Packaged
form: `pnpm app:build` + `pnpm app:start`. Each line is pass/fail; English
strings below are exactly what the UI shows.

1. **Tray & window** — app starts with a tray icon; the tray menu's primary
   item toggles the window (Open/Hide); `Quit ai-fly` exits cleanly (tray icon
   disappears, ports released).
2. **Token gate** — the UI only loads from the app window. Opening the daemon
   URL directly shows the guidance page; a reused link token reports
   "The link token is invalid or was already used."
3. **Theme toggle** — dark/light switch persists across a window close/reopen.
4. **Share wizard (3 steps)** — pick a preset (provider logos render, search
   filters; local presets first), name & group, generate link. The final card
   shows the `aifly1.` link with a copy field and the raw key once.
5. **Connect wizard (3 steps)** — paste the link from another machine (or the
   same one with a fresh data dir), confirm ports, pick an agent writer; the
   preview diff matches the written file.
6. **Key revoke while connected** — revoke the key on the provider (Advanced >
   keys); the consumer's dashboard flips its provider row to an error state and
   requests start failing with `key_revoked` within seconds.
7. **Restart recovery** — quit and relaunch on both sides: services, groups,
   keys, imported providers and custom ports all come back; the gateway
   resumes and serves traffic without re-importing.
8. **Overlay safe area & drag** (macOS overlay window) — the traffic lights
   never overlap the brand block or content; dragging the strip at the very
   top of the window moves the window; resize keeps the offset correct. In a
   plain browser tab the layout must look identical (zero inset fallback).
9. **Secrets panel** — Advanced > secrets: add a key-value pair, pick it in
   the share wizard's "api key" selector, generate a service; the saved
   service shows the auth slot `secret <name>`; values never re-display
   after saving; removing a secret referenced by a service is allowed but the
   service then fails with `secret_missing` until re-added.
10. **Connectivity test** — in the share wizard (with a secret picked) or a
    service row in Advanced, press `test`: the cheapest priced chat model is
    picked by default, the dropdown lists models sorted by price, and the
    result line shows `ok · <ms> · <model>` or the upstream error (an
    upstream 401 with an invalid key is a PASS — the network is proven).
11. **Service lifecycle** — with a running gateway, stop a service from the
    dashboard's port table (or `ai-fly services stop`): its local port
    refuses connections within ~a second and the row flips to disabled;
    start restores the same port. Stop it on the *provider* (`ai-fly service
    stop <name>`): the consumer's row disappears (catalog sync); start brings
    it back. Remove on the consumer keeps the entry hidden-but-revivable —
    `ai-fly services` still lists it as `disabled`, and starting it again
    works without re-importing.
12. **Codex e2e through the gateway** — with a provider exposing a codex
    subscription service and a consumer gateway running, point Codex CLI at
    the mapped port (`OPENAI_BASE_URL=http://127.0.0.1:<port>/v1` with the
    group key): a chat completion streams through, tool calls round-trip, and
    `ai-fly status --verbose` shows the served count climbing.
13. **SSE mid-stream connection swap (kernel continuity)** — start a long
    streaming request through the gateway (e.g. a slow/long codex response),
    then kill the provider's network path mid-stream (`ai-fly` fabric reset
    injection or simply restart the provider process within the recovery
    window): the stream continues in order with **no duplicated tokens**, the
    upstream request is NOT re-executed (provider logs show one execution),
    and `ai-fly status` shows the provider flipping to offline then back —
    the client never sees an error. Kill the provider for longer than the
    recovery window: in-flight requests fail with a network error and only
    *new* requests get 503 `provider_offline`.

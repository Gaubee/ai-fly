# ai-fly

Peer-to-peer network bridge with AI-ready presets, built on [OpenDWeb](https://github.com/jixoai/opendweb).

Share any HTTP/WebSocket upstream (ollama / vllm / LM Studio, an internal gateway, or a keyed third-party API) with friends over an invite-based fabric. Consumers get plain endpoints on `127.0.0.1` — point agents' base URLs (or any WS client) at them. No root certificates, no system-level interception, no proxy.

```
Consumer machine                         Provider machine
Agent ──► http://127.0.0.1:11434/…       ollama :11434 (or any HTTP/WS upstream)
       ──► ws://127.0.0.1:11434/…            ▲   provider engine
           consumer engine                   │   match set + rewrite ($env keys)
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
   rewrite shows `authorization: $secret:<name>`; values never re-display
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

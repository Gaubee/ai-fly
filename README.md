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

**Status: M1 (engine).** The headless engine lands with the `net-fly-core` change
(see `openspec/changes/net-fly-core/`). M2 adds the OpenTray shell + Web UI + the
AI preset library (curated providers + models.dev long tail). Proxy mode is
permanently out of scope (TLS makes credential injection impossible without MITM).

```bash
# Provider
ai-fly serve   --upstream http://127.0.0.1:11434   # run + manage services/groups
ai-fly key     issue --group friends                # sk-aifly-… keys
ai-fly share   --group friends --ttl 30m            # aifly1.… link (token + key)

# Consumer
ai-fly import  <link> --run                        # join + keyring + start gateway
ai-fly key     add <sk-aifly-…> --provider <id>    # bare key into an existing ring
ai-fly status  --verbose                            # ports, providers, service details
```

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

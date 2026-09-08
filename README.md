# ai-fly

Peer-to-peer OpenAI-compatible API sharing, built on [OpenDWeb](https://github.com/jixoai/opendweb).

Share your local inference endpoint (ollama / vllm / LM Studio, or any OpenAI-compatible
upstream) with friends over an invite-based fabric. Consumers get a plain OpenAI surface on
`127.0.0.1` and point their agents' base URL at it — no root certificates, no system-level
network interception.

```
Consumer machine                         Provider machine
Agent ──► 127.0.0.1:8788/v1              ollama :11434/v1 (or any OpenAI-compatible URL)
              │  consumer gateway            ▲  provider gateway
              └──────── OpenDWeb fabric ─────┘  (identity / invites / QUIC direct + relay)
```

- Membership = access. `dweb1.` invite tokens gate who can call; revoke disconnects instantly.
- Credentials never cross the wire in either direction (provider's upstream key stays local;
  the consumer's local key never leaves the machine).
- Streaming-first: SSE chat completions are relayed chunk-by-chunk.

**Status: scaffold.** The command surface below lands with the `api-share` change
(see `openspec/changes/api-share/`).

```bash
ai-fly serve   --upstream http://127.0.0.1:11434/v1   # share (provider side)
ai-fly invite  --ttl 30m                              # dweb1. token for a friend
ai-fly use     <token>                                # join + start 127.0.0.1 gateway
ai-fly setup   codex                                  # write agent base-url config
```

## Development

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit (strict)
pnpm build       # tsdown -> dist/ai-fly.js
pnpm dev         # tsx src/bin.ts
```

Node >= 20. The fabric dependency `@jixo/opendweb-client-sdk` ships native binaries for
darwin-arm64 and win32-x64.

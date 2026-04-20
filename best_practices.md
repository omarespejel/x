# StarkZap Review Rules

These rules are for the AI-review fork workflow in `omarespejel/x`.

## MCP tools

- MCP tools must be thin adapters over SDK methods. Do not duplicate swap, lending, token, account, or transaction business logic in the MCP layer.
- Every MCP tool name must use the `starkzap_` namespace prefix to avoid collisions with other MCP servers.
- Tool inputs must be validated with strict Zod schemas before they reach SDK or chain calls.
- Write tools must be gated by explicit write flags and must enforce configured per-call and batch amount limits.
- Raw execution tools must remain opt-in and must not bypass configured write gates, amount caps, or calldata limits.
- MCP responses must be bounded. Do not return unbounded calldata arrays, full provider payloads, or multi-megabyte JSON responses without explicit pagination or size limits.

## Starknet execution

- Sponsored and gasless transaction paths must not require already-deployed account checks when the SDK supports first sponsored writes.
- Account class-hash checks must distinguish undeployed accounts, mismatched deployed accounts, and unsupported sponsored flows.
- Errors returned to agents should be actionable but must not leak private keys, raw environment variables, or full secret-bearing payloads.
- Fee estimation, address parsing, amount conversion, calldata normalization, and transaction hashes should be deterministic and covered by tests.

## Tests

- Add focused tests for schema validation, write gating, size limits, sponsored account behavior, and previous reviewer regressions.
- Prefer small unit tests for MCP adapter behavior and SDK method delegation. Use integration tests only when RPC or devnet behavior is actually required.
- Do not hand-edit generated preset files or generated docs. Run the documented generators instead.

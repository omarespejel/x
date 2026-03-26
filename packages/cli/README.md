# StarkZap CLI (`starkzap-cli`)

A shell-first adapter for StarkZap P0 execution parity flows. The CLI reuses the same shared handlers as the MCP server for:

- `starkzap_get_balances`
- `starkzap_get_quote`
- `starkzap_build_swap_calls`
- `starkzap_build_calls`
- `starkzap_swap`

## Quick Start

```bash
cd packages/cli
npm install
npm run build

# Read-only parity commands
STARKNET_PRIVATE_KEY=0x... node dist/index.js get-balances --tokens STRK,ETH --network sepolia
STARKNET_PRIVATE_KEY=0x... node dist/index.js get-quote --token-in STRK --token-out ETH --amount-in 1 --network sepolia

# Exact MCP-schema parity mode
STARKNET_PRIVATE_KEY=0x... node dist/index.js run starkzap_build_calls \
  --input '{"calls":[{"contractAddress":"0x1","entrypoint":"transfer","calldata":["1"]}]}' \
  --network sepolia

# Write mode is explicit
STARKNET_PRIVATE_KEY=0x... node dist/index.js swap \
  --token-in STRK \
  --token-out ETH \
  --amount-in 0.01 \
  --network sepolia \
  --enable-write
```

## Global Flags

- `--network <mainnet|sepolia>`
- `--max-amount <decimal>`
- `--max-batch-amount <decimal>`
- `--rate-limit-rpm <int>`
- `--read-rate-limit-rpm <int>`
- `--write-rate-limit-rpm <int>`
- `--enable-write`
- `--enable-execute`

## Exact Parity Mode

`run <tool-name> --input '{...}'` accepts the same JSON object shape as the MCP tool schema. Use this mode when you want deterministic parity between CLI automation and MCP clients.

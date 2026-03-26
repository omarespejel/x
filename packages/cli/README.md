# StarkZap CLI (`starkzap-cli`)

A shell-first adapter for StarkZap P0 execution parity flows. The CLI reuses the same shared handlers as the MCP server for:

- `starkzap_get_balances`
- `starkzap_get_quote`
- `starkzap_lending_markets`
- `starkzap_lending_position`
- `starkzap_lending_health`
- `starkzap_lending_quote_health`
- `starkzap_build_swap_calls`
- `starkzap_build_calls`
- `starkzap_swap`
- `starkzap_lending_deposit`
- `starkzap_lending_withdraw`
- `starkzap_lending_withdraw_max`
- `starkzap_lending_borrow`
- `starkzap_lending_repay`

## Quick Start

```bash
cd packages/cli
npm install
npm run build

# Read-only parity commands
STARKNET_PRIVATE_KEY=0x... node dist/index.js get-balances --tokens STRK,ETH --network sepolia
STARKNET_PRIVATE_KEY=0x... node dist/index.js get-quote --token-in STRK --token-out ETH --amount-in 1 --network sepolia
STARKNET_PRIVATE_KEY=0x... node dist/index.js lending-markets --provider vesu --network sepolia
STARKNET_PRIVATE_KEY=0x... node dist/index.js lending-quote-health \
  --action borrow \
  --collateral-token STRK \
  --debt-token USDC \
  --amount 0.1 \
  --network sepolia

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

STARKNET_PRIVATE_KEY=0x... node dist/index.js lending-borrow \
  --collateral-token STRK \
  --debt-token USDC \
  --amount 0.1 \
  --collateral-amount 20 \
  --provider vesu \
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

## Command Matrix

| CLI command            | Shared action                   |
| ---------------------- | ------------------------------- |
| `get-balances`         | `starkzap_get_balances`         |
| `get-quote`            | `starkzap_get_quote`            |
| `lending-markets`      | `starkzap_lending_markets`      |
| `lending-position`     | `starkzap_lending_position`     |
| `lending-health`       | `starkzap_lending_health`       |
| `lending-quote-health` | `starkzap_lending_quote_health` |
| `build-swap-calls`     | `starkzap_build_swap_calls`     |
| `build-calls`          | `starkzap_build_calls`          |
| `swap`                 | `starkzap_swap`                 |
| `lending-deposit`      | `starkzap_lending_deposit`      |
| `lending-withdraw`     | `starkzap_lending_withdraw`     |
| `lending-withdraw-max` | `starkzap_lending_withdraw_max` |
| `lending-borrow`       | `starkzap_lending_borrow`       |
| `lending-repay`        | `starkzap_lending_repay`        |

import { describe, expect, it } from "vitest";
import { buildTools } from "../../mcp-server/src/core.js";
import { P0_ACTION_MANIFEST } from "../../mcp-server/src/p0-actions.js";
import {
  buildHelpText,
  extractGlobalArgs,
  parseCliInvocation,
} from "../src/cli.js";

describe("starkzap-cli parser", () => {
  it("extracts shared global flags without consuming command options", () => {
    const parsed = extractGlobalArgs([
      "get-quote",
      "--network",
      "sepolia",
      "--token-in",
      "STRK",
      "--token-out",
      "ETH",
      "--amount-in",
      "1",
      "--enable-write",
    ]);

    expect(parsed.globalArgs).toEqual([
      "--network",
      "sepolia",
      "--enable-write",
    ]);
    expect(parsed.commandArgs).toEqual([
      "get-quote",
      "--token-in",
      "STRK",
      "--token-out",
      "ETH",
      "--amount-in",
      "1",
    ]);
  });

  it("parses ergonomic quote invocation into the shared MCP-shaped payload", () => {
    const parsed = parseCliInvocation([
      "get-quote",
      "--token-in",
      "STRK",
      "--token-out",
      "ETH",
      "--amount-in",
      "1.25",
      "--slippage-bps",
      "75",
      "--provider",
      "avnu",
    ]);

    expect(parsed).toEqual({
      kind: "run",
      globalArgs: [],
      toolName: "starkzap_get_quote",
      input: {
        tokenIn: "STRK",
        tokenOut: "ETH",
        amountIn: "1.25",
        slippageBps: 75,
        provider: "avnu",
      },
    });
  });

  it("parses exact parity run mode with JSON input", () => {
    const parsed = parseCliInvocation([
      "run",
      "starkzap_build_calls",
      "--input",
      '{"calls":[{"contractAddress":"0x1","entrypoint":"transfer","calldata":["1"]}]}',
    ]);

    expect(parsed).toEqual({
      kind: "run",
      globalArgs: [],
      toolName: "starkzap_build_calls",
      input: {
        calls: [
          {
            contractAddress: "0x1",
            entrypoint: "transfer",
            calldata: ["1"],
          },
        ],
      },
    });
  });

  it("parses lending borrow ergonomic invocation", () => {
    const parsed = parseCliInvocation([
      "lending-borrow",
      "--collateral-token",
      "STRK",
      "--debt-token",
      "USDC",
      "--amount",
      "0.1",
      "--collateral-amount",
      "20",
      "--provider",
      "vesu",
      "--use-earn-position",
      "--sponsored",
    ]);

    expect(parsed).toEqual({
      kind: "run",
      globalArgs: [],
      toolName: "starkzap_lending_borrow",
      input: {
        collateralToken: "STRK",
        debtToken: "USDC",
        amount: "0.1",
        collateralAmount: "20",
        provider: "vesu",
        useEarnPosition: true,
        sponsored: true,
      },
    });
  });

  it("parses lending quote-health ergonomic invocation", () => {
    const parsed = parseCliInvocation([
      "lending-quote-health",
      "--action",
      "repay",
      "--collateral-token",
      "STRK",
      "--debt-token",
      "USDC",
      "--amount",
      "0",
      "--collateral-amount",
      "5",
      "--withdraw-collateral",
      "--health-user",
      "0x123",
      "--sponsored",
    ]);

    expect(parsed).toEqual({
      kind: "run",
      globalArgs: [],
      toolName: "starkzap_lending_quote_health",
      input: {
        action: {
          action: "repay",
          request: {
            collateralToken: "STRK",
            debtToken: "USDC",
            amount: "0",
            collateralAmount: "5",
            withdrawCollateral: true,
          },
        },
        health: {
          collateralToken: "STRK",
          debtToken: "USDC",
          user: "0x123",
        },
        sponsored: true,
      },
    });
  });
});

describe("starkzap-cli manifest parity", () => {
  it("keeps every P0 action represented in the MCP tool manifest", () => {
    const toolNames = new Set(
      buildTools("1000", "1000").map((tool) => tool.name)
    );
    for (const entry of P0_ACTION_MANIFEST) {
      expect(toolNames.has(entry.toolName)).toBe(true);
    }
  });

  it("keeps CLI command names unique", () => {
    const commandNames = P0_ACTION_MANIFEST.map((entry) => entry.commandName);
    expect(new Set(commandNames).size).toBe(commandNames.length);
  });

  it("documents every ergonomic command in the help text", () => {
    const help = buildHelpText();
    for (const entry of P0_ACTION_MANIFEST) {
      expect(help).toContain(entry.commandName);
    }
  });
});

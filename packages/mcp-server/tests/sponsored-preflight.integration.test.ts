import type { Wallet } from "starkzap";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type TestingExports = {
  handleCallToolRequest(request: {
    params: { name: string; arguments?: Record<string, unknown> | undefined };
  }): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
  setWalletSingleton(value: Wallet | undefined): void;
  resetState(): void;
};

let testing: TestingExports;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.STARKZAP_MCP_ENABLE_TEST_HOOKS = "1";
  process.env.STARKZAP_MCP_TEST_KEY_MARKER =
    "TEST_KEY_DO_NOT_USE_IN_PRODUCTION";
  process.env.STARKNET_PRIVATE_KEY = `0x${"1".padStart(64, "0")}`;
  process.argv = [
    "node",
    "sponsored-preflight.integration.test.ts",
    "--network",
    "sepolia",
    "--enable-write",
  ];

  await import("../src/index.js");
  const hooks = (globalThis as Record<string, unknown>)
    .__STARKZAP_MCP_TESTING__;
  if (!hooks) {
    throw new Error("Expected __STARKZAP_MCP_TESTING__ hooks to be available");
  }
  testing = hooks as TestingExports;
});

beforeEach(() => {
  testing.resetState();
});

describe("sponsored write preflight hardening", () => {
  it("blocks sponsored transfer before submission when account class hash mismatches", async () => {
    const transfer = vi.fn();
    const wallet = {
      address:
        "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      getClassHash: () =>
        "0x01d1777db36cdd06dd62cfde77b1b6ae06412af95d57a13dc40ac77b8a702381",
      getProvider: () => ({
        getClassHashAt: vi
          .fn()
          .mockResolvedValue(
            "0x036078334509b514626504edc9fb252328d1a240e4e948bef8d0c08dff45927f"
          ),
      }),
      transfer,
    } as unknown as Wallet;

    testing.setWalletSingleton(wallet);

    const result = await testing.handleCallToolRequest({
      params: {
        name: "starkzap_transfer",
        arguments: {
          token: "STRK",
          transfers: [{ to: "0x1", amount: "0.1" }],
          sponsored: true,
        },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toContain(
      "Sponsored transfer preflight detected account class hash mismatch"
    );
    expect(transfer).not.toHaveBeenCalled();
  });
});

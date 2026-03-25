import type { Wallet } from "starkzap";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
const originalArgv = [...process.argv];
const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  STARKZAP_MCP_ENABLE_TEST_HOOKS: process.env.STARKZAP_MCP_ENABLE_TEST_HOOKS,
  STARKZAP_MCP_TEST_KEY_MARKER: process.env.STARKZAP_MCP_TEST_KEY_MARKER,
  STARKNET_PRIVATE_KEY: process.env.STARKNET_PRIVATE_KEY,
};
const originalTestingHooks = (globalThis as Record<string, unknown>)
  .__STARKZAP_MCP_TESTING__;

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

afterAll(() => {
  process.argv = originalArgv;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  (globalThis as Record<string, unknown>).__STARKZAP_MCP_TESTING__ =
    originalTestingHooks;
});

describe("sponsored write preflight hardening", () => {
  it("allows sponsored transfer preflight to continue when the account is undeployed", async () => {
    const transfer = vi.fn().mockResolvedValue({
      hash: "0x123",
      wait: vi.fn().mockResolvedValue(undefined),
      explorerUrl: "https://example.com/tx/0x123",
    });
    const wallet = {
      address:
        "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      getClassHash: () =>
        "0x01d1777db36cdd06dd62cfde77b1b6ae06412af95d57a13dc40ac77b8a702381",
      getProvider: () => ({
        getClassHashAt: vi
          .fn()
          .mockRejectedValue(new Error("Contract not found")),
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
      "Sponsored transfer post-check succeeded but wallet account is still not deployed on-chain."
    );
    expect(transfer).toHaveBeenCalledOnce();
  });

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

  it("allows sponsored execute preflight to continue when the account is undeployed", async () => {
    const execute = vi.fn().mockResolvedValue({
      hash: "0x456",
      wait: vi.fn().mockResolvedValue(undefined),
      explorerUrl: "https://example.com/tx/0x456",
    });
    const wallet = {
      address:
        "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      getClassHash: () =>
        "0x01d1777db36cdd06dd62cfde77b1b6ae06412af95d57a13dc40ac77b8a702381",
      getProvider: () => ({
        getClassHashAt: vi
          .fn()
          .mockRejectedValue(new Error("Contract not found")),
      }),
      execute,
    } as unknown as Wallet;

    testing.setWalletSingleton(wallet);

    const result = await testing.handleCallToolRequest({
      params: {
        name: "starkzap_execute",
        arguments: {
          calls: [{ contractAddress: "0x1", entrypoint: "transfer" }],
          sponsored: true,
        },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toContain(
      "Sponsored execute post-check succeeded but wallet account is still not deployed on-chain."
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it("blocks sponsored execute before submission when account class hash mismatches", async () => {
    const execute = vi.fn();
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
      execute,
    } as unknown as Wallet;

    testing.setWalletSingleton(wallet);

    const result = await testing.handleCallToolRequest({
      params: {
        name: "starkzap_execute",
        arguments: {
          calls: [{ contractAddress: "0x1", entrypoint: "transfer" }],
          sponsored: true,
        },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toContain(
      "Sponsored execute preflight detected account class hash mismatch"
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

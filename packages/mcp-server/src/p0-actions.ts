import { Amount } from "starkzap";
import type { Address, Token, Wallet } from "starkzap";
import {
  assertAmountWithinCap,
  schemas,
  validateAddressBatch,
} from "./core.js";

export const P0_ACTION_MANIFEST = [
  {
    toolName: "starkzap_get_balances",
    commandName: "get-balances",
    requiresWrite: false,
    summary: "Get ERC20 balances for multiple pre-verified tokens.",
  },
  {
    toolName: "starkzap_get_quote",
    commandName: "get-quote",
    requiresWrite: false,
    summary: "Get a swap quote using the configured provider.",
  },
  {
    toolName: "starkzap_build_swap_calls",
    commandName: "build-swap-calls",
    requiresWrite: false,
    summary: "Build unsigned swap calls without executing them.",
  },
  {
    toolName: "starkzap_build_calls",
    commandName: "build-calls",
    requiresWrite: false,
    summary: "Normalize raw calls through the tx builder without executing.",
  },
  {
    toolName: "starkzap_swap",
    commandName: "swap",
    requiresWrite: true,
    summary: "Execute a token swap using the configured provider.",
  },
] as const;

export type P0ActionName = (typeof P0_ACTION_MANIFEST)[number]["toolName"];

export interface TrackedTransactionResult {
  hash: string;
  explorerUrl?: string;
}

export interface P0ActionContext {
  maxAmount: string;
  getWallet(): Promise<Wallet>;
  resolveToken(symbolOrAddress: string): Token;
  withTimeout<T>(
    operation: string,
    promiseFactory: () => Promise<T>
  ): Promise<T>;
  parseAmountWithContext(
    literal: string,
    token: Token,
    context: string
  ): Amount;
  sanitizeTokenSymbol(symbol: string): string;
  mapWithConcurrencyLimit<T, R>(
    items: readonly T[],
    limit: number,
    mapper: (item: T, index: number) => Promise<R>
  ): Promise<R[]>;
  assertAmountMethods(
    value: unknown,
    label: string,
    methods: readonly string[]
  ): void;
  assertDistinctSwapTokens(
    tokenIn: Token,
    tokenOut: Token,
    context: string
  ): void;
  assertSwapQuoteShape(quote: unknown): void;
  assertWalletAccountClassHash(wallet: Wallet, context: string): Promise<void>;
  waitForTrackedTransaction(tx: {
    wait: () => Promise<void>;
    hash: string;
    explorerUrl?: string;
  }): Promise<TrackedTransactionResult>;
  normalizeCallForResponse(
    call: unknown,
    label: string
  ): { contractAddress: Address; entrypoint: string; calldata: string[] };
}

export function isP0ActionName(name: string): name is P0ActionName {
  return P0_ACTION_MANIFEST.some((entry) => entry.toolName === name);
}

export async function runP0Action(
  context: P0ActionContext,
  name: P0ActionName,
  rawArgs: Record<string, unknown>
): Promise<Record<string, unknown>> {
  switch (name) {
    case "starkzap_get_balances": {
      const parsed = schemas.starkzap_get_balances.parse(rawArgs);
      const wallet = await context.getWallet();
      const resolvedTokens = parsed.tokens.map((tokenInput) =>
        context.resolveToken(tokenInput)
      );
      const balances = await context.mapWithConcurrencyLimit(
        resolvedTokens,
        8,
        async (token) => {
          const balance = await context.withTimeout(
            `Token balance query (${token.symbol})`,
            () => wallet.balanceOf(token)
          );
          context.assertAmountMethods(balance, "balance", [
            "toUnit",
            "toFormatted",
            "toBase",
            "getDecimals",
          ]);
          return {
            token: context.sanitizeTokenSymbol(token.symbol),
            address: token.address,
            balance: balance.toUnit(),
            formatted: balance.toFormatted(),
            raw: balance.toBase().toString(),
            decimals: balance.getDecimals(),
          };
        }
      );
      return { balances };
    }

    case "starkzap_get_quote": {
      const parsed = schemas.starkzap_get_quote.parse(rawArgs);
      const wallet = await context.getWallet();
      const tokenIn = context.resolveToken(parsed.tokenIn);
      const tokenOut = context.resolveToken(parsed.tokenOut);
      context.assertDistinctSwapTokens(tokenIn, tokenOut, "Swap quote");
      const amountIn = context.parseAmountWithContext(
        parsed.amountIn,
        tokenIn,
        "quote"
      );
      assertAmountWithinCap(amountIn, tokenIn, context.maxAmount);
      const quote = await context.withTimeout("Swap quote query", () =>
        wallet.getQuote({
          tokenIn,
          tokenOut,
          amountIn,
          ...(parsed.slippageBps !== undefined && {
            slippageBps: BigInt(parsed.slippageBps),
          }),
          ...(parsed.provider !== undefined && { provider: parsed.provider }),
        })
      );
      context.assertSwapQuoteShape(quote);
      const quotedInAmount = Amount.fromRaw(quote.amountInBase, tokenIn);
      const quotedOutAmount = Amount.fromRaw(quote.amountOutBase, tokenOut);
      return {
        tokenIn: context.sanitizeTokenSymbol(tokenIn.symbol),
        tokenInAddress: tokenIn.address,
        tokenOut: context.sanitizeTokenSymbol(tokenOut.symbol),
        tokenOutAddress: tokenOut.address,
        amountIn: quotedInAmount.toUnit(),
        amountInRaw: quote.amountInBase.toString(),
        amountOut: quotedOutAmount.toUnit(),
        amountOutRaw: quote.amountOutBase.toString(),
        ...(quote.routeCallCount !== undefined && {
          routeCallCount: quote.routeCallCount,
        }),
        ...(quote.priceImpactBps !== undefined && {
          priceImpactBps:
            quote.priceImpactBps === null
              ? null
              : quote.priceImpactBps.toString(),
        }),
        ...(quote.provider !== undefined && { provider: quote.provider }),
      };
    }

    case "starkzap_build_swap_calls": {
      const parsed = schemas.starkzap_build_swap_calls.parse(rawArgs);
      const wallet = await context.getWallet();
      const tokenIn = context.resolveToken(parsed.tokenIn);
      const tokenOut = context.resolveToken(parsed.tokenOut);
      context.assertDistinctSwapTokens(tokenIn, tokenOut, "Build swap calls");
      const amountIn = context.parseAmountWithContext(
        parsed.amountIn,
        tokenIn,
        "build_swap_calls"
      );
      assertAmountWithinCap(amountIn, tokenIn, context.maxAmount);
      const rawCalls = await context.withTimeout("Swap call build", async () =>
        wallet
          .tx()
          .swap({
            tokenIn,
            tokenOut,
            amountIn,
            ...(parsed.slippageBps !== undefined && {
              slippageBps: BigInt(parsed.slippageBps),
            }),
            ...(parsed.provider !== undefined && { provider: parsed.provider }),
          })
          .calls()
      );
      if (
        !Array.isArray(rawCalls) ||
        rawCalls.length === 0 ||
        rawCalls.length > 10
      ) {
        throw new Error(
          "Invalid swap calls returned by SDK: expected 1-10 calls."
        );
      }
      const formattedCalls = rawCalls.map((call, index) =>
        context.normalizeCallForResponse(call, `swap_call_${index}`)
      );
      const totalCalldataItems = formattedCalls.reduce(
        (sum, call) => sum + call.calldata.length,
        0
      );
      const maxSwapCalldataItems = 4096;
      if (totalCalldataItems > maxSwapCalldataItems) {
        throw new Error(
          `Invalid swap calls returned by SDK: calldata item count exceeds ${maxSwapCalldataItems}.`
        );
      }
      const totalCalldataChars = formattedCalls.reduce(
        (sum, call) =>
          sum +
          call.calldata.reduce((callSum, value) => callSum + value.length, 0),
        0
      );
      const maxSwapCalldataChars = 65_536;
      if (totalCalldataChars > maxSwapCalldataChars) {
        throw new Error(
          `Invalid swap calls returned by SDK: calldata payload exceeds ${maxSwapCalldataChars} characters.`
        );
      }
      return {
        tokenIn: context.sanitizeTokenSymbol(tokenIn.symbol),
        tokenInAddress: tokenIn.address,
        tokenOut: context.sanitizeTokenSymbol(tokenOut.symbol),
        tokenOutAddress: tokenOut.address,
        amountIn: amountIn.toUnit(),
        amountInRaw: amountIn.toBase().toString(),
        calls: formattedCalls,
      };
    }

    case "starkzap_build_calls": {
      const parsed = schemas.starkzap_build_calls.parse(rawArgs);
      const wallet = await context.getWallet();
      const contractAddresses = validateAddressBatch(
        parsed.calls.map((call) => call.contractAddress),
        "contract",
        "calls.contractAddress"
      );
      const requestedCalls = parsed.calls.map((call, index) => ({
        contractAddress: contractAddresses[index],
        entrypoint: call.entrypoint,
        calldata: call.calldata ?? [],
      }));
      const txBuilder = wallet.tx();
      txBuilder.add(...requestedCalls);
      const builtCallsResponse = await context.withTimeout(
        "Build calls query",
        () => txBuilder.calls()
      );
      if (!Array.isArray(builtCallsResponse)) {
        throw new Error(
          "Invalid build calls response from SDK: expected array."
        );
      }
      if (builtCallsResponse.length !== requestedCalls.length) {
        throw new Error(
          `Invalid build calls response from SDK: expected ${requestedCalls.length} calls, received ${builtCallsResponse.length}.`
        );
      }
      return {
        callCount: builtCallsResponse.length,
        calls: builtCallsResponse.map((call, index) =>
          context.normalizeCallForResponse(call, `calls_${index}`)
        ),
      };
    }

    case "starkzap_swap": {
      const parsed = schemas.starkzap_swap.parse(rawArgs);
      const wallet = await context.getWallet();
      const tokenIn = context.resolveToken(parsed.tokenIn);
      const tokenOut = context.resolveToken(parsed.tokenOut);
      context.assertDistinctSwapTokens(tokenIn, tokenOut, "Swap execution");
      const amountIn = context.parseAmountWithContext(
        parsed.amountIn,
        tokenIn,
        "swap"
      );
      assertAmountWithinCap(amountIn, tokenIn, context.maxAmount);
      const quote = await context.withTimeout("Swap quote precheck", () =>
        wallet.getQuote({
          tokenIn,
          tokenOut,
          amountIn,
          ...(parsed.slippageBps !== undefined && {
            slippageBps: BigInt(parsed.slippageBps),
          }),
          ...(parsed.provider !== undefined && { provider: parsed.provider }),
        })
      );
      context.assertSwapQuoteShape(quote);
      const quotedOutAmount = Amount.fromRaw(quote.amountOutBase, tokenOut);
      const feeMode: "sponsored" | undefined = parsed.sponsored
        ? "sponsored"
        : undefined;
      if (feeMode === "sponsored") {
        await context.assertWalletAccountClassHash(
          wallet,
          "Sponsored swap preflight"
        );
      }
      const tx = await context.withTimeout("Swap transaction submission", () =>
        wallet.swap(
          {
            tokenIn,
            tokenOut,
            amountIn,
            ...(parsed.slippageBps !== undefined && {
              slippageBps: BigInt(parsed.slippageBps),
            }),
            ...(parsed.provider !== undefined && { provider: parsed.provider }),
          },
          {
            ...(feeMode && { feeMode }),
          }
        )
      );
      const txResult = await context.waitForTrackedTransaction(tx);
      if (feeMode === "sponsored") {
        await context.assertWalletAccountClassHash(
          wallet,
          "Sponsored swap post-check"
        );
      }
      return {
        hash: txResult.hash,
        ...(txResult.explorerUrl !== undefined && {
          explorerUrl: txResult.explorerUrl,
        }),
        tokenIn: context.sanitizeTokenSymbol(tokenIn.symbol),
        tokenInAddress: tokenIn.address,
        tokenOut: context.sanitizeTokenSymbol(tokenOut.symbol),
        tokenOutAddress: tokenOut.address,
        amountIn: amountIn.toUnit(),
        amountInRaw: amountIn.toBase().toString(),
        amountOut: quotedOutAmount.toUnit(),
        amountOutRaw: quote.amountOutBase.toString(),
        amountOutSource: "pretrade_quote",
        ...(quote.routeCallCount !== undefined && {
          routeCallCount: quote.routeCallCount,
        }),
        ...(quote.priceImpactBps !== undefined && {
          priceImpactBps:
            quote.priceImpactBps === null
              ? null
              : quote.priceImpactBps.toString(),
        }),
        ...(quote.provider !== undefined && { provider: quote.provider }),
      };
    }
  }
}

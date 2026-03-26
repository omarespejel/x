import { Amount } from "starkzap";
import type {
  Address,
  LendingHealth,
  LendingMarket,
  LendingPosition,
  PreflightResult,
  PreparedLendingAction,
  Token,
  Wallet,
} from "starkzap";
import {
  assertAmountWithinCap,
  schemas,
  validateAddressOrThrow,
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
    toolName: "starkzap_lending_markets",
    commandName: "lending-markets",
    requiresWrite: false,
    summary: "Get lending markets from the configured provider.",
  },
  {
    toolName: "starkzap_lending_position",
    commandName: "lending-position",
    requiresWrite: false,
    summary: "Get the current lending position for a market pair.",
  },
  {
    toolName: "starkzap_lending_health",
    commandName: "lending-health",
    requiresWrite: false,
    summary: "Get current lending health for a market pair.",
  },
  {
    toolName: "starkzap_lending_quote_health",
    commandName: "lending-quote-health",
    requiresWrite: false,
    summary: "Simulate a lending action and quote post-action health.",
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
  {
    toolName: "starkzap_lending_deposit",
    commandName: "lending-deposit",
    requiresWrite: true,
    summary: "Deposit assets into a lending market.",
  },
  {
    toolName: "starkzap_lending_withdraw",
    commandName: "lending-withdraw",
    requiresWrite: true,
    summary: "Withdraw assets from a lending market.",
  },
  {
    toolName: "starkzap_lending_withdraw_max",
    commandName: "lending-withdraw-max",
    requiresWrite: true,
    summary: "Withdraw the maximum available lending balance.",
  },
  {
    toolName: "starkzap_lending_borrow",
    commandName: "lending-borrow",
    requiresWrite: true,
    summary: "Borrow against collateral in a lending market.",
  },
  {
    toolName: "starkzap_lending_repay",
    commandName: "lending-repay",
    requiresWrite: true,
    summary: "Repay lending debt and optionally adjust collateral.",
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

function sanitizeDisplayText(
  value: string | undefined,
  maxLength: number = 96
): string | undefined {
  if (!value) {
    return undefined;
  }
  const sanitized = value.replace(/[^A-Za-z0-9 _./:()#-]/g, "").trim();
  if (!sanitized) {
    return undefined;
  }
  return sanitized.slice(0, maxLength);
}

function normalizeOptionalAddress(
  value: string | undefined,
  label: string
): Address | undefined {
  return value === undefined ? undefined : validateAddressOrThrow(value, label);
}

function normalizeTokenForResponse(context: P0ActionContext, token: Token) {
  return {
    symbol: context.sanitizeTokenSymbol(token.symbol),
    address: token.address,
    decimals: token.decimals,
    ...(sanitizeDisplayText(token.name, 128) && {
      name: sanitizeDisplayText(token.name, 128),
    }),
  };
}

function normalizeAmountForResponse(
  context: P0ActionContext,
  value: unknown,
  label: string
) {
  context.assertAmountMethods(value, label, [
    "toUnit",
    "toFormatted",
    "toBase",
    "getDecimals",
  ]);
  const amountLike = value as Amount;
  return {
    value: amountLike.toUnit(),
    formatted: amountLike.toFormatted(),
    raw: amountLike.toBase().toString(),
    decimals: amountLike.getDecimals(),
  };
}

function assertDistinctLendingTokens(
  context: P0ActionContext,
  collateralToken: Token,
  debtToken: Token,
  operation: string
): void {
  const normalizedCollateral = BigInt(collateralToken.address).toString();
  const normalizedDebt = BigInt(debtToken.address).toString();
  if (normalizedCollateral === normalizedDebt) {
    throw new Error(
      `${operation}: collateralToken and debtToken resolve to the same token (${context.sanitizeTokenSymbol(collateralToken.symbol)}).`
    );
  }
}

function normalizeLendingHealth(health: LendingHealth) {
  return {
    isCollateralized: health.isCollateralized,
    collateralValue: health.collateralValue.toString(),
    debtValue: health.debtValue.toString(),
  };
}

function normalizeLendingPosition(position: LendingPosition) {
  return {
    collateralShares: position.collateralShares.toString(),
    nominalDebt: position.nominalDebt.toString(),
    ...(position.collateralAmount !== undefined && {
      collateralAmount: position.collateralAmount.toString(),
    }),
    ...(position.debtAmount !== undefined && {
      debtAmount: position.debtAmount.toString(),
    }),
    collateralValue: position.collateralValue.toString(),
    debtValue: position.debtValue.toString(),
    isCollateralized: position.isCollateralized,
  };
}

function normalizeLendingMarket(
  context: P0ActionContext,
  market: LendingMarket
): Record<string, unknown> {
  return {
    protocol: sanitizeDisplayText(market.protocol, 64) ?? market.protocol,
    poolAddress: market.poolAddress,
    ...(sanitizeDisplayText(market.poolName, 128) && {
      poolName: sanitizeDisplayText(market.poolName, 128),
    }),
    asset: normalizeTokenForResponse(context, market.asset),
    vTokenAddress: market.vTokenAddress,
    ...(sanitizeDisplayText(market.vTokenSymbol, 64) && {
      vTokenSymbol: sanitizeDisplayText(market.vTokenSymbol, 64),
    }),
    ...(market.canBeBorrowed !== undefined && {
      canBeBorrowed: market.canBeBorrowed,
    }),
    ...(market.stats && {
      stats: Object.fromEntries(
        Object.entries({
          supplyApy:
            market.stats.supplyApy &&
            normalizeAmountForResponse(
              context,
              market.stats.supplyApy,
              "lending market supplyApy"
            ),
          borrowApr:
            market.stats.borrowApr &&
            normalizeAmountForResponse(
              context,
              market.stats.borrowApr,
              "lending market borrowApr"
            ),
          totalSupplied:
            market.stats.totalSupplied &&
            normalizeAmountForResponse(
              context,
              market.stats.totalSupplied,
              "lending market totalSupplied"
            ),
          totalBorrowed:
            market.stats.totalBorrowed &&
            normalizeAmountForResponse(
              context,
              market.stats.totalBorrowed,
              "lending market totalBorrowed"
            ),
          utilization:
            market.stats.utilization &&
            normalizeAmountForResponse(
              context,
              market.stats.utilization,
              "lending market utilization"
            ),
        }).filter(([, value]) => value !== undefined)
      ),
    }),
  };
}

function normalizePreparedLendingAction(
  context: P0ActionContext,
  prepared: PreparedLendingAction,
  options: { includeCalls?: boolean } = {}
): Record<string, unknown> {
  if (!Array.isArray(prepared.calls) || prepared.calls.length === 0) {
    throw new Error(
      "Invalid lending action returned by SDK: expected at least one prepared call."
    );
  }
  if (prepared.calls.length > 20) {
    throw new Error(
      "Invalid lending action returned by SDK: too many prepared calls."
    );
  }
  const normalizedCalls = prepared.calls.map((call, index) =>
    context.normalizeCallForResponse(call, `lending_call_${index}`)
  );
  return {
    providerId: prepared.providerId,
    action: prepared.action,
    callCount: normalizedCalls.length,
    ...(options.includeCalls && { calls: normalizedCalls }),
    ...(prepared.market && {
      market: normalizeLendingMarket(context, prepared.market),
    }),
  };
}

function normalizePreflightResult(result: PreflightResult) {
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

function sponsoredFeeMode(sponsored: boolean | undefined) {
  return sponsored ? ("sponsored" as const) : undefined;
}

function normalizeTxResult(txResult: TrackedTransactionResult) {
  return {
    hash: txResult.hash,
    ...(txResult.explorerUrl !== undefined && {
      explorerUrl: txResult.explorerUrl,
    }),
  };
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

    case "starkzap_lending_markets": {
      const parsed = schemas.starkzap_lending_markets.parse(rawArgs);
      const wallet = await context.getWallet();
      const markets = await context.withTimeout("Lending markets query", () =>
        wallet.lending().getMarkets({
          ...(parsed.provider !== undefined && { provider: parsed.provider }),
        })
      );
      return {
        markets: markets.map((market) =>
          normalizeLendingMarket(context, market)
        ),
      };
    }

    case "starkzap_lending_position": {
      const parsed = schemas.starkzap_lending_position.parse(rawArgs);
      const wallet = await context.getWallet();
      const collateralToken = context.resolveToken(parsed.collateralToken);
      const debtToken = context.resolveToken(parsed.debtToken);
      assertDistinctLendingTokens(
        context,
        collateralToken,
        debtToken,
        "Lending position query"
      );
      const position = await context.withTimeout("Lending position query", () =>
        wallet.lending().getPosition({
          collateralToken,
          debtToken,
          ...(parsed.provider !== undefined && { provider: parsed.provider }),
          ...(parsed.poolAddress !== undefined && {
            poolAddress: normalizeOptionalAddress(parsed.poolAddress, "pool"),
          }),
          ...(parsed.user !== undefined && {
            user: normalizeOptionalAddress(parsed.user, "user"),
          }),
        })
      );
      return {
        collateralToken: context.sanitizeTokenSymbol(collateralToken.symbol),
        collateralTokenAddress: collateralToken.address,
        debtToken: context.sanitizeTokenSymbol(debtToken.symbol),
        debtTokenAddress: debtToken.address,
        ...(parsed.user !== undefined && { user: parsed.user }),
        position: normalizeLendingPosition(position),
      };
    }

    case "starkzap_lending_health": {
      const parsed = schemas.starkzap_lending_health.parse(rawArgs);
      const wallet = await context.getWallet();
      const collateralToken = context.resolveToken(parsed.collateralToken);
      const debtToken = context.resolveToken(parsed.debtToken);
      assertDistinctLendingTokens(
        context,
        collateralToken,
        debtToken,
        "Lending health query"
      );
      const health = await context.withTimeout("Lending health query", () =>
        wallet.lending().getHealth({
          collateralToken,
          debtToken,
          ...(parsed.provider !== undefined && { provider: parsed.provider }),
          ...(parsed.poolAddress !== undefined && {
            poolAddress: normalizeOptionalAddress(parsed.poolAddress, "pool"),
          }),
          ...(parsed.user !== undefined && {
            user: normalizeOptionalAddress(parsed.user, "user"),
          }),
        })
      );
      return {
        collateralToken: context.sanitizeTokenSymbol(collateralToken.symbol),
        collateralTokenAddress: collateralToken.address,
        debtToken: context.sanitizeTokenSymbol(debtToken.symbol),
        debtTokenAddress: debtToken.address,
        ...(parsed.user !== undefined && { user: parsed.user }),
        health: normalizeLendingHealth(health),
      };
    }

    case "starkzap_lending_quote_health": {
      const parsed = schemas.starkzap_lending_quote_health.parse(rawArgs);
      const wallet = await context.getWallet();

      const healthCollateralToken = context.resolveToken(
        parsed.health.collateralToken
      );
      const healthDebtToken = context.resolveToken(parsed.health.debtToken);
      assertDistinctLendingTokens(
        context,
        healthCollateralToken,
        healthDebtToken,
        "Lending health quote"
      );

      const healthRequest = {
        collateralToken: healthCollateralToken,
        debtToken: healthDebtToken,
        ...(parsed.health.provider !== undefined && {
          provider: parsed.health.provider,
        }),
        ...(parsed.health.poolAddress !== undefined && {
          poolAddress: normalizeOptionalAddress(
            parsed.health.poolAddress,
            "pool"
          ),
        }),
        ...(parsed.health.user !== undefined && {
          user: normalizeOptionalAddress(parsed.health.user, "user"),
        }),
      };

      const actionInput = (() => {
        switch (parsed.action.action) {
          case "deposit": {
            const token = context.resolveToken(parsed.action.request.token);
            return {
              action: "deposit" as const,
              request: {
                token,
                amount: context.parseAmountWithContext(
                  parsed.action.request.amount,
                  token,
                  "lending deposit"
                ),
                ...(parsed.action.request.provider !== undefined && {
                  provider: parsed.action.request.provider,
                }),
                ...(parsed.action.request.poolAddress !== undefined && {
                  poolAddress: normalizeOptionalAddress(
                    parsed.action.request.poolAddress,
                    "pool"
                  ),
                }),
                ...(parsed.action.request.receiver !== undefined && {
                  receiver: normalizeOptionalAddress(
                    parsed.action.request.receiver,
                    "receiver"
                  ),
                }),
              },
            };
          }
          case "withdraw": {
            const token = context.resolveToken(parsed.action.request.token);
            return {
              action: "withdraw" as const,
              request: {
                token,
                amount: context.parseAmountWithContext(
                  parsed.action.request.amount,
                  token,
                  "lending withdraw"
                ),
                ...(parsed.action.request.provider !== undefined && {
                  provider: parsed.action.request.provider,
                }),
                ...(parsed.action.request.poolAddress !== undefined && {
                  poolAddress: normalizeOptionalAddress(
                    parsed.action.request.poolAddress,
                    "pool"
                  ),
                }),
                ...(parsed.action.request.receiver !== undefined && {
                  receiver: normalizeOptionalAddress(
                    parsed.action.request.receiver,
                    "receiver"
                  ),
                }),
                ...(parsed.action.request.owner !== undefined && {
                  owner: normalizeOptionalAddress(
                    parsed.action.request.owner,
                    "owner"
                  ),
                }),
              },
            };
          }
          case "borrow": {
            const collateralToken = context.resolveToken(
              parsed.action.request.collateralToken
            );
            const debtToken = context.resolveToken(
              parsed.action.request.debtToken
            );
            assertDistinctLendingTokens(
              context,
              collateralToken,
              debtToken,
              "Lending health quote"
            );
            return {
              action: "borrow" as const,
              request: {
                collateralToken,
                debtToken,
                amount: context.parseAmountWithContext(
                  parsed.action.request.amount,
                  debtToken,
                  "lending borrow"
                ),
                ...(parsed.action.request.provider !== undefined && {
                  provider: parsed.action.request.provider,
                }),
                ...(parsed.action.request.poolAddress !== undefined && {
                  poolAddress: normalizeOptionalAddress(
                    parsed.action.request.poolAddress,
                    "pool"
                  ),
                }),
                ...(parsed.action.request.user !== undefined && {
                  user: normalizeOptionalAddress(
                    parsed.action.request.user,
                    "user"
                  ),
                }),
                ...(parsed.action.request.collateralAmount !== undefined && {
                  collateralAmount: context.parseAmountWithContext(
                    parsed.action.request.collateralAmount,
                    collateralToken,
                    "lending borrow collateral"
                  ),
                }),
                ...(parsed.action.request.collateralDenomination !==
                  undefined && {
                  collateralDenomination:
                    parsed.action.request.collateralDenomination,
                }),
                ...(parsed.action.request.debtDenomination !== undefined && {
                  debtDenomination: parsed.action.request.debtDenomination,
                }),
                ...(parsed.action.request.useEarnPosition !== undefined && {
                  useEarnPosition: parsed.action.request.useEarnPosition,
                }),
              },
            };
          }
          case "repay": {
            const collateralToken = context.resolveToken(
              parsed.action.request.collateralToken
            );
            const debtToken = context.resolveToken(
              parsed.action.request.debtToken
            );
            assertDistinctLendingTokens(
              context,
              collateralToken,
              debtToken,
              "Lending health quote"
            );
            return {
              action: "repay" as const,
              request: {
                collateralToken,
                debtToken,
                amount: context.parseAmountWithContext(
                  parsed.action.request.amount,
                  debtToken,
                  "lending repay"
                ),
                ...(parsed.action.request.provider !== undefined && {
                  provider: parsed.action.request.provider,
                }),
                ...(parsed.action.request.poolAddress !== undefined && {
                  poolAddress: normalizeOptionalAddress(
                    parsed.action.request.poolAddress,
                    "pool"
                  ),
                }),
                ...(parsed.action.request.user !== undefined && {
                  user: normalizeOptionalAddress(
                    parsed.action.request.user,
                    "user"
                  ),
                }),
                ...(parsed.action.request.collateralAmount !== undefined && {
                  collateralAmount: context.parseAmountWithContext(
                    parsed.action.request.collateralAmount,
                    collateralToken,
                    "lending repay collateral"
                  ),
                }),
                ...(parsed.action.request.collateralDenomination !==
                  undefined && {
                  collateralDenomination:
                    parsed.action.request.collateralDenomination,
                }),
                ...(parsed.action.request.debtDenomination !== undefined && {
                  debtDenomination: parsed.action.request.debtDenomination,
                }),
                ...(parsed.action.request.withdrawCollateral !== undefined && {
                  withdrawCollateral: parsed.action.request.withdrawCollateral,
                }),
              },
            };
          }
        }
      })();

      const quote = await context.withTimeout("Lending health quote", () =>
        wallet.lending().quoteHealth({
          action: actionInput,
          health: healthRequest,
          ...(parsed.sponsored && { feeMode: "sponsored" }),
        })
      );

      return {
        current: normalizeLendingHealth(quote.current),
        prepared: normalizePreparedLendingAction(context, quote.prepared, {
          includeCalls: true,
        }),
        simulation: normalizePreflightResult(quote.simulation),
        ...(quote.projected !== undefined && {
          projected: quote.projected
            ? normalizeLendingHealth(quote.projected)
            : null,
        }),
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

    case "starkzap_lending_deposit": {
      const parsed = schemas.starkzap_lending_deposit.parse(rawArgs);
      const wallet = await context.getWallet();
      const token = context.resolveToken(parsed.token);
      const amount = context.parseAmountWithContext(
        parsed.amount,
        token,
        "lending deposit"
      );
      assertAmountWithinCap(amount, token, context.maxAmount);
      const prepared = await context.withTimeout("Lending deposit build", () =>
        wallet.lending().prepareDeposit({
          token,
          amount,
          ...(parsed.provider !== undefined && { provider: parsed.provider }),
          ...(parsed.poolAddress !== undefined && {
            poolAddress: normalizeOptionalAddress(parsed.poolAddress, "pool"),
          }),
          ...(parsed.receiver !== undefined && {
            receiver: normalizeOptionalAddress(parsed.receiver, "receiver"),
          }),
        })
      );
      const feeMode = sponsoredFeeMode(parsed.sponsored);
      if (feeMode) {
        await context.assertWalletAccountClassHash(
          wallet,
          "Sponsored lending deposit preflight"
        );
      }
      const tx = await context.withTimeout(
        "Lending deposit transaction submission",
        () =>
          wallet.execute(prepared.calls, {
            ...(feeMode && { feeMode }),
          })
      );
      const txResult = await context.waitForTrackedTransaction(tx);
      if (feeMode) {
        await context.assertWalletAccountClassHash(
          wallet,
          "Sponsored lending deposit post-check"
        );
      }
      return {
        ...normalizeTxResult(txResult),
        ...normalizePreparedLendingAction(context, prepared),
        token: context.sanitizeTokenSymbol(token.symbol),
        tokenAddress: token.address,
        amount: amount.toUnit(),
        amountRaw: amount.toBase().toString(),
      };
    }

    case "starkzap_lending_withdraw": {
      const parsed = schemas.starkzap_lending_withdraw.parse(rawArgs);
      const wallet = await context.getWallet();
      const token = context.resolveToken(parsed.token);
      const amount = context.parseAmountWithContext(
        parsed.amount,
        token,
        "lending withdraw"
      );
      assertAmountWithinCap(amount, token, context.maxAmount);
      const prepared = await context.withTimeout("Lending withdraw build", () =>
        wallet.lending().prepareWithdraw({
          token,
          amount,
          ...(parsed.provider !== undefined && { provider: parsed.provider }),
          ...(parsed.poolAddress !== undefined && {
            poolAddress: normalizeOptionalAddress(parsed.poolAddress, "pool"),
          }),
          ...(parsed.receiver !== undefined && {
            receiver: normalizeOptionalAddress(parsed.receiver, "receiver"),
          }),
          ...(parsed.owner !== undefined && {
            owner: normalizeOptionalAddress(parsed.owner, "owner"),
          }),
        })
      );
      const feeMode = sponsoredFeeMode(parsed.sponsored);
      if (feeMode) {
        await context.assertWalletAccountClassHash(
          wallet,
          "Sponsored lending withdraw preflight"
        );
      }
      const tx = await context.withTimeout(
        "Lending withdraw transaction submission",
        () =>
          wallet.execute(prepared.calls, {
            ...(feeMode && { feeMode }),
          })
      );
      const txResult = await context.waitForTrackedTransaction(tx);
      if (feeMode) {
        await context.assertWalletAccountClassHash(
          wallet,
          "Sponsored lending withdraw post-check"
        );
      }
      return {
        ...normalizeTxResult(txResult),
        ...normalizePreparedLendingAction(context, prepared),
        token: context.sanitizeTokenSymbol(token.symbol),
        tokenAddress: token.address,
        amount: amount.toUnit(),
        amountRaw: amount.toBase().toString(),
      };
    }

    case "starkzap_lending_withdraw_max": {
      const parsed = schemas.starkzap_lending_withdraw_max.parse(rawArgs);
      const wallet = await context.getWallet();
      const token = context.resolveToken(parsed.token);
      const prepared = await context.withTimeout(
        "Lending max-withdraw build",
        () =>
          wallet.lending().prepareWithdrawMax({
            token,
            ...(parsed.provider !== undefined && { provider: parsed.provider }),
            ...(parsed.poolAddress !== undefined && {
              poolAddress: normalizeOptionalAddress(parsed.poolAddress, "pool"),
            }),
            ...(parsed.receiver !== undefined && {
              receiver: normalizeOptionalAddress(parsed.receiver, "receiver"),
            }),
            ...(parsed.owner !== undefined && {
              owner: normalizeOptionalAddress(parsed.owner, "owner"),
            }),
          })
      );
      const feeMode = sponsoredFeeMode(parsed.sponsored);
      if (feeMode) {
        await context.assertWalletAccountClassHash(
          wallet,
          "Sponsored lending max-withdraw preflight"
        );
      }
      const tx = await context.withTimeout(
        "Lending max-withdraw transaction submission",
        () =>
          wallet.execute(prepared.calls, {
            ...(feeMode && { feeMode }),
          })
      );
      const txResult = await context.waitForTrackedTransaction(tx);
      if (feeMode) {
        await context.assertWalletAccountClassHash(
          wallet,
          "Sponsored lending max-withdraw post-check"
        );
      }
      return {
        ...normalizeTxResult(txResult),
        ...normalizePreparedLendingAction(context, prepared),
        toolAction: "withdrawMax",
        token: context.sanitizeTokenSymbol(token.symbol),
        tokenAddress: token.address,
      };
    }

    case "starkzap_lending_borrow": {
      const parsed = schemas.starkzap_lending_borrow.parse(rawArgs);
      const wallet = await context.getWallet();
      const collateralToken = context.resolveToken(parsed.collateralToken);
      const debtToken = context.resolveToken(parsed.debtToken);
      assertDistinctLendingTokens(
        context,
        collateralToken,
        debtToken,
        "Lending borrow"
      );
      const amount = context.parseAmountWithContext(
        parsed.amount,
        debtToken,
        "lending borrow"
      );
      assertAmountWithinCap(amount, debtToken, context.maxAmount);
      const prepared = await context.withTimeout("Lending borrow build", () =>
        wallet.lending().prepareBorrow({
          collateralToken,
          debtToken,
          amount,
          ...(parsed.provider !== undefined && { provider: parsed.provider }),
          ...(parsed.poolAddress !== undefined && {
            poolAddress: normalizeOptionalAddress(parsed.poolAddress, "pool"),
          }),
          ...(parsed.user !== undefined && {
            user: normalizeOptionalAddress(parsed.user, "user"),
          }),
          ...(parsed.collateralAmount !== undefined && {
            collateralAmount: context.parseAmountWithContext(
              parsed.collateralAmount,
              collateralToken,
              "lending borrow collateral"
            ),
          }),
          ...(parsed.collateralDenomination !== undefined && {
            collateralDenomination: parsed.collateralDenomination,
          }),
          ...(parsed.debtDenomination !== undefined && {
            debtDenomination: parsed.debtDenomination,
          }),
          ...(parsed.useEarnPosition !== undefined && {
            useEarnPosition: parsed.useEarnPosition,
          }),
        })
      );
      const feeMode = sponsoredFeeMode(parsed.sponsored);
      if (feeMode) {
        await context.assertWalletAccountClassHash(
          wallet,
          "Sponsored lending borrow preflight"
        );
      }
      const tx = await context.withTimeout(
        "Lending borrow transaction submission",
        () =>
          wallet.execute(prepared.calls, {
            ...(feeMode && { feeMode }),
          })
      );
      const txResult = await context.waitForTrackedTransaction(tx);
      if (feeMode) {
        await context.assertWalletAccountClassHash(
          wallet,
          "Sponsored lending borrow post-check"
        );
      }
      return {
        ...normalizeTxResult(txResult),
        ...normalizePreparedLendingAction(context, prepared),
        collateralToken: context.sanitizeTokenSymbol(collateralToken.symbol),
        collateralTokenAddress: collateralToken.address,
        debtToken: context.sanitizeTokenSymbol(debtToken.symbol),
        debtTokenAddress: debtToken.address,
        amount: amount.toUnit(),
        amountRaw: amount.toBase().toString(),
        ...(parsed.collateralAmount !== undefined && {
          collateralAmount: context
            .parseAmountWithContext(
              parsed.collateralAmount,
              collateralToken,
              "lending borrow collateral"
            )
            .toUnit(),
        }),
      };
    }

    case "starkzap_lending_repay": {
      const parsed = schemas.starkzap_lending_repay.parse(rawArgs);
      const wallet = await context.getWallet();
      const collateralToken = context.resolveToken(parsed.collateralToken);
      const debtToken = context.resolveToken(parsed.debtToken);
      assertDistinctLendingTokens(
        context,
        collateralToken,
        debtToken,
        "Lending repay"
      );
      const amount = context.parseAmountWithContext(
        parsed.amount,
        debtToken,
        "lending repay"
      );
      assertAmountWithinCap(amount, debtToken, context.maxAmount);
      const prepared = await context.withTimeout("Lending repay build", () =>
        wallet.lending().prepareRepay({
          collateralToken,
          debtToken,
          amount,
          ...(parsed.provider !== undefined && { provider: parsed.provider }),
          ...(parsed.poolAddress !== undefined && {
            poolAddress: normalizeOptionalAddress(parsed.poolAddress, "pool"),
          }),
          ...(parsed.user !== undefined && {
            user: normalizeOptionalAddress(parsed.user, "user"),
          }),
          ...(parsed.collateralAmount !== undefined && {
            collateralAmount: context.parseAmountWithContext(
              parsed.collateralAmount,
              collateralToken,
              "lending repay collateral"
            ),
          }),
          ...(parsed.collateralDenomination !== undefined && {
            collateralDenomination: parsed.collateralDenomination,
          }),
          ...(parsed.debtDenomination !== undefined && {
            debtDenomination: parsed.debtDenomination,
          }),
          ...(parsed.withdrawCollateral !== undefined && {
            withdrawCollateral: parsed.withdrawCollateral,
          }),
        })
      );
      const feeMode = sponsoredFeeMode(parsed.sponsored);
      if (feeMode) {
        await context.assertWalletAccountClassHash(
          wallet,
          "Sponsored lending repay preflight"
        );
      }
      const tx = await context.withTimeout(
        "Lending repay transaction submission",
        () =>
          wallet.execute(prepared.calls, {
            ...(feeMode && { feeMode }),
          })
      );
      const txResult = await context.waitForTrackedTransaction(tx);
      if (feeMode) {
        await context.assertWalletAccountClassHash(
          wallet,
          "Sponsored lending repay post-check"
        );
      }
      return {
        ...normalizeTxResult(txResult),
        ...normalizePreparedLendingAction(context, prepared),
        collateralToken: context.sanitizeTokenSymbol(collateralToken.symbol),
        collateralTokenAddress: collateralToken.address,
        debtToken: context.sanitizeTokenSymbol(debtToken.symbol),
        debtTokenAddress: debtToken.address,
        amount: amount.toUnit(),
        amountRaw: amount.toBase().toString(),
        ...(parsed.collateralAmount !== undefined && {
          collateralAmount: context
            .parseAmountWithContext(
              parsed.collateralAmount,
              collateralToken,
              "lending repay collateral"
            )
            .toUnit(),
        }),
        ...(parsed.withdrawCollateral !== undefined && {
          withdrawCollateral: parsed.withdrawCollateral,
        }),
      };
    }
  }
}

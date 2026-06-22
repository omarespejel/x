import { createHash } from "node:crypto";
import { z } from "zod";
import { Amount, fromAddress, StarkSigner, StarkZap } from "starkzap";
import type { Address, Token, Wallet } from "starkzap";
import {
  FELT_REGEX,
  createTokenResolver,
  isClassHashNotFoundError,
  parseCliConfig,
  validateAddressOrThrow,
} from "./core.js";
import type {
  P0ActionContext,
  TrackedTransactionResult,
} from "./p0-actions.js";

const STARK_CURVE_ORDER = BigInt(
  "0x0800000000000011000000000000000000000000000000000000000000000001"
);
const FELT252_UPPER_BOUND = BigInt(
  "0x800000000000011000000000000000000000000000000000000000000000001"
);
const TX_WAIT_TIMEOUT_MS = 120_000;
const WALLET_DISCONNECT_TIMEOUT_MS = 5_000;

type AmountMethod =
  | "toUnit"
  | "toFormatted"
  | "toBase"
  | "getDecimals"
  | "gt"
  | "add"
  | "eq"
  | "isZero";

function normalizePrivateKeyHex(value: string): string {
  const hex = value.slice(2);
  return `0x${hex.padStart(64, "0")}`;
}

function isSecureRpcUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "https:") {
      return true;
    }
    if (url.protocol === "http:") {
      const rawHostname = url.hostname.toLowerCase();
      const hostname =
        rawHostname.startsWith("[") && rawHostname.endsWith("]")
          ? rawHostname.slice(1, -1)
          : rawHostname;
      return (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1"
      );
    }
    return false;
  } catch {
    return false;
  }
}

function summarizeError(error: unknown): string {
  const stringifySafe = (value: unknown): string => {
    try {
      return JSON.stringify(value, (_, current) =>
        typeof current === "bigint" ? current.toString() : current
      );
    } catch {
      return String(value);
    }
  };
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : stringifySafe(error);
  return raw
    .replace(/https?:\/\/[^\s)]+/gi, "<url>")
    .replace(/\[[\da-fA-F:]+\](?::\d{2,5})?/gi, "<host>")
    .replace(
      /\b(?:localhost|::1|(?:\d{1,3}\.){3}\d{1,3})(?::\d{2,5})?\b/gi,
      "<host>"
    )
    .replace(
      /(?<![\\/])\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{2,5})?\b/gi,
      "<host>"
    )
    .slice(0, 1024);
}

function createErrorReference(message: string): string {
  return createHash("sha256").update(message).digest("hex").slice(0, 16);
}

function containsSensitiveConnectionHints(value: string): boolean {
  const patterns = [
    /https?:\/\/[^\s)]+/i,
    /\[[\da-fA-F:]+\](?::\d{2,5})?/i,
    /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/,
    /\b(?:localhost|::1)(?::\d{2,5})?\b/i,
    /(?<![\\/])\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{2,5})?\b/i,
  ] as const;
  return patterns.some((pattern) => pattern.test(value));
}

function sanitizeExplorerUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) {
    return undefined;
  }
  if (rawUrl.length > 512) {
    return undefined;
  }
  try {
    const parsed = new URL(rawUrl);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "https:" && protocol !== "http:") {
      return undefined;
    }
    if (parsed.username || parsed.password) {
      return undefined;
    }
    return rawUrl;
  } catch {
    return undefined;
  }
}

function withTimeoutMessage(operation: string, timeoutMs: number): string {
  return `${operation} timed out after ${timeoutMs}ms`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildPaymasterConfig(env: {
  STARKNET_PAYMASTER_URL?: string;
  AVNU_PAYMASTER_API_KEY?: string;
}) {
  const headers: Record<string, string> = {};
  if (env.AVNU_PAYMASTER_API_KEY) {
    headers["x-paymaster-api-key"] = env.AVNU_PAYMASTER_API_KEY;
  }
  const nodeUrl = env.STARKNET_PAYMASTER_URL;
  if (!nodeUrl && Object.keys(headers).length === 0) {
    return undefined;
  }
  return {
    ...(nodeUrl && { nodeUrl }),
    ...(Object.keys(headers).length > 0 && { headers }),
  };
}

class TransactionWaitTimeoutError extends Error {
  constructor(
    readonly txHash: string,
    readonly timeoutMs: number
  ) {
    super(`Transaction ${txHash} confirmation timed out after ${timeoutMs}ms`);
    this.name = "TransactionWaitTimeoutError";
  }
}

export function isRpcLikeError(error: unknown): boolean {
  const rpcErrorCodes = new Set([
    "contract_not_found",
    "starknet_error_contract_not_found",
    "etimedout",
    "econnreset",
    "econnrefused",
    "enotfound",
    "eai_again",
    "network_error",
    "rpc_error",
    "request_timeout",
    "gateway_timeout",
    "-32000",
    "-32005",
  ]);
  const rpcErrorNames = new Set([
    "aborterror",
    "fetcherror",
    "networkerror",
    "timeouterror",
  ]);
  const statusBasedRpcErrors = new Set([408, 429, 500, 502, 503, 504]);

  const possibleCodes: string[] = [];
  const possibleNames: string[] = [];
  const possibleStatuses: number[] = [];
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (current instanceof Error) {
      possibleNames.push(current.name.toLowerCase());
    }
    if (!isRecord(current)) {
      continue;
    }
    if (typeof current.code === "string" || typeof current.code === "number") {
      possibleCodes.push(String(current.code).toLowerCase());
    }
    if (
      typeof current.status === "number" &&
      Number.isInteger(current.status) &&
      current.status > 0
    ) {
      possibleStatuses.push(current.status);
    }
    if (
      typeof current.statusCode === "number" &&
      Number.isInteger(current.statusCode) &&
      current.statusCode > 0
    ) {
      possibleStatuses.push(current.statusCode);
    }
    if (typeof current.name === "string") {
      possibleNames.push(current.name.toLowerCase());
    }
    if (isRecord(current.data)) {
      queue.push(current.data);
    }
    if (current.cause !== undefined) {
      queue.push(current.cause);
    }
  }

  if (possibleCodes.some((code) => rpcErrorCodes.has(code))) {
    return true;
  }
  if (possibleNames.some((name) => rpcErrorNames.has(name))) {
    return true;
  }
  if (possibleStatuses.some((status) => statusBasedRpcErrors.has(status))) {
    return true;
  }

  const normalized = summarizeError(error).toLowerCase();
  if (normalized.includes("confirmation timed out")) {
    return false;
  }
  const markers = [
    "timed out",
    "timeout",
    "gateway timeout",
    "connection refused",
    "connection reset",
    "network",
    "econn",
    "transport",
    "rpc",
    "failed to fetch",
    "socket",
  ];
  return markers.some((marker) => normalized.includes(marker));
}

const privateKeySchema = z
  .string()
  .regex(
    /^0x[0-9a-fA-F]{1,64}$/,
    "Must be a 0x-prefixed hex private key (1-64 hex chars)"
  )
  .transform(normalizePrivateKeyHex)
  .refine((value) => {
    const key = BigInt(value);
    return key !== 0n && key < STARK_CURVE_ORDER;
  }, "Private key must be cryptographically valid (non-zero and less than Stark curve order)");

const contractAddressSchema = z
  .string()
  .regex(FELT_REGEX, "Must be a 0x-prefixed hex string (1-64 hex chars)")
  .refine(
    (value) => {
      try {
        fromAddress(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid Starknet contract address" }
  );

const envSchema = z.object({
  STARKNET_PRIVATE_KEY: privateKeySchema,
  STARKNET_ACCOUNT_ADDRESS: contractAddressSchema.optional(),
  STARKNET_RPC_URL: z
    .string()
    .url()
    .refine(
      (value) => isSecureRpcUrl(value),
      "RPC URL must use HTTPS (HTTP is only allowed for localhost)"
    )
    .optional(),
  STARKNET_PAYMASTER_URL: z
    .string()
    .url()
    .refine(
      (value) => isSecureRpcUrl(value),
      "Paymaster URL must use HTTPS (HTTP is only allowed for localhost)"
    )
    .optional(),
  AVNU_PAYMASTER_API_KEY: z
    .string()
    .trim()
    .min(1, "AVNU paymaster API key cannot be empty")
    .max(256, "AVNU paymaster API key is too long")
    .optional(),
  STARKNET_RPC_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(300_000)
    .optional(),
});

export interface P0RuntimeHandle {
  cliConfig: ReturnType<typeof parseCliConfig>;
  context: P0ActionContext;
  buildToolErrorText(error: unknown): string;
  maybeResetWalletOnRpcError(error: unknown): Promise<void>;
  cleanupWalletAndSdkResources(): Promise<void>;
}

export function createP0Runtime(cliArgs: string[]): P0RuntimeHandle {
  const cliConfig = parseCliConfig(cliArgs);
  const envInput = {
    ...process.env,
    STARKNET_PRIVATE_KEY: process.env.STARKNET_PRIVATE_KEY,
    AVNU_PAYMASTER_API_KEY: process.env.AVNU_PAYMASTER_API_KEY,
  };
  const parsedEnv = envSchema.safeParse(envInput);
  if (!parsedEnv.success) {
    const details = parsedEnv.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid environment configuration: ${details}`);
  }
  const env = Object.freeze(parsedEnv.data);
  const rpcTimeoutMs = env.STARKNET_RPC_TIMEOUT_MS ?? 30_000;
  const paymasterConfig = buildPaymasterConfig(env);
  const sdkConfig = Object.freeze({
    network: cliConfig.network,
    ...(env.STARKNET_RPC_URL && { rpcUrl: env.STARKNET_RPC_URL }),
    ...(paymasterConfig && { paymaster: paymasterConfig }),
  });
  const resolveToken = createTokenResolver(cliConfig.network);

  let sdkSingleton: StarkZap | undefined;
  let walletSingleton: Wallet | undefined;
  let walletInitPromise: Promise<Wallet> | undefined;
  let walletInitFailureCount = 0;
  let walletInitBackoffUntilMs = 0;
  let sdkInitFailureCount = 0;
  let sdkInitBackoffUntilMs = 0;
  const activeTransactionHashes = new Set<string>();
  const timedOutTransactionHashes = new Set<string>();
  let cleanupPromise: Promise<void> | undefined;

  function nowMs(): number {
    return Date.now();
  }

  function getSdk(): StarkZap {
    if (sdkInitBackoffUntilMs > nowMs()) {
      const retryInMs = sdkInitBackoffUntilMs - nowMs();
      throw new Error(
        `SDK initialization temporarily throttled after recent failures. Retry in ${Math.ceil(retryInMs / 1000)}s.`
      );
    }
    if (!sdkSingleton) {
      try {
        sdkSingleton = new StarkZap(sdkConfig);
        sdkInitFailureCount = 0;
        sdkInitBackoffUntilMs = 0;
      } catch (error) {
        sdkInitFailureCount = Math.min(sdkInitFailureCount + 1, 10);
        const backoffMs = Math.min(
          300_000,
          500 * 2 ** (sdkInitFailureCount - 1)
        );
        sdkInitBackoffUntilMs = nowMs() + backoffMs;
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `SDK initialization failed. ${reason} Retry in ${Math.ceil(backoffMs / 1000)}s.`
        );
      }
    }
    return sdkSingleton;
  }

  async function withTimeout<T>(
    operation: string,
    promiseFactory: () => Promise<T>,
    timeoutMs: number = rpcTimeoutMs
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(withTimeoutMessage(operation, timeoutMs)));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promiseFactory(), timeout]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  async function getWallet(): Promise<Wallet> {
    if (walletSingleton) {
      return walletSingleton;
    }
    if (walletInitBackoffUntilMs > nowMs()) {
      const retryInMs = walletInitBackoffUntilMs - nowMs();
      throw new Error(
        `Wallet initialization temporarily throttled after recent failures. Retry in ${Math.ceil(retryInMs / 1000)}s.`
      );
    }
    if (!walletInitPromise) {
      const accountAddressOverride = env.STARKNET_ACCOUNT_ADDRESS
        ? validateAddressOrThrow(env.STARKNET_ACCOUNT_ADDRESS, "account")
        : undefined;
      walletInitPromise = withTimeout("Wallet initialization", () =>
        getSdk().connectWallet({
          account: {
            signer: new StarkSigner(env.STARKNET_PRIVATE_KEY),
          },
          ...(accountAddressOverride && {
            accountAddress: accountAddressOverride,
          }),
        })
      )
        .then((wallet) => {
          walletSingleton = wallet;
          walletInitFailureCount = 0;
          walletInitBackoffUntilMs = 0;
          walletInitPromise = undefined;
          return wallet;
        })
        .catch((error) => {
          walletInitPromise = undefined;
          walletInitFailureCount = Math.min(walletInitFailureCount + 1, 8);
          const backoffMs = Math.min(
            300_000,
            500 * 2 ** (walletInitFailureCount - 1)
          );
          walletInitBackoffUntilMs = nowMs() + backoffMs;
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Wallet initialization failed. ${reason} Retry in ${Math.ceil(backoffMs / 1000)}s.`
          );
        });
    }
    return walletInitPromise;
  }

  async function assertWalletAccountClassHash(
    wallet: Wallet,
    reason: string
  ): Promise<void> {
    const provider = wallet.getProvider();
    let deployedClassHash: string;
    try {
      deployedClassHash = fromAddress(
        await withTimeout("Wallet account class-hash verification", () =>
          provider.getClassHashAt(wallet.address)
        )
      );
    } catch (error) {
      if (isClassHashNotFoundError(error)) {
        throw new Error(
          `${reason} succeeded but wallet account is still not deployed on-chain.`
        );
      }
      throw error;
    }
    const expectedClassHash = fromAddress(wallet.getClassHash());
    if (deployedClassHash !== expectedClassHash) {
      throw new Error(
        `${reason} detected account class hash mismatch at ${wallet.address}. expected=${expectedClassHash} actual=${deployedClassHash}`
      );
    }
  }

  function assertAmountMethods(
    value: unknown,
    label: string,
    methods: readonly string[]
  ): asserts value is Amount {
    if (!isRecord(value)) {
      throw new Error(
        `Invalid ${label} returned by SDK: expected Amount-like object.`
      );
    }
    for (const method of methods as readonly AmountMethod[]) {
      if (typeof value[method] !== "function") {
        throw new Error(
          `Invalid ${label} returned by SDK: missing Amount method "${method}".`
        );
      }
    }
  }

  function parseAmountWithContext(
    literal: string,
    token: Token,
    context: string
  ): Amount {
    try {
      return Amount.parse(literal, token);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid ${context} amount "${literal}" for ${token.symbol}. ${reason}`
      );
    }
  }

  function sanitizeTokenSymbol(symbol: string): string {
    const sanitized = symbol.replace(/[^A-Za-z0-9 _-]/g, "").trim();
    if (!sanitized) {
      return "UNKNOWN";
    }
    return sanitized.slice(0, 32);
  }

  function assertDistinctSwapTokens(
    tokenIn: Token,
    tokenOut: Token,
    context: string
  ): void {
    const normalizedIn = fromAddress(tokenIn.address);
    const normalizedOut = fromAddress(tokenOut.address);
    if (normalizedIn === normalizedOut) {
      throw new Error(
        `${context}: tokenIn and tokenOut resolve to the same token (${sanitizeTokenSymbol(tokenIn.symbol)}).`
      );
    }
  }

  async function mapWithConcurrencyLimit<T, R>(
    items: readonly T[],
    limit: number,
    mapper: (item: T, index: number) => Promise<R>
  ): Promise<R[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`Invalid concurrency limit: ${limit}`);
    }
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (nextIndex < items.length) {
          const currentIndex = nextIndex;
          nextIndex += 1;
          results[currentIndex] = await mapper(
            items[currentIndex],
            currentIndex
          );
        }
      }
    );
    await Promise.all(workers);
    return results;
  }

  function assertSwapQuoteShape(quote: unknown): asserts quote is {
    amountInBase: bigint;
    amountOutBase: bigint;
    routeCallCount?: number;
    priceImpactBps?: bigint | null;
    provider?: string;
  } {
    const providerIdRegex = /^[A-Za-z0-9._:-]+$/;
    if (!isRecord(quote)) {
      throw new Error(
        "Invalid swap quote returned by SDK: expected object shape."
      );
    }
    if (typeof quote.amountInBase !== "bigint") {
      throw new Error(
        "Invalid swap quote returned by SDK: amountInBase must be bigint."
      );
    }
    if (typeof quote.amountOutBase !== "bigint") {
      throw new Error(
        "Invalid swap quote returned by SDK: amountOutBase must be bigint."
      );
    }
    const routeCallCount = quote.routeCallCount;
    if (routeCallCount !== undefined) {
      if (
        typeof routeCallCount !== "number" ||
        !Number.isInteger(routeCallCount) ||
        routeCallCount < 0
      ) {
        throw new Error(
          "Invalid swap quote returned by SDK: routeCallCount must be a non-negative integer."
        );
      }
    }
    if (
      quote.priceImpactBps !== undefined &&
      quote.priceImpactBps !== null &&
      typeof quote.priceImpactBps !== "bigint"
    ) {
      throw new Error(
        "Invalid swap quote returned by SDK: priceImpactBps must be bigint or null."
      );
    }
    if (
      quote.provider !== undefined &&
      (typeof quote.provider !== "string" ||
        quote.provider.length === 0 ||
        quote.provider.length > 64 ||
        !providerIdRegex.test(quote.provider))
    ) {
      throw new Error(
        "Invalid swap quote returned by SDK: provider must be a safe provider id."
      );
    }
  }

  function normalizeCallCalldataForResponse(
    calldata: unknown,
    label: string
  ): string[] {
    const maxCalldataItems = 2048;
    const maxCalldataItemChars = 256;
    const calldataDecimalRegex = /^\d+$/;
    const calldataHexRegex = /^0x[0-9a-fA-F]{1,64}$/;
    const assertFelt252Value = (value: bigint, index: number): void => {
      if (value >= FELT252_UPPER_BOUND) {
        throw new Error(
          `Invalid ${label} returned by SDK: calldata_${index} exceeds felt range.`
        );
      }
    };

    if (!Array.isArray(calldata)) {
      throw new Error(
        `Invalid ${label} returned by SDK: calldata must be an array.`
      );
    }
    if (calldata.length > maxCalldataItems) {
      throw new Error(
        `Invalid ${label} returned by SDK: calldata exceeds ${maxCalldataItems} items.`
      );
    }
    return calldata.map((item, index) => {
      if (typeof item === "bigint") {
        if (item < 0n) {
          throw new Error(
            `Invalid ${label} returned by SDK: calldata_${index} must be non-negative.`
          );
        }
        assertFelt252Value(item, index);
        return `0x${item.toString(16)}`;
      }
      if (typeof item === "number") {
        if (!Number.isSafeInteger(item) || item < 0) {
          throw new Error(
            `Invalid ${label} returned by SDK: calldata_${index} must be a non-negative safe integer.`
          );
        }
        assertFelt252Value(BigInt(item), index);
        return item.toString(10);
      }
      if (typeof item === "string") {
        const trimmed = item.trim();
        if (!trimmed || trimmed.length > maxCalldataItemChars) {
          throw new Error(
            `Invalid ${label} returned by SDK: calldata_${index} must be a felt-like hex or decimal string.`
          );
        }
        if (calldataDecimalRegex.test(trimmed)) {
          const decimalValue = BigInt(trimmed);
          assertFelt252Value(decimalValue, index);
          return trimmed;
        }
        if (calldataHexRegex.test(trimmed)) {
          assertFelt252Value(BigInt(trimmed), index);
          return trimmed;
        }
        throw new Error(
          `Invalid ${label} returned by SDK: calldata_${index} must be a felt-like hex or decimal string.`
        );
      }
      throw new Error(
        `Invalid ${label} returned by SDK: calldata_${index} has unsupported type.`
      );
    });
  }

  function normalizeCallForResponse(
    call: unknown,
    label: string
  ): { contractAddress: Address; entrypoint: string; calldata: string[] } {
    const entrypointIdentifierRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    if (!isRecord(call)) {
      throw new Error(
        `Invalid ${label} returned by SDK: call must be an object.`
      );
    }
    if (typeof call.contractAddress !== "string") {
      throw new Error(
        `Invalid ${label} returned by SDK: contractAddress must be a string.`
      );
    }
    const contractAddress = validateAddressOrThrow(
      call.contractAddress,
      "contract"
    );
    const entrypoint =
      typeof call.entrypoint === "string" ? call.entrypoint.trim() : "";
    if (
      entrypoint.length === 0 ||
      entrypoint.length > 64 ||
      !entrypointIdentifierRegex.test(entrypoint)
    ) {
      throw new Error(
        `Invalid ${label} returned by SDK: entrypoint must be a valid Cairo identifier.`
      );
    }
    return {
      contractAddress,
      entrypoint,
      calldata: normalizeCallCalldataForResponse(call.calldata ?? [], label),
    };
  }

  function normalizeTransactionHash(hash: string): string {
    if (!FELT_REGEX.test(hash)) {
      throw new Error(`Invalid transaction hash returned by SDK: "${hash}"`);
    }
    const normalized = fromAddress(hash);
    if (BigInt(normalized) === 0n) {
      throw new Error(`Invalid transaction hash returned by SDK: "${hash}"`);
    }
    return normalized;
  }

  async function waitWithTimeout(
    tx: { wait: () => Promise<void>; hash: string },
    timeoutMs: number = TX_WAIT_TIMEOUT_MS
  ): Promise<void> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new TransactionWaitTimeoutError(tx.hash, timeoutMs));
      }, timeoutMs);
    });
    try {
      await Promise.race([tx.wait(), timeout]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  async function waitForTrackedTransaction(tx: {
    wait: () => Promise<void>;
    hash: string;
    explorerUrl?: string;
  }): Promise<TrackedTransactionResult> {
    const normalizedHash = normalizeTransactionHash(tx.hash);
    const explorerUrl = sanitizeExplorerUrl(tx.explorerUrl);
    activeTransactionHashes.add(normalizedHash);
    try {
      await waitWithTimeout(
        { wait: () => tx.wait(), hash: normalizedHash },
        TX_WAIT_TIMEOUT_MS
      );
    } catch (error) {
      if (error instanceof TransactionWaitTimeoutError) {
        timedOutTransactionHashes.add(normalizedHash);
        const explorerHint = explorerUrl
          ? ` Check status in explorer: ${explorerUrl}.`
          : "";
        throw new Error(
          `Transaction ${normalizedHash} was submitted but not confirmed within ${error.timeoutMs}ms.${explorerHint} Avoid blind retries to prevent duplicate intents.`
        );
      }
      throw error;
    } finally {
      activeTransactionHashes.delete(normalizedHash);
    }
    timedOutTransactionHashes.delete(normalizedHash);
    return { hash: normalizedHash, ...(explorerUrl && { explorerUrl }) };
  }

  async function cleanupWalletAndSdkResources(): Promise<void> {
    if (cleanupPromise) {
      return cleanupPromise;
    }
    cleanupPromise = (async () => {
      const wallet = walletSingleton;
      walletSingleton = undefined;
      walletInitPromise = undefined;
      sdkSingleton = undefined;
      walletInitFailureCount = 0;
      walletInitBackoffUntilMs = 0;
      sdkInitFailureCount = 0;
      sdkInitBackoffUntilMs = 0;
      activeTransactionHashes.clear();
      timedOutTransactionHashes.clear();
      if (wallet && typeof wallet.disconnect === "function") {
        try {
          await withTimeout(
            "Wallet disconnect",
            async () => {
              await wallet.disconnect();
            },
            WALLET_DISCONNECT_TIMEOUT_MS
          );
        } catch {
          // best effort cleanup only
        }
      }
    })();
    try {
      await cleanupPromise;
    } finally {
      cleanupPromise = undefined;
    }
  }

  async function maybeResetWalletOnRpcError(error: unknown): Promise<void> {
    if (!isRpcLikeError(error)) {
      return;
    }
    await cleanupWalletAndSdkResources();
  }

  function buildToolErrorText(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const normalizedMessage = message.replace(/\s+/g, " ").trim();
    const requestId = createErrorReference(message);
    const safeMessagePrefixes = [
      "Invalid ",
      "Unknown ",
      "Amount ",
      "Token ",
      "Cannot ",
      "Total ",
      "Could ",
      "Rate ",
      "Sponsored ",
      "Transaction ",
      "Address ",
      "Swap ",
      "Build swap calls:",
      "Build calls ",
      "starkzap_",
    ];
    const hasSafePrefix = safeMessagePrefixes.some((prefix) =>
      normalizedMessage.startsWith(prefix)
    );
    const exceedsSafeLength = normalizedMessage.length > 512;
    const safeMessage =
      hasSafePrefix &&
      !containsSensitiveConnectionHints(normalizedMessage) &&
      !exceedsSafeLength
        ? normalizedMessage
        : `Operation failed. Reference: ${requestId}`;
    return `Error: ${safeMessage}`;
  }

  const context: P0ActionContext = {
    maxAmount: cliConfig.maxAmount,
    getWallet,
    resolveToken,
    withTimeout,
    parseAmountWithContext,
    sanitizeTokenSymbol,
    mapWithConcurrencyLimit,
    assertAmountMethods,
    assertDistinctSwapTokens,
    assertSwapQuoteShape,
    assertWalletAccountClassHash,
    waitForTrackedTransaction,
    normalizeCallForResponse,
  };

  return {
    cliConfig,
    context,
    buildToolErrorText,
    maybeResetWalletOnRpcError,
    cleanupWalletAndSdkResources,
  };
}

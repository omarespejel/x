import { readFileSync } from "node:fs";
import {
  P0_ACTION_MANIFEST,
  isP0ActionName,
  runP0Action,
} from "../../mcp-server/src/p0-actions.js";
import type { P0ActionName } from "../../mcp-server/src/p0-actions.js";
import { createP0Runtime } from "../../mcp-server/src/p0-runtime.js";

const GLOBAL_VALUE_FLAGS = new Set([
  "network",
  "max-amount",
  "max-batch-amount",
  "rate-limit-rpm",
  "read-rate-limit-rpm",
  "write-rate-limit-rpm",
]);
const GLOBAL_BOOLEAN_FLAGS = new Set(["enable-write", "enable-execute"]);

type OutputWriter = Pick<typeof process.stdout, "write">;

export type ParsedInvocation =
  | { kind: "help"; globalArgs: string[] }
  | { kind: "list"; globalArgs: string[]; json: boolean }
  | {
      kind: "run";
      globalArgs: string[];
      toolName: P0ActionName;
      input: Record<string, unknown>;
    };

function readJsonValue(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label}: ${reason}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label}: expected a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function readJsonObjectOption(
  value: string | undefined,
  file: string | undefined,
  label: string
): Record<string, unknown> {
  if (value && file) {
    throw new Error(`Use either --${label} or --${label}-file, not both.`);
  }
  if (file) {
    return readJsonValue(readFileSync(file, "utf8"), `${label}-file`);
  }
  if (value) {
    return readJsonValue(value, label);
  }
  throw new Error(`Missing --${label} or --${label}-file.`);
}

function readJsonArrayOption(
  value: string | undefined,
  file: string | undefined,
  label: string
): unknown[] {
  if (value && file) {
    throw new Error(`Use either --${label} or --${label}-file, not both.`);
  }
  const raw = file ? readFileSync(file, "utf8") : value;
  if (!raw) {
    throw new Error(`Missing --${label} or --${label}-file.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label}: ${reason}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid ${label}: expected a JSON array.`);
  }
  return parsed;
}

function parseIntegerOption(
  value: string | undefined,
  flagName: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `Invalid --${flagName} value "${value}". Must be a non-negative integer.`
    );
  }
  return Number.parseInt(value, 10);
}

function takeOptionValue(
  values: Map<string, string[]>,
  flagName: string
): string | undefined {
  const bucket = values.get(flagName);
  if (!bucket || bucket.length === 0) {
    return undefined;
  }
  if (bucket.length > 1) {
    throw new Error(`Flag --${flagName} may only be provided once.`);
  }
  return bucket[0];
}

function takeRepeatedValues(
  values: Map<string, string[]>,
  flagName: string
): string[] {
  return values.get(flagName) ?? [];
}

function parseFlagBuckets(args: string[]): {
  positionals: string[];
  values: Map<string, string[]>;
  booleans: Set<string>;
} {
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const flagName = token.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      booleans.add(flagName);
      continue;
    }
    const bucket = values.get(flagName) ?? [];
    bucket.push(next);
    values.set(flagName, bucket);
    index += 1;
  }

  return { positionals, values, booleans };
}

export function extractGlobalArgs(args: string[]): {
  globalArgs: string[];
  commandArgs: string[];
} {
  const globalArgs: string[] = [];
  const commandArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      commandArgs.push(token);
      continue;
    }
    const flagName = token.slice(2);
    if (GLOBAL_BOOLEAN_FLAGS.has(flagName)) {
      globalArgs.push(token);
      continue;
    }
    if (GLOBAL_VALUE_FLAGS.has(flagName)) {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`Missing value for flag --${flagName}`);
      }
      globalArgs.push(token, next);
      index += 1;
      continue;
    }
    commandArgs.push(token);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      commandArgs.push(next);
      index += 1;
    }
  }

  return { globalArgs, commandArgs };
}

function csvOrRepeated(
  values: Map<string, string[]>,
  singularFlag: string,
  pluralFlag: string
): string[] {
  const repeated = takeRepeatedValues(values, singularFlag);
  const csv = takeOptionValue(values, pluralFlag);
  const csvValues = csv
    ? csv
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const combined = [...repeated, ...csvValues];
  if (combined.length === 0) {
    throw new Error(`Missing --${singularFlag} or --${pluralFlag}.`);
  }
  return combined;
}

function parseErgonomicCommand(
  commandName: string,
  values: Map<string, string[]>,
  booleans: Set<string>
): { toolName: P0ActionName; input: Record<string, unknown> } {
  switch (commandName) {
    case "get-balances":
      return {
        toolName: "starkzap_get_balances",
        input: {
          tokens: csvOrRepeated(values, "token", "tokens"),
        },
      };
    case "get-quote":
      return {
        toolName: "starkzap_get_quote",
        input: {
          tokenIn: takeOptionValue(values, "token-in"),
          tokenOut: takeOptionValue(values, "token-out"),
          amountIn: takeOptionValue(values, "amount-in"),
          ...(takeOptionValue(values, "provider") && {
            provider: takeOptionValue(values, "provider"),
          }),
          ...(parseIntegerOption(
            takeOptionValue(values, "slippage-bps"),
            "slippage-bps"
          ) !== undefined && {
            slippageBps: parseIntegerOption(
              takeOptionValue(values, "slippage-bps"),
              "slippage-bps"
            ),
          }),
        },
      };
    case "build-swap-calls":
      return {
        toolName: "starkzap_build_swap_calls",
        input: {
          tokenIn: takeOptionValue(values, "token-in"),
          tokenOut: takeOptionValue(values, "token-out"),
          amountIn: takeOptionValue(values, "amount-in"),
          ...(takeOptionValue(values, "provider") && {
            provider: takeOptionValue(values, "provider"),
          }),
          ...(parseIntegerOption(
            takeOptionValue(values, "slippage-bps"),
            "slippage-bps"
          ) !== undefined && {
            slippageBps: parseIntegerOption(
              takeOptionValue(values, "slippage-bps"),
              "slippage-bps"
            ),
          }),
        },
      };
    case "swap":
      return {
        toolName: "starkzap_swap",
        input: {
          tokenIn: takeOptionValue(values, "token-in"),
          tokenOut: takeOptionValue(values, "token-out"),
          amountIn: takeOptionValue(values, "amount-in"),
          ...(takeOptionValue(values, "provider") && {
            provider: takeOptionValue(values, "provider"),
          }),
          ...(parseIntegerOption(
            takeOptionValue(values, "slippage-bps"),
            "slippage-bps"
          ) !== undefined && {
            slippageBps: parseIntegerOption(
              takeOptionValue(values, "slippage-bps"),
              "slippage-bps"
            ),
          }),
          ...(booleans.has("sponsored") && { sponsored: true }),
        },
      };
    case "build-calls":
      return {
        toolName: "starkzap_build_calls",
        input: {
          calls: readJsonArrayOption(
            takeOptionValue(values, "calls"),
            takeOptionValue(values, "calls-file"),
            "calls"
          ),
        },
      };
    default:
      throw new Error(`Unknown command "${commandName}".`);
  }
}

export function parseCliInvocation(args: string[]): ParsedInvocation {
  const { globalArgs, commandArgs } = extractGlobalArgs(args);
  const [command, ...rest] = commandArgs;
  if (!command || command === "help" || command === "--help") {
    return { kind: "help", globalArgs };
  }
  const { positionals, values, booleans } = parseFlagBuckets(rest);
  if (command === "list") {
    return { kind: "list", globalArgs, json: booleans.has("json") };
  }
  if (command === "run") {
    const toolName = positionals[0];
    if (!toolName || !isP0ActionName(toolName)) {
      throw new Error(`Unknown P0 action "${toolName ?? ""}".`);
    }
    const input = readJsonObjectOption(
      takeOptionValue(values, "input"),
      takeOptionValue(values, "input-file"),
      "input"
    );
    return {
      kind: "run",
      globalArgs,
      toolName,
      input,
    };
  }
  const parsed = parseErgonomicCommand(command, values, booleans);
  return {
    kind: "run",
    globalArgs,
    toolName: parsed.toolName,
    input: parsed.input,
  };
}

export function buildHelpText(): string {
  const commandLines = P0_ACTION_MANIFEST.map(
    (entry) => `  ${entry.commandName.padEnd(18)} ${entry.summary}`
  ).join("\n");
  return [
    "starkzap-cli",
    "",
    "Usage:",
    "  starkzap-cli list [--json] [global flags]",
    "  starkzap-cli run <tool-name> --input '{...}' [global flags]",
    "  starkzap-cli get-balances --tokens STRK,ETH [global flags]",
    "  starkzap-cli get-quote --token-in STRK --token-out ETH --amount-in 1 [global flags]",
    "  starkzap-cli build-swap-calls --token-in STRK --token-out ETH --amount-in 1 [global flags]",
    "  starkzap-cli build-calls --calls '[{...}]' [global flags]",
    "  starkzap-cli swap --token-in STRK --token-out ETH --amount-in 1 --enable-write [global flags]",
    "",
    "P0 commands:",
    commandLines,
    "",
    "Global flags:",
    "  --network <mainnet|sepolia>",
    "  --max-amount <decimal>",
    "  --max-batch-amount <decimal>",
    "  --rate-limit-rpm <int>",
    "  --read-rate-limit-rpm <int>",
    "  --write-rate-limit-rpm <int>",
    "  --enable-write",
    "  --enable-execute",
    "",
    "Exact parity mode:",
    "  run accepts the same JSON object shape as the MCP tool input schema.",
  ].join("\n");
}

export async function runCli(
  args: string[],
  stdout: OutputWriter = process.stdout,
  stderr: OutputWriter = process.stderr
): Promise<number> {
  const invocation = parseCliInvocation(args);
  if (invocation.kind === "help") {
    stdout.write(`${buildHelpText()}\n`);
    return 0;
  }
  if (invocation.kind === "list") {
    if (invocation.json) {
      stdout.write(`${JSON.stringify(P0_ACTION_MANIFEST, null, 2)}\n`);
      return 0;
    }
    stdout.write(`${buildHelpText()}\n`);
    return 0;
  }

  const runtime = createP0Runtime(invocation.globalArgs);
  const manifestEntry = P0_ACTION_MANIFEST.find(
    (entry) => entry.toolName === invocation.toolName
  );
  if (!manifestEntry) {
    throw new Error(`Unknown P0 action "${invocation.toolName}".`);
  }
  if (manifestEntry.requiresWrite && !runtime.cliConfig.enableWrite) {
    stderr.write(
      `Error: ${manifestEntry.toolName} is a state-changing command and requires --enable-write.\n`
    );
    return 1;
  }

  try {
    const output = await runP0Action(
      runtime.context,
      invocation.toolName,
      invocation.input
    );
    stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  } catch (error) {
    await runtime.maybeResetWalletOnRpcError(error);
    stderr.write(`${runtime.buildToolErrorText(error)}\n`);
    return 1;
  } finally {
    await runtime.cleanupWalletAndSdkResources();
  }
}

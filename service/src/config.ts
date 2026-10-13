import { getAddress, isAddress, parseEther, parseGwei, type Address, type Hex } from "viem";
import { z } from "zod";
import type { ClientIpSettings } from "./http/client";
import { MAX_SETTLE_IDS } from "./validation";

export const MONAD_MAINNET = 143;

/** Everything the service needs to know that is not a secret. Safe to log. */
export interface Settings {
  chainId: number;
  /** Path prefix the host application mounts the handlers under, for example `/api`. */
  basePath: string;
  contracts: {
    token: Address;
    coverBook: Address;
    coverPool: Address;
    weatherIndex: Address;
  };
  quote: {
    ttlSeconds: number;
    maxRatePerSecond: bigint;
    maxDurationSeconds: number;
    minPremiumBps: number;
  };
  relayer: {
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    minBalance: bigint;
    receiptTimeoutMs: number;
  };
  limits: {
    windowSeconds: number;
    quotePerIp: number;
    quotePerAddress: number;
    relayPerIp: number;
    relayPerAddress: number;
    relayGlobal: number;
    coverPerIp: number;
    blobPerIp: number;
    blobPerAddress: number;
    sandboxPerIp: number;
  };
  clientIp: ClientIpSettings;
  keeper: {
    maxReadingsPerReport: number;
    settleBatch: number;
    scanLimit: number;
    firstReadingSeconds: number;
    heartbeatCell: { lat: number; lon: number };
  };
  x402: {
    enabled: boolean;
    facilitatorUrl: string;
    maxTimeoutSeconds: number;
  };
  blobs: {
    maxBytes: number;
    maxPerAddress: number;
    clockSkewSeconds: number;
  };
  sandbox: {
    enabled: boolean;
    simulatorKey: bigint | null;
  };
}

/** Keys, shared secrets and connection strings. Never logged, never returned. */
export interface Secrets {
  rpcUrl: string;
  underwriterKey: Hex;
  relayerKey: Hex;
  reporterKey: Hex | undefined;
  cronSecret: string | undefined;
  sandboxSecret: string | undefined;
  databaseUrl: string | undefined;
}

export interface Config {
  settings: Settings;
  secrets: Secrets;
}

/** Raised when the environment is incomplete or inconsistent. Lists variable names, never their values. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const integer = (min: number, max: number, fallback?: number) => {
  const schema = z.coerce.number().int().min(min).max(max);
  return fallback === undefined ? schema : schema.default(fallback);
};

const flag = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((value) => value === "true" || value === "1");

const contractAddress = z
  .string()
  .refine((value) => isAddress(value, { strict: true }), "expected an address")
  .transform((value) => getAddress(value));

const privateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte hex private key")
  .transform((value) => value.toLowerCase() as Hex);

const sharedSecret = z.string().min(24, "expected at least 24 characters");

const url = z.url({ protocol: /^https?$/, error: "expected an http(s) URL" });

const decimal = (pattern: RegExp, message: string) => z.string().regex(pattern, message);

const environment = z.object({
  CHAIN_ID: integer(1, 2 ** 31),
  RPC_URL: url,
  BASE_PATH: z
    .string()
    .regex(/^(\/[A-Za-z0-9_-]+)*$/, "expected a path such as /api")
    .default(""),

  TOKEN_ADDRESS: contractAddress,
  COVER_BOOK_ADDRESS: contractAddress,
  COVER_POOL_ADDRESS: contractAddress,
  WEATHER_INDEX_ADDRESS: contractAddress,

  UNDERWRITER_PRIVATE_KEY: privateKey,
  RELAYER_PRIVATE_KEY: privateKey,
  REPORTER_PRIVATE_KEY: privateKey.optional(),

  QUOTE_TTL_SECONDS: integer(15, 600, 120),
  QUOTE_MAX_RATE_PER_SECOND: decimal(/^[1-9]\d{0,30}$/, "expected a positive integer in token base units").default("10000"),
  QUOTE_MAX_DURATION_SECONDS: integer(60, 86_400, 43_200),
  QUOTE_MIN_PREMIUM_BPS: integer(1, 10_000, 100),

  RELAYER_MAX_FEE_GWEI: decimal(/^\d{1,6}(\.\d{1,9})?$/, "expected a gwei amount").default("300"),
  RELAYER_PRIORITY_FEE_GWEI: decimal(/^\d{1,6}(\.\d{1,9})?$/, "expected a gwei amount").default("2"),
  RELAYER_MIN_BALANCE: decimal(/^\d{1,9}(\.\d{1,18})?$/, "expected an amount of the native token").default("1"),
  RELAYER_RECEIPT_TIMEOUT_MS: integer(1_000, 120_000, 15_000),

  RATE_QUOTE_PER_IP: integer(1, 100_000, 60),
  RATE_QUOTE_PER_ADDRESS: integer(1, 100_000, 30),
  RATE_RELAY_PER_IP: integer(1, 100_000, 20),
  RATE_RELAY_PER_ADDRESS: integer(1, 100_000, 10),
  RATE_RELAY_GLOBAL: integer(1, 100_000, 120),
  RATE_COVER_PER_IP: integer(1, 100_000, 30),
  RATE_BLOB_PER_IP: integer(1, 100_000, 60),
  RATE_BLOB_PER_ADDRESS: integer(1, 100_000, 30),
  RATE_SANDBOX_PER_IP: integer(1, 100_000, 10),
  CLIENT_IP_HEADER: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/, "expected a header name")
    .default("x-forwarded-for"),
  TRUSTED_PROXY_HOPS: integer(1, 10, 1),

  CRON_SECRET: sharedSecret.optional(),
  KEEPER_MAX_READINGS_PER_REPORT: integer(1, 20, 20),
  KEEPER_SETTLE_BATCH: integer(1, MAX_SETTLE_IDS, 8),
  KEEPER_SCAN_LIMIT: integer(1, 5_000, 500),
  KEEPER_FIRST_READING_SECONDS: integer(60, 1_800, 300),
  KEEPER_HEARTBEAT_LAT: z.coerce.number().min(-90).max(90).default(52.2297),
  KEEPER_HEARTBEAT_LON: z.coerce.number().min(-180).max(180).default(21.0122),

  X402_ENABLED: flag,
  X402_FACILITATOR_URL: url.default("https://x402-facilitator.molandak.org"),
  X402_MAX_TIMEOUT_SECONDS: integer(30, 600, 120),

  BLOB_MAX_BYTES: integer(1, 4 * 1024 * 1024, 256 * 1024),
  BLOB_MAX_PER_ADDRESS: integer(1, 1_000, 16),
  BLOB_CLOCK_SKEW_SECONDS: integer(30, 900, 300),

  SANDBOX_ENABLED: flag,
  SANDBOX_SECRET: sharedSecret.optional(),
  SANDBOX_SIMULATOR_KEY: decimal(/^(0x[0-9a-fA-F]{1,64}|[1-9]\d{0,77})$/, "expected a uint256 cell key").optional(),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: "expected a postgres:// URL" }).optional(),
});

type Environment = z.infer<typeof environment>;

function crossChecks(env: Environment): string[] {
  const problems: string[] = [];

  if (env.SANDBOX_ENABLED) {
    if (env.CHAIN_ID === MONAD_MAINNET) problems.push("SANDBOX_ENABLED: the sandbox cannot run on chain 143");
    if (!env.SANDBOX_SECRET) problems.push("SANDBOX_SECRET: required when the sandbox is enabled");
    if (!env.SANDBOX_SIMULATOR_KEY) problems.push("SANDBOX_SIMULATOR_KEY: required when the sandbox is enabled");
  }

  const keys = [env.UNDERWRITER_PRIVATE_KEY, env.RELAYER_PRIVATE_KEY, env.REPORTER_PRIVATE_KEY].filter(Boolean);
  if (new Set(keys).size !== keys.length) {
    problems.push("UNDERWRITER_PRIVATE_KEY, RELAYER_PRIVATE_KEY, REPORTER_PRIVATE_KEY: each role needs its own key");
  }

  const contracts = [env.TOKEN_ADDRESS, env.COVER_BOOK_ADDRESS, env.COVER_POOL_ADDRESS, env.WEATHER_INDEX_ADDRESS];
  if (new Set(contracts).size !== contracts.length) {
    problems.push("TOKEN_ADDRESS, COVER_BOOK_ADDRESS, COVER_POOL_ADDRESS, WEATHER_INDEX_ADDRESS: must be distinct");
  }

  if (parseGwei(env.RELAYER_PRIORITY_FEE_GWEI) > parseGwei(env.RELAYER_MAX_FEE_GWEI)) {
    problems.push("RELAYER_PRIORITY_FEE_GWEI: cannot exceed RELAYER_MAX_FEE_GWEI");
  }

  if (env.CRON_SECRET && env.SANDBOX_SECRET && env.CRON_SECRET === env.SANDBOX_SECRET) {
    problems.push("CRON_SECRET, SANDBOX_SECRET: must differ");
  }

  return problems;
}

/**
 * Reads the whole configuration from environment variables. This is the only place the service looks at the
 * environment. Blank values count as unset.
 */
export function loadConfig(source: Record<string, string | undefined>): Config {
  const relevant: Record<string, string | undefined> = {};
  for (const name of Object.keys(environment.shape)) {
    const value = source[name]?.trim();
    relevant[name] = value === undefined || value === "" ? undefined : value;
  }

  const parsed = environment.safeParse(relevant);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const name = String(issue.path[0] ?? "environment");
      const missing = relevant[name] === undefined;
      return `${name}: ${missing ? "required" : issue.message}`;
    });
    throw new ConfigError([...new Set(problems)]);
  }

  const env = parsed.data;
  const problems = crossChecks(env);
  if (problems.length > 0) throw new ConfigError(problems);

  const settings: Settings = {
    chainId: env.CHAIN_ID,
    basePath: env.BASE_PATH,
    contracts: {
      token: env.TOKEN_ADDRESS,
      coverBook: env.COVER_BOOK_ADDRESS,
      coverPool: env.COVER_POOL_ADDRESS,
      weatherIndex: env.WEATHER_INDEX_ADDRESS,
    },
    quote: {
      ttlSeconds: env.QUOTE_TTL_SECONDS,
      maxRatePerSecond: BigInt(env.QUOTE_MAX_RATE_PER_SECOND),
      maxDurationSeconds: env.QUOTE_MAX_DURATION_SECONDS,
      minPremiumBps: env.QUOTE_MIN_PREMIUM_BPS,
    },
    relayer: {
      maxFeePerGas: parseGwei(env.RELAYER_MAX_FEE_GWEI),
      maxPriorityFeePerGas: parseGwei(env.RELAYER_PRIORITY_FEE_GWEI),
      minBalance: parseEther(env.RELAYER_MIN_BALANCE),
      receiptTimeoutMs: env.RELAYER_RECEIPT_TIMEOUT_MS,
    },
    limits: {
      windowSeconds: 60,
      quotePerIp: env.RATE_QUOTE_PER_IP,
      quotePerAddress: env.RATE_QUOTE_PER_ADDRESS,
      relayPerIp: env.RATE_RELAY_PER_IP,
      relayPerAddress: env.RATE_RELAY_PER_ADDRESS,
      relayGlobal: env.RATE_RELAY_GLOBAL,
      coverPerIp: env.RATE_COVER_PER_IP,
      blobPerIp: env.RATE_BLOB_PER_IP,
      blobPerAddress: env.RATE_BLOB_PER_ADDRESS,
      sandboxPerIp: env.RATE_SANDBOX_PER_IP,
    },
    clientIp: { header: env.CLIENT_IP_HEADER.toLowerCase(), trustedHops: env.TRUSTED_PROXY_HOPS },
    keeper: {
      maxReadingsPerReport: env.KEEPER_MAX_READINGS_PER_REPORT,
      settleBatch: env.KEEPER_SETTLE_BATCH,
      scanLimit: env.KEEPER_SCAN_LIMIT,
      firstReadingSeconds: env.KEEPER_FIRST_READING_SECONDS,
      heartbeatCell: { lat: env.KEEPER_HEARTBEAT_LAT, lon: env.KEEPER_HEARTBEAT_LON },
    },
    x402: {
      enabled: env.X402_ENABLED,
      facilitatorUrl: env.X402_FACILITATOR_URL,
      maxTimeoutSeconds: env.X402_MAX_TIMEOUT_SECONDS,
    },
    blobs: {
      maxBytes: env.BLOB_MAX_BYTES,
      maxPerAddress: env.BLOB_MAX_PER_ADDRESS,
      clockSkewSeconds: env.BLOB_CLOCK_SKEW_SECONDS,
    },
    sandbox: {
      enabled: env.SANDBOX_ENABLED,
      simulatorKey: env.SANDBOX_ENABLED && env.SANDBOX_SIMULATOR_KEY ? BigInt(env.SANDBOX_SIMULATOR_KEY) : null,
    },
  };

  const secrets: Secrets = {
    rpcUrl: env.RPC_URL,
    underwriterKey: env.UNDERWRITER_PRIVATE_KEY,
    relayerKey: env.RELAYER_PRIVATE_KEY,
    reporterKey: env.REPORTER_PRIVATE_KEY,
    cronSecret: env.CRON_SECRET,
    sandboxSecret: env.SANDBOX_ENABLED ? env.SANDBOX_SECRET : undefined,
    databaseUrl: env.DATABASE_URL,
  };

  return { settings, secrets };
}

import { CLAUDE_CLIENT_ID, CLIENT_ID_VARIABLE } from "./constants.js";
import type { AccountsEnums, Config } from "./contract.js";

const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * What this plugin's configuration says, under names that read as code.
 *
 * @remarks The three URLs are settings so a test points them at a loopback fixture.
 *
 * @implNote `authorizeUrl` must stay on claude.ai: that host grants a subscription token with a real
 * `user:inference` entitlement, while platform.claude.com mints an API-key-mode token that
 * `/v1/messages` rejects with a 403. The host decides this, not the scope.
 */
export interface ClaudeSettings {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly apiBase: string;
  /** A forebay_accounts_strategy. */
  readonly strategy: number;
  readonly logging: boolean;
  readonly maxAccountAttempts: number;
  readonly defaultCooldownSeconds: number;
  readonly maxCooldownSeconds: number;
  /** The start of every model id this provider offers. */
  readonly modelPrefix: string;
  /** The context window of a model the upstream names none for. */
  readonly defaultContext: number;
  /** The output limit of a model the upstream names none for. */
  readonly defaultOutput: number;
}

type SettingType = "string" | "number" | "boolean";

async function required<Value>(config: Config, key: string, type: SettingType): Promise<Value> {
  const answer = await config.get_tree({ key });
  if (answer === undefined || typeof answer === "symbol") throw new Error(`the ${key} setting is missing from claude-code-provider's configuration`);
  if (typeof answer !== type) throw new Error(`the ${key} setting of claude-code-provider must be a ${type}`);
  return answer as Value;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || LOOPBACK_IPV4.test(hostname);
}

function isSafeForTokens(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));
  } catch {
    return false;
  }
}

async function tokenBearingUrl(config: Config, key: string): Promise<string> {
  const value = await required<string>(config, key, "string");
  if (!isSafeForTokens(value)) throw new Error(`the ${key} setting of claude-code-provider must be an https url, or http on a loopback address, because account tokens are sent to it`);
  return value;
}

/** The strategies by the names the setting takes. */
function strategiesOf(strategy: AccountsEnums["forebay_accounts_strategy"]): Readonly<Record<string, number>> {
  return { sticky: strategy.FOREBAY_ACCOUNTS_STICKY, "round-robin": strategy.FOREBAY_ACCOUNTS_ROUND_ROBIN, hybrid: strategy.FOREBAY_ACCOUNTS_HYBRID };
}

async function strategyOf(config: Config, strategies: Readonly<Record<string, number>>): Promise<number> {
  const name = await required<string>(config, "account_selection_strategy", "string");
  const strategy = strategies[name];
  if (strategy === undefined) throw new Error(`the account_selection_strategy setting of claude-code-provider must be one of ${Object.keys(strategies).join(", ")}, not ${name}`);
  return strategy;
}

async function positiveCount(config: Config, key: string): Promise<number> {
  const value = await required<number>(config, key, "number");
  if (!Number.isInteger(value) || value < 1) throw new Error(`the ${key} setting of claude-code-provider must be a whole number of at least 1`);
  return value;
}

/** Reads every setting afresh, so a change made while the host runs applies to the next call. */
export async function readSettings(config: Config, enums: AccountsEnums): Promise<ClaudeSettings> {
  return {
    authorizeUrl: await required(config, "oauth_authorize_url", "string"),
    tokenUrl: await tokenBearingUrl(config, "oauth_token_url"),
    apiBase: (await tokenBearingUrl(config, "api_base_url")).replace(/\/+$/, ""),
    strategy: await strategyOf(config, strategiesOf(enums.forebay_accounts_strategy)),
    logging: await required(config, "logging", "boolean"),
    maxAccountAttempts: await required(config, "max_account_attempts", "number"),
    defaultCooldownSeconds: await required(config, "default_cooldown_seconds", "number"),
    maxCooldownSeconds: await required(config, "max_cooldown_seconds", "number"),
    modelPrefix: await required(config, "model_prefix", "string"),
    defaultContext: await positiveCount(config, "default_context"),
    defaultOutput: await positiveCount(config, "default_output"),
  };
}

/** The OAuth client id: the environment's override when it is set and not blank, else the public one. */
export function clientIdOf(environment: Record<string, string | undefined>): string {
  const override = environment[CLIENT_ID_VARIABLE]?.trim();
  return override === undefined || override === "" ? CLAUDE_CLIENT_ID : override;
}

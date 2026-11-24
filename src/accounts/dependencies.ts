import type { Accounts, StoredAccount } from "../contract.js";
import type { ClaudeSettings } from "../settings.js";
import type { TextSecrets } from "./secrets.js";

/** What every account operation reaches outside itself for; each is a seam so a test decides it. */
export interface AccountDependencies {
  readonly accounts: Accounts;
  /** The accounts store file. */
  readonly store: string;
  readonly secrets: TextSecrets;
  readonly settings: () => Promise<ClaudeSettings>;
  readonly clientId: () => string;
  readonly clock: () => number;
  readonly random: () => number;
  readonly log: (message: string) => void;
  /** How long a shared token refresh may take before it counts as a failed one. */
  readonly refreshTimeoutMilliseconds?: number;
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Runs an effect that must not stop the caller, logging why it failed, naming `what` was attempted. */
export async function logIfFailed(dependencies: AccountDependencies, what: string, effect: () => Promise<unknown>): Promise<void> {
  try {
    await effect();
  } catch (cause) {
    dependencies.log(`${what}: ${messageOf(cause)}`);
  }
}

export async function storedAccounts(dependencies: AccountDependencies): Promise<readonly StoredAccount[]> {
  return (await dependencies.accounts.list({ argument: { store: dependencies.store } })).accounts;
}

export async function findAccount(dependencies: AccountDependencies, id: string): Promise<StoredAccount | undefined> {
  return (await storedAccounts(dependencies)).find((account) => account.id === id);
}

export async function enabledAccounts(dependencies: AccountDependencies): Promise<StoredAccount[]> {
  return (await storedAccounts(dependencies)).filter((account) => account.enabled !== false);
}

export function accessSecretName(id: string): string {
  return `account.${id}.access`;
}

export function refreshSecretName(id: string): string {
  return `account.${id}.refresh`;
}

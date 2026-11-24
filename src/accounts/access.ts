import { refreshTokens } from "../oauth/refresh.js";
import { reportAttempt } from "../request/report.js";
import { accessSecretName, findAccount, logIfFailed, refreshSecretName, outcomesOf } from "./dependencies.js";
import type { AccountDependencies } from "./dependencies.js";

const DEFAULT_REFRESH_TIMEOUT_MILLISECONDS = 30000;
const RE_LOGIN_REQUIRED = "re-login required";

/** The access token of an account, or why none is usable. */
export type AccessAnswer = { access: string } | { none: true; reason: string };

export interface TokenAccess {
  /** The stored access token while it is valid, else a refreshed one. */
  ensureAccess(id: string, now: number, signal: AbortSignal): Promise<AccessAnswer>;
  /** A refreshed access token whether or not the stored one is still valid. */
  refreshNow(id: string, now: number, signal: AbortSignal): Promise<AccessAnswer>;
}

function unusable(reason: string): AccessAnswer {
  return { none: true, reason };
}

function disable(dependencies: AccountDependencies, id: string, reason: string): Promise<void> {
  return reportAttempt(dependencies, id, { outcome: outcomesOf(dependencies).FOREBAY_ACCOUNTS_DISABLED, reason });
}

/** @implNote The refresh token is written before the access token: a rotated one is already spent upstream, so losing it would lose the account. */
async function storeRefreshed(dependencies: AccountDependencies, id: string, previousRefresh: string, tokens: { access: string; refresh: string; expires: number }): Promise<void> {
  const { secrets } = dependencies;
  if (tokens.refresh !== previousRefresh) await secrets.set(refreshSecretName(id), tokens.refresh);
  await secrets.set(accessSecretName(id), tokens.access);
  await logIfFailed(dependencies, `could not store the new expiry of ${id}`, () => dependencies.accounts.upsert({ argument: { store: dependencies.store, account: { id, expires: tokens.expires } } }));
}

async function refreshed(dependencies: AccountDependencies, id: string, now: number): Promise<AccessAnswer> {
  const refreshToken = await dependencies.secrets.get(refreshSecretName(id));
  if (refreshToken === undefined) {
    await disable(dependencies, id, `${RE_LOGIN_REQUIRED} (no refresh token is stored)`);
    return unusable(RE_LOGIN_REQUIRED);
  }
  const outcome = await refreshTokens({
    tokenUrl: (await dependencies.settings()).tokenUrl,
    clientId: dependencies.clientId(),
    refreshToken,
    now,
    signal: AbortSignal.timeout(dependencies.refreshTimeoutMilliseconds ?? DEFAULT_REFRESH_TIMEOUT_MILLISECONDS),
  });
  if (!outcome.ok) {
    if (outcome.revoked) await disable(dependencies, id, RE_LOGIN_REQUIRED);
    return unusable(outcome.revoked ? RE_LOGIN_REQUIRED : outcome.message);
  }
  await storeRefreshed(dependencies, id, refreshToken, outcome.tokens);
  return { access: outcome.tokens.access };
}

async function isExpired(dependencies: AccountDependencies, expires: number | undefined, now: number): Promise<boolean> {
  const argument = { has_expires: typeof expires === "number" ? 1 : 0, expires: typeof expires === "number" ? expires : 0, now, has_skew_milliseconds: 0, skew_milliseconds: 0 };
  return (await dependencies.accounts.token_expired({ argument })).expired !== 0;
}

/**
 * Builds the token access of the plugin.
 *
 * @remarks A revoked refresh token disables the account with the reason `re-login required`, so the
 * request path moves on to the next account instead of retrying. Any other failure, a timeout
 * included, answers no token for that attempt and reports nothing, and a good refresh reports
 * nothing either: a report of success would clear a rate limit cooldown and count as a use. Only the
 * caller's own abort rejects.
 *
 * @implNote Refreshes of one account share one in flight call: a rotated refresh token makes the
 * second of two concurrent refreshes with the old token fail as revoked, which would disable a
 * healthy account. The shared call has its own timeout, so one caller aborting does not cancel it.
 */
export function createTokenAccess(dependencies: AccountDependencies): TokenAccess {
  const inFlight = new Map<string, Promise<AccessAnswer>>();

  function refreshNow(id: string, now: number, signal: AbortSignal): Promise<AccessAnswer> {
    signal.throwIfAborted();
    const running = inFlight.get(id) ?? refreshed(dependencies, id, now).finally(() => inFlight.delete(id));
    inFlight.set(id, running);
    return running.then((answer) => {
      signal.throwIfAborted();
      return answer;
    });
  }

  async function ensureAccess(id: string, now: number, signal: AbortSignal): Promise<AccessAnswer> {
    signal.throwIfAborted();
    const account = await findAccount(dependencies, id);
    if (account === undefined) return unusable(`no account ${id}`);
    if (account.enabled === false) return unusable(account.disabledReason ?? "disabled");
    const access = await dependencies.secrets.get(accessSecretName(id));
    if (access !== undefined && !(await isExpired(dependencies, account.expires, now))) return { access };
    return refreshNow(id, now, signal);
  }

  return { ensureAccess, refreshNow };
}

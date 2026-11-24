import { logIfFailed } from "../accounts/dependencies.js";
import type { AccountDependencies } from "../accounts/dependencies.js";
import { MESSAGES_LANE } from "../constants.js";
import type { QuotaPool } from "./quota-headers.js";

const MILLISECONDS_PER_SECOND = 1000;

export interface AttemptReport {
  /** A forebay_accounts_report_outcome. */
  readonly outcome: number;
  readonly attempt?: number;
  readonly reason?: string;
  readonly resetAt?: number;
  readonly quota?: { readonly pools: Record<string, QuotaPool>; readonly at: number };
}

/**
 * Reports what an attempt did to an account. A refusal or a failure of the accounts service is
 * logged and never stops the request: the answer to the caller does not depend on the bookkeeping.
 */
/** The outcome as the log words it: its entry's name past the enum's prefix, in lower case. */
function outcomeName(dependencies: AccountDependencies, outcome: number): string {
  const entry = Object.entries(dependencies.enums.accounts.forebay_accounts_report_outcome).find(([, number]) => number === outcome);
  return entry === undefined ? String(outcome) : entry[0].replace("FOREBAY_ACCOUNTS_", "").toLowerCase();
}

export async function reportAttempt(dependencies: AccountDependencies, id: string, report: AttemptReport): Promise<void> {
  await logIfFailed(dependencies, `could not report ${outcomeName(dependencies, report.outcome)} for ${id}`, async () => {
    const settings = await dependencies.settings();
    await dependencies.accounts.report({
      argument: {
        store: dependencies.store,
        id,
        outcome: report.outcome,
        now: dependencies.clock(),
        lane: MESSAGES_LANE,
        ...(report.reason === undefined ? {} : { reason: report.reason }),
        has_reset_at: report.resetAt === undefined ? 0 : 1,
        reset_at: report.resetAt ?? 0,
        has_random: 1,
        random: dependencies.random(),
        attempt: report.attempt ?? 0,
        base_milliseconds: settings.defaultCooldownSeconds * MILLISECONDS_PER_SECOND,
        max_milliseconds: settings.maxCooldownSeconds * MILLISECONDS_PER_SECOND,
        ...(report.quota === undefined ? {} : { quota: report.quota }),
      },
    });
  });
}

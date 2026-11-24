import { findAccount, logIfFailed } from "../accounts/dependencies.js";
import type { AccountDependencies } from "../accounts/dependencies.js";
import { REPORT_OUTCOME } from "../contract.js";
import { readPools } from "./quota-headers.js";
import type { QuotaPool, StoredQuota } from "./quota-headers.js";
import { reportAttempt } from "./report.js";

/** Pools a response's headers carry, merged over the stored ones. */
export function mergedPools(stored: StoredQuota | undefined, found: Record<string, QuotaPool>): Record<string, QuotaPool> {
  return { ...stored?.pools, ...found };
}

/**
 * Records what a response's headers say of the account's quota. The merge keeps the pools this
 * response did not mention: a model scoped weekly bucket only appears on requests to that model.
 */
export async function captureQuota(dependencies: AccountDependencies, id: string, headers: Record<string, string>): Promise<void> {
  const found = readPools(headers);
  if (Object.keys(found).length === 0) return;
  await logIfFailed(dependencies, `could not capture the quota of ${id}`, async () => {
    const stored = (await findAccount(dependencies, id))?.quota as StoredQuota | undefined;
    await reportAttempt(dependencies, id, { outcome: REPORT_OUTCOME.QUOTA, quota: { pools: mergedPools(stored, found), at: dependencies.clock() } });
  });
}

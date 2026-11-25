import { describe, expect, it } from "vitest";
import { accountsWith, NEVER_ABORTED, NOW, RUN_BOUND, seedAccount, useWorld } from "../../test/world.js";
import { createTokenAccess } from "./access.js";

const world = useWorld();
const HOUR = 3_600_000;
const SLOW_REFRESH = 3_000;
const READ_ONLY = "accounts.upsert answered refused: the store is read only (make it writable)";

function refusing(): never {
  throw new Error(READ_ONLY);
}

describe("ensureAccess", () => {
  it("answers the stored access token while it is valid, without reaching the endpoint", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    expect(await createTokenAccess(world().dependencies).ensureAccess("a", NOW, NEVER_ABORTED)).toEqual({ access: "stored-access-a" });
    expect(world().server.requests).toHaveLength(0);
  }, RUN_BOUND);

  it("refreshes on expiry, keeping the new tokens in secrets and only the expiry in the store", async () => {
    await seedAccount(world(), "a", NOW - 1);
    const answer = await createTokenAccess(world().dependencies).ensureAccess("a", NOW, NEVER_ABORTED);
    expect(answer).toEqual({ access: "access-from-refresh" });
    expect(world().secrets.entries.get("account.a.access")).toBe("access-from-refresh");
    expect(world().secrets.entries.get("account.a.refresh")).toBe("stored-refresh-a");
    expect((await world().storedAccount("a"))?.expires).toBe(NOW + HOUR);
    expect(new URLSearchParams(world().server.requestsTo("/v1/oauth/token")[0]?.body).get("refresh_token")).toBe("stored-refresh-a");
  }, RUN_BOUND);

  it("refreshes a token that expires within the skew", async () => {
    await seedAccount(world(), "a", NOW + 30_000);
    expect(await createTokenAccess(world().dependencies).ensureAccess("a", NOW, NEVER_ABORTED)).toEqual({ access: "access-from-refresh" });
  }, RUN_BOUND);

  it("refreshes when the access secret is gone though the expiry is still ahead", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    world().secrets.entries.delete("account.a.access");
    expect(await createTokenAccess(world().dependencies).ensureAccess("a", NOW, NEVER_ABORTED)).toEqual({ access: "access-from-refresh" });
  }, RUN_BOUND);

  it("stores a rotated refresh token", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().server.tokenResponder = () => ({ status: 200, body: { access_token: "n", refresh_token: "rotated" } });
    await createTokenAccess(world().dependencies).ensureAccess("a", NOW, NEVER_ABORTED);
    expect(world().secrets.entries.get("account.a.refresh")).toBe("rotated");
  }, RUN_BOUND);

  it("disables the account on invalid_grant with the reason re-login required, and answers none", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().server.tokenResponder = () => ({ status: 400, body: { error: "invalid_grant" } });
    const answer = await createTokenAccess(world().dependencies).ensureAccess("a", NOW, NEVER_ABORTED);
    expect(answer).toEqual({ none: true, reason: "re-login required" });
    expect(await world().storedAccount("a")).toMatchObject({ enabled: false, disabledReason: "re-login required" });
  }, RUN_BOUND);

  it("moves on: a failing refresh disables the account, and acquire gives the next one", async () => {
    await seedAccount(world(), "a", NOW - 1);
    await seedAccount(world(), "b", NOW + HOUR);
    world().server.tokenResponder = () => ({ status: 400, body: { error: "invalid_grant" } });
    const access = createTokenAccess(world().dependencies);
    const { accounts, store } = world();
    const first = await accounts.acquire({ argument: { store, lane: "messages", strategy: world().enums.accounts.forebay_accounts_strategy.FOREBAY_ACCOUNTS_STICKY, now: NOW } });
    expect(first.id).toBe("a");
    expect(await access.ensureAccess("a", NOW, NEVER_ABORTED)).toMatchObject({ none: true });
    const next = await accounts.acquire({ argument: { store, lane: "messages", strategy: world().enums.accounts.forebay_accounts_strategy.FOREBAY_ACCOUNTS_STICKY, now: NOW } });
    expect(next.id).toBe("b");
    expect(await access.ensureAccess("b", NOW, NEVER_ABORTED)).toEqual({ access: "stored-access-b" });
    expect(world().server.requestsTo("/v1/oauth/token")).toHaveLength(1);
  }, RUN_BOUND);

  it("reports nothing against the account on a refusal that is not a revocation", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().server.tokenResponder = () => ({ status: 503, body: {} });
    const answer = await createTokenAccess(world().dependencies).ensureAccess("a", NOW, NEVER_ABORTED);
    expect(answer).toEqual({ none: true, reason: "the token endpoint answered 503" });
    const account = await world().storedAccount("a");
    expect(account?.enabled).toBe(true);
    expect(account?.coolingDownUntil).toBeUndefined();
  }, RUN_BOUND);

  it("disables an account whose refresh token is missing", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().secrets.entries.delete("account.a.refresh");
    expect(await createTokenAccess(world().dependencies).ensureAccess("a", NOW, NEVER_ABORTED)).toEqual({ none: true, reason: "re-login required" });
    expect((await world().storedAccount("a"))?.enabled).toBe(false);
    expect(world().server.requests).toHaveLength(0);
  }, RUN_BOUND);

  it("answers none for an unknown account and for a disabled one, saying why", async () => {
    const access = createTokenAccess(world().dependencies);
    expect(await access.ensureAccess("ghost", NOW, NEVER_ABORTED)).toEqual({ none: true, reason: "no account ghost" });
    await seedAccount(world(), "a", NOW + HOUR);
    await world().accounts.upsert({ argument: { store: world().store, account: { id: "a", enabled: false, disabledReason: "quota" } } });
    expect(await access.ensureAccess("a", NOW, NEVER_ABORTED)).toEqual({ none: true, reason: "quota" });
  }, RUN_BOUND);

  it("makes concurrent refreshes of one account one request, so a rotated token is not spent twice", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().server.tokenResponder = () => ({ status: 200, body: { access_token: "once", refresh_token: "rotated" }, delayMilliseconds: 50 });
    const access = createTokenAccess(world().dependencies);
    const answers = await Promise.all([access.ensureAccess("a", NOW, NEVER_ABORTED), access.ensureAccess("a", NOW, NEVER_ABORTED)]);
    expect(answers).toEqual([{ access: "once" }, { access: "once" }]);
    expect(world().server.requestsTo("/v1/oauth/token")).toHaveLength(1);
  }, RUN_BOUND);

  it("stops a cancelled caller's wait on a shared refresh at once, while the refresh still serves the other", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().server.tokenResponder = () => ({ status: 200, body: { access_token: "once", refresh_token: "rotated" }, delayMilliseconds: SLOW_REFRESH });
    const access = createTokenAccess(world().dependencies);
    const aborter = new AbortController();
    const began = Date.now();

    const cancelled = access.ensureAccess("a", NOW, aborter.signal);
    const kept = access.ensureAccess("a", NOW, NEVER_ABORTED);
    setTimeout(() => aborter.abort(new Error("client went away")), 50);

    await expect(cancelled).rejects.toThrow("client went away");
    expect(Date.now() - began).toBeLessThan(SLOW_REFRESH / 2);
    expect(await kept).toEqual({ access: "once" });
    expect(world().server.requestsTo("/v1/oauth/token")).toHaveLength(1);
  }, RUN_BOUND);

  it("rejects an aborted call and reports nothing against the account", async () => {
    await seedAccount(world(), "a", NOW - 1);
    const aborter = new AbortController();
    aborter.abort(new Error("client went away"));
    await expect(createTokenAccess(world().dependencies).ensureAccess("a", NOW, aborter.signal)).rejects.toThrow("client went away");
    const account = await world().storedAccount("a");
    expect(account).toMatchObject({ enabled: true });
    expect(account?.coolingDownUntil).toBeUndefined();
    expect(world().server.requests).toHaveLength(0);
  }, RUN_BOUND);

  it("still answers when reporting fails, logging it", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().server.tokenResponder = () => ({ status: 400, body: { error: "invalid_grant" } });
    const failing = { ...world().dependencies, accounts: accountsWith(world().accounts, { report: refusing }) };
    expect(await createTokenAccess(failing).ensureAccess("a", NOW, NEVER_ABORTED)).toMatchObject({ none: true });
    expect(world().reports.join()).toMatch(/could not report disabled for a: .*the store is read only \(make it writable\)/);
  }, RUN_BOUND);
});

describe("ensureAccess under failure", () => {
  it("answers none and reports nothing when the token endpoint does not answer in time", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().server.tokenResponder = () => ({ status: 200, body: {}, delayMilliseconds: 500 });
    const access = createTokenAccess({ ...world().dependencies, refreshTimeoutMilliseconds: 50 });
    expect(await access.ensureAccess("a", NOW, NEVER_ABORTED)).toEqual({ none: true, reason: "the token endpoint did not answer in time" });
    const account = await world().storedAccount("a");
    expect(account).toMatchObject({ enabled: true });
    expect(account?.coolingDownUntil).toBeUndefined();
  }, RUN_BOUND);

  it("writes a rotated refresh token before the access token, so a failure between them loses no spent token", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().server.tokenResponder = () => ({ status: 200, body: { access_token: "n", refresh_token: "rotated" } });
    const secrets = world().secrets;
    const failing = {
      ...world().dependencies,
      secrets: {
        ...secrets,
        set: async (name: string, value: string) => {
          if (name.endsWith(".access")) throw new Error("keychain locked");
          await secrets.set(name, value);
        },
      },
    };
    await expect(createTokenAccess(failing).ensureAccess("a", NOW, NEVER_ABORTED)).rejects.toThrow("keychain locked");
    expect(secrets.entries.get("account.a.refresh")).toBe("rotated");
  }, RUN_BOUND);

  it("leaves a rate limit cooldown untouched and the account unused after a good refresh", async () => {
    await seedAccount(world(), "a", NOW - 1);
    const argument = { store: world().store, id: "a", outcome: world().enums.accounts.forebay_accounts_report_outcome.FOREBAY_ACCOUNTS_RATE_LIMITED, now: NOW, has_reset_at: 1, reset_at: NOW + 600_000, has_random: 0, random: 0, attempt: 0, base_milliseconds: 0, max_milliseconds: 0 };
    await world().accounts.report({ argument });
    const before = (await world().storedAccount("a")) as Record<string, unknown> | undefined;
    expect(before?.coolingDownUntil).toBe(NOW + 600_000);
    await createTokenAccess(world().dependencies).ensureAccess("a", NOW, NEVER_ABORTED);
    const after = (await world().storedAccount("a")) as Record<string, unknown> | undefined;
    expect(after?.coolingDownUntil).toBe(NOW + 600_000);
    expect(after?.lastUsed).toBe(before?.lastUsed);
  }, RUN_BOUND);

  it("logs a refused expiry upsert and still answers the token it got", async () => {
    await seedAccount(world(), "a", NOW - 1);
    const failing = { ...world().dependencies, accounts: accountsWith(world().accounts, { upsert: refusing }) };
    expect(await createTokenAccess(failing).ensureAccess("a", NOW, NEVER_ABORTED)).toEqual({ access: "access-from-refresh" });
    expect(world().reports.join()).toMatch(/could not store the new expiry of a: .*the store is read only \(make it writable\)/);
  }, RUN_BOUND);
});

describe("refreshNow", () => {
  it("refreshes a token that is still valid", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    expect(await createTokenAccess(world().dependencies).refreshNow("a", NOW, NEVER_ABORTED)).toEqual({ access: "access-from-refresh" });
  }, RUN_BOUND);
});

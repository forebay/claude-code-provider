import { describe, expect, it } from "vitest";
import { accountsWith, NOW, RUN_BOUND, seedAccount, useWorld } from "../../test/world.js";
import { createTokenAccess } from "./access.js";
import { listAccountsAction, refreshAction, removeAction, verifyAction } from "./actions.js";

const world = useWorld();
const HOUR = 3_600_000;
const READ_ONLY = "the store is read only (make it writable)";

function refusing(): never {
  throw new Error(READ_ONLY);
}

const verify = () => verifyAction(world().dependencies, createTokenAccess(world().dependencies));

describe("the accounts action", () => {
  it("lists each account with whether it is usable and never a token", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    await world().accounts.upsert({ argument: { store: world().store, account: { id: "b", enabled: false, disabledReason: "re-login required" } } });
    const listed = await listAccountsAction(world().dependencies)();
    expect(listed.accounts).toEqual([
      { id: "a", label: "a", enabled: true, expires: NOW + HOUR },
      { id: "b", enabled: false, disabledReason: "re-login required" },
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/stored-/);
  }, RUN_BOUND);

  it("lists nothing when no account was added", async () => {
    expect(await listAccountsAction(world().dependencies)()).toEqual({ accounts: [] });
  }, RUN_BOUND);

  it("fails with the cause when the list is refused", async () => {
    const failing = { ...world().dependencies, accounts: accountsWith(world().accounts, { list: refusing }) };
    await expect(listAccountsAction(failing)()).rejects.toThrow(READ_ONLY);
  }, RUN_BOUND);
});

describe("the verify action", () => {
  it.each([200, 400, 429])("reports a %i as verified", async (status) => {
    await seedAccount(world(), "a", NOW + HOUR);
    world().server.messagesResponder = () => ({ status, body: {} });
    expect(await verify()({ item: "a" })).toEqual({ results: [{ id: "a", status: "verified" }] });
  }, RUN_BOUND);

  it("sends the one token message with the oauth headers and the access token", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    await verify()({ item: "a" });
    const [request] = world().server.requestsTo("/v1/messages");
    expect(request?.headers).toMatchObject({ authorization: "Bearer stored-access-a", "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" });
    expect(request?.headers["x-api-key"]).toBeUndefined();
    expect(JSON.parse(request?.body ?? "")).toMatchObject({ max_tokens: 1, system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }] });
  }, RUN_BOUND);

  it("reports a 401 as expired and makes the next use refresh the token", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    world().server.messagesResponder = () => ({ status: 401, body: {} });
    const answer = await verify()({ item: "a" });
    expect(answer.results[0]).toMatchObject({ id: "a", status: "expired" });
    expect(await world().storedAccount("a")).toMatchObject({ enabled: true, expires: NOW });
    expect(await createTokenAccess(world().dependencies).ensureAccess("a", NOW, new AbortController().signal)).toEqual({ access: "access-from-refresh" });
  }, RUN_BOUND);

  it("reports a 403 as disabled and disables the account", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    world().server.messagesResponder = () => ({ status: 403, body: {} });
    expect((await verify()({ item: "a" })).results[0]).toMatchObject({ id: "a", status: "disabled" });
    expect(await world().storedAccount("a")).toMatchObject({ enabled: false, disabledReason: "re-login required (token lacks inference scope)" });
  }, RUN_BOUND);

  it("logs a refused disable after a 403", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    world().server.messagesResponder = () => ({ status: 403, body: {} });
    const failing = { ...world().dependencies, accounts: accountsWith(world().accounts, { report: refusing }) };
    await verifyAction(failing, createTokenAccess(failing))({ item: "a" });
    expect(world().reports.join()).toContain(READ_ONLY);
  }, RUN_BOUND);

  it("reports any other status as failed with the status", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    world().server.messagesResponder = () => ({ status: 500, body: {} });
    expect((await verify()({ item: "a" })).results[0]).toEqual({ id: "a", status: "failed", detail: "the upstream answered 500" });
  }, RUN_BOUND);

  it("reports an account with no usable token as failed, saying why", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().server.tokenResponder = () => ({ status: 400, body: { error: "invalid_grant" } });
    expect((await verify()({ item: "a" })).results[0]).toEqual({ id: "a", status: "failed", detail: "re-login required" });
  }, RUN_BOUND);

  it("verifies every enabled account when run without a row, or with no argument at all", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    await seedAccount(world(), "b", NOW + HOUR);
    await world().accounts.upsert({ argument: { store: world().store, account: { id: "c", enabled: false } } });
    expect((await verify()({})).results.map((result) => result.id)).toEqual(["a", "b"]);
    expect((await verify()()).results.map((result) => result.id)).toEqual(["a", "b"]);
  }, RUN_BOUND);
});

describe("one bad account", () => {
  async function twoAccountsWithABrokenFirst() {
    await seedAccount(world(), "a", NOW + HOUR);
    await seedAccount(world(), "b", NOW + HOUR);
    const secrets = world().secrets;
    const broken = {
      ...secrets,
      get: async (name: string) => {
        if (name.includes(".a.")) throw new Error("keychain locked");
        return secrets.get(name);
      },
    };
    return { ...world().dependencies, secrets: broken };
  }

  it("does not lose the other accounts' verify results", async () => {
    const dependencies = await twoAccountsWithABrokenFirst();
    const answer = await verifyAction(dependencies, createTokenAccess(dependencies))({});
    expect(answer.results).toEqual([{ id: "a", status: "failed", detail: "keychain locked" }, { id: "b", status: "verified" }]);
  }, RUN_BOUND);

  it("does not lose the other accounts' refresh results", async () => {
    const dependencies = await twoAccountsWithABrokenFirst();
    const answer = await refreshAction(dependencies, createTokenAccess(dependencies))({});
    expect(answer.results).toEqual([{ id: "a", refreshed: false, reason: "keychain locked" }, { id: "b", refreshed: true }]);
  }, RUN_BOUND);
});

describe("the refresh action", () => {
  it("refreshes the row's account", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    const action = refreshAction(world().dependencies, createTokenAccess(world().dependencies));
    expect(await action({ item: "a" })).toEqual({ results: [{ id: "a", refreshed: true }] });
    expect(world().secrets.entries.get("account.a.access")).toBe("access-from-refresh");
  }, RUN_BOUND);

  it("says why an account could not be refreshed", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    world().server.tokenResponder = () => ({ status: 400, body: { error: "invalid_grant" } });
    const action = refreshAction(world().dependencies, createTokenAccess(world().dependencies));
    expect(await action({ item: "a" })).toEqual({ results: [{ id: "a", refreshed: false, reason: "re-login required" }] });
  }, RUN_BOUND);
});

describe("the remove action", () => {
  it("forgets the account and deletes its tokens", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    expect(await removeAction(world().dependencies)({ item: "a" })).toEqual({ id: "a", removed: true });
    expect(await world().storedAccount("a")).toBeUndefined();
    expect(world().secrets.entries.size).toBe(0);
  }, RUN_BOUND);

  it("fails with the cause when the store refuses, keeping the tokens", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    const failing = { ...world().dependencies, accounts: accountsWith(world().accounts, { remove: refusing }) };
    await expect(removeAction(failing)({ item: "a" })).rejects.toThrow(READ_ONLY);
    expect(world().secrets.entries.size).toBe(2);
  }, RUN_BOUND);

  it("refuses to run without an account", async () => {
    await expect(removeAction(world().dependencies)({})).rejects.toThrow(/needs an account/);
  }, RUN_BOUND);
});

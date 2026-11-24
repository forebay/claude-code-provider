import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningHost } from "@weivel/typescript/program";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Accounts } from "../src/contract.js";
import { bundled, homeWith, hostIn, providerInstall, realPlacesSnapshot, REPOSITORY, type Home } from "./fixtures/home.js";
import { GRANTED_TOKENS, startOauthServer, successfulGrants, type OauthServer, type RecordedRequest, type Reply } from "./fixtures/oauth-server.js";
import { consumerInstall, RUN_BOUND, settingsFor } from "./world.js";

const realBefore = realPlacesSnapshot();
const PROVIDER = "claude-code-provider";
const ACTIONS = "claude-code-provider:accounts";

interface Actions {
  login(input?: { code?: string }): Promise<{ url?: string; id?: string; outcome?: string }>;
  list(): Promise<{ accounts: { id: string; enabled: boolean; disabledReason?: string }[] }>;
  verify(input?: { item?: string }): Promise<{ results: { id: string; status: string; detail?: string }[] }>;
  refresh(input?: { item?: string }): Promise<{ results: { id: string; refreshed: boolean; reason?: string }[] }>;
  quota(input?: { item?: string }): Promise<{ results: { id: string; hasCapacity?: boolean; reason?: string }[] }>;
  remove(input?: { item?: string }): Promise<{ id: string; removed: boolean }>;
}

let bundles: string;
let providerBundle: string;
let consumerBundle: string;
let server: OauthServer;
const homes: Home[] = [];
const hosts: RunningHost[] = [];

function home(): Home {
  const made = homeWith([providerInstall(providerBundle, settingsFor(server)), consumerInstall(consumerBundle)]);
  homes.push(made);
  return made;
}

async function serving(made: Home): Promise<RunningHost> {
  const host = await hostIn(made);
  hosts.push(host);
  return host;
}

function actionsOf(host: RunningHost): Actions {
  const actions = host.service<Actions>(PROVIDER, ACTIONS);
  if (actions === undefined) throw new Error("claude-code-provider registered no accounts service");
  return actions;
}

function accountsOf(host: RunningHost): Accounts {
  const accounts = host.service<Accounts>("consumer", "consumer:accounts");
  if (accounts === undefined) throw new Error("the consumer registered no accounts service");
  return accounts;
}

async function action(made: Home, name: string, argument: unknown = {}): Promise<number> {
  const host = await hostIn(made, ["action", PROVIDER, name, JSON.stringify(argument)]);
  return host.ended;
}

function storeIn(made: Home): string {
  const found = readdirSync(made.base, { recursive: true, encoding: "utf8" }).find((file) => file.endsWith("accounts.json"));
  if (found === undefined) throw new Error("no accounts store was written");
  return join(made.base, found);
}

/** Grants the code exchange for `email`, its access token living `expiresIn` seconds, and every refresh as the fixture does. */
function grantFor(email: string, expiresIn = 3600): (request: RecordedRequest) => Reply {
  return (request) => {
    if (new URLSearchParams(request.body).get("grant_type") === "refresh_token") return successfulGrants(request);
    return { status: 200, body: { ...GRANTED_TOKENS, expires_in: expiresIn, account: { email_address: email } } };
  };
}

async function loggedIn(actions: Actions, email = "me@example.com", expiresIn = 3600): Promise<string> {
  server.tokenResponder = grantFor(email, expiresIn);
  const started = await actions.login();
  const state = new URL(started.url!).searchParams.get("state");
  const completed = await actions.login({ code: `the-code#${state}` });
  return completed.id!;
}

function bearersSentTo(path: string): string[] {
  return server.requestsTo(path).map((request) => String(request.headers.authorization));
}

beforeAll(async () => {
  bundles = mkdtempSync(join(tmpdir(), "claude-code-provider-bundles-"));
  providerBundle = await bundled(join(REPOSITORY, "src", "plugin.ts"), join(bundles, "provider"));
  consumerBundle = await bundled(join(REPOSITORY, "test", "fixtures", "consumer", "index.ts"), join(bundles, "consumer"));
}, RUN_BOUND);

beforeEach(async () => {
  server = await startOauthServer();
});

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const made of homes.splice(0)) made.remove();
  await server.close();
});

afterAll(() => rmSync(bundles, { recursive: true, force: true }));

describe("claude-code-provider's accounts under the host program, over runtime in a temporary home", () => {
  it("logs an account in, keeping its tokens in the host's secrets and the account in the store with no token", async () => {
    const made = home();
    const actions = actionsOf(await serving(made));

    const id = await loggedIn(actions);
    const verified = await actions.verify({ item: id });

    expect(id).toBe("me@example.com");
    const store = readFileSync(storeIn(made), "utf8");
    expect(store).not.toMatch(/access|refresh|token/i);
    expect(JSON.parse(store)).toMatchObject({ accounts: [{ id, label: id, enabled: true }] });
    expect(verified.results).toEqual([{ id, status: "verified" }]);
    expect(bearersSentTo("/v1/messages")).toEqual(["Bearer access-from-grant"]);
  }, RUN_BOUND);

  it("refreshes an expired access token before using it, and keeps the new one", async () => {
    const actions = actionsOf(await serving(home()));
    const id = await loggedIn(actions, "me@example.com", 1);

    await actions.verify({ item: id });
    await actions.verify({ item: id });

    expect(new URLSearchParams(server.requestsTo("/v1/oauth/token")[1]?.body).get("refresh_token")).toBe("refresh-from-grant");
    expect(bearersSentTo("/v1/messages")).toEqual(["Bearer access-from-refresh", "Bearer access-from-refresh"]);
  }, RUN_BOUND);

  it("reports an account whose refresh fails as needing a login, and acquire then gives the next", async () => {
    const made = home();
    const host = await serving(made);
    const actions = actionsOf(host);
    const first = await loggedIn(actions, "first@example.com");
    const second = await loggedIn(actions, "second@example.com");
    server.tokenResponder = () => ({ status: 400, body: { error: "invalid_grant" } });

    const refreshed = await actions.refresh({ item: first });
    const acquired = await accountsOf(host).acquire({ argument: { store: storeIn(made), lane: "messages", strategy: 1, now: Date.now() } });

    expect(refreshed.results).toEqual([{ id: first, refreshed: false, reason: "re-login required" }]);
    expect((await actions.list()).accounts).toMatchObject([{ id: first, enabled: false, disabledReason: "re-login required" }, { id: second, enabled: true }]);
    expect(acquired).toMatchObject({ kind: 1, id: second, available: 1 });
  }, RUN_BOUND);

  it("removes an account with its tokens", async () => {
    const made = home();
    const host = await serving(made);
    const actions = actionsOf(host);
    const id = await loggedIn(actions);
    const tokenRequests = server.requestsTo("/v1/oauth/token").length;

    const removed = await actions.remove({ item: id });
    await accountsOf(host).upsert({ argument: { store: storeIn(made), account: { id, label: id, enabled: true } } });
    const verified = await actions.verify({ item: id });

    expect(removed).toEqual({ id, removed: true });
    expect(verified.results).toEqual([{ id, status: "failed", detail: "re-login required" }]);
    expect(server.requestsTo("/v1/oauth/token")).toHaveLength(tokenRequests);
  }, RUN_BOUND);

  it("runs each action through the program's ACTION mode", async () => {
    const made = home();
    const host = await serving(made);
    const id = await loggedIn(actionsOf(host));
    server.usageResponder = () => ({ status: 200, body: { limits: [{ kind: "session", percent: 25 }] } });
    await host.stop();

    const exits = {
      login: await action(made, "login"),
      accounts: await action(made, "accounts"),
      verify: await action(made, "verify", { item: id }),
      refresh: await action(made, "refresh", { item: id }),
      quota: await action(made, "quota", { item: id }),
      remove: await action(made, "remove", { item: id }),
      unknown: await action(made, "no-such-action"),
    };

    expect(exits).toMatchObject({ login: 0, accounts: 0, verify: 0, refresh: 0, quota: 0, remove: 0 });
    expect(exits.unknown).not.toBe(0);
    expect(server.requestsTo("/v1/messages")).toHaveLength(1);
    expect(server.requestsTo("/api/oauth/usage")).toHaveLength(1);
    expect(bearersSentTo("/api/oauth/usage")).toEqual(["Bearer access-from-refresh"]);
    expect(JSON.parse(readFileSync(storeIn(made), "utf8"))).toMatchObject({ accounts: [] });
  }, RUN_BOUND);

  it("left the real home's places as they were", () => {
    expect(realPlacesSnapshot()).toEqual(realBefore);
  });
});

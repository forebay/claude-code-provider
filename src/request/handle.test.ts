import { describe, expect, it } from "vitest";
import { createTokenAccess } from "../accounts/access.js";
import type { HandleAnswer, IrRequest } from "../contract.js";
import { accountsWith, NOW, RUN_BOUND, seedAccount, useWorld, type World } from "../../test/world.js";
import type { Reply } from "../../test/fixtures/oauth-server.js";
import { createHandle } from "./handle.js";

const world = useWorld();
const HOUR = 3_600_000;
const RESET_SECONDS = String(NOW / 1000 + 600);
const MESSAGE = { id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "hi" }], model: "claude-sonnet-4", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };

const ok = (headers: Record<string, string> = {}): Reply => ({ status: 200, rawBody: JSON.stringify(MESSAGE), headers: { "content-type": "application/json", ...headers } });
const rateLimited = (status: number, headers: Record<string, string> = {}): Reply => ({ status, rawBody: "rate limited", headers: { "content-type": "text/plain", ...headers } });
const dropped: Reply = { status: 200, destroy: true };

function refusing(): never {
  throw new Error("the store is read only (make it writable)");
}

function handleIn(current: World, dependencies = current.dependencies): ReturnType<typeof createHandle> {
  const requestDependencies = { ...dependencies, anthropic: current.anthropic };
  return createHandle(requestDependencies, createTokenAccess(requestDependencies));
}

function requestOf(current: World): IrRequest {
  const text = current.enums.provider.forebay_ir_block_kind.FOREBAY_IR_BLOCK_TEXT;
  return { model: "claude-sonnet-4", messages: [{ role: "user", content: [{ kind: text, text: "hi" }] }], stream: 0 };
}

function served(current: World, upstream = new AbortController(), dependencies = current.dependencies): Promise<HandleAnswer> {
  return handleIn(current, dependencies)({ request: requestOf(current), headers: [], token: 1n }, upstream);
}

function repliesInTurn(current: World, replies: Reply[]): void {
  current.server.messagesResponder = () => replies.shift() ?? ok();
}

async function seeded(current: World, ...ids: string[]): Promise<void> {
  for (const id of ids) await seedAccount(current, id, NOW + HOUR);
}

async function untilTrue(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
}

async function cooledUntil(current: World, id: string): Promise<number> {
  const account = (await current.storedAccount(id)) as { rateLimitResetTimes?: { messages?: number }; coolingDownUntil?: number } | undefined;
  return account?.rateLimitResetTimes?.messages ?? account?.coolingDownUntil ?? Number.NaN;
}

describe("the request path over the real accounts and anthropic services", () => {
  it.each([429, 529])("backs an account off by its attempt after a %i with no reset, doubling turn by turn", async (status) => {
    const current = world();
    await seeded(current, "a", "b");
    repliesInTurn(current, [rateLimited(status), rateLimited(status), ok()]);
    current.settings.max_account_attempts = 2;

    const answer = await served(current);

    expect(answer).toMatchObject({ kind: current.enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_FAILURE, failure: { status } });
    const first = (await cooledUntil(current, "a")) - NOW;
    const second = (await cooledUntil(current, "b")) - NOW;
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(2 * first);
  }, RUN_BOUND);

  it("rotates past a transport failure, reporting it against that account, and serves from the next", async () => {
    const current = world();
    await seeded(current, "a", "b");
    repliesInTurn(current, [dropped, ok()]);

    const answer = await served(current);

    expect(answer.kind).toBe(current.enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_RESPONSE);
    expect(current.server.requestsTo("/v1/messages").map((request) => request.headers.authorization)).toEqual(["Bearer stored-access-a", "Bearer stored-access-b"]);
    expect(await cooledUntil(current, "a")).toBeGreaterThan(NOW);
  }, RUN_BOUND);

  it("stops after max_account_attempts turns and answers the last upstream 429", async () => {
    const current = world();
    await seeded(current, "a", "b", "c", "d");
    let sent = 0;
    current.server.messagesResponder = () => rateLimited(429, { "anthropic-ratelimit-unified-reset": RESET_SECONDS, "x-turn": String(++sent) });
    current.settings.max_account_attempts = 2;

    const answer = await served(current);

    expect(current.server.requestsTo("/v1/messages")).toHaveLength(2);
    expect(answer).toMatchObject({ kind: current.enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_FAILURE, failure: { status: 429, body: "rate limited", has_retry_after: 1, retry_after_milliseconds: 600_000 } });
    expect(answer.failure?.headers).toContainEqual({ name: "x-turn", value: "2" });
  }, RUN_BOUND);

  it("answers a 502 when every turn failed without an upstream answer", async () => {
    const current = world();
    await seeded(current, "a", "b");
    repliesInTurn(current, [dropped, dropped]);
    current.settings.max_account_attempts = 2;

    const answer = await served(current);

    expect(answer).toMatchObject({ kind: current.enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_FAILURE, failure: { status: 502 } });
    expect(JSON.parse(answer.failure!.body)).toMatchObject({ error: { type: "api_error", message: "Claude request failed after 2 attempts" } });
  }, RUN_BOUND);

  it("merges the quota a response's headers carry over the pools already stored", async () => {
    const current = world();
    await seeded(current, "a");
    const stored = { pools: { "7d": { utilization: 0.1 } }, at: NOW };
    const argument = { store: current.store, id: "a", outcome: current.enums.accounts.forebay_accounts_report_outcome.FOREBAY_ACCOUNTS_QUOTA, now: NOW, has_reset_at: 0, reset_at: 0, has_random: 0, random: 0, attempt: 0, base_milliseconds: 0, max_milliseconds: 0, quota: stored };
    await current.accounts.report({ argument });
    repliesInTurn(current, [ok({ "anthropic-ratelimit-unified-5h-utilization": "0.5", "anthropic-ratelimit-unified-5h-status": "allowed" })]);

    await served(current);

    expect((await current.storedAccount("a"))?.quota).toMatchObject({ pools: { "7d": { utilization: 0.1 }, "5h": { utilization: 0.5, status: "allowed" } } });
  }, RUN_BOUND);

  it("rotates past an account whose token cannot be had, reporting why, without sending a request for it", async () => {
    const current = world();
    await seedAccount(current, "a", NOW - 1);
    await seeded(current, "b");
    current.secrets.entries.delete("account.a.refresh");
    repliesInTurn(current, [ok()]);

    const answer = await served(current);

    expect(answer.kind).toBe(current.enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_RESPONSE);
    expect(current.server.requestsTo("/v1/messages").map((request) => request.headers.authorization)).toEqual(["Bearer stored-access-b"]);
    expect(await current.storedAccount("a")).toMatchObject({ enabled: false, disabledReason: "re-login required (no refresh token is stored)" });
  }, RUN_BOUND);

  it("logs a refused report and still serves the answer", async () => {
    const current = world();
    await seeded(current, "a");
    repliesInTurn(current, [ok()]);
    const failing = { ...current.dependencies, accounts: accountsWith(current.accounts, { report: refusing }) };

    const answer = await served(current, new AbortController(), failing);

    expect(answer.kind).toBe(current.enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_RESPONSE);
    expect(current.reports.join()).toMatch(/could not report success for a: the store is read only \(make it writable\)/);
  }, RUN_BOUND);

  it("answers THROWN with the cause when the accounts service refuses to pick an account", async () => {
    const current = world();
    await seeded(current, "a");
    const failing = { ...current.dependencies, accounts: accountsWith(current.accounts, { acquire: refusing }) };

    const answer = await served(current, new AbortController(), failing);

    expect(answer).toEqual({ kind: current.enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_THROWN, message: "claude-code-provider could not serve the request: the store is read only (make it writable)" });
    expect(current.server.requestsTo("/v1/messages")).toHaveLength(0);
  }, RUN_BOUND);
});

describe("a cancelled call", () => {
  it("before the first turn answers THROWN without taking an account", async () => {
    const current = world();
    await seeded(current, "a");
    const upstream = new AbortController();
    upstream.abort();

    const answer = await served(current, upstream);

    expect(answer.kind).toBe(current.enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_THROWN);
    expect((await current.storedAccount("a")) as unknown as Record<string, unknown>).not.toHaveProperty("lastUsed");
    expect(current.server.requests).toHaveLength(0);
  }, RUN_BOUND);

  it("while an access token is being refreshed answers THROWN and reports nothing", async () => {
    const current = world();
    await seedAccount(current, "a", NOW - 1);
    current.server.tokenResponder = () => ({ status: 200, body: { access_token: "late" }, delayMilliseconds: 2_000 });
    const upstream = new AbortController();

    const answering = served(current, upstream);
    await untilTrue(() => current.server.requestsTo("/v1/oauth/token").length > 0);
    upstream.abort();
    const answer = await answering;

    expect(answer.kind).toBe(current.enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_THROWN);
    const account = (await current.storedAccount("a")) as unknown as Record<string, unknown>;
    expect(account).toMatchObject({ enabled: true });
    expect(account).not.toHaveProperty("coolingDownUntil");
    expect(current.server.requestsTo("/v1/messages")).toHaveLength(0);
  }, RUN_BOUND);

  it("while the 2xx body is being read answers THROWN, not a body that is not a message", async () => {
    const current = world();
    await seeded(current, "a");
    current.server.messagesResponder = () => ({ status: 200, stall: true, headers: { "content-type": "application/json" } });
    const upstream = new AbortController();

    const answering = served(current, upstream);
    await untilTrue(() => current.server.requestsTo("/v1/messages").length > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    upstream.abort();
    const answer = await answering;

    expect(answer).toEqual({ kind: current.enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_THROWN, message: "claude-code-provider's call was cancelled before it was served" });
  }, RUN_BOUND);
});

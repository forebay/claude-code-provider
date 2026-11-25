import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningHost } from "@weivel/typescript/program";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Enums, Pair } from "../src/contract.js";
import { bundled, homeWith, hostIn, providerInstall, realPlacesSnapshot, REPOSITORY, type Home } from "./fixtures/home.js";
import { GRANTED_TOKENS, startOauthServer, successfulGrants, type OauthServer, type Reply } from "./fixtures/oauth-server.js";
import { consumerInstall, RUN_BOUND, settingsFor } from "./world.js";

const realBefore = await realPlacesSnapshot();
const PROVIDER = "claude-code-provider";
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const LONG_WAIT = 30_000;
const FIVE_HOUR_RESET_SECONDS = Math.floor(Date.now() / 1000) + 5 * 3600;

const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "hi" }],
  model: "claude-sonnet-4",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

const STREAM_START = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s","type":"message","role":"assistant","model":"claude-sonnet-4","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"streamed"}}\n\n',
].join("");

interface Answered {
  readonly kind: number;
  readonly response?: { readonly content: readonly { readonly kind: number; readonly text: string }[] };
  readonly failure?: { readonly status: number; readonly body: string; readonly headers: readonly Pair[]; readonly has_retry_after: number; readonly retry_after_milliseconds: number };
  readonly stream?: unknown;
  readonly message?: string;
}

interface Calls {
  count(): number;
  models(): Promise<{ provider: { provider: string; models: { id: string; context: number; output: number }[] } }>;
  handle(argument: unknown): Promise<Answered>;
  next(stream: unknown): Promise<{ kind: number; event?: { kind: number; text?: string } }>;
  release_stream(stream: unknown): void;
  cancel(token: bigint | number): Promise<unknown>;
}

interface Actions {
  login(input?: { code?: string }): Promise<{ url?: string; id?: string }>;
  remove(input: { item: string }): Promise<unknown>;
}

interface Running {
  readonly home: Home;
  readonly host: RunningHost;
  readonly calls: Calls;
  readonly actions: Actions;
  readonly enums: Enums;
}

let bundles: string;
let providerBundle: string;
let consumerBundle: string;
let server: OauthServer;
const homes: Home[] = [];
const hosts: RunningHost[] = [];

async function started(settings: Record<string, unknown> = {}): Promise<Running> {
  const home = await homeWith([providerInstall(providerBundle, { ...settingsFor(server), ...settings }), consumerInstall(consumerBundle)]);
  homes.push(home);
  const host = await hostIn(home);
  hosts.push(host);
  const calls = host.service<Calls>("consumer", "consumer:calls");
  const actions = host.service<Actions>(PROVIDER, "claude-code-provider:accounts");
  const enums = host.service<Enums>("consumer", "consumer:enums");
  if (calls === undefined || actions === undefined || enums === undefined) throw new Error("the consumer or the provider registered no service");
  return { home, host, calls, actions, enums };
}

async function loggedIn(actions: Actions, email = "me@example.com"): Promise<string> {
  server.tokenResponder = (request) =>
    new URLSearchParams(request.body).get("grant_type") === "refresh_token" ? successfulGrants(request) : { status: 200, body: { ...GRANTED_TOKENS, account: { email_address: email } } };
  const state = new URL((await actions.login()).url!).searchParams.get("state");
  return (await actions.login({ code: `the-code#${state}` })).id!;
}

async function serving(settings: Record<string, unknown> = {}): Promise<Running> {
  const running = await started(settings);
  await loggedIn(running.actions);
  return running;
}

/** The IR event kinds the contract's description carries, which the provider passes on without reading them. */
function eventKinds(enums: Enums): Readonly<Record<string, number>> {
  return (enums.provider as unknown as Readonly<Record<string, Readonly<Record<string, number>>>>).forebay_ir_event_kind!;
}

function argument(enums: Enums, token: bigint, headers: readonly Pair[] = [], stream = 0): unknown {
  const text = enums.provider.forebay_ir_block_kind.FOREBAY_IR_BLOCK_TEXT;
  return { request: { model: "claude-sonnet-4", messages: [{ role: "user", content: [{ kind: text, text: "hi" }] }], stream }, headers, token };
}

function storedAccounts(home: Home): Array<Record<string, unknown>> {
  const found = readdirSync(home.base, { recursive: true, encoding: "utf8" }).find((file) => file.endsWith("accounts.json"));
  return JSON.parse(readFileSync(join(home.base, found!), "utf8")).accounts;
}

function waited(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition() && Date.now() < deadline) await waited(20);
}

const ok = (): Reply => ({ status: 200, rawBody: JSON.stringify(MESSAGE), headers: { "content-type": "application/json" } });

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
  for (const home of homes.splice(0)) home.remove();
  await server.close();
});

afterAll(() => rmSync(bundles, { recursive: true, force: true }));

describe("claude-code-provider's forebay.provider under the host program, over runtime in a temporary home", () => {
  it("provides forebay.provider past the host's provide-time contract check", async () => {
    const { calls, enums } = await started();

    expect(calls.count()).toBe(1);
  }, RUN_BOUND);

  it("sends a request C encoded, led by the identity block and with the oauth beta merged in, and answers C's decoding", async () => {
    const { calls, enums } = await serving();
    server.messagesResponder = ok;

    const answer = await calls.handle(argument(enums, 1n, [{ name: "anthropic-beta", value: "tools-2024" }, { name: "x-app", value: "cli" }]));

    const [sent] = server.requestsTo("/v1/messages");
    expect(answer.kind, answer.message).toBe(enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_RESPONSE);
    expect(answer.response?.content).toEqual([expect.objectContaining({ kind: enums.provider.forebay_ir_block_kind.FOREBAY_IR_BLOCK_TEXT, text: "hi" })]);
    expect(sent?.headers).toMatchObject({ authorization: "Bearer access-from-grant", "anthropic-beta": "tools-2024,oauth-2025-04-20", "anthropic-version": "2023-06-01", "x-app": "cli" });
    expect(JSON.parse(sent!.body)).toMatchObject({ model: "claude-sonnet-4", system: [{ type: "text", text: IDENTITY }], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  }, RUN_BOUND);

  it("cools an account until the five hour reset a 429 names, and says when to retry", async () => {
    const { home, calls, enums } = await serving({ max_account_attempts: 1 });
    server.messagesResponder = () => ({ status: 429, rawBody: "rate limited", headers: { "content-type": "text/plain", "anthropic-ratelimit-unified-5h-reset": String(FIVE_HOUR_RESET_SECONDS) } });

    const answer = await calls.handle(argument(enums, 1n));

    expect(answer.kind).toBe(enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_FAILURE);
    expect(answer.failure).toMatchObject({ status: 429, body: "rate limited", has_retry_after: 1 });
    expect(answer.failure!.retry_after_milliseconds).toBeGreaterThan(4 * 3600 * 1000);
    expect(storedAccounts(home)[0]).toMatchObject({ rateLimitResetTimes: { messages: FIVE_HOUR_RESET_SECONDS * 1000 } });
  }, RUN_BOUND);

  it("streams C's decoded IR events, and release_stream ends the upstream request", async () => {
    const { calls, enums } = await serving();
    server.messagesResponder = () => ({ status: 200, rawBody: STREAM_START, headers: { "content-type": "text/event-stream" }, holdOpen: true });

    const answer = await calls.handle(argument(enums, 1n, [], 1));
    const events = [await calls.next(answer.stream), await calls.next(answer.stream), await calls.next(answer.stream)];
    calls.release_stream(answer.stream);
    await until(() => server.abandoned.length > 0);

    expect(answer.kind, answer.message).toBe(enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_STREAM);
    const { FOREBAY_PROVIDER_NEXT_EVENT } = enums.provider.forebay_provider_next_kind;
    const { FOREBAY_IR_EVENT_MESSAGE_START, FOREBAY_IR_EVENT_CONTENT_BLOCK_START, FOREBAY_IR_EVENT_TEXT_DELTA } = eventKinds(enums);
    expect(events.map((next) => [next.kind, next.event?.kind])).toEqual([
      [FOREBAY_PROVIDER_NEXT_EVENT, FOREBAY_IR_EVENT_MESSAGE_START],
      [FOREBAY_PROVIDER_NEXT_EVENT, FOREBAY_IR_EVENT_CONTENT_BLOCK_START],
      [FOREBAY_PROVIDER_NEXT_EVENT, FOREBAY_IR_EVENT_TEXT_DELTA],
    ]);
    expect(events[2]?.event?.text).toBe("streamed");
    expect(server.abandoned.map((request) => request.path)).toEqual(["/v1/messages"]);
  }, RUN_BOUND);

  it.each([["a bigint", (token: bigint) => token], ["a number", (token: bigint) => Number(token)]])("cancels a pending upstream request by its token given as %s, answering THROWN", async (_form, form) => {
    const { calls, enums } = await serving();
    server.messagesResponder = () => ({ ...ok(), delayMilliseconds: LONG_WAIT });
    const began = Date.now();

    const answering = calls.handle(argument(enums, 7n));
    await until(() => server.requestsTo("/v1/messages").length > 0);
    await calls.cancel(form(7n));
    const answer = await answering;
    await until(() => server.abandoned.length > 0);

    expect(answer.kind).toBe(enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_THROWN);
    expect(Date.now() - began).toBeLessThan(LONG_WAIT / 2);
    expect(server.abandoned.map((request) => request.path)).toEqual(["/v1/messages"]);
  }, RUN_BOUND);

  it("answers a cancel of a token it does not know, and changes nothing", async () => {
    const { calls, enums } = await serving();
    server.messagesResponder = ok;

    await expect(calls.cancel(99n)).resolves.toBeUndefined();
    const answer = await calls.handle(argument(enums, 99n));

    expect(answer.kind, answer.message).toBe(enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_RESPONSE);
  }, RUN_BOUND);

  it("with every account removed, offers no models and answers 503 in Anthropic's error shape", async () => {
    const { calls, actions, enums } = await started();
    const id = await loggedIn(actions);
    await actions.remove({ item: id });

    const models = await calls.models();
    const answer = await calls.handle(argument(enums, 1n));

    expect(models.provider).toMatchObject({ provider: PROVIDER, models: [] });
    expect(answer.kind).toBe(enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_FAILURE);
    expect(answer.failure?.status).toBe(503);
    expect(JSON.parse(answer.failure!.body)).toMatchObject({ type: "error", error: { type: "api_error", message: expect.stringContaining("login action") } });
    expect(answer.failure?.headers).toContainEqual({ name: "content-type", value: "application/json" });
    expect(server.requestsTo("/v1/messages")).toHaveLength(0);
  }, RUN_BOUND);

  it("offers only the upstream's models whose id starts with the configured model_prefix, with the configured default limits", async () => {
    const { calls, enums } = await serving({ model_prefix: "claude-opus", default_context: 1000, default_output: 500 });
    server.modelsResponder = () => ({ status: 200, body: { data: [{ id: "claude-opus-4" }, { id: "claude-sonnet-4" }, { id: "claude-opus-5", max_input_tokens: 9000 }] } });

    const models = await calls.models();

    expect(models.provider.models.map((model) => [model.id, model.context, model.output])).toEqual([["claude-opus-4", 1000, 500], ["claude-opus-5", 9000, 500]]);
  }, RUN_BOUND);

  it("rotates past a 403, disabling that account, and serves from the next", async () => {
    const { home, calls, actions, enums } = await started();
    const first = await loggedIn(actions, "first@example.com");
    const second = await loggedIn(actions, "second@example.com");
    const replies: Reply[] = [{ status: 403, rawBody: "forbidden", headers: { "content-type": "text/plain" } }, ok()];
    server.messagesResponder = () => replies.shift()!;

    const answer = await calls.handle(argument(enums, 1n));

    expect(answer.kind, answer.message).toBe(enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_RESPONSE);
    expect(storedAccounts(home)).toMatchObject([{ id: first, enabled: false, disabledReason: "re-login required (token lacks inference scope)" }, { id: second, enabled: true }]);
  }, RUN_BOUND);

  it("answers another upstream failure as it came", async () => {
    const { calls, enums } = await serving();
    server.messagesResponder = () => ({ status: 500, rawBody: "upstream broke", headers: { "content-type": "text/plain", "x-upstream": "1" } });

    const answer = await calls.handle(argument(enums, 1n));

    expect(answer.failure).toMatchObject({ status: 500, body: "upstream broke", has_retry_after: 0 });
    expect(answer.failure?.headers).toContainEqual({ name: "x-upstream", value: "1" });
    expect(server.requestsTo("/v1/messages")).toHaveLength(1);
  }, RUN_BOUND);

  it("answers a 502 for a 2xx body that is not a message", async () => {
    const { calls, enums } = await serving();
    server.messagesResponder = () => ({ status: 200, rawBody: "<html>", headers: { "content-type": "application/json" } });

    const answer = await calls.handle(argument(enums, 1n));

    expect(answer.failure?.status).toBe(502);
    expect(JSON.parse(answer.failure!.body)).toMatchObject({ type: "error", error: { type: "api_error" } });
  }, RUN_BOUND);

  it("answers a 503 saying when to retry once every account is cooling", async () => {
    const { calls, enums } = await serving();
    const reset = Math.floor(Date.now() / 1000) + 600;
    server.messagesResponder = () => ({ status: 429, rawBody: "rate limited", headers: { "content-type": "text/plain", "anthropic-ratelimit-unified-reset": String(reset) } });

    const answer = await calls.handle(argument(enums, 1n));

    expect(server.requestsTo("/v1/messages")).toHaveLength(1);
    expect(answer.failure).toMatchObject({ status: 503, has_retry_after: 1 });
    expect(answer.failure!.retry_after_milliseconds).toBeGreaterThan(500_000);
    expect(JSON.parse(answer.failure!.body)).toMatchObject({ type: "error", error: { type: "api_error", message: expect.stringContaining("all rate-limited") } });
  }, RUN_BOUND);

  it("left the real home's places as they were", async () => {
    expect(await realPlacesSnapshot()).toEqual(realBefore);
  });
});

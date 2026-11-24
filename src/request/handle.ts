import type { AccessAnswer, TokenAccess } from "../accounts/access.js";
import { messageOf, outcomesOf } from "../accounts/dependencies.js";
import type { AccountDependencies } from "../accounts/dependencies.js";
import { INFERENCE_SCOPE_REASON, MESSAGES_LANE } from "../constants.js";
import type { AcquireAnswer, Anthropic, HandleAnswer, HandleArgument, IrFailure, Pair } from "../contract.js";
import { isRateLimitStatus, sendAttempt, type Attempt } from "./attempt.js";
import { captureQuota } from "./capture-quota.js";
import { reportAttempt } from "./report.js";
import { rewrite } from "./rewrite.js";
import { UpstreamStream } from "./upstream-stream.js";

const UNAVAILABLE_STATUS = 503;
const BAD_GATEWAY_STATUS = 502;
const ALL_COOLING_MESSAGE = "No Claude account free right now (all rate-limited). Try again shortly.";
const NO_ACCOUNT_MESSAGE = "No Claude account can serve: every account is disabled or logged out. Sign one in with the login action.";
const EVENT_STREAM = "text/event-stream";

/** What serving a request reaches beyond the account operations. */
export interface RequestDependencies extends AccountDependencies {
  readonly anthropic: Anthropic;
}

type Received = Extract<Attempt, { kind: "response" }>;

/** A turn either ends the request with an answer, or rotates on, remembering the real upstream failure it saw, if any. */
type Turn = { answer: HandleAnswer } | { rotated: IrFailure | undefined };

function pairsOf(headers: Record<string, string>): Pair[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function failed(dependencies: RequestDependencies, failure: IrFailure): HandleAnswer {
  return { kind: dependencies.enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_FAILURE, failure };
}

/** A failure this plugin words itself, as an Anthropic error body `anthropic` writes, waiting `retryAfter` when known. */
async function ownFailure(dependencies: RequestDependencies, status: number, message: string, retryAfter?: number): Promise<IrFailure> {
  const body = await dependencies.anthropic.error_envelope({ argument: { reply_kind: dependencies.enums.anthropic.forebay_reply_kind.FOREBAY_REPLY_PROVIDER_FAILURE, message } });
  const retry = retryAfter === undefined ? { has_retry_after: 0, retry_after_milliseconds: 0 } : { has_retry_after: 1, retry_after_milliseconds: Math.max(0, retryAfter) };
  return { status, headers: body.headers, body: new TextDecoder().decode(body.bytes), ...retry };
}

/** The reset the upstream's headers name, read by `anthropic`, as epoch milliseconds, or undefined. */
async function resetOf(dependencies: RequestDependencies, headers: readonly Pair[]): Promise<number | undefined> {
  const reset = await dependencies.anthropic.reset_time({ argument: { headers, now: dependencies.clock() } });
  return reset.has_reset_at === 1 ? reset.reset_at : undefined;
}

/** The upstream's failure as it came, waiting until the reset its headers name, and that reset. */
async function upstreamFailure(dependencies: RequestDependencies, received: Received): Promise<{ failure: IrFailure; resetAt: number | undefined }> {
  const headers = pairsOf(received.headers);
  const body = await received.response.text();
  const resetAt = await resetOf(dependencies, headers);
  const retry = resetAt === undefined ? { has_retry_after: 0, retry_after_milliseconds: 0 } : { has_retry_after: 1, retry_after_milliseconds: Math.max(0, resetAt - dependencies.clock()) };
  return { failure: { status: received.response.status, headers, body, ...retry }, resetAt };
}

async function decoded(dependencies: RequestDependencies, received: Received, upstream: AbortController): Promise<HandleAnswer> {
  const { response } = received;
  if (response.headers.get("content-type")?.includes(EVENT_STREAM) === true && response.body !== null) {
    const decoder = await dependencies.anthropic.stream_decoder_open({});
    return { kind: dependencies.enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_STREAM, stream: new UpstreamStream(dependencies.anthropic, dependencies.enums.provider, decoder, response.body as ReadableStream<Uint8Array>, upstream) };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  try {
    return { kind: dependencies.enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_RESPONSE, response: (await dependencies.anthropic.decode_response({ argument: { bytes, headers: [] } })).response };
  } catch {
    return failed(dependencies, await ownFailure(dependencies, BAD_GATEWAY_STATUS, "the upstream answered a body that is not a message"));
  }
}

async function unavailable(dependencies: RequestDependencies, acquired: AcquireAnswer): Promise<HandleAnswer> {
  const now = dependencies.clock();
  const retryAfter = acquired.knows_available_at === 1 ? acquired.available_at - now : undefined;
  if (acquired.kind === dependencies.enums.accounts.forebay_accounts_acquire_kind.FOREBAY_ACCOUNTS_CLAIMED) return failed(dependencies, await ownFailure(dependencies, UNAVAILABLE_STATUS, ALL_COOLING_MESSAGE, retryAfter));
  return failed(dependencies, await ownFailure(dependencies, UNAVAILABLE_STATUS, retryAfter === undefined ? NO_ACCOUNT_MESSAGE : ALL_COOLING_MESSAGE, retryAfter));
}

/**
 * Builds the `handle` of the plugin: up to `max_account_attempts` turns, each taking an account from the `accounts`
 * service, getting its access token, sending one request and reporting what happened to that account.
 *
 * @remarks A 429 or 529 rotates, reporting the reset `anthropic` reads from the response, else only its attempt, which
 * the accounts service backs the account off by. A 401 rotates, a 403 disables the account, any other status is the
 * answer as the upstream gave it. No account that can serve, or accounts that are all cooling, is a 503, saying when
 * to retry where that is known, and running out of turns answers the last real upstream failure, else a 502. A
 * refused `acquire` answers THROWN with its cause, and a cancelled call answers THROWN and reports nothing.
 */
export function createHandle(dependencies: RequestDependencies, access: TokenAccess): (argument: HandleArgument, upstream: AbortController) => Promise<HandleAnswer> {
  async function ensured(id: string, signal: AbortSignal): Promise<AccessAnswer> {
    try {
      return await access.ensureAccess(id, dependencies.clock(), signal);
    } catch (cause) {
      if (signal.aborted) throw cause;
      return { none: true, reason: messageOf(cause) };
    }
  }

  async function afterResponse(id: string, attemptNumber: number, received: Received, upstream: AbortController): Promise<Turn> {
    const status = received.response.status;
    await captureQuota(dependencies, id, received.headers);
    if (isRateLimitStatus(status)) {
      const { failure, resetAt } = await upstreamFailure(dependencies, received);
      await reportAttempt(dependencies, id, resetAt === undefined ? { outcome: outcomesOf(dependencies).FOREBAY_ACCOUNTS_RATE_LIMITED, attempt: attemptNumber } : { outcome: outcomesOf(dependencies).FOREBAY_ACCOUNTS_RATE_LIMITED, resetAt });
      return { rotated: failure };
    }
    if (status === 401) {
      await reportAttempt(dependencies, id, { outcome: outcomesOf(dependencies).FOREBAY_ACCOUNTS_ERROR, attempt: attemptNumber, reason: "401 unauthorized" });
      return { rotated: (await upstreamFailure(dependencies, received)).failure };
    }
    if (status === 403) {
      await reportAttempt(dependencies, id, { outcome: outcomesOf(dependencies).FOREBAY_ACCOUNTS_DISABLED, reason: INFERENCE_SCOPE_REASON });
      return { rotated: (await upstreamFailure(dependencies, received)).failure };
    }
    if (!received.response.ok) return { answer: failed(dependencies, (await upstreamFailure(dependencies, received)).failure) };
    await reportAttempt(dependencies, id, { outcome: outcomesOf(dependencies).FOREBAY_ACCOUNTS_SUCCESS });
    return { answer: await decoded(dependencies, received, upstream) };
  }

  async function turn(argument: HandleArgument, upstream: AbortController, attemptNumber: number): Promise<Turn> {
    const settings = await dependencies.settings();
    const acquired = await dependencies.accounts.acquire({ argument: { store: dependencies.store, lane: MESSAGES_LANE, strategy: settings.strategy, now: dependencies.clock() } });
    if (acquired.kind !== dependencies.enums.accounts.forebay_accounts_acquire_kind.FOREBAY_ACCOUNTS_CLAIMED || acquired.id === undefined || acquired.available !== 1) return { answer: await unavailable(dependencies, acquired) };
    const id = acquired.id;
    const token = await ensured(id, upstream.signal);
    if ("none" in token) {
      await reportAttempt(dependencies, id, { outcome: outcomesOf(dependencies).FOREBAY_ACCOUNTS_ERROR, attempt: attemptNumber, reason: token.reason });
      return { rotated: undefined };
    }
    const request = await rewrite(dependencies.anthropic, dependencies.enums.provider.forebay_ir_block_kind, argument.request, argument.headers, token.access, settings.apiBase);
    const attempt = await sendAttempt(request, upstream.signal);
    if (attempt.kind === "transport-failed") {
      await reportAttempt(dependencies, id, { outcome: outcomesOf(dependencies).FOREBAY_ACCOUNTS_ERROR, attempt: attemptNumber, reason: "transport failed" });
      return { rotated: undefined };
    }
    return afterResponse(id, attemptNumber, attempt, upstream);
  }

  async function served(argument: HandleArgument, upstream: AbortController): Promise<HandleAnswer> {
    const turns = (await dependencies.settings()).maxAccountAttempts;
    let last: IrFailure | undefined;
    for (let attemptNumber = 0; attemptNumber < turns; attemptNumber++) {
      upstream.signal.throwIfAborted();
      const result = await turn(argument, upstream, attemptNumber);
      if ("answer" in result) return result.answer;
      last = result.rotated ?? last;
    }
    return failed(dependencies, last ?? (await ownFailure(dependencies, BAD_GATEWAY_STATUS, `Claude request failed after ${turns} attempts`)));
  }

  return async (argument, upstream) => {
    try {
      return await served(argument, upstream);
    } catch (cause) {
      if (upstream.signal.aborted) return { kind: dependencies.enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_THROWN, message: "claude-code-provider's call was cancelled before it was served" };
      return { kind: dependencies.enums.provider.forebay_provider_handle_kind.FOREBAY_PROVIDER_HANDLE_THROWN, message: `claude-code-provider could not serve the request: ${messageOf(cause)}` };
    }
  };
}

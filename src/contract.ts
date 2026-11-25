import type { RequiredEnums } from "@weivel/typescript/context";

/**
 * The shapes weivel/typescript's binding gives the definitions this plugin provides and calls: each operation one
 * async method taking its input parameters by name and answering its answer struct without its sizes, counts and
 * storage, a NULL text left out, a NULL array answered empty and NONE answered as a symbol. Only the members this
 * plugin reads or writes are named.
 */

export interface Pair {
  readonly name: string;
  readonly value: string;
}

export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly has_context: number;
  readonly context: number;
  readonly has_output: number;
  readonly output: number;
}

export interface CatalogProvider {
  readonly provider: string;
  readonly models: readonly CatalogModel[];
  readonly has_ranking: number;
}

/** A handle the binding wraps: an opaque pointer the provider frees on `release`. */
export interface Handle {
  release(): void;
}

/** An IR block of the binding's shape; this plugin writes text blocks and reads only `kind` and `text`. */
export interface IrBlock {
  readonly kind: number;
  readonly text?: string;
  readonly [member: string]: unknown;
}

/** An IR request of the binding's shape, every member this plugin does not touch passed on as it came. */
export interface IrRequest {
  readonly has_system?: number;
  readonly system?: readonly IrBlock[];
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly [member: string]: unknown;
}

export interface IrFailure {
  readonly status: number;
  readonly headers: readonly Pair[];
  readonly body: string;
  readonly has_retry_after: number;
  readonly retry_after_milliseconds: number;
}

/** A stream this plugin hands back, read by `next` one event at a time. */
export interface Stream {
  next(): Promise<NextAnswer>;
  release(): void;
}

/** What `handle` answers: a forebay_provider_handle_kind, and the member that kind carries. */
export interface HandleAnswer {
  readonly kind: number;
  readonly response?: unknown;
  readonly failure?: IrFailure;
  readonly stream?: Stream;
  readonly message?: string;
}

/** What `next` answers: a forebay_provider_next_kind, and the member that kind carries. */
export interface NextAnswer {
  readonly kind: number;
  readonly event?: unknown;
  readonly failure?: string;
}

/** A call's token; a uint64 out of C may arrive as a number or as a bigint. */
export type Token = bigint | number;

export interface HandleArgument {
  readonly request: IrRequest;
  readonly headers: readonly Pair[];
  readonly token: Token;
}

/** The `forebay.provider` contract as this plugin offers it, in the binding's shapes. */
export interface Provider {
  models(input: Record<string, never>): Promise<{ provider: CatalogProvider }>;
  handle(input: { argument: HandleArgument }): Promise<HandleAnswer>;
  next(input: { stream: Stream }): Promise<NextAnswer>;
  release_stream(input: { stream: Stream }): void;
  cancel(input: { argument: { token: Token } }): Promise<void>;
}

/** Bytes C wrote and the reply they go out in. */
export interface Body {
  readonly bytes: Uint8Array;
  readonly status: number;
  readonly headers: readonly Pair[];
}

/** forebay-library's `anthropic` service, the operations this plugin calls. */
export interface Anthropic {
  encode_request(input: { argument: { request: IrRequest } }): Promise<Body>;
  decode_response(input: { argument: { bytes: Uint8Array; headers: readonly Pair[] } }): Promise<{ response: unknown }>;
  stream_decoder_open(input: Record<string, never>): Promise<Handle>;
  stream_decode(input: { argument: { decoder: Handle; bytes: Uint8Array } }): Promise<{ events: readonly unknown[] }>;
  stream_decode_finish(input: { argument: { decoder: Handle; bytes: Uint8Array } }): Promise<{ events: readonly unknown[] }>;
  error_envelope(input: { argument: { reply_kind: number; message: string } }): Promise<Body>;
  reset_time(input: { argument: { headers: readonly Pair[]; now: number } }): Promise<{ has_reset_at: number; reset_at: number }>;
}

/** An account as the store keeps it: the members the store reads, and this plugin's own beside them. */
export interface StoredAccount {
  readonly id: string;
  readonly label?: string;
  readonly enabled?: boolean;
  readonly disabledReason?: string;
  readonly coolingDownUntil?: number;
  readonly expires?: number;
  readonly addedAt?: number;
  readonly quota?: unknown;
}

export interface AcquireAnswer {
  readonly kind: number;
  readonly id?: string;
  readonly available: number;
  readonly knows_available_at: number;
  readonly available_at: number;
}

export interface ReportArgument {
  readonly store: string;
  readonly id: string;
  readonly outcome: number;
  readonly now: number;
  readonly lane?: string;
  readonly reason?: string;
  readonly has_reset_at: number;
  readonly reset_at: number;
  readonly has_random: number;
  readonly random: number;
  readonly attempt: number;
  readonly base_milliseconds: number;
  readonly max_milliseconds: number;
  readonly quota?: unknown;
}

/** forebay-library's `accounts` service. */
export interface Accounts {
  list(input: { argument: { store: string } }): Promise<{ accounts: readonly StoredAccount[] }>;
  upsert(input: { argument: { store: string; account: Record<string, unknown> } }): Promise<{ outcome: number }>;
  remove(input: { argument: { store: string; id: string } }): Promise<{ removed: number }>;
  acquire(input: { argument: { store: string; lane: string; strategy: number; now: number } }): Promise<AcquireAnswer>;
  report(input: { argument: ReportArgument }): Promise<{ changed: number }>;
  token_expired(input: { argument: { has_expires: number; expires: number; now: number; has_skew_milliseconds: number; skew_milliseconds: number } }): Promise<{ expired: number }>;
  has_capacity(input: { argument: { pools: readonly unknown[] } }): Promise<{ capacity: number }>;
}

/** The host's `weivel.secrets`: any bytes under a name. */
export interface Secrets {
  get(input: { name: string }): Promise<{ bytes: Uint8Array } | symbol>;
  set(input: { name: string; bytes: Uint8Array }): Promise<void>;
  remove(input: { name: string }): Promise<void>;
}

export interface Config {
  get_tree(input: { key: string }): Promise<unknown>;
}

export interface Paths {
  plugin(input: Record<string, never>): Promise<string>;
}

export interface Log {
  write(input: { level: number; message: string }): Promise<void>;
}

/**
 * The enums this plugin reads, by the names forebay-library's and the standard's headers spell them. Only the names
 * are written here: the numbers are the descriptions', which the plugin's context answers.
 */
export const PROVIDER_ENUM_NAMES = {
  forebay_provider_handle_kind: ["FOREBAY_PROVIDER_HANDLE_RESPONSE", "FOREBAY_PROVIDER_HANDLE_FAILURE", "FOREBAY_PROVIDER_HANDLE_STREAM", "FOREBAY_PROVIDER_HANDLE_THROWN"],
  forebay_provider_next_kind: ["FOREBAY_PROVIDER_NEXT_EVENT", "FOREBAY_PROVIDER_NEXT_END", "FOREBAY_PROVIDER_NEXT_FAILURE"],
  forebay_ir_block_kind: ["FOREBAY_IR_BLOCK_TEXT"],
} as const;

export type ProviderEnums = RequiredEnums<typeof PROVIDER_ENUM_NAMES>;

export const ANTHROPIC_ENUM_NAMES = {
  forebay_reply_kind: ["FOREBAY_REPLY_PROVIDER_FAILURE"],
} as const;

export type AnthropicEnums = RequiredEnums<typeof ANTHROPIC_ENUM_NAMES>;

export const ACCOUNTS_ENUM_NAMES = {
  forebay_accounts_acquire_kind: ["FOREBAY_ACCOUNTS_CLAIMED"],
  forebay_accounts_strategy: ["FOREBAY_ACCOUNTS_STICKY", "FOREBAY_ACCOUNTS_ROUND_ROBIN", "FOREBAY_ACCOUNTS_HYBRID"],
  forebay_accounts_report_outcome: ["FOREBAY_ACCOUNTS_SUCCESS", "FOREBAY_ACCOUNTS_RATE_LIMITED", "FOREBAY_ACCOUNTS_ERROR", "FOREBAY_ACCOUNTS_DISABLED", "FOREBAY_ACCOUNTS_QUOTA"],
  forebay_accounts_upsert_outcome: ["FOREBAY_ACCOUNTS_ADDED", "FOREBAY_ACCOUNTS_UNCHANGED", "FOREBAY_ACCOUNTS_UPDATED"],
} as const;

export type AccountsEnums = RequiredEnums<typeof ACCOUNTS_ENUM_NAMES>;

export const LOG_ENUM_NAMES = {
  weivel_standard_log_level: ["WEIVEL_STANDARD_LOG_WARN"],
} as const;

export type LogEnums = RequiredEnums<typeof LOG_ENUM_NAMES>;

/** Each enum serving a request reads, by the definition or contract whose description carries it. */
export interface Enums {
  readonly provider: ProviderEnums;
  readonly anthropic: AnthropicEnums;
  readonly accounts: AccountsEnums;
}

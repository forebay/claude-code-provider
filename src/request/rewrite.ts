import { ANTHROPIC_OAUTH_BETA, ANTHROPIC_VERSION, CLAUDE_CODE_SYSTEM } from "../constants.js";
import { IR_BLOCK_TEXT, type Anthropic, type IrBlock, type IrRequest, type Pair } from "../contract.js";
import type { UpstreamRequest } from "./attempt.js";

const MESSAGES_PATH = "/v1/messages";
/** The request extension that makes `anthropic` write a lone text system block back as a bare string. */
const SYSTEM_IS_STRING = "$systemIsString";

function isIdentity(block: IrBlock | undefined): boolean {
  return block?.kind === IR_BLOCK_TEXT && block.text === CLAUDE_CODE_SYSTEM;
}

/** The system blocks led by the Claude Code identity block exactly once; a block already leading is kept as it is. */
export function withIdentityBlock(system: readonly IrBlock[] | undefined): readonly IrBlock[] {
  const blocks = system ?? [];
  return isIdentity(blocks[0]) ? blocks : [{ kind: IR_BLOCK_TEXT, text: CLAUDE_CODE_SYSTEM }, ...blocks];
}

/**
 * The request with the identity system block, written as a list of blocks.
 *
 * @implNote The upstream does not accept the identity as a bare string, so the note that the client sent its system as
 * one is dropped.
 */
export function withIdentity(request: IrRequest): IrRequest {
  const { [SYSTEM_IS_STRING]: _dropped, ...extensions } = request.extensions ?? {};
  return { ...request, has_system: 1, system: withIdentityBlock(request.has_system === 1 ? request.system : undefined), extensions };
}

/**
 * The `anthropic-beta` value with the OAuth flag added unless it is already there.
 *
 * @implNote The check is by substring, not by list membership, so `foo-oauth-2025-04-20-bar` counts as carrying the flag.
 */
export function mergeBeta(existing: string | undefined): string {
  if (existing === undefined || existing === "") return ANTHROPIC_OAUTH_BETA;
  return existing.includes(ANTHROPIC_OAUTH_BETA) ? existing : `${existing},${ANTHROPIC_OAUTH_BETA}`;
}

function clientHeaders(headers: readonly Pair[]): Record<string, string> {
  return Object.fromEntries(headers.map((pair) => [pair.name.toLowerCase(), pair.value]));
}

/**
 * Puts a request onto the Anthropic API for a subscription token: the body `anthropic` writes from the request led by
 * the identity block, and the client's forwarded headers with the Bearer token added, its `anthropic-version` kept
 * else the default, and the OAuth beta merged in.
 */
export async function rewrite(anthropic: Anthropic, request: IrRequest, headers: readonly Pair[], access: string, apiBase: string): Promise<UpstreamRequest> {
  const body = await anthropic.encode_request({ argument: { request: withIdentity(request) } });
  const client = clientHeaders(headers);
  return {
    url: `${apiBase}${MESSAGES_PATH}`,
    headers: {
      ...client,
      authorization: `Bearer ${access}`,
      "anthropic-version": client["anthropic-version"] === undefined || client["anthropic-version"] === "" ? ANTHROPIC_VERSION : client["anthropic-version"],
      "anthropic-beta": mergeBeta(client["anthropic-beta"]),
      "content-type": "application/json",
    },
    body: body.bytes,
  };
}

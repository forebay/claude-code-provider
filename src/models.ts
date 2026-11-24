import { ANTHROPIC_OAUTH_BETA, ANTHROPIC_VERSION } from "./constants.js";
import type { CatalogModel } from "./contract.js";
import { objectMember, textMember } from "./oauth/token-set.js";

const MODELS_TIMEOUT_MILLISECONDS = 20000;
const NAME_SUFFIX = " (Claude Code)";

/** Which upstream models this provider offers, and the limits of one the upstream names none for. */
export interface ModelChoice {
  readonly prefix: string;
  readonly defaultContext: number;
  readonly defaultOutput: number;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** @implNote The provider contract wants a context window and an output limit of at least 1, so a model the upstream gives no limits for gets the defaults. */
function entryOf(model: unknown, choice: ModelChoice): CatalogModel | undefined {
  const id = textMember(model, "id");
  if (id === undefined || !id.startsWith(choice.prefix)) return undefined;
  return {
    id,
    name: `${textMember(model, "display_name") ?? id}${NAME_SUFFIX}`,
    has_context: 1,
    context: positiveInteger(objectMember(model, "max_input_tokens"), choice.defaultContext),
    has_output: 1,
    output: positiveInteger(objectMember(model, "max_tokens"), choice.defaultOutput),
  };
}

function entriesOf(payload: unknown, choice: ModelChoice): CatalogModel[] {
  const data = objectMember(payload, "data");
  if (!Array.isArray(data)) return [];
  return data.map((model) => entryOf(model, choice)).filter((entry): entry is CatalogModel => entry !== undefined);
}

/**
 * The models the upstream lists for an access token whose id starts with the chosen prefix. Every failure, a
 * refusal, an unreachable upstream or a body that is not a list, answers no models rather than throwing: a model
 * list that cannot be fetched is an empty one, never a false one.
 */
export async function fetchModels(apiBase: string, access: string, choice: ModelChoice, signal: AbortSignal = AbortSignal.timeout(MODELS_TIMEOUT_MILLISECONDS)): Promise<CatalogModel[]> {
  try {
    const response = await fetch(`${apiBase}/v1/models?limit=1000`, {
      headers: { authorization: `Bearer ${access}`, "anthropic-version": ANTHROPIC_VERSION, "anthropic-beta": ANTHROPIC_OAUTH_BETA },
      signal,
    });
    if (!response.ok) return [];
    return entriesOf(await response.json(), choice);
  } catch {
    return [];
  }
}

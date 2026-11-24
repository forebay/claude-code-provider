import type { TokenAccess } from "./accounts/access.js";
import { enabledAccounts, messageOf } from "./accounts/dependencies.js";
import type { CatalogModel, CatalogProvider, Provider } from "./contract.js";
import { fetchModels } from "./models.js";
import { Cancellations } from "./request/cancellations.js";
import { createHandle, type RequestDependencies } from "./request/handle.js";

const PROVIDER_NAME = "claude-code-provider";
const ACCESS_TIMEOUT_MILLISECONDS = 30000;

function catalogOf(models: readonly CatalogModel[]): { provider: CatalogProvider } {
  return { provider: { provider: PROVIDER_NAME, models, has_ranking: 0 } };
}

/** The models of one account, or undefined when it has no usable access token. */
async function modelsOf(dependencies: RequestDependencies, access: TokenAccess, id: string): Promise<CatalogModel[] | undefined> {
  try {
    const answer = await access.ensureAccess(id, dependencies.clock(), AbortSignal.timeout(ACCESS_TIMEOUT_MILLISECONDS));
    if ("none" in answer) return undefined;
    const settings = await dependencies.settings();
    return await fetchModels(settings.apiBase, answer.access, { prefix: settings.modelPrefix, defaultContext: settings.defaultContext, defaultOutput: settings.defaultOutput });
  } catch (cause) {
    dependencies.log(`could not list the models of ${id}: ${messageOf(cause)}`);
    return undefined;
  }
}

/**
 * The models of the first enabled account with a usable access token, or none while no account is enabled; a cooling account is
 * enabled, so it still offers its models.
 *
 * @remarks Never rejects: an account that fails in any way is skipped, and no account at all is an empty list.
 */
async function listModels(dependencies: RequestDependencies, access: TokenAccess): Promise<{ provider: CatalogProvider }> {
  try {
    for (const account of await enabledAccounts(dependencies)) {
      const models = await modelsOf(dependencies, access, account.id);
      if (models !== undefined) return catalogOf(models);
    }
  } catch (cause) {
    dependencies.log(`could not list the models: ${messageOf(cause)}`);
  }
  return catalogOf([]);
}

/** This plugin's `forebay.provider` implementation. */
export function createProvider(dependencies: RequestDependencies, access: TokenAccess): Provider {
  const cancellations = new Cancellations();
  const handle = createHandle(dependencies, access);
  return {
    models: () => listModels(dependencies, access),
    async handle({ argument }) {
      const upstream = cancellations.begin(argument.token);
      try {
        return await handle(argument, upstream);
      } finally {
        cancellations.end(argument.token, upstream);
      }
    },
    next: ({ stream }) => stream.next(),
    release_stream({ stream }) {
      stream.release();
    },
    async cancel({ argument }) {
      cancellations.cancel(argument.token);
    },
  };
}

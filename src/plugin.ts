import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DescribedEnums, PluginContext } from "@weivel/typescript/context";
import type { Plugin } from "@weivel/typescript/host";
import { createTokenAccess } from "./accounts/access.js";
import { listAccountsAction, refreshAction, removeAction, verifyAction } from "./accounts/actions.js";
import { createLoginAction } from "./accounts/login.js";
import { quotaAction } from "./accounts/quota-action.js";
import { textSecrets } from "./accounts/secrets.js";
import type { Accounts, Anthropic, Config, Enums, Log, LogEnums, Paths, Provider, Secrets } from "./contract.js";
import { createProvider } from "./provider.js";
import type { RequestDependencies } from "./request/handle.js";
import { clientIdOf, readSettings } from "./settings.js";

const PROVIDER_CAPABILITY = "forebay.provider";
const ACCOUNTS_STORE_FILE = "accounts.json";
const ACTIONS_SERVICE = "claude-code-provider:accounts";

function required<Service>(context: PluginContext, id: string): Service {
  const service = context.services.get(context.service<Service>(id));
  if (service === undefined) throw new Error(`claude-code-provider reaches no ${id} service`);
  return service;
}

/** The enums a description carries, read as the names this plugin reads of them. */
function described<Read>(enums: DescribedEnums | undefined, of: string): Read {
  if (enums === undefined) throw new Error(`claude-code-provider reads the enums of ${of}, and no description carries them`);
  return enums as unknown as Read;
}

async function dependenciesOf(context: PluginContext): Promise<RequestDependencies> {
  const config = required<Config>(context, "weivel.config");
  const log = required<Log>(context, "weivel.log");
  const accounts = required<Accounts>(context, "accounts");
  const anthropic = required<Anthropic>(context, "anthropic");
  const enums: Enums = {
    provider: described(context.capabilities.enumsOf(context.capability<Provider>(PROVIDER_CAPABILITY)), PROVIDER_CAPABILITY),
    anthropic: described(context.services.enumsOf(anthropic), "anthropic"),
    accounts: described(context.services.enumsOf(accounts), "accounts"),
  };
  const { WEIVEL_STANDARD_LOG_WARN } = described<LogEnums>(context.services.enumsOf(log), "weivel.log").weivel_standard_log_level;
  const directory = await required<Paths>(context, "weivel.paths").plugin({});
  mkdirSync(directory, { recursive: true });
  return {
    accounts,
    anthropic,
    enums,
    store: join(directory, ACCOUNTS_STORE_FILE),
    secrets: textSecrets(required<Secrets>(context, "weivel.secrets")),
    settings: () => readSettings(config, enums.accounts),
    clientId: () => clientIdOf(process.env),
    clock: Date.now,
    random: Math.random,
    log: (message) => void log.write({ level: WEIVEL_STANDARD_LOG_WARN, message }).catch(() => undefined),
  };
}

const plugin: Plugin = {
  async activate(context) {
    const dependencies = await dependenciesOf(context);
    const access = createTokenAccess(dependencies);
    context.provide(context.capability<Provider>(PROVIDER_CAPABILITY), createProvider(dependencies, access));
    context.services.register(context.service(ACTIONS_SERVICE), {
      login: createLoginAction(dependencies),
      list: listAccountsAction(dependencies),
      verify: verifyAction(dependencies, access),
      refresh: refreshAction(dependencies, access),
      quota: quotaAction(dependencies, access),
      remove: removeAction(dependencies),
    });
  },
};

export default plugin;

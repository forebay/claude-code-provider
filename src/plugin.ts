import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PluginContext } from "@weivel/typescript/context";
import type { Plugin } from "@weivel/typescript/host";
import { createTokenAccess } from "./accounts/access.js";
import { listAccountsAction, refreshAction, removeAction, verifyAction } from "./accounts/actions.js";
import { createLoginAction } from "./accounts/login.js";
import { quotaAction } from "./accounts/quota-action.js";
import { textSecrets } from "./accounts/secrets.js";
import { ACCOUNTS_ENUM_NAMES, ANTHROPIC_ENUM_NAMES, LOG_ENUM_NAMES, PROVIDER_ENUM_NAMES, type Accounts, type Anthropic, type Config, type Enums, type Log, type Paths, type Provider, type Secrets } from "./contract.js";
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

/**
 * Every enum entry serving a request reads, from the descriptions of what this plugin reaches, refusing the activation
 * when one lacks a name it reads.
 *
 * @implNote They are read once, at the activation, which holds because a header's enums are append-only: an entry never
 * changes its number while the plugin runs.
 */
function enumsOf(context: PluginContext, reached: { accounts: Accounts; anthropic: Anthropic }): Enums {
  const { services, capabilities } = context;
  return {
    provider: context.requireEnums(capabilities.enumsOf(context.capability(PROVIDER_CAPABILITY)), PROVIDER_ENUM_NAMES, PROVIDER_CAPABILITY),
    anthropic: context.requireEnums(services.enumsOf(reached.anthropic), ANTHROPIC_ENUM_NAMES, "anthropic"),
    accounts: context.requireEnums(services.enumsOf(reached.accounts), ACCOUNTS_ENUM_NAMES, "accounts"),
  };
}

async function dependenciesOf(context: PluginContext): Promise<RequestDependencies> {
  const config = required<Config>(context, "weivel.config");
  const log = required<Log>(context, "weivel.log");
  const accounts = required<Accounts>(context, "accounts");
  const anthropic = required<Anthropic>(context, "anthropic");
  const enums = enumsOf(context, { accounts, anthropic });
  const { WEIVEL_STANDARD_LOG_WARN } = context.requireEnums(context.services.enumsOf(log), LOG_ENUM_NAMES, "weivel.log").weivel_standard_log_level;
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

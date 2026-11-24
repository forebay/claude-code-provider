import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PluginContext } from "@weivel/typescript/context";
import type { Plugin } from "@weivel/typescript/host";
import { createTokenAccess } from "./accounts/access.js";
import { listAccountsAction, refreshAction, removeAction, verifyAction } from "./accounts/actions.js";
import type { AccountDependencies } from "./accounts/dependencies.js";
import { createLoginAction } from "./accounts/login.js";
import { quotaAction } from "./accounts/quota-action.js";
import { textSecrets } from "./accounts/secrets.js";
import { WEIVEL_LOG, type Accounts, type Config, type Log, type Paths, type Secrets } from "./contract.js";
import { clientIdOf, readSettings } from "./settings.js";

const ACCOUNTS_STORE_FILE = "accounts.json";
const ACTIONS_SERVICE = "claude-code-provider:accounts";

function required<Service>(context: PluginContext, id: string): Service {
  const service = context.services.get(context.service<Service>(id));
  if (service === undefined) throw new Error(`claude-code-provider reaches no ${id} service`);
  return service;
}

async function dependenciesOf(context: PluginContext): Promise<AccountDependencies> {
  const config = required<Config>(context, "weivel.config");
  const log = required<Log>(context, "weivel.log");
  const directory = await required<Paths>(context, "weivel.paths").plugin({});
  mkdirSync(directory, { recursive: true });
  return {
    accounts: required<Accounts>(context, "accounts"),
    store: join(directory, ACCOUNTS_STORE_FILE),
    secrets: textSecrets(required<Secrets>(context, "weivel.secrets")),
    settings: () => readSettings(config),
    clientId: () => clientIdOf(process.env),
    clock: Date.now,
    random: Math.random,
    log: (message) => void log.write({ level: WEIVEL_LOG.WARN, message }).catch(() => undefined),
  };
}

const plugin: Plugin = {
  async activate(context) {
    const dependencies = await dependenciesOf(context);
    const access = createTokenAccess(dependencies);
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

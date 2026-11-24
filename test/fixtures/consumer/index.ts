interface Context {
  service(id: string): unknown;
  capability(id: string): unknown;
  readonly capabilities: { all(capability: unknown): unknown[]; enumsOf(capability: unknown): object | undefined };
  readonly services: { get(service: unknown): object | undefined; register(service: unknown, object: object): unknown; enumsOf(service: unknown): object | undefined };
}

interface Provider {
  models(input: Record<string, never>): Promise<unknown>;
  handle(input: { argument: unknown }): Promise<unknown>;
  next(input: { stream: unknown }): Promise<unknown>;
  release_stream(input: { stream: unknown }): unknown;
  cancel(input: { argument: { token: bigint | number } }): Promise<unknown>;
}

function required(context: Context, id: string): object {
  const service = context.services.get(context.service(id));
  if (service === undefined) throw new Error(`the consumer reaches no ${id} service`);
  return service;
}

/**
 * A plugin that hands the test forebay-library's `accounts` and `anthropic` services, through `consumer:accounts` and
 * `consumer:anthropic`, the enums their descriptions and the contract's carry, through `consumer:enums`, and every call of the `forebay.provider` contract through `consumer:calls`, so a test calls
 * the real C operations and the provider as a proxy does, through the capability the host verified.
 */
export default {
  activate(context: Context): void {
    const accounts = required(context, "accounts");
    const anthropic = required(context, "anthropic");
    context.services.register(context.service("consumer:accounts"), accounts);
    context.services.register(context.service("consumer:anthropic"), anthropic);
    context.services.register(context.service("consumer:enums"), {
      accounts: context.services.enumsOf(accounts),
      anthropic: context.services.enumsOf(anthropic),
      provider: context.capabilities.enumsOf(context.capability("forebay.provider")),
    });
    const providers = (): Provider[] => context.capabilities.all(context.capability("forebay.provider")) as Provider[];
    const only = (): Provider => {
      const all = providers();
      if (all.length !== 1) throw new Error(`the consumer reaches ${all.length} providers, not one`);
      return all[0]!;
    };
    context.services.register(context.service("consumer:calls"), {
      count: () => providers().length,
      models: () => only().models({}),
      handle: (argument: unknown) => only().handle({ argument }),
      next: (stream: unknown) => only().next({ stream }),
      release_stream: (stream: unknown) => only().release_stream({ stream }),
      cancel: (token: bigint | number) => only().cancel({ argument: { token } }),
    });
  },
};

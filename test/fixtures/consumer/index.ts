interface Context {
  service(id: string): unknown;
  readonly services: { get(service: unknown): object | undefined; register(service: unknown, object: object): unknown };
}

function required(context: Context, id: string): object {
  const service = context.services.get(context.service(id));
  if (service === undefined) throw new Error(`the consumer reaches no ${id} service`);
  return service;
}

/**
 * A plugin that hands the test forebay-library's `accounts` service through `consumer:accounts`, so a test calls the
 * real C operations this plugin's code calls.
 */
export default {
  activate(context: Context): void {
    context.services.register(context.service("consumer:accounts"), required(context, "accounts"));
  },
};

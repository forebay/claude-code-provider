import type { Secrets } from "../contract.js";

/** The host's secrets as text, stored as its UTF-8. */
export interface TextSecrets {
  /** The secret's text, undefined when the name holds none. */
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  /** Removes the secret; removing one that is not there succeeds. */
  remove(name: string): Promise<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function textSecrets(secrets: Secrets): TextSecrets {
  return {
    async get(name) {
      const answer = await secrets.get({ name });
      return typeof answer === "symbol" ? undefined : decoder.decode(answer.bytes);
    },
    set: (name, value) => secrets.set({ name, bytes: encoder.encode(value) }),
    remove: (name) => secrets.remove({ name }),
  };
}

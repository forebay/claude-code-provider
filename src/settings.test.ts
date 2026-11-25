import { describe, expect, it } from "vitest";
import { configOf, MANIFEST_DEFAULTS } from "../test/world.js";
import type { AccountsEnums } from "./contract.js";
import { clientIdOf, readSettings } from "./settings.js";

/** The strategies as a description would carry them; the numbers are this fake's own. */
const ACCOUNTS = { forebay_accounts_strategy: { FOREBAY_ACCOUNTS_STICKY: 11, FOREBAY_ACCOUNTS_ROUND_ROBIN: 12, FOREBAY_ACCOUNTS_HYBRID: 13 } } as Partial<AccountsEnums> as AccountsEnums;

describe("readSettings", () => {
  it("reads what the manifest declares, with the real upstream urls by default", async () => {
    expect(await readSettings(configOf(MANIFEST_DEFAULTS), ACCOUNTS)).toEqual({
      authorizeUrl: "https://claude.ai/oauth/authorize",
      tokenUrl: "https://platform.claude.com/v1/oauth/token",
      apiBase: "https://api.anthropic.com",
      strategy: 13,
      logging: true,
      maxAccountAttempts: 4,
      defaultCooldownSeconds: 60,
      maxCooldownSeconds: 900,
      modelPrefix: "claude-",
      defaultContext: 200000,
      defaultOutput: 64000,
    });
  });

  it("drops a trailing slash from the api base", async () => {
    expect((await readSettings(configOf({ ...MANIFEST_DEFAULTS, api_base_url: "http://127.0.0.1:1/" }), ACCOUNTS)).apiBase).toBe("http://127.0.0.1:1");
  });

  it("names a missing or mistyped setting", async () => {
    await expect(readSettings(configOf({ ...MANIFEST_DEFAULTS, oauth_token_url: undefined }), ACCOUNTS)).rejects.toThrow(/oauth_token_url setting is missing/);
    await expect(readSettings(configOf({ ...MANIFEST_DEFAULTS, logging: "yes" }), ACCOUNTS)).rejects.toThrow(/logging setting of claude-code-provider must be a boolean/);
  });

  it.each([["sticky", 11], ["round-robin", 12], ["hybrid", 13]])("reads the strategy %s as the accounts strategy %i", async (name, strategy) => {
    expect((await readSettings(configOf({ ...MANIFEST_DEFAULTS, account_selection_strategy: name }), ACCOUNTS)).strategy).toBe(strategy);
  });

  it("refuses a strategy it does not know rather than choosing one", async () => {
    await expect(readSettings(configOf({ ...MANIFEST_DEFAULTS, account_selection_strategy: "random" }), ACCOUNTS)).rejects.toThrow(/account_selection_strategy setting of claude-code-provider must be one of sticky, round-robin, hybrid, not random/);
  });

  it("refuses a default limit that is not a whole number of at least 1", async () => {
    await expect(readSettings(configOf({ ...MANIFEST_DEFAULTS, default_context: 0 }), ACCOUNTS)).rejects.toThrow(/default_context setting of claude-code-provider must be a whole number of at least 1/);
    await expect(readSettings(configOf({ ...MANIFEST_DEFAULTS, default_output: 1.5 }), ACCOUNTS)).rejects.toThrow(/default_output setting/);
  });
});

describe.each(["max_account_attempts", "default_cooldown_seconds", "max_cooldown_seconds"])("the %s setting, which a request turns into attempts or a backoff", (key) => {
  it.each([0, -1, 2.5])("refuses %s, which would leave a request no attempt or an account no backoff", async (value) => {
    await expect(readSettings(configOf({ ...MANIFEST_DEFAULTS, [key]: value }), ACCOUNTS)).rejects.toThrow(new RegExp(`${key} setting of claude-code-provider must be a whole number of at least 1`));
  });
});

describe("the cooldowns", () => {
  it("refuses a longest cooldown shorter than the first", async () => {
    await expect(readSettings(configOf({ ...MANIFEST_DEFAULTS, default_cooldown_seconds: 60, max_cooldown_seconds: 30 }), ACCOUNTS)).rejects.toThrow(/max_cooldown_seconds setting of claude-code-provider must be at least its default_cooldown_seconds, 60/);
  });

  it("accepts a longest cooldown equal to the first", async () => {
    expect(await readSettings(configOf({ ...MANIFEST_DEFAULTS, default_cooldown_seconds: 60, max_cooldown_seconds: 60 }), ACCOUNTS)).toMatchObject({ defaultCooldownSeconds: 60, maxCooldownSeconds: 60 });
  });
});

describe.each(["oauth_token_url", "api_base_url"])("the %s setting, which receives account tokens", (key) => {
  it.each(["https://example.test/token", "http://localhost:1", "http://127.0.0.1:1", "http://127.9.9.9:1", "http://[::1]:1"])("accepts %s", async (url) => {
    await expect(readSettings(configOf({ ...MANIFEST_DEFAULTS, [key]: url }), ACCOUNTS)).resolves.toBeDefined();
  });

  it.each(["http://example.test", "http://127.0.0.1.example.com", "http://localhost.example.com", "http://127.0.0.1@example.test", "ftp://127.0.0.1", "not a url"])("refuses %s", async (url) => {
    await expect(readSettings(configOf({ ...MANIFEST_DEFAULTS, [key]: url }), ACCOUNTS)).rejects.toThrow(new RegExp(`${key} setting of claude-code-provider must be an https url`));
  });
});

describe("clientIdOf", () => {
  it("is the public client unless CLAUDE_CODE_CLIENT_ID overrides it", () => {
    expect(clientIdOf({})).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(clientIdOf({ CLAUDE_CODE_CLIENT_ID: "override" })).toBe("override");
  });

  it("ignores a blank override", () => {
    expect(clientIdOf({ CLAUDE_CODE_CLIENT_ID: "  " })).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  });
});

import { describe, expect, it } from "vitest";
import { configOf, MANIFEST_DEFAULTS } from "../test/world.js";
import { clientIdOf, readSettings } from "./settings.js";

describe("readSettings", () => {
  it("reads what the manifest declares, with the real upstream urls by default", async () => {
    expect(await readSettings(configOf(MANIFEST_DEFAULTS))).toEqual({
      authorizeUrl: "https://claude.ai/oauth/authorize",
      tokenUrl: "https://platform.claude.com/v1/oauth/token",
      apiBase: "https://api.anthropic.com",
      strategy: 3,
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
    expect((await readSettings(configOf({ ...MANIFEST_DEFAULTS, api_base_url: "http://127.0.0.1:1/" }))).apiBase).toBe("http://127.0.0.1:1");
  });

  it("names a missing or mistyped setting", async () => {
    await expect(readSettings(configOf({ ...MANIFEST_DEFAULTS, oauth_token_url: undefined }))).rejects.toThrow(/oauth_token_url setting is missing/);
    await expect(readSettings(configOf({ ...MANIFEST_DEFAULTS, logging: "yes" }))).rejects.toThrow(/logging setting of claude-code-provider must be a boolean/);
  });

  it.each([["sticky", 1], ["round-robin", 2], ["hybrid", 3]])("reads the strategy %s as the accounts strategy %i", async (name, strategy) => {
    expect((await readSettings(configOf({ ...MANIFEST_DEFAULTS, account_selection_strategy: name }))).strategy).toBe(strategy);
  });

  it("refuses a strategy it does not know rather than choosing one", async () => {
    await expect(readSettings(configOf({ ...MANIFEST_DEFAULTS, account_selection_strategy: "random" }))).rejects.toThrow(/account_selection_strategy setting of claude-code-provider must be one of sticky, round-robin, hybrid, not random/);
  });

  it("refuses a default limit that is not a whole number of at least 1", async () => {
    await expect(readSettings(configOf({ ...MANIFEST_DEFAULTS, default_context: 0 }))).rejects.toThrow(/default_context setting of claude-code-provider must be a whole number of at least 1/);
    await expect(readSettings(configOf({ ...MANIFEST_DEFAULTS, default_output: 1.5 }))).rejects.toThrow(/default_output setting/);
  });
});

describe.each(["oauth_token_url", "api_base_url"])("the %s setting, which receives account tokens", (key) => {
  it.each(["https://example.test/token", "http://localhost:1", "http://127.0.0.1:1", "http://127.9.9.9:1", "http://[::1]:1"])("accepts %s", async (url) => {
    await expect(readSettings(configOf({ ...MANIFEST_DEFAULTS, [key]: url }))).resolves.toBeDefined();
  });

  it.each(["http://example.test", "http://127.0.0.1.example.com", "http://localhost.example.com", "http://127.0.0.1@example.test", "ftp://127.0.0.1", "not a url"])("refuses %s", async (url) => {
    await expect(readSettings(configOf({ ...MANIFEST_DEFAULTS, [key]: url }))).rejects.toThrow(new RegExp(`${key} setting of claude-code-provider must be an https url`));
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

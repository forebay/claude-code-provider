import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningHost } from "@weivel/typescript/program";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import type { AccountDependencies } from "../src/accounts/dependencies.js";
import type { TextSecrets } from "../src/accounts/secrets.js";
import type { Accounts, Anthropic, IrRequest, Pair, StoredAccount } from "../src/contract.js";
import { readSettings } from "../src/settings.js";
import { bundled, homeWith, hostIn, realPlacesSnapshot, REPOSITORY, type Home, type Install } from "./fixtures/home.js";
import { startOauthServer, type OauthServer } from "./fixtures/oauth-server.js";

export const NOW = 1_700_000_000_000;
export const NEVER_ABORTED = new AbortController().signal;
export const RUN_BOUND = 60_000;

const MANIFEST = JSON.parse(readFileSync(join(REPOSITORY, "plugin.json"), "utf8")) as { config: { defaults: Record<string, unknown> } };

/** The defaults `plugin.json` declares, under the keys the host's configuration answers them by. */
export const MANIFEST_DEFAULTS: Record<string, unknown> = MANIFEST.config.defaults;

/** The settings of a plugin whose three upstream urls point at `server`. */
export function settingsFor(server: OauthServer): Record<string, unknown> {
  return {
    ...MANIFEST_DEFAULTS,
    oauth_authorize_url: `${server.url}/oauth/authorize`,
    oauth_token_url: `${server.url}/v1/oauth/token`,
    api_base_url: server.url,
  };
}

/** A config service answering `values`, as weivel.config's `get_tree` does: NONE for a key it does not hold. */
export function configOf(values: Record<string, unknown>): { get_tree(input: { key: string }): Promise<unknown> } {
  return { get_tree: async ({ key }) => (values[key] === undefined ? Symbol("none") : values[key]) };
}

/** An in-memory secret store in the text shape this plugin keeps its secrets in. */
export function fakeSecrets(): TextSecrets & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get: async (name) => entries.get(name),
    set: async (name, value) => {
      entries.set(name, value);
    },
    remove: async (name) => {
      entries.delete(name);
    },
  };
}

/** The install of the consumer fixture, which hands the test the real `accounts` and `anthropic` services and the provider calls. */
export function consumerInstall(bundle: string): Install {
  const manifest = {
    api: 1,
    importName: "consumer",
    id: "consumer",
    version: "1.0.0",
    entry: "index.js",
    capabilities: { provides: [], consumes: ["forebay.provider"] },
    services: { provides: ["consumer:accounts", "consumer:anthropic", "consumer:calls"], consumes: ["accounts", "anthropic"] },
    config: { defaults: {} },
  };
  return { manifest, bundle, settings: {} };
}

/** forebay-library's `anthropic` service with the reading a test needs to make a request as a proxy hands it on. */
export interface TestAnthropic extends Anthropic {
  decode_request(input: { argument: { bytes: Uint8Array; headers: readonly Pair[] } }): Promise<{ request: IrRequest; forwarded_headers: readonly Pair[] }>;
}

export interface World {
  server: OauthServer;
  accounts: Accounts;
  anthropic: TestAnthropic;
  store: string;
  secrets: ReturnType<typeof fakeSecrets>;
  settings: Record<string, unknown>;
  reports: string[];
  dependencies: AccountDependencies;
  /** Moves the dependencies' clock to `time`. */
  at(time: number): void;
  storedAccount(id: string): Promise<StoredAccount | undefined>;
}

/**
 * One host per test file serving forebay-library's real `accounts` through the consumer fixture, and for each test a
 * fresh loopback server, a store in a fresh folder and in-memory secrets. Once the file ran, the real home's places
 * must be as they were before it.
 */
export function useWorld(): () => World {
  const realBefore = realPlacesSnapshot();
  let bundles: string;
  let home: Home;
  let host: RunningHost;
  let folder: string;
  let current: World | undefined;
  beforeAll(async () => {
    bundles = mkdtempSync(join(tmpdir(), "claude-code-provider-bundles-"));
    const consumer = await bundled(join(REPOSITORY, "test", "fixtures", "consumer", "index.ts"), join(bundles, "consumer"));
    home = homeWith([consumerInstall(consumer)]);
    host = await hostIn(home);
  }, RUN_BOUND);
  afterAll(async () => {
    await host?.stop();
    home?.remove();
    rmSync(bundles, { recursive: true, force: true });
    expect(realPlacesSnapshot()).toEqual(realBefore);
  });
  beforeEach(async () => {
    const accounts = host.service<Accounts>("consumer", "consumer:accounts");
    const anthropic = host.service<TestAnthropic>("consumer", "consumer:anthropic");
    if (accounts === undefined || anthropic === undefined) throw new Error("the consumer registered no accounts or anthropic service");
    const server = await startOauthServer();
    folder = mkdtempSync(join(tmpdir(), "claude-code-provider-store-"));
    const store = join(folder, "accounts.json");
    const secrets = fakeSecrets();
    const settings = settingsFor(server);
    const reports: string[] = [];
    let time = NOW;
    const dependencies: AccountDependencies = {
      accounts,
      store,
      secrets,
      settings: () => readSettings(configOf(settings)),
      clientId: () => "client-under-test",
      clock: () => time,
      random: () => 0.5,
      log: (message) => reports.push(message),
    };
    current = {
      server,
      accounts,
      anthropic,
      store,
      secrets,
      settings,
      reports,
      dependencies,
      at: (value) => {
        time = value;
      },
      storedAccount: async (id) => (await accounts.list({ argument: { store } })).accounts.find((account) => account.id === id),
    };
  });
  afterEach(async () => {
    await current?.server.close();
    rmSync(folder, { recursive: true, force: true });
  });
  return () => current as World;
}

/** `accounts` with some operations replaced, every other one still the real service's. */
export function accountsWith(accounts: Accounts, overrides: Partial<Record<keyof Accounts, (...input: never[]) => unknown>>): Accounts {
  return { ...accounts, ...overrides } as Accounts;
}

/** Adds an enabled account with a stored access and refresh token, expiring at `expires`. */
export async function seedAccount(world: World, id: string, expires: number): Promise<void> {
  await world.accounts.upsert({ argument: { store: world.store, account: { id, label: id, enabled: true, expires } } });
  await world.secrets.set(`account.${id}.access`, `stored-access-${id}`);
  await world.secrets.set(`account.${id}.refresh`, `stored-refresh-${id}`);
}

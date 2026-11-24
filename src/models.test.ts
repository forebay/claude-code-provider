import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startOauthServer } from "../test/fixtures/oauth-server.js";
import type { OauthServer } from "../test/fixtures/oauth-server.js";
import { loadVectors } from "../test/vectors.js";
import { fetchModels } from "./models.js";

const CHOICE = { prefix: "claude-", defaultContext: 200_000, defaultOutput: 64_000 };

let server: OauthServer;

beforeEach(async () => {
  server = await startOauthServer();
});

afterEach(async () => {
  await server.close();
});

describe("fetchModels", () => {
  it("maps the claude models with the oauth headers and never an api key", async () => {
    server.modelsResponder = () => ({
      status: 200,
      body: { data: [{ id: "claude-sonnet-4", display_name: "Claude Sonnet 4" }, { id: "gpt-4", display_name: "GPT-4" }, { id: "claude-bare" }, { display_name: "no id" }, null] },
    });
    const answer = await fetchModels(server.url, "the-access", CHOICE);
    expect(answer.map((model) => [model.id, model.name])).toEqual([
      ["claude-sonnet-4", "Claude Sonnet 4 (Claude Code)"],
      ["claude-bare", "claude-bare (Claude Code)"],
    ]);
    const [request] = server.requestsTo("/v1/models");
    expect(request?.method).toBe("GET");
    expect(request?.headers).toMatchObject({ authorization: "Bearer the-access", "anthropic-version": "2023-06-01" });
    expect(String(request?.headers["anthropic-beta"])).toContain("oauth-2025-04-20");
    expect(request?.headers["x-api-key"]).toBeUndefined();
  });

  it("offers only the models whose id starts with the chosen prefix", async () => {
    server.modelsResponder = () => ({ status: 200, body: { data: [{ id: "claude-a" }, { id: "other-b" }, { id: "other-c" }] } });
    const answer = await fetchModels(server.url, "a", { ...CHOICE, prefix: "other-" });
    expect(answer.map((model) => model.id)).toEqual(["other-b", "other-c"]);
  });

  it("asks for up to a thousand models", async () => {
    await fetchModels(server.url, "a", CHOICE);
    expect(server.requestsTo("/v1/models").map((request) => request.query)).toEqual(["?limit=1000"]);
  });

  it("takes limits from the upstream when it gives them, else the chosen defaults", async () => {
    server.modelsResponder = () => ({ status: 200, body: { data: [{ id: "claude-a", max_input_tokens: 1_000_000, max_tokens: 128_000 }, { id: "claude-b", max_tokens: 0 }] } });
    const answer = await fetchModels(server.url, "a", CHOICE);
    expect(answer.map((model) => [model.has_context, model.has_output])).toEqual([[1, 1], [1, 1]]);
    expect(answer.map((model) => [model.context, model.output])).toEqual([[1_000_000, 128_000], [200_000, 64_000]]);
  });

  it("answers no models, never a throw, when the upstream refuses", async () => {
    server.modelsResponder = () => ({ status: 401, body: { type: "error" } });
    expect(await fetchModels(server.url, "a", CHOICE)).toEqual([]);
  });

  it("answers no models for a body that is not a list, or not JSON", async () => {
    server.modelsResponder = () => ({ status: 200, body: { data: "nope" } });
    expect(await fetchModels(server.url, "a", CHOICE)).toEqual([]);
    server.modelsResponder = () => ({ status: 200, rawBody: "<html>" });
    expect(await fetchModels(server.url, "a", CHOICE)).toEqual([]);
  });

  it("answers no models when the upstream cannot be reached", async () => {
    const unreachable = server.url;
    await server.close();
    expect(await fetchModels(unreachable, "a", CHOICE)).toEqual([]);
    server = await startOauthServer();
  });
});
describe("fetchModels against the Java vectors of the model mapping", () => {
  for (const vector of loadVectors<string | null, string | null>("models", "fetchModelsMapping")) {
    it(vector.name, async () => {
      server.modelsResponder = () => ({ status: 200, rawBody: vector.input ?? "" });
      const answer = await fetchModels(server.url, "a", CHOICE);
      const wanted = vector.expected === null ? {} : (JSON.parse(vector.expected) as { models: Record<string, { name: string }> }).models;
      expect(Object.fromEntries(answer.map((model) => [model.id, { name: model.name }]))).toEqual(wanted);
    });
  }
});

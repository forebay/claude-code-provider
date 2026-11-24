import { describe, expect, it } from "vitest";
import type { OauthServer } from "../../test/fixtures/oauth-server.js";
import { loadVectors } from "../../test/vectors.js";
import { RUN_BOUND, useWorld } from "../../test/world.js";
import { bucketOfLimit, poolsOfUsage, refreshQuota } from "./usage.js";
import { quotaBars, remainingFractions } from "./quota-headers.js";
import type { StoredQuota } from "./quota-headers.js";

const world = useWorld();
const server = (): OauthServer => world().server;

describe("bucketOfLimit against the Java vectors", () => {
  for (const vector of loadVectors<unknown, string | null>("quota", "bucketOfLimit")) {
    it(vector.name, () => {
      expect(bucketOfLimit(vector.input) ?? null).toBe(vector.expected);
    });
  }
});

interface UsageVector {
  input: { status: number; body: string };
  expected: { status: string; bars: Array<{ label: string; remainingFraction: number; resetTime: string | null }>; pools: Record<string, unknown> | null };
}

function parsedOrUndefined(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

describe("the usage endpoint's answer against the Java vectors", () => {
  for (const vector of loadVectors<UsageVector["input"], UsageVector["expected"]>("usage", "usage")) {
    it(vector.name, async () => {
      const pools = vector.input.status === 200 ? poolsOfUsage(parsedOrUndefined(vector.input.body)) : undefined;
      expect(pools ?? null).toEqual(vector.expected.pools);
      if (pools === undefined) {
        expect(vector.expected.status).toBe("error");
        return;
      }
      const quota: StoredQuota = { pools };
      const bars = (quotaBars(quota) ?? []).map((bar) => ({ ...bar, resetTime: bar.resetTime === null ? null : new Date(bar.resetTime).getTime() }));
      expect(bars).toEqual(vector.expected.bars.map((bar) => ({ ...bar, resetTime: bar.resetTime === null ? null : Date.parse(bar.resetTime) })));
      const active = (await world().accounts.has_capacity({ argument: { pools: remainingFractions(quota) } })).capacity === 1;
      expect(active ? "active" : "rate-limited").toBe(vector.expected.status);
    }, RUN_BOUND);
  }
});

describe("refreshQuota", () => {
  it("asks the usage endpoint with the oauth headers and answers every pool it lists", async () => {
    server().usageResponder = () => ({ status: 200, body: { limits: [{ kind: "session", percent: 25 }] } });
    expect(await refreshQuota(server().url, "the-access")).toEqual({ pools: { "5h": { utilization: 0.25 } }, complete: true });
    const [request] = server().requestsTo("/api/oauth/usage");
    expect(request?.headers).toMatchObject({ authorization: "Bearer the-access", "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" });
  });

  it("reads or cancels the body of the ping's response, so the connection is released", async () => {
    let cancelled = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      if (String(input).endsWith("/api/oauth/usage")) return new Response("{}", { status: 404 });
      const body = new ReadableStream({ pull: (controller) => controller.enqueue(new Uint8Array([1])), cancel: () => { cancelled = true; } });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    try {
      await refreshQuota(server().url, "the-access");
    } finally {
      globalThis.fetch = original;
    }
    expect(cancelled).toBe(true);
  });

  it("falls back to a one token ping whose response headers carry the pools", async () => {
    server().messagesResponder = () => ({
      status: 200,
      body: {},
      headers: { "content-type": "application/json", "anthropic-ratelimit-unified-5h-utilization": "0.4", "anthropic-ratelimit-unified-5h-status": "allowed" },
    });
    const answer = await refreshQuota(server().url, "the-access");
    expect(answer).toEqual({ pools: { "5h": { utilization: 0.4, status: "allowed" } }, complete: false });
    expect(JSON.parse(server().requestsTo("/v1/messages")[0]?.body ?? "")).toMatchObject({ model: "claude-haiku-4-5", max_tokens: 1 });
  });

});

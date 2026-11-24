import { describe, expect, it } from "vitest";
import type { IrBlock, ProviderEnums } from "../contract.js";
import { loadVectors } from "../../test/vectors.js";
import { RUN_BOUND, useWorld } from "../../test/world.js";
import { mergeBeta, rewrite, withIdentityBlock } from "./rewrite.js";

const world = useWorld();
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const API_BASE = "http://upstream.test";
const encoder = new TextEncoder();

function blockKinds(): ProviderEnums["forebay_ir_block_kind"] {
  return world().enums.provider.forebay_ir_block_kind;
}

interface PrepareInput {
  body: string;
  headers: Record<string, string>;
  access: string;
}

interface PrepareExpected {
  headers: Record<string, string>;
  bodyJson: unknown;
}

/** The request and forwarded headers a proxy hands on for a client's body and headers, as `anthropic` reads them. */
async function handedOn(body: string, headers: Record<string, string> = {}) {
  const pairs = Object.entries(headers).map(([name, value]) => ({ name, value }));
  const decoded = await world().anthropic.decode_request({ argument: { bytes: encoder.encode(body), headers: pairs } });
  return { request: decoded.request, headers: decoded.forwarded_headers };
}

function sentBody(bytes: Uint8Array | string): unknown {
  return JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes));
}

describe("rewrite against the Java vectors, with the body read and written by C's anthropic", () => {
  for (const vector of loadVectors<PrepareInput, PrepareExpected>("rewrite", "prepare")) {
    it(vector.name, async () => {
      const { request, headers } = await handedOn(vector.input.body, vector.input.headers);
      const rewritten = await rewrite(world().anthropic, blockKinds(), request, headers, vector.input.access, API_BASE);
      expect(sentBody(rewritten.body)).toEqual(vector.expected.bodyJson);
      expect(rewritten.url).toBe(`${API_BASE}/v1/messages`);
      expect(rewritten.headers).toEqual(vector.expected.headers);
    }, RUN_BOUND);
  }

  it("sends the oauth beta alone when the request carries no client headers", async () => {
    const { request } = await handedOn(JSON.stringify({ model: "claude-x", messages: [] }));
    const rewritten = await rewrite(world().anthropic, blockKinds(), request, [], "t", API_BASE);
    expect(rewritten.headers).toEqual({ authorization: "Bearer t", "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" });
  }, RUN_BOUND);

  it("keeps the client headers out of the body", async () => {
    const { request, headers } = await handedOn(JSON.stringify({ model: "claude-x", messages: [] }), { "x-app": "cli" });
    expect(JSON.stringify(sentBody((await rewrite(world().anthropic, blockKinds(), request, headers, "t", API_BASE)).body))).not.toContain("x-app");
  }, RUN_BOUND);

  it("never turns a lone identity string into a bare wire string", async () => {
    const { request } = await handedOn(JSON.stringify({ model: "claude-x", system: IDENTITY, messages: [] }));
    const body = sentBody((await rewrite(world().anthropic, blockKinds(), request, [], "t", API_BASE)).body) as { system: unknown };
    expect(body.system).toEqual([{ type: "text", text: IDENTITY }]);
  }, RUN_BOUND);
});

describe("mergeBeta against the Java vectors", () => {
  for (const vector of loadVectors<string | null, string>("rewrite", "mergeBeta")) {
    it(vector.name, () => {
      expect(mergeBeta(vector.input ?? undefined)).toBe(vector.expected);
    });
  }
});

describe("withIdentityBlock", () => {
  it("leads a missing or empty system with the identity block", () => {
    for (const system of [undefined, []]) expect(withIdentityBlock(system, blockKinds())).toEqual([{ kind: blockKinds().FOREBAY_IR_BLOCK_TEXT, text: IDENTITY }]);
  });

  it("keeps a system that already leads with the identity as it is", () => {
    const { FOREBAY_IR_BLOCK_TEXT } = blockKinds();
    const system: IrBlock[] = [{ kind: FOREBAY_IR_BLOCK_TEXT, text: IDENTITY }, { kind: FOREBAY_IR_BLOCK_TEXT, text: "extra" }];
    expect(withIdentityBlock(system, blockKinds())).toBe(system);
  });

  it("prepends the identity once, in front of the original blocks", () => {
    const original: IrBlock = { kind: blockKinds().FOREBAY_IR_BLOCK_TEXT, text: "custom" };
    const result = withIdentityBlock([original], blockKinds());
    expect(result).toHaveLength(2);
    expect(result[1]).toBe(original);
  });
});

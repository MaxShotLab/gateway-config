import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { DEFAULT_STRATEGY, prepareCandidates, selectPortfolio, buildChatModelsJson } from "./update-models.mjs";

const now = Date.parse("2026-10-10T00:00:00Z");
const model = (id, extra = {}) => ({
  id, name: id, created: now / 1000, context_length: 1_000_000,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: "0.000001", completion: "0.000002" },
  supported_parameters: ["reasoning"], top_provider: { context_length: 1_000_000 },
  ...extra,
});
const prepare = (models) => prepareCandidates({ weekly: { data: models } }, DEFAULT_STRATEGY,
  new Map(models.map((m) => [m.id, { verified: true, available: true, uptime: 100 }])), now);

for (const id of ["meta/muse-spark", "meta/muse-spark-1.3", "meta/muse-spark-1.3-contributor", "meta/muse-spark-2.0:free"]) {
  test(`healthy endpoint cannot admit age-gated family ${id}`, () => {
    const [candidate] = prepare([model(id)]);
    assert.equal(candidate.health.available, true);
    assert.ok(candidate.hardGateReasons.includes("Requires provider account attestation"));
  });
}

test("canonical aliases retain the account attestation gate without blocking other Meta models", () => {
  const [alias, glimmer, glm] = prepare([
    model("other/alias", { canonical_slug: "meta/muse-spark-1.3-contributor-20260902" }),
    model("meta/muse-glimmer-30b"), model("z-ai/glm-5.3"),
  ]);
  assert.ok(alias.hardGateReasons.includes("Requires provider account attestation"));
  assert.deepEqual(glimmer.hardGateReasons, []);
  assert.deepEqual(glm.hardGateReasons, []);
});

test("portfolio replaces a higher-ranked gated candidate and never makes it the default", () => {
  const candidates = prepare([model("meta/muse-spark-1.3-contributor"), model("z-ai/glm-5.3")]);
  const config = { ...DEFAULT_STRATEGY, quotas: { free: 0, code: 0, flagship: 0, reasoning: 1, economy: 0, balanced: 0 } };
  const portfolio = selectPortfolio(candidates, config);
  assert.deepEqual(portfolio.shortages, []);
  assert.deepEqual(portfolio.selected.map((m) => m.id), ["z-ai/glm-5.3"]);
  const output = buildChatModelsJson(portfolio.selected);
  assert.equal(output["z-ai/glm-5.3"].chatDefault, true);
  assert.equal(output["meta/muse-spark-1.3-contributor"], undefined);
  const unavailable = selectPortfolio(candidates.slice(0, 1), config);
  assert.equal(unavailable.selected.length, 0);
  assert.deepEqual(unavailable.shortages, [{ category: "reasoning", target: 1, found: 0 }]);
});

test("later automatic updates choose the default without pinning the temporary GLM model", () => {
  const output = buildChatModelsJson([
    { ...prepare([model("deepseek/deepseek-v4.1-flash")])[0], category: "economy" },
    { ...prepare([model("z-ai/glm-5.3")])[0], category: "code" },
  ]);
  assert.equal(output["deepseek/deepseek-v4.1-flash"].chatDefault, true);
  assert.equal(output["z-ai/glm-5.3"].chatDefault, undefined);
});

test("published configuration has one enabled default and no known gated models", async () => {
  const data = JSON.parse(await fs.readFile(new URL("../chat-models.json", import.meta.url), "utf8"));
  assert.ok(Object.keys(data).length > 0 && Object.keys(data).length <= 24);
  const defaults = Object.entries(data).filter(([, m]) => m.chatDefault);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0][1].chatEnabled, true);
  assert.ok(prepare(Object.keys(data).map((id) => model(id))).every((m) => m.hardGateReasons.length === 0));
  assert.equal(new Set(Object.values(data).map((m) => m.chatRank)).size, Object.keys(data).length);
});

const { buildProbeRequest, parseInferenceResponse, boundedEndpointPricing, probePortfolio } = await import("./update-models.mjs");
const stream = (id, extra = {}) => `: processing\n\ndata: ${JSON.stringify({ model: id, choices: [{ delta: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 2, cost: 0.00001 }, ...extra })}\n\ndata: [DONE]\n\n`;
const fixture = (ids) => prepare(ids.map((id) => model(id))).map((m) => ({ ...m,
  health: { ...m.health, probePricing: { prompt: 0.000001, completion: 0.000002, request: 0 } } }));
const smallConfig = (count) => ({ ...DEFAULT_STRATEGY, quotas: { free: 0, code: 0, flagship: 0, reasoning: 0, economy: 0, balanced: count } });
const fakeResponse = (status, text) => new Response(text, { status });

test("probe matches default reasoning and optimization profiles without sampling overrides", () => {
  const candidate = fixture(["z-ai/glm-5.3"])[0];
  const request = buildProbeRequest(candidate);
  assert.deepEqual(request.reasoning, { effort: "medium" });
  assert.equal(request.temperature, undefined);
  assert.equal(request.max_tokens, 4096);
  assert.equal(request.stream_options.include_usage, true);
  assert.equal(buildProbeRequest(candidate, "optimize").reasoning, undefined);
  assert.equal(buildProbeRequest({ ...candidate, supportsReasoning: false }).max_tokens, 256);
});

test("stream validation requires visible text, completion and the requested identity", () => {
  const candidate = fixture(["z-ai/glm-5.3"])[0];
  const parse = (raw) => parseInferenceResponse(200, raw, 1, candidate);
  assert.equal(parse(stream(candidate.id)).success, true);
  assert.equal(parse(stream(candidate.id).replace("data: [DONE]", "")).success, false);
  assert.equal(parse(stream("other/model")).success, false);
  assert.equal(parse(stream(candidate.id, { choices: [{ delta: { reasoning: "thinking" }, finish_reason: "stop" }] })).success, false);
  const failure = parse(stream(candidate.id, { error: { code: 402, message: "No credits" } }));
  assert.equal(failure.success, false);
  assert.equal(failure.systemic, true);
  assert.equal(parse('{"error":{"code":403,"message":"Attestation required"}}').success, false);
  assert.equal(parse(stream(candidate.id, { choices: [{ delta: { content: "OK" }, finish_reason: "length" }] })).success, false);
});

test("price bounds include per-request charges and reject unknown positive fees", () => {
  assert.deepEqual(boundedEndpointPricing([{ pricing: { prompt: "0.1", completion: "0.2", request: "0.3" } },
    { pricing: { prompt: "0.4", completion: "0.1" } }]), { prompt: 0.4, completion: 0.2, request: 0.3 });
  assert.equal(boundedEndpointPricing([{ pricing: { prompt: "0", completion: "0", unknown_fee: "1" } }]), null);
  assert.equal(boundedEndpointPricing([{ pricing: { prompt: "0" } }]), null);
});

test("failed paid candidate is replaced and all published models pass both required checks", async () => {
  const calls = [];
  const result = await probePortfolio(fixture(["z-ai/one", "z-ai/two", "z-ai/three"]), smallConfig(2), "fake", {
    sleepImpl: async () => {}, fetchImpl: async (_, init) => {
      const request = JSON.parse(init.body); calls.push(request);
      return request.model === "z-ai/one" ? fakeResponse(403, '{"error":{"code":403,"message":"Attestation required"}}') :
        fakeResponse(200, stream(request.model));
    },
  });
  assert.equal(result.error, null);
  assert.deepEqual(result.portfolio.selected.map((m) => m.id), ["z-ai/two", "z-ai/three"]);
  assert.equal(calls.filter((r) => r.model === "z-ai/one").length, 1);
  assert.equal(result.report.requests, 4);
  assert.equal(calls.at(-1).messages[0].role, "system");
});

test("partial passing selection is publishable and failed optimization defaults are replaced", async () => {
  const result = await probePortfolio(fixture(["z-ai/one", "z-ai/two"]), smallConfig(3), "fake", {
    fetchImpl: async (_, init) => {
      const request = JSON.parse(init.body);
      return request.model === "z-ai/one" && request.messages[0].role === "system" ?
        fakeResponse(400, '{"error":{"code":400,"message":"Invalid system message"}}') : fakeResponse(200, stream(request.model));
    },
  });
  assert.equal(result.error, null);
  assert.equal(result.defaultId, "z-ai/two");
  assert.equal(result.portfolio.selected.length, 2);
  assert.equal(result.report.shortages[0].found, 2);
});

test("shared account failures abort publication rather than deleting the catalog", async () => {
  const result = await probePortfolio(fixture(["z-ai/one", "z-ai/two", "z-ai/three"]), smallConfig(2), "fake", {
    fetchImpl: async () => fakeResponse(401, '{"error":{"code":401,"message":"Invalid key"}}'),
  });
  assert.match(result.error, /Shared OpenRouter account failure/);
  assert.ok(result.report.requests <= 2);
});

test("unknown charges stay reserved and retries obey request and cost limits", async () => {
  const result = await probePortfolio(fixture(["z-ai/one", "z-ai/two"]), smallConfig(2), "fake", {
    limits: { budgetUsd: 0.013, requests: 2 }, sleepImpl: async () => {},
    fetchImpl: async () => fakeResponse(503, '{"error":{"code":503,"message":"Unavailable"}}'),
  });
  assert.ok(result.error);
  assert.ok(result.report.requests <= 1);
  assert.equal(result.report.unknownCostRequests, result.report.requests);
  assert.ok(result.report.accountedUsd > 0);
  assert.ok(result.report.accountedUsd <= 0.013);
});

test("transient failures retry once and confirmed bad defaults do not", async () => {
  let calls = 0;
  const result = await probePortfolio(fixture(["z-ai/one"]), smallConfig(1), "fake", {
    sleepImpl: async () => {}, fetchImpl: async (_, init) => {
      calls++;
      return calls === 1 ? fakeResponse(429, '{"error":{"code":429,"message":"Busy"}}') :
        fakeResponse(200, stream(JSON.parse(init.body).model));
    },
  });
  assert.equal(result.error, null);
  assert.equal(calls, 3);
});


test("cache fees and discounts are bounded without excluding ordinary endpoints", () => {
  assert.deepEqual(boundedEndpointPricing([{ pricing: { prompt: "0.1", completion: "0.2", input_cache_read: "0.05", input_cache_write: "0.15", discount: 0.3 } }]),
    { prompt: 0.15, completion: 0.2, request: 0 });
});


test("text probe bounds tiered prices and reasoning but does not invoke priced media or search", () => {
  assert.deepEqual(boundedEndpointPricing([{ pricing: {
    prompt: "0.1", completion: "0.2", internal_reasoning: "0.3", input_cache_write_1h: "0.15",
    web_search: "10", image: "20", audio: "30", input_audio_cache: "10",
    overrides: [{ min_prompt_tokens: 272000, prompt: "0.4", completion: "0.5" }],
  } }]), { prompt: 0.4, completion: 0.8, request: 0 });
  assert.equal(boundedEndpointPricing([{ pricing: { prompt: null, completion: "0.2" } }]), null);
});

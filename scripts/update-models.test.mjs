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

#!/usr/bin/env node

/**
 * Automated chat-models.json updater.
 *
 * Replicates the Model Selection Algorithm (ALGORITHM_REFERENCE.md) to:
 *   1. Fetch model data from OpenRouter APIs
 *   2. Gate against new-api supported model set
 *   3. Score, filter, and allocate 24 models across 6 categories
 *   4. Probe every selected model using production-default Chat parameters
 *   5. Write chat-models.json only when the selection fingerprint changes
 *
 * Environment variables:
 *   OPENROUTER_API_KEY  — required
 *   NEW_API_URL         — required (e.g. https://api.example.com)
 *   NEW_API_TOKEN       — required (Bearer token for new-api)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─── Constants ───────────────────────────────────────────────────────────────

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DAY_MS = 86_400_000;
const MODEL_COUNT = 24;
const CATEGORY_ORDER = ["flagship", "reasoning", "balanced", "economy", "code", "free"];
const ALLOCATION_ORDER = ["free", "code", "flagship", "reasoning", "economy", "balanced"];

const DEFAULT_STRATEGY = {
  quotas: { flagship: 6, reasoning: 3, balanced: 5, economy: 3, code: 3, free: 4 },
  weights: { weekly: 25, monthly: 20, newModel: 15, quality: 15, reliability: 10, performance: 10, value: 5 },
  filters: {
    requirePrice: true,
    requireAvailable: true,
    requireTextOutput: true,
    minimumContext: 32_000,
  },
};

const FLAGSHIP_AUTHORS = new Set([
  "anthropic", "deepseek", "google", "minimax", "mistralai",
  "moonshotai", "openai", "qwen", "x-ai", "z-ai",
]);
const BLOCKED_ID = /(^openrouter\/|^stealth\/|\b(alpha|beta)\b|:(nitro|floor|thinking|extended)$)/i;
// OpenRouter public endpoint status does not expose account attestation gates.
// Exclude the confirmed age-gated family, including future versions and variants.
const ACCOUNT_ATTESTATION_GATED_ID = /^meta\/muse-spark(?:[-/:]|$)/i;
const CODE_ID = /(code|coder|codestral|devstral|programming)/i;

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const asArray = (v) => Array.isArray(v) ? v : [];
const finiteNumber = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const perMillion = (v) => { const n = finiteNumber(v); return n === null ? null : n * 1_000_000; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toDateString(date) { return date.toISOString().slice(0, 10); }

function rankMap(models) {
  return new Map(asArray(models).map((m, i) => [m.id, i + 1]));
}

function rankScore(rank, count) {
  if (!rank || count < 2) return 0;
  return Math.max(0, 1 - (rank - 1) / (count - 1));
}

function normalizeNumber(value, min, max) {
  if (value === null || max <= min) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function rankWithin(value, maximum) {
  return typeof value === "number" && value > 0 && value <= maximum;
}

function getBenchmark(model, key) {
  return finiteNumber(model.benchmarks?.artificial_analysis?.[key]);
}

async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

// ─── OpenRouter fetch ────────────────────────────────────────────────────────

function openRouterHeaders(apiKey, accept = "application/json") {
  return {
    accept,
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "HTTP-Referer": "https://maxshot.ai",
    "X-Title": "Maxshot Model Strategy",
  };
}

async function openRouterFetch(apiKey, pathname, timeoutMs = 20_000, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(`${OPENROUTER_BASE_URL}${pathname}`, {
        headers: openRouterHeaders(apiKey),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || `OpenRouter returned HTTP ${response.status}`);
      return body;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = attempt * 1500;
        console.warn(`  [retry ${attempt}/${maxRetries}] ${pathname} failed (${err.message}). Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

// ─── Data Sources ────────────────────────────────────────────────────────────

async function fetchSources(apiKey, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);
  const paths = {
    weekly: "/models?sort=top-weekly",
    newest: "/models?sort=newest",
    intelligence: "/models?sort=intelligence-high-to-low",
    throughput: "/models?sort=throughput-high-to-low",
    latency: "/models?sort=latency-low-to-high",
    monthly: `/datasets/rankings-daily?start_date=${toDateString(start)}&end_date=${toDateString(end)}&modality=text`,
  };
  console.log(`Fetching OpenRouter data sources (${Object.keys(paths).length} endpoints)...`);
  const entries = await Promise.all(
    Object.entries(paths).map(async ([key, p]) => [key, await openRouterFetch(apiKey, p)]),
  );
  const source = Object.fromEntries(entries);
  console.log(`  weekly models: ${asArray(source.weekly?.data).length}`);
  return source;
}

// ─── new-api supported models ────────────────────────────────────────────────

async function fetchSupportedModelIds(url, token, maxRetries = 3) {
  console.log(`Fetching supported models from new-api: ${url}/models`);
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(`${url}/models`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`new-api returned HTTP ${response.status}`);
      const body = await response.json();
      const ids = new Set(asArray(body.data).map((m) => m.id).filter(Boolean));
      console.log(`  supported models: ${ids.size}`);
      return ids;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = attempt * 1500;
        console.warn(`  [retry ${attempt}/${maxRetries}] new-api fetch failed (${err.message}). Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

// ─── Endpoint Health ─────────────────────────────────────────────────────────

function boundedEndpointPricing(endpoints) {
  if (!endpoints.length) return null;
  // These features are absent from the text-only probe, so their prices cannot apply.
  const inactive = new Set(["web_search", "image", "audio", "video", "input_audio_cache", "audio_output", "utc_start", "utc_end", "utc_days"]);
  const inputKeys = ["prompt", "input_cache_read", "input_cache_write", "input_cache_write_1h"];
  const known = new Set([...inputKeys, "completion", "request", "internal_reasoning", "discount", "min_prompt_tokens", "max_prompt_tokens"]);
  const prices = [];
  for (const endpoint of endpoints) {
    const base = endpoint.pricing;
    if (!base || base.prompt == null || base.completion == null ||
        (base.overrides !== undefined && !Array.isArray(base.overrides))) return null;
    for (const override of [null, ...asArray(base.overrides)]) {
      if (override !== null && (!override || typeof override !== "object" || Array.isArray(override))) return null;
      const price = { ...base, ...override };
      delete price.overrides;
      if (Object.entries(price).some(([key, value]) => !inactive.has(key) && (
        (!known.has(key) && Number(value) !== 0) ||
        (known.has(key) && (value === null || value === "" || finiteNumber(value) === null || Number(value) < 0))))) return null;
      prices.push(price);
    }
  }
  return {
    prompt: Math.max(...prices.flatMap((price) => inputKeys.map((key) => Number(price[key] ?? 0)))),
    // Conservatively bound separate internal reasoning charges as well as output tokens.
    completion: Math.max(...prices.map((price) => Number(price.completion) + Number(price.internal_reasoning ?? 0))),
    request: Math.max(...prices.map((price) => Number(price.request ?? 0))),
  };
}

async function fetchEndpointHealth(apiKey, modelId) {
  const [author, ...slugParts] = modelId.split("/");
  const pathname = `/models/${encodeURIComponent(author)}/${encodeURIComponent(slugParts.join("/"))}/endpoints`;
  try {
    const payload = await openRouterFetch(apiKey, pathname);
    const endpoints = asArray(payload?.data?.endpoints);
    const healthy = endpoints.filter((ep) => {
      const statusOk = ep.status === undefined || ep.status === null || ep.status === 0;
      const uptime = Number(ep.uptime_last_1d);
      return statusOk && (!Number.isFinite(uptime) || uptime >= 95);
    });
    const uptimes = healthy.map((ep) => Number(ep.uptime_last_1d)).filter(Number.isFinite);
    return {
      verified: true,
      probePricing: boundedEndpointPricing(endpoints),
      available: healthy.length > 0,
      endpointCount: endpoints.length,
      healthyEndpointCount: healthy.length,
      uptime: uptimes.length > 0 ? Math.max(...uptimes) : healthy.length > 0 ? 95 : 0,
      reason: endpoints.length === 0 ? "No provider endpoints" : healthy.length === 0 ? "No endpoint meets 95% uptime" : null,
    };
  } catch (error) {
    return { verified: true, available: false, endpointCount: 0, healthyEndpointCount: 0, uptime: 0, reason: `Endpoint check failed: ${error.message}` };
  }
}

// ─── Inference Probes ────────────────────────────────────────────────────────

const PROBE_LIMITS = { budgetUsd: 2, models: 40, requests: 60, timeoutMs: 90_000, durationMs: 1_200_000 };

function buildProbeRequest(model, profile = "chat") {
  return {
    model: model.id, stream: true, stream_options: { include_usage: true },
    max_tokens: model.supportsReasoning ? 4096 : 256,
    messages: profile === "optimize"
      ? [{ role: "system", content: "You are a professional prompt engineer. Return only the improved prompt." },
        { role: "user", content: "Improve this image prompt briefly: a red apple on a table." }]
      : [{ role: "user", content: "Reply with exactly OK." }],
    ...(profile === "chat" && model.supportsReasoning ? { reasoning: { effort: "medium" } } : {}),
  };
}

function parseInferenceResponse(httpStatus, raw, latencyMs, expectedModel) {
  let content = "", provider = null, finishReason = null, error = null, usage = null, done = false;
  const returnedModels = new Set();
  const consume = (event) => {
    provider ??= event.provider ?? null;
    if (event.model) returnedModels.add(event.model);
    if (event.usage) usage = event.usage;
    const delta = event.choices?.[0]?.delta?.content;
    if (typeof delta === "string") content += delta;
    finishReason = event.choices?.[0]?.finish_reason ?? finishReason;
    if (event.error) error = event.error;
  };
  if (!raw.trimStart().startsWith("data:") && !raw.trimStart().startsWith(":")) {
    try { consume(JSON.parse(raw)); } catch { error = { message: "Invalid inference response" }; }
  } else {
    for (const block of raw.replace(/\r\n/g, "\n").split(/\n\n/)) {
      const data = block.split("\n").filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      if (data === "[DONE]") { done = true; continue; }
      try { consume(JSON.parse(data)); } catch { error = { message: "Invalid stream event" }; }
    }
  }
  const allowed = expectedModel ? new Set([expectedModel.id, expectedModel.canonicalSlug]) : null;
  const mismatch = allowed && (returnedModels.size === 0 || [...returnedModels].some((id) => !allowed.has(id)));
  const success = httpStatus >= 200 && httpStatus < 300 && !error && !mismatch && done &&
    content.trim().length > 0 && finishReason === "stop";
  const errorCode = error?.code ?? null;
  const status = Number(errorCode) || httpStatus;
  return {
    success, httpStatus, latencyMs, provider, finishReason, usage, errorCode,
    systemic: status === 401 || status === 402,
    retryable: status === 429 || status >= 500 || (!error && !done && httpStatus === 200),
    reason: success ? null : (typeof error?.message === "string" ? error.message.replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/gi, "[redacted]").slice(0, 500) : null) || (mismatch ? "Returned model identity mismatch" :
      httpStatus >= 300 ? `OpenRouter returned HTTP ${httpStatus}` : !done ? "Incomplete stream" :
      !content.trim() ? "No visible assistant content" : `Unexpected finish reason: ${finishReason}`),
  };
}

// Reserve conservatively before dispatch; unknown charges retain the reservation.
function estimateProbeCost(model, request) {
  const price = model.health?.probePricing;
  if (!price) return null;
  return price.prompt * 4096 + price.completion * request.max_tokens + price.request;
}

async function probePortfolio(candidates, config, apiKey, options = {}) {
  const limits = { ...PROBE_LIMITS, ...options.limits };
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait = options.sleepImpl ?? sleep;
  const startedAt = options.startedAt ?? Date.now();
  const report = { startedAt: new Date(startedAt).toISOString(), limits, requests: 0, accountedUsd: 0,
    actualUsd: 0, unknownCostRequests: 0, stopReason: null, probes: [], shortages: [] };
  const results = new Map();
  const attempted = new Set();
  let systemicError = null;
  async function probe(model, profile = "chat") {
    const request = buildProbeRequest(model, profile);
    const reservation = estimateProbeCost(model, request);
    if (reservation === null) {
      const result = { success: false, reason: "Complete bounded probe pricing unavailable", profile, model: model.id };
      report.probes.push(result);
      return result;
    }
    if (report.requests >= limits.requests || Date.now() - startedAt >= limits.durationMs ||
        report.accountedUsd >= limits.budgetUsd) {
      report.stopReason = "Request, time or cost budget reached";
      return { success: false, reason: report.stopReason };
    }
    if (report.accountedUsd + reservation > limits.budgetUsd) {
      const result = { success: false, model: model.id, profile, reservedUsd: reservation,
        reason: "Candidate price bound exceeds remaining budget" };
      report.probes.push(result);
      return result;
    }
    report.requests++;
    report.accountedUsd += reservation;
    const begin = Date.now();
    let result;
    try {
      const response = await fetchImpl(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST", headers: openRouterHeaders(apiKey, "text/event-stream"),
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(Math.max(1, Math.min(limits.timeoutMs, limits.durationMs - (Date.now() - startedAt)))),
      });
      result = parseInferenceResponse(response.status, await response.text(), Date.now() - begin, model);
      result.retryAfterMs = Math.min(90_000, Math.max(0, Number(response.headers.get("retry-after")) * 1000 ||
        Date.parse(response.headers.get("retry-after")) - Date.now() || 1000));
    } catch (error) {
      result = { success: false, reason: error.name === "TimeoutError" ? "Inference timed out" : "Inference transport failed",
        retryable: true, latencyMs: Date.now() - begin };
    }
    const cost = result.usage?.cost;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
      report.accountedUsd += cost - reservation;
      report.actualUsd += cost;
      if (cost > reservation + 0.000001) systemicError = "Reported charge exceeded reserved price bound";
    } else report.unknownCostRequests++;
    report.probes.push({ model: model.id, profile, reservedUsd: reservation, ...result });
    if (result.systemic) systemicError = `Shared OpenRouter account failure (${result.errorCode || result.httpStatus})`;
    return result;
  }
  async function check(model, profile = "chat") {
    let result = await probe(model, profile);
    if (!result.success && result.retryable && !systemicError && !report.stopReason) {
      await wait(result.retryAfterMs || 1000);
      if (!systemicError) result = await probe(model, profile);
    }
    return result;
  }
  while (!systemicError && !report.stopReason) {
    const eligible = candidates.filter((m) => !m.hardGateReasons.length && results.get(m.id)?.success !== false);
    const proposed = selectPortfolio(eligible, config);
    const pending = proposed.selected.filter((m) => !attempted.has(m.id));
    if (!pending.length || attempted.size >= limits.models) break;
    const batch = pending.slice(0, Math.min(2, limits.models - attempted.size));
    await Promise.all(batch.map(async (model) => {
      attempted.add(model.id);
      results.set(model.id, await check(model));
    }));
    const rateLimits = report.probes.filter((p) => p.httpStatus === 429 || Number(p.errorCode) === 429);
    if (report.requests >= 4 && rateLimits.length >= Math.ceil(report.requests / 2)) {
      systemicError = "Systemic inference rate limiting";
    }
  }
  const portfolio = selectPortfolio(candidates.filter((m) => results.get(m.id)?.success), config);
  report.shortages = portfolio.shortages;
  let defaultId = null;
  const preferred = portfolio.selected.filter((m) => ["balanced", "economy"].includes(m.category));
  for (const model of [...preferred, ...portfolio.selected.filter((m) => !preferred.includes(m))]) {
    if (systemicError) break;
    if ((await check(model, "optimize")).success) { defaultId = model.id; break; }
    if (report.stopReason) break;
  }
  report.selected = portfolio.selected.map((m) => m.id);
  report.defaultId = defaultId;
  report.finishedAt = new Date().toISOString();
  report.systemicError = systemicError;
  return { portfolio, defaultId, report, error: systemicError || (!defaultId ? "No verified prompt-optimization default" : null) };
}

// ─── Monthly Rankings ────────────────────────────────────────────────────────

function monthlyRanks(rows) {
  const totals = new Map();
  for (const row of asArray(rows)) {
    const slug = typeof row.model_permaslug === "string" ? row.model_permaslug : "";
    if (!slug || slug === "other") continue;
    totals.set(slug, (totals.get(slug) ?? 0) + (finiteNumber(row.total_tokens) ?? 0));
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  return {
    count: sorted.length,
    ranks: new Map(sorted.map(([slug], i) => [slug, i + 1])),
  };
}

// ─── Category Eligibility ────────────────────────────────────────────────────

function categoryEligibility(model, pricePercentile) {
  const provider = model.id.split("/")[0];
  const intelligence = getBenchmark(model.raw, "intelligence_index") ?? 0;
  const coding = getBenchmark(model.raw, "coding_index") ?? 0;
  const free = model.inputPrice === 0 && model.outputPrice === 0;
  return {
    free,
    code: !free && (CODE_ID.test(`${model.id} ${model.name}`) || coding >= 55),
    flagship: !free && FLAGSHIP_AUTHORS.has(provider) && (
      intelligence >= 40 || rankWithin(model.weeklyRank, 25) || rankWithin(model.monthlyRank, 25) || model.ageDays <= 30
    ),
    reasoning: !free && model.supportsReasoning && (
      intelligence >= 25 || rankWithin(model.weeklyRank, 75) || rankWithin(model.monthlyRank, 75)
    ),
    economy: !free && pricePercentile <= 0.4,
    balanced: !free,
  };
}

// ─── Hard Gates ──────────────────────────────────────────────────────────────

function hardGateReasons(raw, config, nowMs) {
  const reasons = [];
  const inputs = asArray(raw.architecture?.input_modalities).map(String);
  const outputs = asArray(raw.architecture?.output_modalities).map(String);
  const inputPrice = perMillion(raw.pricing?.prompt);
  const outputPrice = perMillion(raw.pricing?.completion);
  const expirationMs = raw.expiration_date ? Date.parse(raw.expiration_date) : null;

  if (typeof raw.id !== "string" || !raw.id.includes("/")) reasons.push("Invalid model ID");
  if ([raw.id, raw.canonical_slug].some((id) => typeof id === "string" && ACCOUNT_ATTESTATION_GATED_ID.test(id))) {
    reasons.push("Requires provider account attestation");
  }
  if (BLOCKED_ID.test(`${raw.id ?? ""} ${raw.name ?? ""}`)) reasons.push("Dynamic or experimental model");
  if (config.filters.requireTextOutput && !outputs.includes("text")) reasons.push("No text output");
  if (!inputs.includes("text")) reasons.push("No text input");
  if (config.filters.requirePrice && (inputPrice === null || outputPrice === null || inputPrice < 0 || outputPrice < 0)) reasons.push("Price unavailable");
  if ((finiteNumber(raw.context_length) ?? 0) < config.filters.minimumContext) reasons.push("Context below minimum");
  if (expirationMs && expirationMs < nowMs + 14 * DAY_MS) reasons.push("Expires within 14 days");
  if (config.filters.requireAvailable && !raw.top_provider) reasons.push("No active top provider");
  return reasons;
}

// ─── Prepare Candidates ─────────────────────────────────────────────────────

function prepareCandidates(source, config, endpointHealth = new Map(), nowMs = Date.now()) {
  const weeklyModels = asArray(source.weekly?.data);
  const weekly = rankMap(weeklyModels);
  const newest = rankMap(source.newest?.data);
  const intelligence = rankMap(source.intelligence?.data);
  const throughput = rankMap(source.throughput?.data);
  const latency = rankMap(source.latency?.data);
  const monthly = monthlyRanks(source.monthly?.data);
  const qualityValues = weeklyModels.map((m) => getBenchmark(m, "intelligence_index")).filter((v) => v !== null);
  const qualityMin = Math.min(...qualityValues, 0);
  const qualityMax = Math.max(...qualityValues, 100);

  const preliminary = weeklyModels.map((raw) => {
    const canonicalSlug = raw.canonical_slug || raw.id;
    const inputPrice = perMillion(raw.pricing?.prompt);
    const outputPrice = perMillion(raw.pricing?.completion);
    const weightedPrice = inputPrice === null || outputPrice === null ? Number.POSITIVE_INFINITY : inputPrice * 0.4 + outputPrice * 0.6;
    const createdMs = finiteNumber(raw.created) ? Number(raw.created) * 1000 : nowMs;
    const ageDays = Math.max(0, Math.floor((nowMs - createdMs) / DAY_MS));
    const health = endpointHealth.get(raw.id);
    return {
      id: raw.id,
      canonicalSlug,
      name: raw.name || raw.id,
      description: raw.description || "",
      raw,
      provider: raw.id?.split("/")[0] || "unknown",
      inputPrice, outputPrice, weightedPrice,
      contextLength: finiteNumber(raw.context_length) ?? 0,
      ageDays,
      weeklyRank: weekly.get(raw.id) ?? null,
      monthlyRank: monthly.ranks.get(canonicalSlug) ?? monthly.ranks.get(raw.id) ?? null,
      newestRank: newest.get(raw.id) ?? null,
      intelligenceRank: intelligence.get(raw.id) ?? null,
      throughputRank: throughput.get(raw.id) ?? null,
      latencyRank: latency.get(raw.id) ?? null,
      supportsReasoning: asArray(raw.supported_parameters).some((v) => ["reasoning", "include_reasoning", "reasoning_effort"].includes(v)),
      health,
      hardGateReasons: hardGateReasons(raw, config, nowMs),
    };
  });

  const priced = preliminary.filter((m) => Number.isFinite(m.weightedPrice)).sort((a, b) => a.weightedPrice - b.weightedPrice);
  const priceRank = new Map(priced.map((m, i) => [m.id, i]));
  const priceDivisor = Math.max(1, priced.length - 1);

  return preliminary.map((model) => {
    const pricePercentile = (priceRank.get(model.id) ?? priceDivisor) / priceDivisor;
    const eligibility = categoryEligibility(model, pricePercentile);
    const qualityIndex = getBenchmark(model.raw, "intelligence_index");
    const components = {
      weekly: rankScore(model.weeklyRank, weekly.size),
      monthly: rankScore(model.monthlyRank, monthly.count),
      newModel: Math.exp(-model.ageDays / 30),
      quality: qualityIndex === null ? rankScore(model.intelligenceRank, intelligence.size) : normalizeNumber(qualityIndex, qualityMin, qualityMax),
      reliability: model.health?.verified ? Math.max(0, Math.min(1, model.health.uptime / 100)) : 0.5,
      performance: (rankScore(model.throughputRank, throughput.size) + rankScore(model.latencyRank, latency.size)) / 2,
      value: 1 - pricePercentile,
    };
    const score = Object.entries(config.weights).reduce((sum, [key, w]) => sum + components[key] * w, 0);
    const gates = [...model.hardGateReasons];
    if (model.health?.verified && !model.health.available) gates.push(model.health.reason || "No healthy endpoint");
    return { ...model, eligibility, components, score, hardGateReasons: gates };
  });
}

// ─── Supported Model Gate ────────────────────────────────────────────────────

function applySupportedModelGate(candidates, supportedModelIds) {
  return candidates.map((model) => supportedModelIds.has(model.id)
    ? model
    : { ...model, hardGateReasons: [...model.hardGateReasons, "Unavailable in new-api"] });
}

// ─── Portfolio Selection ─────────────────────────────────────────────────────

function selectPortfolio(candidates, config) {
  const selected = [];
  const selectedIds = new Set();
  const sorted = candidates
    .filter((m) => m.hardGateReasons.length === 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const shortages = [];

  for (const category of ALLOCATION_ORDER) {
    const target = config.quotas[category];
    const matches = sorted.filter((m) => !selectedIds.has(m.id) && m.eligibility[category]);
    const chosen = matches.slice(0, target);
    for (const model of chosen) {
      selectedIds.add(model.id);
      selected.push({ ...model, category });
    }
    if (chosen.length < target) shortages.push({ category, target, found: chosen.length });
  }

  selected.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const ranked = selected.map((m, i) => ({ ...m, rank: i + 1 }));
  return { selected: ranked, shortages };
}

// ─── Output Formatting ──────────────────────────────────────────────────────

function buildChatModelsJson(selected, defaultId) {
  const defaultModel = selected.find((m) => m.id === defaultId) ?? selected.find((m) => ["balanced", "economy"].includes(m.category) && m.health?.available) ?? selected[0];
  const recommended = selected.find((m) => m.category === "flagship") ?? selected[0];

  return Object.fromEntries(selected.map((model, index) => {
    const inputModalities = asArray(model.raw.architecture?.input_modalities);
    const reasoning = model.supportsReasoning;
    const requestPatches = {
      webSearch: { tools: [{ type: "openrouter:web_search", parameters: { engine: "exa", max_results: 5 } }] },
      ...(reasoning ? { reasoning: { reasoning: { effort: "medium" } } } : {}),
    };
    return [model.id, {
      displayName: model.name,
      description: model.description,
      tier: model.category,
      ...(model.id === recommended?.id ? { recommended: true } : {}),
      chatEnabled: true,
      chatRank: (index + 1) * 10,
      ...(model.id === defaultModel?.id ? { chatDefault: true } : {}),
      capabilities: {
        files: inputModalities.includes("file"),
        vision: inputModalities.includes("image"),
        audio: inputModalities.includes("audio"),
        webSearch: true,
        reasoning,
      },
      requestPatches,
    }];
  }));
}

// ─── Fingerprint ─────────────────────────────────────────────────────────────

function selectionRefreshFingerprint(models) {
  return JSON.stringify(models
    .map((m) => [m.id, m.category, m.inputPrice, m.outputPrice])
    .sort((a, b) => a[0].localeCompare(b[0])));
}

function currentFingerprint(json) {
  // Reconstruct a comparable fingerprint from existing chat-models.json.
  // Since the existing file doesn't store raw prices, we use model ID + tier
  // as a simplified fingerprint. A full match requires the algorithm's output.
  const entries = Object.entries(json).map(([id, model]) => [id, model.tier]);
  return JSON.stringify(entries.sort((a, b) => a[0].localeCompare(b[0])));
}

function newFingerprint(selected) {
  const entries = selected.map((m) => [m.id, m.category]);
  return JSON.stringify(entries.sort((a, b) => a[0].localeCompare(b[0])));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const newApiUrl = process.env.NEW_API_URL?.trim();
  const newApiToken = process.env.NEW_API_TOKEN?.trim();

  if (!apiKey) { console.error("Error: OPENROUTER_API_KEY is required."); process.exit(1); }
  if (!newApiUrl) { console.error("Error: NEW_API_URL is required."); process.exit(1); }
  if (!newApiToken) { console.error("Error: NEW_API_TOKEN is required."); process.exit(1); }

  const config = DEFAULT_STRATEGY;
  const now = new Date();
  const nowMs = now.getTime();
  const startedAt = Date.now();

  // Step 1: Fetch supported model IDs from new-api
  const supportedModelIds = await fetchSupportedModelIds(newApiUrl, newApiToken);

  // Step 2: Fetch all data sources from OpenRouter
  const source = await fetchSources(apiKey, now);

  // Step 3: Prepare candidates and apply supported model gate
  console.log("Preparing candidates...");
  const baseCandidates = applySupportedModelGate(
    prepareCandidates(source, config, new Map(), nowMs),
    supportedModelIds,
  );
  const eligible = baseCandidates.filter((m) => m.hardGateReasons.length === 0);
  console.log(`  candidates: ${baseCandidates.length}, passed hard gates: ${eligible.length}`);

  // Step 4: Fetch endpoint health for eligible models
  console.log(`Checking endpoint health (${eligible.length} models, concurrency 5)...`);
  const healthChecks = await mapWithConcurrency(eligible, 5, async (m) => [m.id, await fetchEndpointHealth(apiKey, m.id)]);
  const healthMap = new Map(healthChecks);
  const healthyCount = [...healthMap.values()].filter((h) => h.available).length;
  console.log(`  healthy: ${healthyCount}/${eligible.length}`);

  // Step 5: Re-score with health data and apply supported model gate
  const scored = applySupportedModelGate(
    prepareCandidates(source, config, healthMap, nowMs),
    supportedModelIds,
  );

  // Publish only models verified in this run; shortages are warnings, not stale-list fallback.
  const { portfolio, defaultId, report, error } = await probePortfolio(scored, config, apiKey, { startedAt });
  await fs.writeFile(path.join(rootDir, "chat-probe-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Inference: ${report.requests} requests; actual $${report.actualUsd.toFixed(6)}; accounted $${report.accountedUsd.toFixed(6)}`);
  if (error) throw new Error(error);
  if (portfolio.shortages.length) console.warn(`Partial selection: ${portfolio.selected.length}/${MODEL_COUNT}; ${JSON.stringify(portfolio.shortages)}`);
  const chatModels = buildChatModelsJson(portfolio.selected, defaultId);
  const output = JSON.stringify(chatModels, null, "\t") + "\n";

  // Step 9: Compare with existing file
  const outputPath = path.join(rootDir, "chat-models.json");
  let existing = null;
  try {
    existing = await fs.readFile(outputPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (existing !== null && existing === output) {
    console.log("\nchat-models.json is already up to date. No changes needed.");
    process.exit(0);
  }

  // Also compare fingerprints for logging purposes
  const newFp = newFingerprint(portfolio.selected);
  let fpChanged = true;
  if (existing) {
    try {
      const oldFp = currentFingerprint(JSON.parse(existing));
      fpChanged = oldFp !== newFp;
    } catch {}
  }

  // Step 10: Write updated file
  await fs.writeFile(outputPath, output, "utf8");

  // Summary
  const categories = {};
  for (const m of portfolio.selected) categories[m.category] = (categories[m.category] || 0) + 1;
  const providers = new Set(portfolio.selected.map((m) => m.provider));

  console.log("\nchat-models.json updated successfully!");
  console.log(`  models: ${portfolio.selected.length}`);
  console.log(`  providers: ${providers.size} (${[...providers].sort().join(", ")})`);
  console.log(`  categories: ${CATEGORY_ORDER.map((c) => `${c}: ${categories[c] || 0}`).join(", ")}`);
  console.log(`  fingerprint changed: ${fpChanged}`);
  if (!fpChanged) {
    console.log("  (metadata-only change, e.g. display name or description)");
  }
}

export { DEFAULT_STRATEGY, prepareCandidates, selectPortfolio, buildChatModelsJson, buildProbeRequest, parseInferenceResponse, estimateProbeCost, boundedEndpointPricing, probePortfolio };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\nFatal error: ${error.message}`);
    if (error.cause) console.error("Cause:", error.cause);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  });
}

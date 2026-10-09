#!/usr/bin/env node

// Scoring reference: MaxShotLab/llm_gateway_prototype@4cf7908.
// Rank the complete upstream candidate pool before gating against Studio.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MEDIA_COUNTS = { image: 15, video: 10 };

function rankScores(models, field) {
  const ranked = [...models].filter((model) => model[field] > 0).sort((a, b) => b[field] - a[field]);
  return new Map(ranked.map((model, index) => [model.id, { rank: index + 1, score: 1 - index / Math.max(1, ranked.length - 1) }]));
}

function usageTotals(rows, endDate) {
  const totals = new Map();
  const weekStart = new Date(`${endDate}T00:00:00Z`);
  weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  const firstWeekDay = weekStart.toISOString().slice(0, 10);
  for (const row of rows) {
    if (!row.model_permaslug || row.model_permaslug === "other") continue;
    const value = Number(row.total_tokens);
    if (!Number.isFinite(value) || value < 0) continue;
    const total = totals.get(row.model_permaslug) ?? { weekly: 0, monthly: 0 };
    total.monthly += value;
    if (row.date >= firstWeekDay && row.date <= endDate) total.weekly += value;
    totals.set(row.model_permaslug, total);
  }
  return totals;
}

function freshness(created, nowSeconds) {
  const ageDays = Math.max(0, (nowSeconds - Number(created || 0)) / 86_400);
  return Math.exp(-ageDays / 180);
}

function abilities(input, output) {
  return {
    t2i: output.includes("image") && input.includes("text"),
    i2i: output.includes("image") && input.includes("image"),
    t2v: output.includes("video") && input.includes("text"),
    i2v: output.includes("video") && input.includes("image"),
    v2v: output.includes("video") && input.includes("video"),
  };
}

export function scoreMediaModels({ models, imageModels, videoModels, imageUsage }, now = Date.now()) {
  const imageById = new Map(imageModels.map((model) => [model.id, model]));
  const videoById = new Map(videoModels.map((model) => [model.id, model]));
  const usage = usageTotals(imageUsage.data, imageUsage.meta.end_date);
  const nowSeconds = now / 1_000;
  const image = [];
  const video = [];

  for (const model of models) {
    const input = model.architecture?.input_modalities ?? [];
    const output = model.architecture?.output_modalities ?? [];
    if (model.expiration_date) {
      const expires = typeof model.expiration_date === "number"
        ? model.expiration_date * 1_000 : Date.parse(model.expiration_date);
      if (!Number.isFinite(expires) || expires <= now) continue;
    }
    const capability = abilities(input, output);
    const base = {
      id: model.id,
      name: model.name,
      description: model.description,
      created: model.created,
      abilities: capability,
      inputModalities: input,
      outputModalities: output,
    };
    if (capability.t2i || capability.i2i) {
      const detail = imageById.get(model.id);
      const requiresReference = Number(detail?.supported_parameters?.input_references?.min) > 0;
      const totals = usage.get(model.canonical_slug ?? model.id) ?? { weekly: 0, monthly: 0 };
      const imageAbilities = { ...capability, t2i: capability.t2i && !requiresReference };
      if (imageAbilities.t2i || imageAbilities.i2i) image.push({
        ...base,
        abilities: imageAbilities,
        weeklyTokens: totals.weekly,
        monthlyTokens: totals.monthly,
        imageOutputPrice: model.pricing?.image_output ?? null,
        inImageApi: Boolean(detail),
        supportedParameters: detail?.supported_parameters ?? {},
        supportsStreaming: detail?.supports_streaming ?? null,
      });
    }
    if (videoById.has(model.id) && (capability.t2v || capability.i2v || capability.v2v)) {
      const detail = videoById.get(model.id);
      video.push({
        ...base,
        generateAudio: detail.generate_audio,
        supportedDurations: detail.supported_durations ?? [],
        supportedResolutions: detail.supported_resolutions ?? [],
        supportedFrameImages: detail.supported_frame_images ?? [],
        pricingSkus: detail.pricing_skus ?? {},
      });
    }
  }

  const weekly = rankScores(image, "weeklyTokens");
  const monthly = rankScores(image, "monthlyTokens");
  for (const model of image) {
    model.weeklyRank = weekly.get(model.id)?.rank ?? null;
    model.monthlyRank = monthly.get(model.id)?.rank ?? null;
    model.score = Math.round(100 * (
      0.45 * (weekly.get(model.id)?.score ?? 0) +
      0.25 * (monthly.get(model.id)?.score ?? 0) +
      0.20 * freshness(model.created, nowSeconds) +
      0.10 * (Number(model.abilities.t2i) + Number(model.abilities.i2i)) / 2
    ));
  }
  for (const model of video) {
    const breadth = (Number(model.abilities.t2v) + Number(model.abilities.i2v) + Number(model.abilities.v2v)) / 3;
    const specs = (Number(model.supportedDurations.length > 0) + Number(model.supportedResolutions.length > 0) + Number(model.supportedFrameImages.length > 0)) / 3;
    model.score = Math.round(100 * (0.60 * freshness(model.created, nowSeconds) + 0.25 * breadth + 0.15 * specs));
  }
  const order = (a, b) => b.score - a.score || b.created - a.created || a.id.localeCompare(b.id);
  return { image: image.sort(order), video: video.sort(order) };
}

export const DEFAULT_STUDIO_URL = "https://api-gateway.888646.xyz/studio/v1/models?scope=all";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function validateSelection(selection) {
  if (!selection || Object.keys(selection).sort().join(",") !== "image,video") throw new Error("Invalid Studio selection shape");
  const ids = [];
  for (const kind of ["image", "video"]) {
    if (!Array.isArray(selection[kind]) || selection[kind].length > 500 ||
        selection[kind].some((id) => typeof id !== "string" || !id.trim() || id !== id.trim())) {
      throw new Error(`Invalid ${kind} selection`);
    }
    ids.push(...selection[kind]);
  }
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate Studio selection IDs");
  return selection;
}

export function selectStudioGroup(kind, scored, studioModels) {
  const byProvider = new Map();
  const publicIdCounts = new Map();
  for (const model of studioModels) {
    const id = model.namespace === "openrouter" ? model.providerModelId : model.id;
    if (typeof id === "string") publicIdCounts.set(id, (publicIdCounts.get(id) ?? 0) + 1);
  }
  for (const model of studioModels) {
    if (model.namespace !== "openrouter" || model.kind !== kind || model.enabled !== true) continue;
    if (typeof model.providerModelId !== "string" || !model.providerModelId) continue;
    if (byProvider.has(model.providerModelId)) throw new Error(`Ambiguous Studio mapping: ${model.providerModelId}`);
    byProvider.set(model.providerModelId, model);
  }
  const selected = scored.filter((model) => byProvider.has(model.id))
    .slice(0, MEDIA_COUNTS[kind]).map((model) => byProvider.get(model.id));
  if (selected.length !== MEDIA_COUNTS[kind]) {
    throw new Error(`Incomplete ${kind} selection: ${selected.length}/${MEDIA_COUNTS[kind]}`);
  }
  const modes = kind === "image" ? ["textToImage", "imageEdit"] : ["textToVideo", "imageToVideo"];
  for (const mode of modes) {
    const count = selected.filter((model) => model.capabilities?.[mode] === true).length;
    if (count < 3) throw new Error(`Insufficient ${kind} coverage: ${mode} ${count}/3`);
  }
  // Use upstream author/slug IDs even while Studio still returns legacy IDs.
  const ids = selected.map((model) => model.providerModelId);
  if (ids.some((id) => typeof id !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(id)) ||
      new Set(ids).size !== ids.length || ids.some((id) => publicIdCounts.get(id) !== 1)) {
    throw new Error(`Invalid or duplicate ${kind} public IDs`);
  }
  return ids;
}

export function buildStudioSelection(existing, scored, studioModels, sourceErrors = {}) {
  validateSelection(existing);
  const selection = { image: [...existing.image], video: [...existing.video] };
  const errors = {};
  // Validate each group before replacing it. A failed group retains its old order.
  for (const kind of ["image", "video"]) {
    try {
      if (sourceErrors[kind]) throw new Error(sourceErrors[kind]);
      const ids = selectStudioGroup(kind, scored[kind], studioModels);
      const otherKind = kind === "image" ? "video" : "image";
      if (ids.some((id) => selection[otherKind].includes(id))) throw new Error("Cross-group duplicate public ID");
      selection[kind] = ids;
    } catch (error) {
      errors[kind] = error.message;
    }
  }
  validateSelection(selection);
  return { selection, errors };
}

async function fetchJson(url, headers, fetchImpl) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(45_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${new URL(url).pathname}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function fetchStudioSources({ apiKey, studioUrl = DEFAULT_STUDIO_URL, now = new Date(), fetchImpl = fetch }) {
  const url = new URL(studioUrl);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Studio URL must use HTTP or HTTPS");
  url.searchParams.set("scope", "all");
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);
  const date = (value) => value.toISOString().slice(0, 10);
  const requests = {
    catalog: "/models?output_modalities=all",
    images: "/images/models",
    videos: "/videos/models",
    usage: `/datasets/rankings-daily?start_date=${date(start)}&end_date=${date(end)}&modality=image_output`,
    studio: url.toString(),
  };
  const results = await Promise.allSettled(Object.entries(requests).map(async ([key, endpoint]) => {
    const payload = await fetchJson(key === "studio" ? endpoint : `https://openrouter.ai/api/v1${endpoint}`,
      key === "studio" ? { accept: "application/json" } : {
        accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      }, fetchImpl);
    if (key === "studio") {
      if (!Array.isArray(payload?.items) || payload.items.some((model) =>
        !model || typeof model.id !== "string" || !model.id.trim() ||
        !["image", "video"].includes(model.kind) || typeof model.enabled !== "boolean" ||
        !model.capabilities || typeof model.capabilities !== "object")) {
        throw new Error("Invalid Studio published catalog");
      }
    } else {
      if (!Array.isArray(payload?.data) || payload.data.some((row) => !row || typeof row !== "object")) {
        throw new Error(`Invalid OpenRouter ${key} data`);
      }
      if (key === "usage" && (payload.meta?.start_date !== date(start) || payload.meta?.end_date !== date(end))) {
        throw new Error("Incomplete or stale image usage window");
      }
      if (key === "catalog" && payload.data.some((model) =>
        !Array.isArray(model.architecture?.input_modalities) || !Array.isArray(model.architecture?.output_modalities))) {
        throw new Error("Invalid OpenRouter catalog modalities");
      }
      if (key !== "usage" && payload.data.some((model) => typeof model.id !== "string" || !model.id)) {
        throw new Error(`Invalid OpenRouter ${key} model IDs`);
      }
      if (key !== "usage" && new Set(payload.data.map((model) => model.id)).size !== payload.data.length) {
        throw new Error(`Duplicate OpenRouter ${key} model IDs`);
      }
    }
    return payload;
  }));
  const data = {}, failures = {};
  Object.keys(requests).forEach((key, index) => {
    const result = results[index];
    if (result.status === "fulfilled") data[key] = result.value;
    else failures[key] = result.reason.message;
  });
  const common = failures.catalog || failures.studio;
  const sourceErrors = {};
  if (common || failures.images || failures.usage) sourceErrors.image = common || failures.images || failures.usage;
  if (common || failures.videos) sourceErrors.video = common || failures.videos;
  return { data, sourceErrors, window: { start: date(start), end: date(end) } };
}

export async function updateStudioModels({ apiKey, studioUrl, outputPath = path.join(ROOT, "studio-models.json"),
  dryRun = false, now = new Date(), fetchImpl = fetch } = {}) {
  const existingText = await fs.readFile(outputPath, "utf8");
  const existing = validateSelection(JSON.parse(existingText));
  const { data, sourceErrors, window } = await fetchStudioSources({ apiKey, studioUrl, now, fetchImpl });
  let scored = { image: [], video: [] };
  if (data.catalog && data.studio) {
    scored = scoreMediaModels({ models: data.catalog.data, imageModels: data.images?.data ?? [],
      videoModels: data.videos?.data ?? [], imageUsage: data.usage ?? { meta: { end_date: window.end }, data: [] } }, now.getTime());
  }
  const result = buildStudioSelection(existing, scored, data.studio?.items ?? [], sourceErrors);
  const changed = JSON.stringify(existing) !== JSON.stringify(result.selection);
  if (changed && !dryRun) {
    const temporaryPath = `${outputPath}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(result.selection, null, "  ") + "\n", "utf8");
      await fs.rename(temporaryPath, outputPath);
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  }
  return { ...result, changed, dryRun };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  updateStudioModels({ apiKey: process.env.OPENROUTER_API_KEY?.trim(),
    studioUrl: process.env.STUDIO_MODELS_URL?.trim() || DEFAULT_STUDIO_URL,
    dryRun: process.argv.includes("--dry-run") }).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (Object.keys(result.errors).length) process.exitCode = 1;
  }).catch((error) => {
    console.error(`Studio model update failed: ${error.message}`);
    process.exitCode = 1;
  });
}

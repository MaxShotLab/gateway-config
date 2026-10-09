import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scoreMediaModels, buildStudioSelection, selectStudioGroup, updateStudioModels, validateSelection } from "./update-studio-models.mjs";

const now = new Date("2026-10-08T00:00:00Z");
const usage = { meta: { start_date: "2026-09-08", end_date: "2026-10-07" }, data: [] };
const model = (id, kind = "image", extra = {}) => ({ id, created: now.getTime() / 1_000,
  architecture: { input_modalities: ["text", "image"], output_modalities: [kind] }, ...extra });
const studioModel = (id, kind = "image", extra = {}) => ({ id: `public/${id}`, providerModelId: id,
  kind, namespace: "openrouter", enabled: true, capabilities: {
    textToImage: kind === "image", imageEdit: kind === "image",
    textToVideo: kind === "video", imageToVideo: kind === "video",
  }, ...extra });
const pool = (kind, count) => Array.from({ length: count }, (_, i) => ({ id: `${kind}/${String(i).padStart(2, "0")}` }));
const images = pool("image", 16), videos = pool("video", 11);
const catalog = [...images.map((m) => model(m.id)), ...videos.map((m) => model(m.id, "video"))];
const studio = [...images.map((m) => studioModel(m.id)), ...videos.map((m) => studioModel(m.id, "video"))];
const existing = { image: ["public/old-image"], video: ["public/old-video"] };
const scored = { image: images, video: videos };

test("reference scoring retains canonical usage, required references, and global ranks", () => {
  const data = { models: [model("a", "image", { canonical_slug: "canonical-a" }), model("b"), model("c")],
    imageModels: [{ id: "a", supported_parameters: { input_references: { min: 1 } } }], videoModels: [],
    imageUsage: { ...usage, data: [
      { model_permaslug: "canonical-a", date: "2026-10-07", total_tokens: "100" },
      { model_permaslug: "b", date: "2026-09-08", total_tokens: "50" },
    ] } };
  const result = scoreMediaModels(data, now.getTime());
  assert.equal(result.image.find((m) => m.id === "a").score, 95);
  assert.equal(result.image.find((m) => m.id === "b").score, 30);
  assert.equal(result.image.find((m) => m.id === "a").abilities.t2i, false);
  assert.equal(result.image.find((m) => m.id === "a").abilities.i2i, true);
  assert.equal(result.image.find((m) => m.id === "b").weeklyTokens, 0);
  assert.equal(result.image.find((m) => m.id === "b").monthlyTokens, 50);
});

test("ISO dates exclude expired and invalid models and retain future models", () => {
  const result = scoreMediaModels({ models: [model("expired", "image", { expiration_date: "2020-01-01" }),
    model("invalid", "image", { expiration_date: "invalid" }), model("future", "image", { expiration_date: "2027-01-01" })],
    imageModels: [], videoModels: [], imageUsage: usage }, now.getTime());
  assert.deepEqual(result.image.map((m) => m.id), ["future"]);
});

test("video scores preserve reference weights and score ties use creation date then ID", () => {
  const ms = [model("z", "video"), model("a", "video"), model("old", "video", { created: now.getTime() / 1_000 - 86400 })];
  const result = scoreMediaModels({ models: ms, imageModels: [], imageUsage: usage,
    videoModels: ms.map((m) => ({ id: m.id, supported_durations: [5], supported_resolutions: ["720p"], supported_frame_images: ["first"] })) }, now.getTime());
  assert.equal(result.video[0].score, 92);
  assert.deepEqual(result.video.map((m) => m.id), ["a", "z", "old"]);
});

test("Studio gates before truncation and writes exact upstream public IDs", () => {
  const disabled = studio.map((m) => m.providerModelId === "image/00" ? { ...m, enabled: false } : m);
  const result = buildStudioSelection(existing, scored, disabled);
  assert.deepEqual(result.errors, {});
  assert.equal(result.selection.image.length, 15);
  assert.equal(result.selection.video.length, 10);
  assert.equal(result.selection.image[0], "image/01");
  assert.equal(result.selection.image.at(-1), "image/15");
});

test("legacy and migrated Studio catalogs produce the same author-scoped selection", () => {
  const legacy = studio.map((m) => ({ ...m, id: `openrouter/${m.providerModelId.split("/")[1]}` }));
  const migrated = studio.map((m) => ({ ...m, id: m.providerModelId }));
  assert.deepEqual(buildStudioSelection(existing, scored, legacy), buildStudioSelection(existing, scored, migrated));
  assert.deepEqual(selectStudioGroup("video", videos, migrated), videos.slice(0, 10).map((m) => m.id));
});

test("invalid author-scoped IDs and published collisions retain the affected group", () => {
  const collision = [...studio, { ...studio[0], namespace: "another-provider", enabled: false, id: "image/00" }];
  const result = buildStudioSelection(existing, scored, collision);
  assert.match(result.errors.image, /duplicate/);
  assert.deepEqual(result.selection.image, existing.image);
  assert.equal(result.selection.video.length, 10);
  const unscoped = pool("image", 15).map((m, i) => ({ ...m, id: `unscoped-${i}` }));
  assert.throws(() => selectStudioGroup("image", unscoped, unscoped.map((m) => studioModel(m.id))), /Invalid/);
});

test("shortage preserves one group while the other updates", () => {
  const result = buildStudioSelection(existing, { ...scored, image: images.slice(0, 14) }, studio);
  assert.match(result.errors.image, /14\/15/);
  assert.deepEqual(result.selection.image, existing.image);
  assert.equal(result.selection.video.length, 10);
});

test("published coverage is authoritative and no lower-ranked replacement is inserted", () => {
  const limited = studio.map((m) => m.kind === "image" ? {
    ...m, capabilities: { textToImage: true, imageEdit: ["image/00", "image/01", "image/15"].includes(m.providerModelId) },
  } : m);
  const result = buildStudioSelection(existing, scored, limited);
  assert.match(result.errors.image, /imageEdit 2\/3/);
  assert.deepEqual(result.selection.image, existing.image);
  assert.equal(result.selection.video.length, 10);
});

test("ambiguous mappings, duplicate output IDs, and invalid existing files are rejected", () => {
  assert.throws(() => selectStudioGroup("image", images, [...studio, studioModel("image/00", "image", { id: "another" })]), /Ambiguous/);
  assert.throws(() => selectStudioGroup("image", images, [...studio, { ...studio[0], namespace: "another-provider", id: "image/00" }]), /duplicate/);
  assert.throws(() => validateSelection({ image: ["same"], video: ["same"] }), /Duplicate/);
  assert.throws(() => validateSelection({ image: [], video: [], metadata: {} }), /shape/);
});

function fakeFetch(overrides = {}, requests = []) {
  return async (url, options) => {
    requests.push({ url: String(url), headers: options.headers });
    const u = new URL(url);
    let key = "catalog";
    if (u.hostname === "studio.invalid") key = "studio";
    else if (u.pathname.endsWith("/images/models")) key = "images";
    else if (u.pathname.endsWith("/videos/models")) key = "videos";
    else if (u.pathname.includes("rankings-daily")) key = "usage";
    const payloads = { catalog: { data: catalog }, images: { data: images }, videos: { data: videos }, usage,
      studio: { items: studio } };
    return new Response(JSON.stringify(Object.hasOwn(overrides, key) ? overrides[key] : payloads[key]), { status: 200 });
  };
}

async function withOutput(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-selection-test-"));
  const outputPath = path.join(dir, "studio-models.json");
  await fs.writeFile(outputPath, JSON.stringify(existing));
  try { await run(outputPath); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

const options = { now, studioUrl: "https://studio.invalid/models?scope=curated" };

test("dry run does not write; normal update writes; unchanged selection does not rewrite", async () => withOutput(async (outputPath) => {
  const requests = [];
  const args = { ...options, outputPath, apiKey: "test-key", fetchImpl: fakeFetch({}, requests) };
  const dry = await updateStudioModels({ ...args, dryRun: true });
  assert.equal(dry.changed, true);
  assert.deepEqual(JSON.parse(await fs.readFile(outputPath, "utf8")), existing);
  const live = await updateStudioModels(args);
  assert.deepEqual(live.errors, {});
  assert.deepEqual(JSON.parse(await fs.readFile(outputPath, "utf8")), live.selection);
  const stat = await fs.stat(outputPath);
  assert.equal((await updateStudioModels(args)).changed, false);
  assert.equal((await fs.stat(outputPath)).mtimeMs, stat.mtimeMs);
  const request = requests.find((r) => r.url.includes("studio.invalid"));
  assert.equal(new URL(request.url).searchParams.get("scope"), "all");
  assert.equal(request.headers.authorization, undefined);
  assert.equal(requests.find((r) => r.url.includes("openrouter.ai")).headers.authorization, "Bearer test-key");
}));

test("image source failures do not block video and video failures do not block image", async () => {
  for (const [failedSource, failedGroup, goodGroup] of [["images", "image", "video"], ["usage", "image", "video"], ["videos", "video", "image"]]) {
    await withOutput(async (outputPath) => {
      const result = await updateStudioModels({ ...options, outputPath, fetchImpl: fakeFetch({ [failedSource]: {} }) });
      assert.ok(result.errors[failedGroup]);
      assert.equal(result.errors[goodGroup], undefined);
      assert.deepEqual(result.selection[failedGroup], existing[failedGroup]);
      assert.equal(result.selection[goodGroup].length, goodGroup === "image" ? 15 : 10);
      assert.deepEqual(JSON.parse(await fs.readFile(outputPath, "utf8")), result.selection);
    });
  }
});

test("invalid shared catalogs and stale usage cannot overwrite affected groups", async () => {
  for (const source of ["catalog", "studio"]) await withOutput(async (outputPath) => {
    const before = await fs.readFile(outputPath, "utf8");
    const result = await updateStudioModels({ ...options, outputPath, fetchImpl: fakeFetch({ [source]: {} }) });
    assert.ok(result.errors.image && result.errors.video);
    assert.equal(result.changed, false);
    assert.equal(await fs.readFile(outputPath, "utf8"), before);
  });
  await withOutput(async (outputPath) => {
    const result = await updateStudioModels({ ...options, outputPath, fetchImpl: fakeFetch({ usage: { ...usage, meta: { ...usage.meta, end_date: "2026-10-06" } } }) });
    assert.ok(result.errors.image);
    assert.equal(result.errors.video, undefined);
  });
});

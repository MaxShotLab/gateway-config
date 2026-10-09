# Gateway model configuration

`chat-models.json` is updated daily at 00:00 UTC (08:00 Asia/Shanghai) and
through manual GitHub Actions dispatch. Failed selections retain the previous
configuration and are reported as workflow failures.

Automatic updates of `studio-models.json` are paused. The Studio updater remains
available for local manual runs.

## Automated Studio selection

Run `npm run update:studio`, or use `node scripts/update-studio-models.mjs --dry-run`
to inspect the proposed selection without writing. Run `npm test` for offline
regression checks. `OPENROUTER_API_KEY` is required by the image rankings dataset and is supplied
from the existing Actions secret. Without a usable key, the image group is
retained and reported as failed; publicly accessible video data can still update.
`STUDIO_MODELS_URL` optionally overrides the published Studio catalog URL; the
updater always requests `scope=all`. The default is
`https://api-gateway.888646.xyz/studio/v1/models?scope=all`.

The scoring reference is [llm_gateway_prototype commit 4cf7908](https://github.com/MaxShotLab/llm_gateway_prototype/commit/4cf7908a3db2b041cb83678a5ca98e7838e5e6a1).
The updater fetches the general OpenRouter catalog, Image API catalog, Video API
catalog and image-output rankings for the previous 30 complete UTC days. Image
weekly/monthly usage, freshness and ability weights remain 45/25/20/10; video
freshness, ability breadth and parameter completeness remain 60/25/15. Video
scores do not represent popularity. Dates are parsed correctly to exclude
expired models; invalid expiration dates also exclude the candidate.

Scores and ranks are computed on the complete eligible OpenRouter candidate
pool, before Studio filtering. Candidates then match currently published,
`enabled` OpenRouter Studio models by `providerModelId` and medium; output uses
the exact upstream author/slug as the Studio public ID, for example
`bytedance-seed/seedream-5-0-pro` and `bytedance/seedance-2.5`. The updater uses
`providerModelId` even when a rolling deployment still returns legacy
`openrouter/slug` IDs. It rejects collisions with any published catalog entry,
including disabled models. `namespace=openrouter` remains the provider routing
identifier, independent of the public ID. No ID is inferred by removing or adding
an author prefix.
Each group retains score-descending, creation-descending, ID order from the
reference. Images outside the dedicated Image API remain upstream candidates,
but still require an enabled matching Studio model. No generation requests are
made and upstream endpoint inference availability is not probed.

Targets are **15 images and 10 videos**. Each selected image group must contain
at least three models with `textToImage` and three with `imageEdit`; each selected
video group must contain at least three with `textToVideo` and three with
`imageToVideo`, using the published Studio capabilities. A group with insufficient
count, insufficient coverage, ambiguous IDs or failed required data retains its
previous selection and order. A valid other group can still update. The updater
exits nonzero for any failed group. Studio or general catalog failure retains
both groups; image-data failure does not block video and vice versa. Coverage
validation never replaces top-ranked models with lower-ranked candidates.

Only membership or order changes write the JSON file. Failed/empty source data
cannot clear a group. Arrays contain public Studio IDs grouped by output kind;
a model is listed once even when it supports multiple input modes. Existing
remote-refresh behavior and backend fallback storage remain unchanged. The backend
continues accepting legacy `openrouter/slug` inputs for compatibility; all Studio
model IDs returned by the backend use the new author/slug format.

## Historical Studio initial selection

Selection date: 2026-09-30. Sources: [OpenRouter image rankings](https://openrouter.ai/rankings/image),
[video rankings](https://openrouter.ai/rankings/video), model creation timestamps,
and each candidate's `/api/v1/models/{author}/{slug}/endpoints` status and
`uptime_last_1d`. Ranking pages may expose different cached cutoff dates: the
image page snapshot used here contained data through September 29; the video
page displayed data through September 28. Counts are ranking-surface request
counts, not our application traffic. No unverified time window is assumed.

The selection balances request volume, recent releases, model families and
currently executable, priceable Studio capabilities. Recent one-day uptime is
short-term evidence, not a long-term availability guarantee. Historical test
server results are excluded because earlier implementation defects and
incomplete features affected those results.

| Kind | Model | Role |
| --- | --- | --- |
| image | Seedream 4.5 | Higher-volume established image generation/editing |
| image | Grok Imagine Image 2.0 | Higher-volume recent generation/editing |
| image | Seedream 5.0 Pro | Recent precision-oriented generation/editing |
| image | Recraft V4.1 Flash | New speed-oriented text-to-image model |
| image | Seedream 5.0 Lite | Recent generation/editing with multiple outputs |
| image | Qwen Image 3 | Generation/editing family diversity |
| video | Seedance 2.5 | Higher-volume recent text/image-to-video |
| video | Seedance 2.0 Mini | Higher-volume lightweight text/image-to-video |
| video | Wan 3.0 | Higher-volume recent text/image-to-video |
| video | Wan 2.7 | Higher-volume established text/image-to-video |
| video | Hailuo 3 Max | Recent text/image-to-video with first/last frames |
| video | Kling V3.0 Pro | Family diversity and first/last frame controls |

At initial verification, all candidates had a provider endpoint with `status=0`;
one-day uptime was 100% except Grok Imagine Image 2.0 (approximately 99.85%).
Image capability coverage was t2i=6, i2i=5; video coverage was t2v=6, i2v=6.
Google/OpenAI models that were not enabled in Studio were not selected merely
because they ranked highly: curation cannot bypass billing or safety gates.

## Studio incident selection review (2026-10-09)

The video selection replaces `heygen/heygen-video-1` with `alibaba/wan-2.7`
and retains the other nine models in their existing relative order. Three
HeyGen attempts were rejected because the provider always emits audio and
rejects `generate_audio=false`, while the upstream catalog declares
`generate_audio=false`. This removes HeyGen from curated discovery only; it
remains enabled in `scope=all`. Wan 2.7 is published and enabled, declares
text-to-video, image-to-video and first/last-frame support, and passes live
pricing checks with an image reference for both silent and audio output.
No paid generation was performed to verify the replacement.

The five reported image models remain selected: `black-forest-labs/flux-3-image`,
`recraft/recraft-v4.1`, `sourceful/riverflow-v2.5-pro`,
`sourceful/riverflow-v2.5-fast`, and `recraft/recraft-v4`. Their upstream endpoints
advertise reference-image support but only output-image prices. Studio currently
requires explicit reference-input pricing and rejects those image-edit quotes;
this is a pricing integration limitation, not evidence of provider generation
failure. Removing them would also remove their priceable text-to-image mode.
Aligning capability discovery and quotation needs a separate backend change.

The two incomplete Seedance 1.5 Pro checks were blocked before provider dispatch
by the existing daily Studio cost budget, not a recorded model rejection; its
selection is retained. This review does not change billing, budgets, model
admission, enabled flags, or the paused automatic-selection schedule.

## Backend release coordination

The backend shipped fallback (`apps/studio-service/src/studio-models.json`) is
synchronized from this repository during normal backend releases. Daily Actions
updates do not modify or deploy the backend. A process restart with an unavailable
remote configuration can temporarily use an older shipped selection. No durable
selection cache is added. A valid remote refresh replaces that fallback.

The backend polls this configuration on curated-list requests using a five-minute
cache, with a thirty-second retry after failure and a five-second request timeout.
Refresh is nonblocking. It keeps the last valid in-memory selection on failure;
a process restart starts with its shipped fallback snapshot. Empty groups are
valid and intentionally display no models for that group.

`scope=curated` is the default on all three Studio models listing endpoints.
`scope=all` returns the existing full published catalog, including disabled
models. Default listings omit disabled, unpublished and wrong-kind entries.
Coverage gaps are logged; the backend never automatically adds replacements.
This configuration affects listing only. Quotes, generation, historical tasks
and upstream capability/price synchronization remain independent.

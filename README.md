# Gateway model configuration

`chat-models.json` is maintained by the existing chat selection workflow.
`studio-models.json` is a manually maintained Studio listing selection. The chat
workflow must not update it. Arrays contain existing Studio model IDs in display
order, grouped by output kind (`image` and `video`). An ID may cover multiple
input modes; it is listed only once in its output group.

## Studio initial selection

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

## Manual update procedure

1. Check the latest official request-volume, availability and release evidence.
2. Check candidates against the published Studio catalog using `scope=all`.
3. Preserve at least three currently enabled models for each of t2i, i2i, t2v
   and i2v. A model can satisfy multiple modes. Avoid duplicate IDs.
4. Edit `studio-models.json` and update the deployed backend's shipped fallback
   snapshot (`apps/studio-service/src/studio-models.json`) in the coordinated release.
5. Validate both JSON files match and verify capability coverage. Commit the
   configuration first, then release the backend snapshot.

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

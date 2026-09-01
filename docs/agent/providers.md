# Provider wire contracts

The load-bearing details of talking to each provider shape. Read this when a task touches
`src/modules/providers/` adapters, streaming, tool results, or model lists.

- **Anthropic rejects consecutive same-role messages.** Tool results go back as ONE user
  message with N `tool_result` blocks; OpenAI expands to N separate `role: "tool"`
  messages. The shared `ChatMessage` shape is `role: "tool_results"` + `toolResults[]`;
  each adapter serializes its own way (`buildOpenAIBody` / `buildAnthropicBody` —
  exported, unit-tested).
- **Auth headers:** Anthropic reads `x-api-key`; coding-plan proxies (Kimi, Z.ai,
  QwenCloud) read `Authorization: Bearer`. The Anthropic adapter sends both.
- **Usage:** OpenAI via `stream_options: {include_usage: true}`; Anthropic via
  `message_start`/`message_delta`. Both adapters emit `{type:"usage"}` deltas. **Anthropic's
  `input_tokens` EXCLUDES cached tokens** — reads and writes come back as
  `cache_read_input_tokens`/`cache_creation_input_tokens` and the adapter sums all three.
  That sum is load-bearing, not cosmetic: the loop reads it as the run's context size
  (`needsCompaction`, and the ceiling learned from a length rejection), and a cached token
  fills the window exactly like a fresh one — unsummed, a well-cached run reports a tenth of
  its real size, auto-compaction never fires, and the run dies on a context 400. The OpenAI
  shapes count the other way (`cached_tokens` is a subset already inside the input total) and
  need no reconciling.
  All three call `logCacheUsage` (`http.ts`) — one debug line per turn, silent on a miss, and
  the only evidence prompt caching is working at all.
- **Cost is estimated, never reported.** No first-party API returns a price — only token
  counts — so `pricing.ts` holds list rates (USD/Mtok, input/output/cacheRead/cacheWrite,
  hand-maintained and dated; drift is the accepted ceiling) and `tokenCost` prices a call
  from the usage delta's cache split. The split is why the adapters carry `cacheRead`/
  `cacheWrite` on the `{type:"usage"}` delta at all: `input` stays the FULL figure (context
  size semantics above), and the slices bill at their own rates — Anthropic reads 0.1× /
  writes 1.25×; the auto-caching shapes discount only reads, per model (gpt-5-family 0.1×,
  gpt-4o 0.5×). A gateway that prices its own calls (OpenRouter `usage.cost`) rides through
  `UsageTick.cost` and wins over the table. An unknown model prices nothing — `undefined`
  means "no estimate", and every surface shows no money rather than a guessed $0.00. The
  running total lives on the run slot, stamps `RunSummary.cost` at settle, accumulates
  `ConversationMeta.spentTotal` per thread, and shows in the band, the per-run receipt line
  and the history row.
- **Prompt caching is explicit on Anthropic, automatic everywhere else.** Two `cache_control`
  breakpoints of the four the API allows: one on the **last system block** (Anthropic builds
  its prefix tools → system → messages, so it covers the tool defs above it — never mark the
  tools array, it buys nothing and spends a breakpoint), one **rolling on the tail of the
  newest message**. Both are gated on `tools.length > 0`: the agent loop is the only caller
  that sends a second turn with the same prefix, and also the only one that declares tools —
  compact, memory extract, title and skill distill answer in one shot, where a marker bills a
  1.25x write nobody reads. `system` is block-form for key auth too; a bare string cannot
  carry a marker, and that shape now reaches the coding-plan proxies. **What makes any of it
  pay is prefix stability**, which is a whole-repo invariant, not a provider one:
  `buildSystemPrompt`/`buildToolDefs` are called once at run start and carry no clock, URL or
  tab list, and `pruneResultText` trims in cliffs precisely so it stops rewriting the old end
  of the history every turn (loop.ts). Break either and caching silently turns into a 25%
  surcharge. The OpenAI shapes take no markers — they cache automatically off the same stable
  prefix above a ~1024-token minimum. OpenRouter is the one OpenAI-shape endpoint where
  "automatic" isn't enough: its default routing picks a fresh upstream host per request and the
  cache lives on that host, so the prefix re-prefilled cold every turn. When `baseUrl` is
  `openrouter.ai`, `buildOpenAIBody` pins the model's own vendor —
  `provider: {order: [slug], allow_fallbacks: true}` — via the verified vendor→slug map in
  `openai.ts` (`qwen→alibaba`, `google→google-ai-studio`: the slug is often not the prefix).
  Vendors that don't serve their own models there (`meta-llama`, `nvidia` — third-party hosting
  only) aren't on the map and keep default routing rather than a guess. `allow_fallbacks` keeps
  the pin a preference — one cold miss when the host is down, then back on. Single-host
  OpenAI-shape endpoints get no block.
- **No sampling params.** Never send temperature/topP — provider defaults always apply.
  The one knob we expose is `reasoningEffort` (`none|low|medium|high|max`, optional):
  verbatim `reasoning_effort` on OpenAI-shape; `thinking: {type:"adaptive"}` +
  `output_config: {effort}` on Anthropic-shape (`none` = adaptive only, Anthropic has no
  off switch). Unsupported levels come back as a clean provider 400, surfaced in chat — we
  never sniff model names.
- **Images are data URLs everywhere inside TabRunner**, split per wire format at the
  adapter edge. Anthropic nests image blocks inside the `tool_result` itself; an
  OpenAI-shape `role:"tool"` message is text-only, so that adapter trails a `user` message
  carrying the images. The agent loop keeps only the newest `MAX_ATTACHED_IMAGES`
  screenshots attached (every image is re-sent on every later turn); a user's own
  attachment is never pruned. Screenshots are JPEG q80 from `Page.captureScreenshot` and
  are stripped before storage — user attachments persist.
- **A run's own request body is bounded, not just its images.** Every tool result is
  re-sent on every later turn and a page snapshot is the biggest thing a run makes:
  untrimmed, twenty steps of a real page is already ~1MB of body, so a long run dies on a
  context-length 400 mid-task — the exact dead end the step budget's checkpoint exists to
  prevent. `pruneResultText` is `pruneImages`'s text sibling: newest results keep their
  payload, older ones keep their id (the wire needs one result per call) and a line
  telling the model to re-fetch. This is what makes a 500-step `MAX_STEPS` safe; the two
  must move together. It trims in **cliffs** — trips at `MAX_RESULT_CHARS`, cuts back to
  `KEEP_RESULT_CHARS` — because shaving exactly enough to sit at the ceiling rewrote a
  message every turn once saturated, and that boundary lives at the _old_ end of the history
  where a rewrite invalidates the entire cached prefix behind it. `pruneImages` keeps
  shaving on purpose: its boundary is a couple of turns back, so a rewrite there costs a
  couple of turns, not the run.
- **The ChatGPT subscription provider is a `responses` shape** (`responses.ts`), streaming
  the Codex backend's `POST {base}/responses` — it exposes no chat-completions surface.
  Auth is a Bearer access token PLUS the `ChatGPT-Account-Id` header (extracted from the
  JWT at sign-in as `OAuthCredential.chatgptAccountId`; re-extracted on refresh, so it
  never goes stale). Reasoning (`reasoning_summary_text`/`reasoning_text` deltas) is
  displayed but NEVER replayed — the backend requires it blanked. Tool results with
  screenshots use the codex-rs content-array form (`output: [{input_text, input_image}]`);
  text-only results stay a plain string. `reasoningEffort` maps to `reasoning: {effort}`
  (`none` omits the knob — codex models have no off switch).
- **Stream retry** happens in place (agent loop) with full-jitter backoff, only while
  nothing has been emitted yet — the UI never sees replayed tokens. A server's
  `retry-after` (≤ 60s) outranks the backoff guess; a longer one (a subscription 5h/weekly
  window, not a blip) makes the 429 non-retryable so the run fails fast with the reset
  time. `rate-limit.ts` reads the reset off the 429 — Anthropic's
  `anthropic-ratelimit-unified-5h/7d-utilization/-reset` headers (which also name WHICH
  subscription window bound), the RFC 3339 `anthropic-ratelimit-*-reset`, `retry-after`,
  or the codex backend's body-carried `error.resets_at`/`resets_in_seconds` (the only
  place ChatGPT discloses it; the window name — 5h/weekly/monthly — is inferred from the
  wait, but only past 10 min so a per-minute throttle never gets a fake window label) —
  and the error lead says when it actually resets instead of "try again in a moment".
- **Subscription usage endpoints** (`usage.ts`, all unofficial/undocumented — parsers omit
  windows they can't read): Claude `GET api.anthropic.com/api/oauth/usage` (Bearer +
  `anthropic-beta: oauth-2025-04-20`; `{five_hour, seven_day: {utilization, resets_at}}`),
  ChatGPT `GET chatgpt.com/backend-api/wham/usage` (Bearer + `ChatGPT-Account-Id`;
  `rate_limit.primary_window` = 5h, `secondary_window` = weekly, `used_percent` +
  `plan_type`), Kimi `GET api.kimi.ai/coding/v1/usages` (Bearer; `limits[0].detail` = 5h,
  `usage` = weekly, numbers as strings, `resetTime` RFC 3339). Only the OAuth presets have
  one (`supportsUsage`); keyed variants don't. The panel's gauge icon (between the model
  and effort selects) fetches lazily on popover open, cached 60s — these endpoints are
  rate-sensitive.
- **Stop is not an error.** User abort is normal control flow: the loop ends with `done`,
  never a red bubble. The `done` event carries the model's final summary — on tool-only
  final turns it IS the answer, so the panel renders it when no text was streamed.
- **Model lists are live, presets are fallback.** `listModels` (`models.ts`) reads
  `GET {base}/v1/models` (Anthropic-shape) or `GET {base}/models` (OpenAI-shape, non-chat
  ids filtered). `ProviderConfig.model` is optional — absent means auto, resolved at run
  start by `resolveProviderModel`: persisted choice → newest listed (by `created`) →
  preset's first → clear error. QwenCloud has no list route; that's why presets keep model
  ids at all. The ChatGPT backend (responses shape) has NO list route either —
  `listModels` short-circuits to `[]`, so the preset models ARE the picker's list.
  Endpoints that ship a human label (Anthropic `display_name`, OpenRouter `name`) get it
  in `ModelInfo.name` and the picker shows it; the id stays the value on the wire and in
  the tooltip. Model and effort are per-task choices in the side-panel header selects,
  persisted per provider — never asked for at provider-setup time (the key doesn't exist
  yet, so the list can't be fetched there). The "Auto" option renders the model it
  currently resolves to, tagged with an `Auto` chip. A listing that reports its window
  (`context_length`, `max_context_length`, `context_window`) lands in
  `ModelInfo.contextLength` and feeds `context-window.ts` — one rung below ceilings
  learned from real rejections, one above the 200k default.

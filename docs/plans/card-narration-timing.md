# Card scenes: `duration_ms` or `wait_for_narration` + optional `wait_after`

## Context

Card scenes (`type: card`) are styled title/ending/credits slates. Today a card's on-screen
time is `duration_ms` (default 4000), and if the card names a voiceover via `clip`, the hold
time auto-extends to `max(duration_ms, clipDuration + 400ms lead + 800ms tail)`. The 800ms
trailing pad is a hardcoded constant (`NARRATION_TAIL_MS` in [cards.ts:11](src/cards.ts#L11)) —
authors can't control it, and cards have no `wait_for_narration`/`wait_after` fields, unlike
browser steps ([types.ts:27-31](src/types.ts#L27-L31)) which do.

Goal: let a card be timed the same two ways a browser step already is — a fixed `duration_ms`,
**or** `wait_for_narration` (hold until a narration clip finishes) with an optional `wait_after`
trailing pause. `wait_for_narration` is a **clip-ID string** (matching browser-step convention):
the named clip is both the card's voiceover and what the hold waits for. Per the user's decision,
`duration_ms` acts as a **floor** — the effective hold is `max(duration_ms, narration + lead + wait_after)`.

This is purely additive and backward compatible: existing cards using `clip` + `duration_ms`
behave exactly as before (`wait_after` defaults to the current 800ms tail).

## Behavior model

A card's voiceover/narration clip = `wait_for_narration ?? clip` (whichever is set).

- **Fixed:** `duration_ms` only, no narration → holds exactly `duration_ms`.
- **Narration:** `wait_for_narration: some_clip` (or legacy `clip:`) → holds
  `max(duration_ms, narrationDurationMs + LEAD(400) + tail)`, where `tail = wait_after ?? 800`.
- A card may set **either** `clip` **or** `wait_for_narration`, not both (validation error) —
  they are two names for the same voiceover slot; `wait_for_narration` is the preferred field.
- `wait_after` (optional, ms) makes the previously-hardcoded 800ms tail authorable. It only
  affects cards that have narration.

## Changes

### 1. Schema — [src/types.ts](src/types.ts)
In `cardSceneSchema` ([types.ts:116-145](src/types.ts#L116-L145)) add:
- `wait_for_narration: z.string().optional()` — narration clip ID; serves as voiceover and
  gates the hold time.
- `wait_after: z.number().nonnegative().optional()` — trailing pad (ms) after narration;
  falls back to the built-in 800ms tail.
- Update the `duration_ms` doc comment to describe it as the floor / minimum hold.

In the `superRefine` card branch ([types.ts:227-234](src/types.ts#L227-L234)):
- Validate `wait_for_narration` references a known clip ID (mirror the browser-step check at
  [types.ts:245-251](src/types.ts#L245-L251)).
- Add an error if both `clip` and `wait_for_narration` are set on the same card
  ("set either `clip` or `wait_for_narration`, not both").

### 2. Duration computation — [src/cards.ts](src/cards.ts)
In `cardDurationMs` ([cards.ts:17-20](src/cards.ts#L17-L20)) use the authorable tail:
`const tail = card.wait_after ?? NARRATION_TAIL_MS;` and use `tail` in place of the constant.
Signature unchanged; `wait_after` is read off the card. Existing behavior preserved when
`wait_after` is unset.

### 3. Narration lookup — [src/runner.ts](src/runner.ts)
At [runner.ts:225](src/runner.ts#L225) resolve the clip from either field:
```ts
const clipId = card.wait_for_narration ?? card.clip;
const narration = clipId ? manifest.get(clipId) : undefined;
```
Everything downstream (`cardDurationMs`, `composeCardSegment`) already consumes `narration`
unchanged.

### 4. Tests
- [src/__tests__/cards.test.ts](src/__tests__/cards.test.ts) `cardDurationMs` block: add a case
  proving `wait_after` overrides the 800ms tail (e.g. `wait_after: 2000` extends the hold), and
  that the default tail still applies when `wait_after` is unset.
- [src/__tests__/types.test.ts](src/__tests__/types.test.ts): add parse coverage for a card with
  `wait_for_narration` + `wait_after`; assert validation errors for (a) `wait_for_narration`
  referencing an unknown clip and (b) a card that sets both `clip` and `wait_for_narration`.

### 5. Docs & example
- [README.md](README.md) card section ([README.md:328-378](README.md#L328-L378)): add
  `wait_for_narration` and `wait_after` rows to the fields table, note that `duration_ms` is a
  floor, and clarify `clip` vs `wait_for_narration` are mutually exclusive.
- [examples/smoke.demo.yaml](examples/smoke.demo.yaml): update one card (e.g. the `title` card at
  lines 37-44) to demonstrate `wait_for_narration` + `wait_after` instead of `clip` + `duration_ms`.

## Verification

1. `npm run build` (tsc) — confirms the Zod/TS types compile.
2. `npm test` (vitest) — the new + existing `cards.test.ts` / `types.test.ts` cases pass.
3. Parse check: run the pipeline parse on the updated `examples/smoke.demo.yaml` and confirm it
   validates; then run a card-only compose (the runner logs `segment i: card "title" (... Nms)`)
   and confirm the reported duration reflects `max(duration_ms, narration + 400 + wait_after)`.
4. Negative check: temporarily set both `clip` and `wait_for_narration` on a card and a bogus
   `wait_for_narration` clip id; confirm each produces the expected validation error at parse time.

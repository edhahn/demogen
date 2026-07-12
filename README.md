# demogen

Automated product demo recordings driven by a YAML script. Each demo is a Playwright browser session with synchronized narration audio, composed into a final MP4.

```
YAML script  ─►  TTS narration  ─►  build segments        ─►  concat + music  ─►  demo.mp4
                 (cached by hash)    (browser recordings +      (stream-copy +
                                      rendered card slates)      music bed)
```

## Install

```bash
npm install demogen
# or
pnpm add demogen
```

`demogen` ships with `@playwright/test` as a runtime dependency. After install, pull the Chromium binary:

```bash
npx playwright install chromium
```

## Prerequisites

- **Node.js 20+**
- **ffmpeg** with `ffprobe` — `brew install ffmpeg`
- A TTS provider — see [TTS configuration](#tts-configuration) below. Defaults to macOS `say`; switch to ElevenLabs or OpenAI for higher-quality narration.

## Quick start

```bash
# Record a public-page demo
npx demogen ./scripts/smoke.demo.yaml

# Watch the browser while recording
npx demogen ./scripts/smoke.demo.yaml --headed

# Override the base URL
npx demogen ./scripts/smoke.demo.yaml --base-url http://localhost:5173

# Skip re-generating narration (uses cached .wav files)
npx demogen ./scripts/smoke.demo.yaml --skip-narration
```

Output is written to `<outDir>/output/<demo-name>.mp4`. By default `<outDir>` is `./demos` next to the YAML file; override with `--out-dir`. See [Directory layout](#directory-layout) for how to point individual subdirectories elsewhere.

## CLI flags

| Flag | Description |
|------|-------------|
| `--skip-narration` | Reuse existing narration clips. |
| `--skip-composition` | Stop after recording the `.webm` (no audio overlay). |
| `--headed` | Run the browser headed (visible). |
| `--base-url <url>` | Override the recording base URL. |
| `--out-dir <path>` | Base dir for generated content (default: `./demos` next to script). |
| `--interstitial-dir <p>` | Override interstitial dir (default: `<out-dir>/interstitial`). |
| `--output-dir <path>` | Override final output dir (default: `<out-dir>/output`). |
| `--voices <path>` | Path to `voices.yml` (default: `./voices.yml` in cwd). |
| `--env <path>` | Path to a `.env` file to load (default: `./.env.demogen` if present). |
| `--open` | Open the output in the system default player when done. |

## Configuring with `.env.demogen`

At startup, demogen loads `./.env.demogen` (or the file passed to `--env`) and applies its `KEY=value` lines to `process.env` *without* overriding anything already exported in your shell. This keeps API keys and provider config out of your demo YAML and out of your shell rc files.

```bash
cp .env.demogen.example .env.demogen
# edit .env.demogen — uncomment and fill in the vars you need
demogen ./demos/source/smoke.demo.yaml
```

The example file at [`.env.demogen.example`](.env.demogen.example) documents every supported variable. Any of the env vars in the table below can live in `.env.demogen`. **Do not commit your real `.env.demogen`** — add it to `.gitignore`.

To load a different file: `demogen ./script.yaml --env ./envs/prod.env`. An explicit `--env` path that doesn't exist is an error; the implicit `./.env.demogen` default is silently skipped if absent.

## Environment variables

| Var | Default | Description |
|-----|---------|-------------|
| `DEMOGEN_BASE_URL` | — | Base URL (overridden by `--base-url`). |
| `DEMOGEN_OUT_DIR` | `./demos` | Base dir for generated content. |
| `DEMOGEN_INTERSTITIAL_DIR` | `<out>/interstitial` | Override interstitial dir. |
| `DEMOGEN_OUTPUT_DIR` | `<out>/output` | Override final output dir. |
| `DEMOGEN_VOICES` | `./voices.yml` | Path to the voices map file. |
| `DEMOGEN_TTS_SERVICE` | `say` | `say` (macOS), `elevenlabs`, `openai`, or `kokoro`. |
| `ELEVENLABS_API_KEY` | — | Required when `DEMOGEN_TTS_SERVICE=elevenlabs`. |
| `ELEVENLABS_VOICE_ID` | — | Fallback voice when no `voices.yml` mapping exists. |
| `OPENAI_API_KEY` | — | Required when `DEMOGEN_TTS_SERVICE=openai`. |
| `OPENAI_VOICE` | `nova` | Fallback voice (`alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`). |
| `OPENAI_TTS_MODEL` | `tts-1` | OpenAI TTS model — use `tts-1-hd` for higher fidelity. |
| `KOKORO_BASE_URL` | `http://localhost:8880/v1` | Kokoro-FastAPI base URL (used when `DEMOGEN_TTS_SERVICE=kokoro`). |
| `KOKORO_VOICE` | `af_heart` | Fallback voice when no `voices.yml` mapping exists. |
| `KOKORO_MODEL` | `kokoro` | Model name sent to the Kokoro server. |
| `KOKORO_API_KEY` | — | Optional bearer token, if your Kokoro endpoint is gated. |

## TTS configuration

demogen supports four TTS providers. Pick one by setting `DEMOGEN_TTS_SERVICE`:

### `say` (macOS, default)

No setup beyond having the `say` binary. Voice names in your YAML (e.g. `Samantha`) map to the macOS system voices — list them with `say -v ?`.

### `elevenlabs`

Add to `.env.demogen` in the directory you run `demogen` from:

```dotenv
DEMOGEN_TTS_SERVICE=elevenlabs
ELEVENLABS_API_KEY=sk_...
# Optional: fallback voice for any clip that doesn't have a voices.yml entry
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
```

### `openai`

Add to `.env.demogen` in the directory you run `demogen` from:

```dotenv
DEMOGEN_TTS_SERVICE=openai
OPENAI_API_KEY=sk-...
# Optional
OPENAI_VOICE=nova           # alloy | echo | fable | onyx | nova | shimmer
OPENAI_TTS_MODEL=tts-1-hd   # default: tts-1
```

### `kokoro` (local, self-hosted)

Run [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) locally — it serves
an OpenAI-compatible speech endpoint, so narration is generated on your machine with
no API key or per-call cost. For example:

```sh
docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest   # or the -gpu image
```

Then add to `.env.demogen` in the directory you run `demogen` from:

```dotenv
DEMOGEN_TTS_SERVICE=kokoro
# Optional — defaults shown
KOKORO_BASE_URL=http://localhost:8880/v1
KOKORO_VOICE=af_heart       # e.g. af_heart, af_bella, am_michael
KOKORO_MODEL=kokoro
# KOKORO_API_KEY=...        # only if your endpoint is gated
```

### `voices.yml` — friendly voice names

Keep your demo YAML readable by referring to voices by friendly name (`Samantha`, `Daniel`) and mapping those to provider-specific IDs in a `voices.yml` file. demogen looks for it at `--voices <path>`, then `DEMOGEN_VOICES`, then `./voices.yml` in the current working directory.

```yaml
# voices.yml
default: Samantha            # used when a script/clip doesn't specify a voice
elevenlabs:
  Samantha: 21m00Tcm4TlvDq8ikWAM   # ElevenLabs voice_id from your dashboard
  Daniel: onwK4e9ZLuTAKqWW03F9
openai:
  Samantha: nova                   # one of alloy|echo|fable|onyx|nova|shimmer
  Daniel: onyx
say:
  # Optional. macOS `say` already uses voice names natively.
  Samantha: Samantha
```

In your demo script, reference the friendly name:

```yaml
narration:
  voice: Samantha          # resolved via voices.yml for the active service
  rate: 175
  clips:
    - id: welcome
      text: "Welcome to the demo."
      voice: Daniel        # per-clip override (also resolved via voices.yml)
```

If a friendly name has no entry under the active service, demogen passes the name through as-is — useful for `say` and for cases where you want to put a raw provider voice ID directly in the YAML.

Voice resolution order for any clip:

1. Clip-level `voice:` (if set)
2. Script-level `narration.voice` (if set)
3. `default:` from `voices.yml`
4. `"Samantha"` (built-in fallback)

The resolved friendly name is then looked up in the active service's block.

A complete example lives at [`examples/voices.yml`](examples/voices.yml).

## Directory layout

By default demogen writes everything under `./demos/` next to your script:

```
./demos/
├── source/                 # your demo .yaml scripts (informational; not enforced)
├── interstitial/
│   ├── narration/<demo>/   # .wav/.mp3 clips + .hash cache files
│   └── recordings/<demo>/  # raw Playwright .webm recording
└── output/                 # final <demo>.mp4
```

Override the whole tree with `--out-dir` / `DEMOGEN_OUT_DIR`, or relocate individual subtrees with `--interstitial-dir` / `--output-dir` (or their env equivalents). The `source/` folder is a convention for organizing your scripts — demogen reads from whatever path you pass on the CLI.

## Writing a demo script

```yaml
meta:
  name: my-feature          # kebab-case — becomes the output filename
  description: "What this demo shows"
  feature: dashboard        # optional tag

base_url: http://localhost:3000   # optional — overridden by --base-url / DEMOGEN_BASE_URL

auth:
  role: admin               # optional — passed to setupAuth callback (see below)

output:
  resolution: { width: 1280, height: 720 }
  quality: high             # high | medium

narration:
  voice: Samantha           # friendly name; resolved via voices.yml per active TTS service
  rate: 175                 # words per minute (used by `say`; ignored by elevenlabs/openai)
  clips:
    - id: welcome           # snake_case ID referenced by steps
      text: "Welcome to the dashboard."

scenes:
  - id: intro               # snake_case scene ID
    steps:
      - action: narrate
        clip: welcome

      - action: goto
        value: /home
        wait_for_narration: welcome   # block until clip finishes speaking
        wait_after: 2000              # ms to pause after the action
```

### Step actions

All steps share these optional fields: `wait_after` (ms after action, default 1000), `wait_for_narration` (clip ID to wait on before executing), `description`.

| Action | Required fields | Notes |
|--------|----------------|-------|
| `narrate` | `clip` | Records the timestamp where the named audio clip starts. No audio plays during recording — it's mixed in by ffmpeg. |
| `goto` | `value` | URL path or full URL. |
| `click` | `selector` | Cursor animates to the target before clicking. |
| `fill` | `selector`, `value` | |
| `press` | `value` | Keyboard key (e.g. `Enter`, `Tab`). |
| `hover` | `selector` | |
| `scroll` | `value` | `up`, `down`, or a pixel amount like `300`. |
| `wait` | `condition` | `selector` (+ `selector`), `timeout` (+ `timeout` ms), or `networkidle`. |

### Timing narration to browser actions

The pipeline records narration audio first, then records the browser, then composes them together. `wait_for_narration` is how you keep them in sync.

```yaml
# Narrate, then act
- action: narrate
  clip: explain_feature

- action: goto
  value: /some-page
  wait_for_narration: explain_feature
  wait_after: 1000

# Hold at end until the closing clip finishes
- action: narrate
  clip: closing

- action: wait
  condition: timeout
  timeout: 2000
  wait_for_narration: closing
```

## Card scenes (title / ending / credits)

A scene can be a **card** instead of a browser recording — a styled slate for a
title, closing, or credits screen. Cards are rendered from HTML in the same
headless Chromium, screenshotted, and turned into a video segment. Add one as an
entry in the `scenes` list with `type: card`; place it anywhere. Contiguous
browser scenes on either side are recorded separately and concatenated around
the card.

```yaml
scenes:
  - type: card
    id: title              # snake_case scene ID
    kind: title            # title | ending | credits — styling/semantics hint
    headline: "Acme Dashboard"
    subtitle: "A 90-second tour"    # optional
    clip: title_vo         # optional voiceover — a narration clip ID
    duration_ms: 4000      # min hold time; a longer voiceover extends it
    fade: true             # fade in/out to black (default true)

  - id: intro              # a normal browser scene
    steps:
      - action: goto
        value: /home

  - type: card
    id: credits
    kind: credits
    headline: "Thanks for watching"
    lines:                 # stacked lines, handy for credits
      - "Built with demogen"
      - "github.com/edhahn/demogen"
    background: "#0b1220"  # optional CSS color or gradient
    duration_ms: 5000
```

| Field | Required | Notes |
|-------|----------|-------|
| `type` | yes | Must be `card`. |
| `id` | yes | snake_case scene ID. |
| `headline` | yes | Main line. |
| `kind` | no | `title` \| `ending` \| `credits` (default `title`) — styling hint only. |
| `subtitle` | no | Secondary line under the headline. |
| `lines` | no | List of smaller lines (credits). |
| `background` | no | CSS color/gradient (default dark). |
| `duration_ms` | no | Minimum on-screen time (default 4000). A `clip` voiceover extends it. |
| `clip` | no | Narration clip ID for an optional voiceover. |
| `fade` | no | Fade in/out to black (default true). |

A card's `clip` refers to an entry in `narration.clips`, exactly like a `narrate`
step — define the spoken text there and reference it by ID.

## Background music

Add an optional `music` block to lay a looping music bed under the entire video
(narration and cards included). The track is looped to cover the timeline,
volume-scaled, optionally faded, and trimmed to length.

```yaml
music:
  path: ./assets/bg.mp3   # resolved relative to the demo script's directory
  volume: 0.15            # 0..1 mix gain (default 0.15)
  fade_in_ms: 1000        # optional
  fade_out_ms: 2000       # optional
```

No royalty-free track handy? Generate a quick test tone:

```bash
ffmpeg -f lavfi -i "sine=frequency=220:duration=30" -y assets/bg.mp3
```

## Programmatic API

```ts
import { runDemoPipeline } from "demogen";

await runDemoPipeline("./scripts/my-demo.demo.yaml", {
  baseURL: "http://localhost:3000",
  headless: true,
  setupAuth: async ({ role, baseURL, headless }) => {
    // Bootstrap auth in a hidden browser context, write storageState to disk,
    // and return the path. demogen loads it into the recording context so
    // the demo starts already authenticated.
    return "/path/to/storageState.json";
  },
});
```

See [`examples/programmatic.ts`](examples/programmatic.ts) for a fuller example.

### Auth bootstrap

If your script declares `auth.role`, you must pass `setupAuth`. The callback receives `{ role, baseURL, headless }` and must return an absolute path to a Playwright [storageState](https://playwright.dev/docs/auth#reuse-signed-in-state) JSON file. demogen loads that file into the recording context, so the demo starts pre-authenticated and the login UI never appears in the recording.

A typical implementation:

```ts
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const setupAuth = async ({ role, baseURL, headless }) => {
  const storageStatePath = join(tmpdir(), `demogen-auth-${role}.json`);
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    // Drive whatever login flow your app needs — email/password, magic link,
    // a /api/test-session route that mints a session cookie, etc.
    await loginAs(page, role);
    await context.storageState({ path: storageStatePath });
  } finally {
    await context.close();
    await browser.close();
  }
  return storageStatePath;
};
```

## Pipeline stages

```
1. Parse & validate YAML  (zod schema)
2. Generate narration audio (cached by content hash)
3. Build segments: record each browser run → .webm → .mp4, render each card → .mp4
4. Concatenate segments in order, then mix in optional background music → .mp4
```

Because a card scene can sit between browser scenes, demogen records each
contiguous run of browser scenes as its own segment and concatenates them with
the rendered card segments — rather than producing one continuous recording.

See [Directory layout](#directory-layout) for where each pipeline stage writes its output.

> **Note:** `recordDemo` now takes the list of browser scenes to record as its
> second argument — `recordDemo(script, scenes, manifest, outDir, opts)` — since
> the runner calls it once per browser segment. Most users go through
> `runDemoPipeline` and are unaffected.

## Cursor overlay

By default demogen renders a synthetic cursor overlay on top of the page so viewers can see where clicks happen. Configure via the `cursor` block in your YAML:

```yaml
cursor:
  enabled: true
  travelMs: 500          # how long cursor moves take
  steps: 15              # smoothness of cursor path
  showClickRipple: true  # ripple animation on click
```

## License

MIT

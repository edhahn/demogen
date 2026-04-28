# demogen

Automated product demo recordings driven by a YAML script. Each demo is a Playwright browser session with synchronized narration audio, composed into a final MP4.

```
YAML script  ─►  TTS narration  ─►  Playwright recording  ─►  ffmpeg compose  ─►  demo.mp4
                 (cached by hash)    (narration-aware timing)   (adelay + amix)
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
- **macOS** if using the default `say` TTS, OR set `DEMOGEN_TTS_SERVICE=elevenlabs` with `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID`

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

Output is written to `<outDir>/output/<demo-name>.mp4`. By default `<outDir>` is `./demogen-out` next to the YAML file; override with `--out-dir`.

## CLI flags

| Flag | Description |
|------|-------------|
| `--skip-narration` | Reuse existing narration clips. |
| `--skip-composition` | Stop after recording the `.webm` (no audio overlay). |
| `--headed` | Run the browser headed (visible). |
| `--base-url <url>` | Override the recording base URL. |
| `--out-dir <path>` | Override the output directory root. |
| `--open` | Open the output in the system default player when done. |

## Environment variables

| Var | Default | Description |
|-----|---------|-------------|
| `DEMOGEN_BASE_URL` | — | Base URL (overridden by `--base-url`). |
| `DEMOGEN_TTS_SERVICE` | `say` | `say` (macOS) or `elevenlabs`. |
| `ELEVENLABS_API_KEY` | — | Required when `DEMOGEN_TTS_SERVICE=elevenlabs`. |
| `ELEVENLABS_VOICE_ID` | — | Required when `DEMOGEN_TTS_SERVICE=elevenlabs`. |

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
  voice: Samantha           # macOS voice name (ignored for elevenlabs)
  rate: 175                 # words per minute
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
3. Record browser with narration-aware timing → .webm
4. Compose: ffmpeg mixes audio into video → .mp4
```

Intermediate files live under `<outDir>/`:
- `narration/<demo-name>/` — `.wav`/`.mp3` clips + `.hash` cache files
- `recordings/<demo-name>/` — raw Playwright `.webm` recording
- `output/` — final `.mp4`

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

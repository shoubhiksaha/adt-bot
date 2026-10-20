# Third-party code

ADT Bot includes code adapted from these projects. Their licenses are kept next to the code.

| Project | License | Where | What |
| --- | --- | --- | --- |
| [OpenBOT](https://github.com/ashhart/OpenBot) | MIT, © 2026 OpenBOT contributors | `src/lib/agent/vendor/openbot/` and files marked "Adapted from OpenBOT" | Tool-call parsing, text tool protocol, approval policy, memory filter, cron, charts and rich cards, kanban model, coding-agent supervision, macOS control |
| [CopilotKit OpenBot](https://github.com/CopilotKit/OpenBot) | MIT, © 2026 CopilotKit | `src/lib/agent/vendor/copilotkit/`, `src/lib/mcp/` | Untrusted-content envelope, routine firing frame, MCP client limits |
| [Synara](https://github.com/Emanuele-web04/synara) (via OpenBOT) | MIT, © 2026 T3 Tools Inc., © 2026 Emanuele | `electron/features/50-cli-agents.cjs` | Parts of the CLI-agent process supervision |
| [QR Code generator library](https://www.nayuki.io/page/qr-code-generator-library) | MIT, © Project Nayuki | `server/qr.mjs` | QR encoding algorithm and tables (rewritten, reduced) |
| [IBM Plex](https://github.com/IBM/plex) | SIL OFL 1.1, © 2017 IBM Corp. | `public/fonts/` (`OFL-IBMPlex.txt`) | Brand typeface (IBM Plex Sans, IBM Plex Mono) |
| [Space Grotesk](https://github.com/floriankarsten/space-grotesk) | SIL OFL 1.1, © 2020 The Space Grotesk Project Authors | `public/fonts/` (`OFL-SpaceGrotesk.txt`) | Brand display typeface |
| [Rakazo](https://github.com/elie222/rakazo) | Apache-2.0 | Design tokens, model catalog | |

No code from nightly-labs/openbot (PolyForm Noncommercial) is included; only ideas (for example the
Status / Result / Evidence / Unblock report format) were re-implemented. If any is added later it must go under
`src/vendor-nc/` or `electron/features/nc-*` and be removed before commercial use.

## Bundled libraries with their own licenses

Only loaded when Kokoro is the chosen reply voice (a separate chunk, `assets/kokoro-*.js`, started from
`src/lib/kokoro-tts.worker.ts`); nothing from it is in the main bundle.

| Library | License | What |
| --- | --- | --- |
| [kokoro-js](https://github.com/hexgrad/kokoro/tree/main/kokoro.js) by hexgrad | Apache-2.0 | Runs the Kokoro voice model (text normalisation, phonemes to speech) |
| [phonemizer](https://github.com/xenova/phonemizer.js) by Xenova | Apache-2.0 (wrapper) | Text to phonemes for Kokoro |
| [eSpeak NG](https://github.com/espeak-ng/espeak-ng), compiled into phonemizer | GPL-3.0-or-later | The phonemizer's engine and pronunciation data. Its source is at the link; the app's owner has approved this GPL dependency |

## Models downloaded at run time

These aren't bundled with the app; they download on first use and are cached on the device.

| Model | License | Used for |
| --- | --- | --- |
| [Supertonic TTS](https://huggingface.co/onnx-community/Supertonic-TTS-ONNX) by Supertone ([source](https://github.com/supertone-inc/supertonic)) | OpenRAIL-M (model; use-based restrictions apply), MIT (sample code) | "Natural, on this device" reply voice (`src/lib/local-tts.worker.ts`) |
| [Smart Turn v3.2](https://huggingface.co/pipecat-ai/smart-turn-v3) by Pipecat (8-bit CPU model, and the full-precision model on the GPU) | BSD-2-Clause | End-of-turn detection in voice mode |
| [Silero VAD](https://github.com/snakers4/silero-vad) | MIT | Voice activity detection |
| [Whisper](https://github.com/openai/whisper) (ONNX by onnx-community) | MIT | On-device speech recognition |
| [Moonshine](https://github.com/moonshine-ai/moonshine) by Useful Sensors ([ONNX](https://huggingface.co/onnx-community/moonshine-base-ONNX) by onnx-community) | MIT | On-device speech recognition for English (optional, Settings → Voice) |
| [Moonshine streaming tiny](https://huggingface.co/moonshine-ai/moonshine-streaming-tiny) by Moonshine AI (Useful Sensors) ([ONNX](https://huggingface.co/Masterx/moonshine-streaming-tiny-ONNX) by Masterx) | MIT | Live captions while you talk, English (`src/lib/caption.worker.ts`) |
| [Supertonic 3](https://huggingface.co/Supertone/supertonic-3) by Supertone ([source](https://github.com/supertone-inc/supertonic), archived) | OpenRAIL-M (model; its use-based restrictions apply and are passed on to users, including no impersonation without consent and no passing off speech as human), MIT (sample code the worker follows) | "Supertonic 3" on-device reply voice in 31 languages (`src/lib/supertonic3.worker.ts`) |
| [Granite Embedding 97M Multilingual R2](https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2) by IBM ([ONNX](https://huggingface.co/onnx-community/granite-embedding-97m-multilingual-r2-ONNX) by onnx-community) | Apache-2.0 | "Smarter memory search" (optional, Settings → Workspace; `src/lib/embed.worker.ts`) |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad ([ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) by onnx-community) | Apache-2.0 | "Kokoro" on-device reply voice (`src/lib/kokoro-tts.worker.ts`) |

## Bundled in the desktop app (auto-update)

| Package | License |
| --- | --- |
| electron-updater 6.8.10 | MIT |
| builder-util-runtime 9.7.0 | MIT |
| js-yaml | MIT |
| argparse | Python-2.0 |
| fs-extra | MIT |
| graceful-fs | ISC |
| jsonfile | MIT |
| universalify | MIT |
| semver | ISC |
| lazy-val | MIT |
| lodash.isequal | MIT |
| lodash.escaperegexp | MIT |
| tiny-typed-emitter | MIT |
| debug | MIT |
| ms | MIT |
| sax | BlueOak-1.0.0 |

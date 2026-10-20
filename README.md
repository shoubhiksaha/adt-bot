# ADT Bot

Your own AI assistant that works with **any provider**, **local models** or **your own private server**, on
**web, macOS, Windows, Linux, Android and iOS**. It does Grok-style live web search, thinking, image creation,
file reading and memory, all with whichever model you choose. Everything is stored on your device.

It is a lightweight, serverless take on [Rakazo](https://github.com/elie222/rakazo) (Apache-2.0). It keeps
Rakazo's core ideas: persistent bots with their own personality, memory and history, bring-your-own models,
and one product on every surface. It also reuses Rakazo's design tokens and model catalog. There is no
database or server stack to run.

## ADT Bot compared with Grok

| | Grok | ADT Bot |
| --- | --- | --- |
| Models | xAI's Grok models | Any: Grok, GPT, Claude, Gemini, DeepSeek, Llama, Qwen, Mistral, 300+ via OpenRouter, or your own local and private models |
| Runs offline / locally | No | Yes, with Ollama, LM Studio, llama.cpp, vLLM and more (auto-detected) |
| Your data | Stored by xAI | Stays on your device; private chats are never saved |
| Live web search with sources | Yes | Yes, for every model: the provider's built-in search (Gemini, Claude, OpenRouter, Perplexity), or ADT Bot's own search (free, Brave, Tavily or self-hosted SearXNG) |
| Think mode | Yes | Yes (reasoning effort for OpenAI-style, Claude, Gemini and DeepSeek models; shows the thought process) |
| Image creation | Yes | Yes, via OpenRouter, OpenAI, xAI, Gemini or any `/images/generations` server |
| Reads PDFs, documents, code, links | Yes | Yes: PDFs, text and code files, images, and any link you paste |
| Personalities | A few built-in modes and companions | Unlimited bots, each with its own personality, model and memory |
| Voice | Yes | Hands-free voice mode with wake word (“Hey <nickname>”), voice commands, interrupting, live captions, natural voices (OpenAI, ElevenLabs, Fish Audio, Cartesia, Deepgram, Sarvam, Google, Azure, self-hosted Kokoro, or any voice API you add) or free device voices, on every platform |
| Your company's look | No | Your name, logo and theme, imported from a logo, brand guide, CSS file or website |
| Knows your business | Limited | “About us”, custom instructions and knowledge files (PDF, Word, Markdown, HTML…), shared or per bot |
| Price | Free tier with limits; subscriptions for more | Free app; pay your provider per use, or nothing with local models |

## Features

- **Any provider**: xAI (Grok), OpenAI, Anthropic (Claude), Google Gemini, OpenRouter (300+ models), Groq,
  DeepSeek, Mistral, Together, Fireworks, Cerebras, Perplexity, Moonshot (Kimi), NVIDIA NIM and Hugging Face.
  Any other OpenAI- or Anthropic-compatible endpoint (Azure, gateways…) also works.
- **Local LLMs**: Ollama, LM Studio, llama.cpp server, vLLM, Jan, LocalAI, KoboldCpp, GPT4All,
  text-generation-webui and llamafile. Servers running on your computer are **detected automatically**:
  one click and you're chatting. Every installed model shows up in the model switcher.
- **Private / self-hosted servers**: a model server on another machine, your LAN, a VPN (Tailscale, WireGuard)
  or a company network. Open WebUI, LiteLLM, or any OpenAI-compatible server (vLLM, TGI, SGLang, Ollama…).
  It supports API keys and **extra headers** for servers behind a login (Basic auth, Cloudflare Access, etc.).
- **Search · Think · Imagine** toggles under the message box, plus `/search`, `/imagine` and `/remember`.
  Answers cite numbered sources you can click.
- **Attachments**: images (for vision models), PDFs, and text or code files. Paste, drag and drop, or use the paperclip.
- **Bots and memory**: ADT (witty and direct), Assistant, Coder, Tutor and Writer presets, or make your own.
  Bots remember facts you tell them; you can edit memory in bot settings. **Custom instructions** apply to every bot.
- **Chats**: grouped by date, searchable (⌘/Ctrl+K), renameable, with automatic smart titles. Private chats
  (the eye icon) are never saved. Export any chat as Markdown.
- Streaming replies with a live thought process, syntax-highlighted code with copy buttons, edit and resend,
  regenerate, retry, stop (Esc), response time and speed, a jump-to-latest button, and dark and light themes.
- Backup and restore everything as a JSON file (with or without keys).

## Bots that act: tools, computers and teams

Bots can do things as well as talk. Turn it on or off, and choose what needs your approval, in
**Settings → Tools & safety**. Each bot can be limited to certain tool groups in its own settings.

- **Tool use with every model**: native tool calling for OpenAI-style, Claude and Gemini models. For local
  models without it, a text protocol is used, and calls a model prints as plain JSON (common with Llama 3.x)
  are caught too. Cloud models see the full tool list; local models see the everyday tools plus a
  "find tools" search, so long catalogs don't confuse them.
- **Approvals**: reading never asks; changes ask the first time (or always, or never, as you choose), with
  **Allow once / Always allow / Deny** in the chat; destructive actions always ask. A deny list blocks commands
  such as `rm -rf /` and `sudo`. Content from the web, files, connectors and room guests is marked as untrusted
  data and kept out of the system prompt. Models can still be fooled by it, so once a reply has read outside
  content, commands, file changes and new routines ask first, even with Full access. Images in replies load only
  when you click them. **⌘⇧⎋** (Ctrl+Alt+Shift+Esc elsewhere) stops every bot from any app. Every action is in
  the activity log.
- **Computer access** (desktop): three levels in **Settings → Tools & safety**.
  - **Sandbox**: bots only use the `~/ADT Bot Workspace` folder. Commands run there under an OS sandbox: macOS
    `sandbox-exec`, or `bubblewrap` on Linux (not yet on Windows). The sandbox can't read the rest of your home
    folder or shared temp folders, launch apps or connect to the network, and screen control is off. Connectors
    (MCP servers) you add run as you configured them, outside the sandbox.
  - **Restrictive** (default): the whole computer, with approvals as above.
  - **Full access**: bots control the whole computer without asking: commands, files, apps, screen, mouse and
    keyboard. Destructive actions still ask unless you turn that off, and the deny list still applies. Shared
    rooms never get more than Restrictive. Voice mode can use these tools too.
- **Charts and cards**: bar charts, stat tiles, timelines and flow diagrams inline in the chat, plus email,
  message and link cards with Copy / Open in Mail.
- **Projects (kanban boards)**: Backlog → To do → In progress → Review → Done, with labels, due dates,
  checklists and comments. Assign a card to a bot and press **Run**: it works in the background in the card's
  own chat and moves the card to Review. Bots can also create and update tasks from any chat.
- **Routines**: "every weekday at 8:00, summarise the AI news". Once, daily, weekly, every N minutes or cron,
  in any time zone, with run history, catch-up rules and notifications. Runs that find nothing new stay quiet.
  On desktop, the app can keep running in the menu bar for them.
- **Bots working together**: a bot can hand a task to another bot (`ask_bot`) and gets back a short report.
  Loop guards stop bots passing work back and forth.
- **Connectors (MCP)**: add any MCP server (remote URL with a token, or a local command on desktop) in
  **Settings → Connectors**; its tools become bot tools, and screenshots they return are shown to the model.
  One-click setups for open-source Mac-control servers: [Peekaboo](https://github.com/openclaw/Peekaboo),
  [Ghost OS](https://github.com/ghostwright/ghost-os) and
  [macOS Computer Use Kit](https://github.com/Sur-Cai/macos-computer-use-kit) (all MIT; install once with the shown
  command). Mark a connector "Controls this computer" and it follows Computer access. Tools ask before running
  unless you mark them read-only (servers' own read-only claims aren't trusted).
- **Coding agents** (desktop): bots can hand work to Claude Code, Codex, Gemini CLI, OpenCode or Aider in a
  folder you choose, and you can watch the live transcript. Claude Code (and the others) can also be picked
  as a bot's model.
- **Control your Mac** (desktop, macOS, off by default; on with Full access). Bots use apps by name, the way
  [Ghost OS](https://github.com/ghostwright/ghost-os) does: a small built-in helper reads each app's controls from
  macOS accessibility (buttons, fields, chat lists, dialogs, and web pages in Chrome, Brave or Electron apps), presses
  them even when the app is behind other windows, and types any language or emoji without touching the clipboard.
  Each action returns the updated window, so a task like "send Mom 'on my way' on WhatsApp" takes a few steps
  instead of a screenshot-and-click loop. App links (`whatsapp://send?…`, `mailto:`, Spotify, Maps, Zoom…) open
  directly. Screenshots, clicks, keys, scrolling and AppleScript are there for everything else. Buttons such as
  Delete, Pay or Sign out always ask. A "Stop" banner shows while it works, and nothing is typed while the Mac is
  locked. Needs Accessibility and Screen Recording permission (**Settings → Computer control** links to the right
  System Settings pages).
- **Each bot's own computer** (desktop): a Docker container per bot with a persistent `/workspace`,
  resource limits, and an optional "no network" switch. See **Computers** in the sidebar.
- **Rooms** (desktop): people on your network chat with each other and your bots from any browser by
  opening a link or scanning a QR code and entering a PIN. Nothing to install. Guests can't use tools that
  need approval unless you allow it.
- **Desktop tools**: run commands, read and write files (in `~/ADT Bot Workspace` by default), open
  files and links.

## Voice (hands-free, like Grok's voice mode)

Click the **sound-wave button** next to the mic for a hands-free conversation:

- **Just talk.** It detects when you've finished (on-device voice activity detection) and starts transcribing the
  moment you pause, so your words are understood in about 0.1–1 s.
- **Answers start speaking right away**, sentence by sentence as the AI writes, in short spoken-style replies.
  Claude and other reasoning models use lighter thinking in voice mode.
- **Interrupt any time** by talking (instantly with natural voices; device voices check it isn't hearing itself), by
  tapping the orb, or by pressing Space.
- **Voice commands:** “stop”, “new chat”, “switch to Coder”, “search for …”, “draw …”, “repeat that”,
  “slower”/“faster”, “goodbye”.
- **Wake word:** after a quiet spell it goes to standby. Say “Hey <nickname>” (each bot's nickname, set in bot
  settings) to continue. Turn on **Always listen** in Settings → Voice to wake it from anywhere in the app; this runs
  on your device and shows an indicator.
- Live captions, a latency badge (hover it for the breakdown), mute (M), end (Esc).

| | Listens with | Speaks with |
| --- | --- | --- |
| Chrome, Edge, Safari | The browser's recognizer | Device voice, or a natural voice |
| iPhone / iPad | iOS speech recognition | iOS voices, or a natural voice |
| Android | Android speech recognition | Android voices, or a natural voice |
| Desktop app, Firefox | Whisper on your device (77 MB once, then offline and private) | Device voice, or a natural voice |

**Natural voice on this device** (Settings → Voice → Reply voice): [Supertonic](https://huggingface.co/onnx-community/Supertonic-TTS-ONNX)
runs offline in the app (a 262 MB download once, 10 voices). It starts speaking in about 0.2–0.6 s per
sentence, much faster than the macOS voice, and you can interrupt it by talking. Kokoro's browser package wasn't
used because it bundles GPL-licensed code.

**Natural voices online** (Settings → Voice → Reply voice): any OpenAI-compatible `/audio/speech` server (OpenAI
`gpt-4o-mini-tts`, or a free self-hosted [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) server added as a
private server), ElevenLabs, Fish Audio, Cartesia or Deepgram Aura, each with your own API key. Choose
**＋ Add a voice provider…** to use any other text-to-speech API: templates fill in Sarvam AI (Indian languages),
Google Cloud and Azure, or describe any service yourself (web address, headers, a body with `{{text}}`, `{{voice}}`,
`{{model}}`, `{{speed}}`, `{{key}}`, and whether it returns audio or base64 audio in JSON). With device voices, macOS's free “Premium”/“Enhanced” voices sound much better
(System Settings → Accessibility → Spoken Content → Manage voices); the best one is picked automatically.

For the snappiest conversations, pick a fast **voice model** in Settings → Voice (e.g. Claude Haiku, Gemini Flash
or Groq) and set “Reply after you pause for” to *Short*.

## Make it yours: name, logo, theme

**Settings → Appearance**

- **App name and logo**: shown in the sidebar, welcome screen, window title and favicon. Optionally use the logo
  as the main bot's picture.
- **Match my brand**: drop a **logo**, **brand guide (PDF/Word)**, **CSS/SCSS** or **design-tokens JSON**, or type
  your **website**. The name, logo and colours are picked up automatically; click any found colour to use it. If a
  brand guide only describes colours in words (“Pantone 286 C”), **Ask AI** reads it for you.
- **Themes**: 12 presets, or your own brand colour, page colour, font and corner style. Light and dark palettes
  are generated with readable contrast.
- **Brand kit**: export your look as a file to share with colleagues. To rebrand the **installable apps** (app name,
  icons for Mac/Windows/Linux/Android/iOS, default theme), run `npm run brand your-brand-kit.json` and rebuild.

## Workspace: who you are, what the bots are for

**Settings → Workspace**

- **Your name**: bots address you by it.
- **About you, your team or company**: who you are, what you do, and what the bots should help with. Fill it in by
  hand or from a file (company profile, About page).
- **How bots should answer**: tone, length, units, language.
- **Shared knowledge**: upload documents every bot can use, such as a handbook, price list, FAQs or product docs
  (PDF, Word, Markdown, HTML, text, CSV, JSON). Small files go to the AI in full; for large ones only the passages
  relevant to each question are sent (BM25 ranking, works offline with any model). Answers show which files they used.

**Bot settings** (sliders icon → Bot settings) add a **nickname/wake word**, a **picture**, **instructions from a
file**, and **knowledge files just for that bot**.

## Adding your Anthropic (Claude) key

1. Get a key at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys).
2. On first launch, click **Anthropic (Claude)** on the welcome screen. Later, open **Settings** (bottom of the
   sidebar) → **Providers** → **Add provider** → **Anthropic (Claude)**.
3. Paste the key into **API key** and click **Connect**. ADT Bot checks the key and lists your Claude models.
4. Pick a Claude model from the model switcher at the top of any chat.

Keys are stored only on your device. Anthropic doesn't offer speech-to-text, so with Claude, voice uses your
device's recognizer or on-device Whisper. Search with Claude uses Anthropic's built-in web search.

## Using it

| To | Do |
| --- | --- |
| Get fresh, cited answers | Turn on **Search** (or start with `/search`) |
| Get deeper reasoning | Turn on **Think** (reasoning models) |
| Talk hands-free | Click the sound-wave button next to the mic (voice mode) |
| Create an image | Turn on **Imagine**, or type `/imagine a fox astronaut, watercolor` |
| Ask about a document | Attach a PDF or text/code file with the paperclip, or drag it in |
| Summarize a web page | Paste the link in your message |
| Teach a bot about you | Just tell it, or type `/remember I prefer metric units` |
| Switch models | Click the model name at the top (type to search, ↑↓ Enter) |
| Chat without saving | Click the eye icon for a private chat |
| Shortcuts | ⌘/Ctrl+K search chats · ⌘/Ctrl+Shift+O new chat · `/` focus input · Esc stop |

## Quick start

Requires Node 22+.

```bash
npm install
npm run dev          # http://localhost:5173 (hot reload, includes the provider relay)
```

Open the app, pick a provider, paste a key (or pick **Ollama (local)**), and start chatting.

### Use a local LLM

```bash
brew install ollama          # or download from https://ollama.com
ollama serve
ollama pull llama3.2         # or qwen3, deepseek-r1, gemma3, mistral, …
```

In ADT Bot, choose **Ollama (local)** → **Save provider**. The other local servers work the same way; just
start their server first. Any model you install (`ollama pull qwen3`, a GGUF loaded in LM Studio, …) appears
in the model switcher. Press **Fetch** in bot settings to refresh the list. Each bot can use a different model.

### Use a model server on another machine (private server)

1. On the server, make it listen on the network. For Ollama: `OLLAMA_HOST=0.0.0.0 ollama serve`. For vLLM:
   `vllm serve <model> --host 0.0.0.0 --api-key <optional-key>`.
2. In ADT Bot, choose **Private server (OpenAI-compatible)**. Enter its address, e.g. `http://192.168.1.50:11434`,
   `http://gpu-box.tailnet-1234.ts.net:8000` or `https://llm.mycompany.internal`. If you leave off `/v1`, it is
   added automatically.
3. If the server needs a login, paste its key, or add **Extra headers** (one per line), e.g.
   `Authorization: Basic …` or `CF-Access-Client-Id: …` / `CF-Access-Client-Secret: …`.
   Extra headers take precedence over the API key.
4. **Test connection** → **Save provider**.

Platform notes for private servers:

- **Desktop app**: reaches anything your computer can reach, including VPN-only hosts. It uses your OS
  certificate store, so a server with a company or self-signed certificate works once that certificate is
  trusted in Keychain or the Windows/Linux certificate store.
- **Web (`npm start`, bound to localhost)**: can reach any host. For a server with a self-signed certificate,
  start it with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem npm start`.
- **Web (Docker / LAN / public)**: set `ADTBOT_PROXY_PRIVATE=1` to allow private-network servers, or list
  hostnames in `ADTBOT_PROXY_HOSTS`.
- **Android/iOS**: the phone must be on the same network or VPN as the server. Plain `http` is allowed for
  this. If you publish to the App Store, Apple may ask why the app allows plain `http`; in that case use
  `https` servers and remove `NSAllowsArbitraryLoads` from `ios/App/App/Info.plist`.

## Run it everywhere

| Platform | Command | Output |
| --- | --- | --- |
| Web (dev) | `npm run dev` | http://localhost:5173 |
| Web (self-hosted) | `npm run build && npm start` | http://127.0.0.1:8787 |
| Web (Docker) | `docker build -t adt-bot . && docker run -p 8787:8787 adt-bot` | http://localhost:8787 |
| Web (static hosting) | `npm run build`, then upload `dist/` to any static host | see the CORS note below |
| Desktop app (run) | `npm run desktop` | Electron window |
| macOS installer | `npm run dist:mac` | `release/*.dmg`, `.zip` |
| Windows installer | `npm run dist:win` | `release/*.exe` (NSIS and portable) |
| Linux packages | `npm run dist:linux` | `release/*.AppImage`, `.deb` |
| Android | `npm run android` (opens Android Studio) or `npm run android:apk` | `android/app/build/outputs/apk/debug/app-debug.apk` |
| iOS | `npm run ios` (opens Xcode, then press Run) | iPhone or iPad app |
| Install as an app from the browser | Open the web version, then **Add to Home Screen** or **Install app** | PWA, works offline |

Notes:

- **Windows/Linux installers** build best on their own OS (or in CI). Building a macOS `.dmg` requires a Mac.
  Unsigned builds work; for public distribution, set up code signing
  (see [electron.build/code-signing](https://www.electron.build/code-signing)).
- **Android** needs Android Studio. If `java` is not on your PATH, use the JDK that ships with it:
  `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`.
- **iOS** needs Xcode. Choose your signing team in Xcode before running on a real device.
- After changing web code, run `npm run cap:sync` to copy it into the mobile projects.

### Self-hosting on a server or LAN

```bash
npm run build
HOST=0.0.0.0 PORT=8787 npm start
```

| Env var | Purpose |
| --- | --- |
| `HOST`, `PORT` | Where to listen (default `127.0.0.1:8787`). |
| `ADTBOT_PROXY_PRIVATE=1` | Let the relay reach model servers on private networks: LAN IPs, Tailscale/VPN, `.local`/`.internal` names, names that resolve to private IPs, and the Docker host (`host.docker.internal`). |
| `ADTBOT_PROXY_HOSTS` | Extra hosts the relay may reach, comma separated (e.g. `my-gateway.example.com,*.openai.azure.com`). |
| `ADTBOT_PROXY_ALLOW_ALL=1` | Allow any host. Only do this on a trusted network. |
| `NODE_EXTRA_CA_CERTS` | Trust a private CA, for model servers with self-signed or company certificates. |

When bound to `127.0.0.1` (the default), the relay may reach any host, but it only accepts requests from
pages opened on `localhost`. Once you expose the server with `HOST=0.0.0.0`, only the cloud providers above
plus whatever you allow are reachable, so it can't be used as an open proxy into your network.

The relay never stores keys. They travel from the browser, through your server, to the provider on each
request. Put HTTPS in front of the server if you expose it beyond your machine.

## How requests reach providers (CORS)

Browsers block many AI APIs and local servers with CORS. ADT Bot routes around this on every platform:

- **Desktop**: requests go through the app's private `app://` relay, so every provider and local server works.
- **Web via `npm run dev`, `npm start` or Docker**: requests go through the same-origin `/api/proxy` relay.
- **Android/iOS**: requests go straight from the app, falling back to native HTTP when blocked.
  Native HTTP buffers the reply, so it shows all at once instead of streaming.
- **Static hosting with no relay**: providers that allow browser calls work directly. As of October 2026
  these include xAI, OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, Mistral, Together, Perplexity and
  Cerebras. Others (Groq, for example) need the relay. For a local server, enable CORS on it
  (e.g. `OLLAMA_ORIGINS=*`, or the CORS toggle in LM Studio).

## Project layout

```
src/lib/llm.ts         Provider adapters: OpenAI-compatible, Anthropic, Gemini (streaming, vision, reasoning, built-in search)
src/lib/chat.ts        Send, search, stream, stop, regenerate, memory, smart titles
src/lib/search.ts      Web search engines, page reading, citations
src/lib/imagine.ts     Image generation (OpenRouter, Gemini, OpenAI-style)
src/lib/voice-session.ts  Hands-free voice conversation: turns, commands, wake word, barge-in
src/lib/speech.worker.ts  Silero VAD + Whisper in a worker (speculative transcription, live captions)
src/lib/segmenter.ts      Turn detection from voice probabilities
src/lib/voice-commands.ts Voice commands, wake-word matching, echo detection
src/lib/tts.ts            Reply voices: device, OpenAI-compatible, ElevenLabs, Fish Audio, Cartesia, Deepgram; sentence streaming
src/lib/custom-tts.ts     Voice services you add yourself (templates: Sarvam, Google Cloud, Azure)
src/lib/voice.ts          Speech engines (browser, Android, Whisper, cloud) for dictation
src/lib/knowledge.ts      Knowledge files: storage, chunking, BM25 retrieval
src/lib/theme.ts          Theme engine (contrast-safe palettes from brand colours)
src/lib/brand-import.ts   Brand detection from logos, documents, CSS/tokens and websites
scripts/brand.mjs         Rebrands installers and mobile apps from a brand kit
src/lib/images.ts      Attachments: image resizing, PDF and text extraction
src/lib/detect.ts      Local AI server auto-detection
src/lib/providers.ts   Provider presets (cloud, local, private)
src/lib/catalog.json   Bundled model list, generated from Rakazo's model catalog (npm run catalog)
src/lib/transport.ts   Chooses relay, direct or native HTTP per platform
src/lib/store.ts       App state, persisted to IndexedDB (throttled writes; private chats never saved)
src/lib/agent/         Tool registry, tool loop (native and text protocol), approvals, activity log, built-in tools
src/lib/visualize/     Charts and cards (visualize tool, ```chart / ```card blocks)
src/lib/mcp/           MCP client (Streamable HTTP, SSE, stdio via desktop)
src/lib/cli-agents/    Coding-agent tool and "local CLI" provider
src/features/          Projects, routines + delegation, rooms, connectors, coding agents, Mac control, computers
electron/features/     Desktop side of those features (IPC "adt:<feature>:*")
server/rooms.mjs       LAN room server and guest page
src/components/        React UI
server/                Static server and provider relay (web, Docker, dev)
electron/              Desktop shell (macOS, Windows, Linux)
android/, ios/         Capacitor native projects
```

## Development

```bash
npm test             # adapters, built-in search, images, files, citations and relay, tested against fake servers
npm run build        # type-check and production web build
npm run catalog      # refresh bundled model ids from @earendil-works/pi-ai
npm run icons        # regenerate icons from public/icon.svg
```

## License

Apache-2.0. Based on ideas, design tokens and the model catalog from
[Rakazo](https://github.com/elie222/rakazo) by Elie Steinbock and contributors.

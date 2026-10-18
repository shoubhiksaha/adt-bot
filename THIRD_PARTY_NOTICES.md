# Third-party code

ADT Bot includes code adapted from these projects. Their licenses are kept next to the code.

| Project | License | Where | What |
| --- | --- | --- | --- |
| [OpenBOT](https://github.com/ashhart/OpenBot) | MIT, © 2026 OpenBOT contributors | `src/lib/agent/vendor/openbot/` and files marked "Adapted from OpenBOT" | Tool-call parsing, text tool protocol, approval policy, memory filter, cron, visualisation spec |
| [CopilotKit OpenBot](https://github.com/CopilotKit/OpenBot) | MIT, © 2026 CopilotKit | `src/lib/agent/vendor/copilotkit/` | Untrusted-content envelope, routine firing frame |
| [QR Code generator library](https://www.nayuki.io/page/qr-code-generator-library) | MIT, © Project Nayuki | `server/qr.mjs` | QR encoding algorithm and tables (rewritten, reduced) |
| [Rakazo](https://github.com/elie222/rakazo) | Apache-2.0 | Design tokens, model catalog | |

Code marked **PolyForm Noncommercial** (from nightly-labs/openbot) is kept under `src/vendor-nc/` and
`electron/features/nc-*`. It may only be used non-commercially; remove it before any commercial use.

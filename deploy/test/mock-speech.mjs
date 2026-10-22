// Stand-in for the speech container in the smoke test: the same OpenAI-style routes speaches serves
// (/health, /v1/models, model downloads, transcription, speech), with fixed answers.
import http from "node:http";

const models = new Set();
http
  .createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString("latin1");
    if (req.url === "/health") return res.end("OK");
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [...models].map((id) => ({ id })) }));
    if (req.url.startsWith("/v1/models/") && req.method === "POST") {
      models.add(decodeURIComponent(req.url.slice("/v1/models/".length)));
      return res.end("{}");
    }
    if (req.url === "/v1/audio/transcriptions") {
      const model = /name="model"\r\n\r\n([^\r]*)/.exec(body)?.[1] ?? "";
      return res.end(JSON.stringify({ text: `Tell me about Rome (${model}, ${body.length} bytes)` }));
    }
    if (req.url === "/v1/audio/speech") {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      return res.end(Buffer.from(`ID3 stand-in for: ${JSON.parse(body).input}`));
    }
    res.writeHead(404).end();
  })
  .listen(8000, "0.0.0.0", () => console.log("stand-in speech service on 8000"));

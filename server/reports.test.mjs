// @vitest-environment node
// The developer's voice report inbox: anyone can send a real report (small, a few an hour), only the
// token reads them, and they're gone after the keeping time.
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "./index.mjs";
import { createReportInbox, readStoredZip } from "./reports.mjs";
import { zipFiles } from "../src/lib/voice-report";
import { wavFile } from "../src/lib/voice-recording";

const TOKEN = "developer-token-1234567890";
const dir = mkdtempSync(join(tmpdir(), "adt-reports-"));
let clock = Date.parse("2026-10-28T10:00:00Z");
const inbox = createReportInbox({ dir, token: TOKEN, maxBytes: 64 * 1024, maxTotalBytes: 400 * 1024, keepDays: 30, perAddress: 3, perHour: 5, now: () => clock });
let server;
let base;
beforeAll(async () => {
  ({ server, url: base } = await startServer({ port: 0, distDir: "/nonexistent", reports: inbox }));
});
afterAll(() => {
  inbox.close();
  return new Promise((r) => server.close(r));
});

const text = (extra = "") => new TextEncoder().encode(`ADT Bot voice report\nSaved: now\n\nWhat went wrong:\nA siren${extra}\n`);
const about = (o) => encodeURIComponent(JSON.stringify(o));
const send = (body, { type = "text/plain; charset=utf-8", meta = { version: "1.5.11", platform: "darwin", arch: "arm64", note: "A siren" }, ip } = {}) =>
  fetch(`${base}/api/reports`, { method: "POST", body, headers: { "content-type": type, "x-adtbot-report": about(meta), ...(ip ? { "x-forwarded-for": ip } : {}) } });
const dev = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });

describe("report inbox", () => {
  it("takes a report from anyone and gives back a code to quote", async () => {
    const res = await send(text());
    expect(res.status).toBe(201);
    const { code, keepDays } = await res.json();
    expect(code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    expect(keepDays).toBe(30);
    const list = await (await dev("/api/reports")).json();
    expect(list.reports).toHaveLength(1);
    expect(list.reports[0]).toMatchObject({ code, version: "1.5.11", platform: "darwin", arch: "arm64", note: "A siren", zip: false, voice: false });
    expect(await (await dev(`/api/reports/${list.reports[0].id}/report.txt`)).text()).toContain("A siren");
    // Nothing about the sender is kept.
    const stored = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(stored).toHaveLength(1);
  });

  it("keeps the bot's voice from a .zip, playable on its own", async () => {
    const wav = wavFile(new Float32Array(4800).map((_, i) => Math.sin(i / 5) * 0.4), 48000);
    const zip = zipFiles([{ name: "report.txt", data: text(" with voice") }, { name: "bot-voice.wav", data: wav }]);
    expect(readStoredZip(Buffer.from(zip))?.size).toBe(2);
    const res = await send(zip, { type: "application/zip" });
    expect(res.status).toBe(201);
    const { reports } = await (await dev("/api/reports")).json();
    const report = reports.find((r) => r.zip);
    expect(report.voice).toBe(true);
    const audio = await dev(`/api/reports/${report.id}/bot-voice.wav`);
    expect(audio.headers.get("content-type")).toBe("audio/wav");
    expect(Buffer.compare(Buffer.from(await audio.arrayBuffer()), Buffer.from(wav))).toBe(0);
    const download = await dev(`/api/reports/${report.id}/download`);
    expect(download.headers.get("content-disposition")).toContain(`ADT Bot voice report ${report.code}.zip`);
    expect(Buffer.compare(Buffer.from(await download.arrayBuffer()), Buffer.from(zip))).toBe(0);
  });

  it("turns away anything that isn't a report, and anything too big", async () => {
    expect((await send(new TextEncoder().encode("hello"))).status).toBe(400);
    expect((await send(new TextEncoder().encode("<html>"), { type: "text/html" })).status).toBe(415);
    const other = zipFiles([{ name: "report.txt", data: text() }, { name: "run.sh", data: new TextEncoder().encode("rm -rf /") }]);
    expect((await send(other, { type: "application/zip", ip: "10.0.0.9" })).status).toBe(400);
    const fake = zipFiles([{ name: "report.txt", data: text() }, { name: "bot-voice.wav", data: new TextEncoder().encode("not a wav") }]);
    expect((await send(fake, { type: "application/zip", ip: "10.0.0.9" })).status).toBe(400);
    expect((await send(text("x".repeat(70 * 1024)), { ip: "10.0.0.9" })).status).toBe(413);
    // Odd details from the app are dropped, not stored.
    const odd = await send(text(), { meta: { version: "<script>", platform: "plan9", arch: "../x", note: "a\u0000b".repeat(200) }, ip: "10.0.0.9" });
    expect(odd.status).toBe(201);
    const { code } = await odd.json();
    const stored = (await (await dev("/api/reports")).json()).reports.find((r) => r.code === code);
    expect(stored).toMatchObject({ version: "", platform: "", arch: "" });
    expect(stored.note.length).toBe(300);
    expect(stored.note).not.toContain("\u0000");
  });

  it("needs the token for everything but sending", async () => {
    expect((await fetch(`${base}/api/reports`)).status).toBe(401);
    expect((await fetch(`${base}/api/reports`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const { reports } = await (await dev("/api/reports")).json();
    const id = reports[0].id;
    expect((await fetch(`${base}/api/reports/${id}/report.txt`)).status).toBe(401);
    expect((await fetch(`${base}/api/reports/${id}`, { method: "DELETE" })).status).toBe(401);
    expect((await dev("/api/reports/0123456789abcdef01234567")).status).toBe(404);
    expect((await dev(`/api/reports/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await dev(`/api/reports/${id}/report.txt`)).status).toBe(404);
  });

  it("limits how many come from one address and from everyone", async () => {
    clock += 2 * 3_600_000;
    for (let i = 0; i < 3; i++) expect((await send(text(), { ip: "10.0.0.1" })).status).toBe(201);
    // In tests every request comes from 127.0.0.1 (the forwarded address isn't trusted here).
    expect((await send(text(), { ip: "10.0.0.2" })).status).toBe(429);
    clock += 2 * 3_600_000;
    const wide = createReportInbox({ dir: mkdtempSync(join(tmpdir(), "adt-reports-")), token: TOKEN, perAddress: 10, perHour: 2, trustProxy: true, now: () => clock });
    const { server: s2, url } = await startServer({ port: 0, distDir: "/nonexistent", reports: wide });
    const post = (ip) => fetch(`${url}/api/reports`, { method: "POST", body: text(), headers: { "content-type": "text/plain", "x-forwarded-for": ip } });
    expect((await post("10.1.0.1")).status).toBe(201);
    expect((await post("10.1.0.2")).status).toBe(201);
    expect((await post("10.1.0.3")).status).toBe(429);
    wide.close();
    await new Promise((r) => s2.close(r));
  });

  it("deletes reports after the keeping time, and stops when the disk budget is used", async () => {
    const before = (await (await dev("/api/reports")).json()).reports.length;
    expect(before).toBeGreaterThan(0);
    clock += 31 * 24 * 3_600_000;
    expect((await (await dev("/api/reports")).json()).reports).toHaveLength(0);
    // Leftovers of an interrupted write are cleaned up too.
    writeFileSync(join(dir, "0123456789abcdef01234567.bin.123.abcd.tmp"), "x");
    inbox.sweep();
    expect(readdirSync(dir)).toEqual([]);
    const small = createReportInbox({ dir: mkdtempSync(join(tmpdir(), "adt-reports-")), token: TOKEN, maxBytes: 64 * 1024, maxTotalBytes: 60 * 1024, perAddress: 10, now: () => clock });
    const { server: s3, url } = await startServer({ port: 0, distDir: "/nonexistent", reports: small });
    const post = () => fetch(`${url}/api/reports`, { method: "POST", body: text("y".repeat(40 * 1024)), headers: { "content-type": "text/plain" } });
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(507);
    small.close();
    await new Promise((r) => s3.close(r));
  });

  it("serves the inbox page under a strict content policy", async () => {
    const page = await fetch(`${base}/reports`);
    expect(page.status).toBe(200);
    const csp = page.headers.get("content-security-policy");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toContain("unsafe");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(await page.text()).toContain("Voice reports");
  });

  it("refuses a short token", () => {
    expect(() => createReportInbox({ dir: mkdtempSync(join(tmpdir(), "adt-reports-")), token: "short" })).toThrow(/16 or more/);
  });
});

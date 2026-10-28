// Reads the voice report inbox (server/reports.mjs) from the command line.
//   ADT_REPORTS_URL=https://your.server ADT_REPORTS_TOKEN=… npm run reports            list them
//   … npm run reports -- get ABCD-EFGH                                                 save one in reports/ABCD-EFGH/
//   … npm run reports -- delete ABCD-EFGH
// reports/ is gitignored: what people said may be in them.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const base = (process.env.ADT_REPORTS_URL ?? "").replace(/\/+$/, "");
const token = process.env.ADT_REPORTS_TOKEN ?? "";
if (!base || !token) {
  console.error("Set ADT_REPORTS_URL (your server, e.g. https://adt.example.com) and ADT_REPORTS_TOKEN.");
  process.exit(2);
}
const call = async (path, init = {}) => {
  const res = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}` } });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return res;
};
const find = async (wanted) => {
  const { reports } = await (await call("/api/reports")).json();
  const report = reports.find((r) => r.code === wanted.toUpperCase() || r.id === wanted);
  if (!report) throw new Error(`No report ${wanted}.`);
  return report;
};

const [command = "list", wanted] = process.argv.slice(2);
try {
  if (command === "list") {
    const { reports, keepDays } = await (await call("/api/reports")).json();
    for (const r of reports) {
      const what = [r.version && `ADT Bot ${r.version}`, r.platform, r.arch, r.voice ? "voice" : ""].filter(Boolean).join(" ");
      console.log(`${r.code}  ${new Date(r.at).toISOString().slice(0, 16).replace("T", " ")}  ${what}  ${r.note || "(no description)"}`);
    }
    console.log(`${reports.length} report(s); each is deleted after ${keepDays} days.`);
  } else if (command === "get" && wanted) {
    const report = await find(wanted);
    const dir = join("reports", report.code);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.txt"), Buffer.from(await (await call(`/api/reports/${report.id}/report.txt`)).arrayBuffer()));
    if (report.voice) writeFileSync(join(dir, "bot-voice.wav"), Buffer.from(await (await call(`/api/reports/${report.id}/bot-voice.wav`)).arrayBuffer()));
    console.log(`Saved in ${dir}/`);
  } else if (command === "delete" && wanted) {
    const report = await find(wanted);
    await call(`/api/reports/${report.id}`, { method: "DELETE" });
    console.log(`Deleted ${report.code}.`);
  } else {
    console.error("Use: list | get <code> | delete <code>");
    process.exit(2);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

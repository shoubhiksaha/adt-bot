// End-to-end check for LAN rooms: starts a room server on 127.0.0.1, opens two guest browsers
// (Google Chrome via playwright-core), and checks they see each other's messages, a streamed bot
// reply, that HTML stays inert text, and that stopping the room closes both pages.
//   node scripts/rooms-e2e.mjs
// playwright-core is taken from node_modules, PLAYWRIGHT_CORE (a path), or a global `playwright` install.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createRoomHub } from "../server/rooms.mjs";

const require = createRequire(import.meta.url);

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_CORE, "playwright-core"];
  try {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    candidates.push(join(root, "playwright-core"), join(root, "playwright", "node_modules", "playwright-core"));
  } catch {}
  for (const c of candidates.filter(Boolean)) {
    try {
      if (c.startsWith("/") && !existsSync(c)) continue;
      return require(c);
    } catch {}
  }
  throw new Error("playwright-core not found (set PLAYWRIGHT_CORE=/path/to/playwright-core)");
}

const { chromium } = loadPlaywright();
const hub = createRoomHub({ hosts: ["127.0.0.1"], port: 0 });
let browser;
const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
};

try {
  const room = await hub.startRoom({ name: "E2E room", hostName: "Dom", brand: "ADT Bot", bots: [{ id: "b1", name: "Ada" }] });
  const url = room.urls[0];
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const alice = await (await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true })).newPage();
  const bob = await (await browser.newContext()).newPage();
  const cspErrors = [];
  for (const page of [alice, bob]) {
    page.on("console", (m) => /Content Security Policy|Refused to/i.test(m.text()) && cspErrors.push(m.text()));
    page.on("pageerror", (e) => cspErrors.push(String(e)));
  }

  const joinAs = async (page, name) => {
    await page.goto(url);
    await page.fill("#name", name);
    await page.fill("#pin", room.pin);
    await page.click("#join-btn");
    await page.waitForSelector("#chat-view:not([hidden])");
  };

  // Wrong PIN first.
  await alice.goto(url);
  await alice.fill("#name", "Alice");
  await alice.fill("#pin", room.pin === "000000" ? "111111" : "000000");
  await alice.click("#join-btn");
  await alice.waitForSelector("#join-error:not([hidden])");
  check((await alice.textContent("#join-error")).includes("Wrong PIN"), "wrong PIN is refused");

  await joinAs(alice, "Alice");
  await joinAs(bob, "Bob");
  await alice.waitForFunction(() => document.querySelector("#people")?.textContent?.includes("Bob"));
  check(true, "both guests joined and see each other in the people list");

  await alice.fill("#text", "Hello from Alice");
  await alice.press("#text", "Enter");
  await bob.waitForFunction(() => [...document.querySelectorAll(".bubble")].some((b) => b.textContent === "Hello from Alice"));
  check(true, "Bob receives Alice's message");

  const evil = `<img src=x onerror="window.pwned=1">`;
  await bob.fill("#text", evil);
  await bob.click("#send-btn");
  await alice.waitForFunction((t) => [...document.querySelectorAll(".bubble")].some((b) => b.textContent === t), evil);
  check((await alice.evaluate(() => document.querySelectorAll(".messages img").length === 0 && !window.pwned)), "Alice receives Bob's message, HTML shown as text");

  // A streamed bot reply (as the host app would send it).
  const reply = hub.post(room.id, { kind: "bot", author: "Ada", botId: "b1", pending: true });
  hub.update(room.id, reply.id, { text: "Thinking" });
  hub.update(room.id, reply.id, { text: "Thinking… here's the answer.", done: true });
  for (const page of [alice, bob]) {
    await page.waitForFunction(() => [...document.querySelectorAll(".msg.bot .bubble")].some((b) => b.textContent === "Thinking… here's the answer."));
  }
  check(true, "both guests see the streamed bot reply");

  // Late joiner gets the history.
  const carol = await (await browser.newContext()).newPage();
  await joinAs(carol, "Carol");
  await carol.waitForFunction(() => document.querySelectorAll(".msg").length >= 3);
  check(true, "a late joiner sees the earlier messages");

  check(cspErrors.length === 0, `no CSP violations or page errors${cspErrors.length ? `: ${cspErrors.join(" | ")}` : ""}`);

  await hub.stopRoom(room.id);
  for (const page of [alice, bob, carol]) await page.waitForSelector("#ended-view:not([hidden])");
  check((await bob.textContent("#ended-title")) === "Room closed", "stopping the room closes every guest page");
} catch (error) {
  failures.push(String(error?.stack ?? error));
  console.error(error);
} finally {
  await browser?.close();
  await hub.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll room e2e checks passed");

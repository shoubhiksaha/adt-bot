// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { encodeQr, qrSvg } from "./qr.mjs";
import { cleanText, createRoomHub, escapeHtml, generatePin, pinMatches } from "./rooms.mjs";

/** @type {ReturnType<typeof createRoomHub>[]} */
const hubs = [];
afterEach(async () => {
  while (hubs.length) await hubs.pop().close();
});

async function setup(limits = {}, config = {}) {
  const events = [];
  const hub = createRoomHub({ hosts: ["127.0.0.1"], port: 0, limits, onEvent: (e) => events.push(e) });
  hubs.push(hub);
  const room = await hub.startRoom({ name: "Test room", bots: [{ id: "b1", name: "Ada" }], hostName: "Dom", brand: "ADT Bot", ...config });
  const base = `http://127.0.0.1:${room.port}/r/${room.id}`;
  return { hub, room, base, events };
}

async function post(url, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body ?? {}) });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

async function join(base, name, pin) {
  const r = await post(`${base}/join`, { name, pin });
  if (r.status !== 200) throw new Error(`join failed ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

/** Minimal SSE client: collects events, lets tests wait for one. */
function listen(base, token) {
  const controller = new AbortController();
  const events = [];
  const waiters = [];
  let ended = false;
  const done = (async () => {
    const res = await fetch(`${base}/events?token=${encodeURIComponent(token)}`, { signal: controller.signal });
    if (res.status !== 200) {
      ended = true;
      return res.status;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
          const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null");
          events.push({ type, data });
          for (const w of [...waiters]) w();
        }
      }
    } catch {}
    ended = true;
    for (const w of [...waiters]) w();
    return 200;
  })();
  const waitFor = (predicate, ms = 3000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const found = events.find(predicate);
        if (found) {
          waiters.splice(waiters.indexOf(check), 1);
          clearTimeout(timer);
          resolve(found);
        }
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(check), 1);
        reject(new Error(`timed out; got ${events.map((e) => e.type).join(",")}`));
      }, ms);
      waiters.push(check);
      check();
    });
  return { events, waitFor, close: () => controller.abort(), done, get ended() { return ended; } };
}

describe("room server", () => {
  it("starts with a 6-digit PIN, LAN URLs and a QR code, and serves a locked-down guest page", async () => {
    const { room, base } = await setup({}, { name: `<script>alert("x")</script>`, brand: `<b>Acme</b>` });
    expect(room.pin).toMatch(/^\d{6}$/);
    expect(room.urls[0]).toBe(base);
    expect(room.qr.startsWith("<svg")).toBe(true);
    const res = await fetch(base);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toMatch(/<script>[^<]/); // no inline scripts at all
    expect((await fetch(`http://127.0.0.1:${room.port}/r/nope-not-a-room`)).status).toBe(404);
  });

  it("joins with the right PIN, refuses a wrong one and rejects guests without a token", async () => {
    const { room, base } = await setup();
    const wrong = room.pin === "000000" ? "111111" : "000000";
    const bad = await post(`${base}/join`, { name: "Eve", pin: wrong });
    expect(bad.status).toBe(403);
    expect(bad.data.error).toMatch(/wrong pin/i);
    const ok = await post(`${base}/join`, { name: "Bob", pin: room.pin });
    expect(ok.status).toBe(200);
    expect(ok.data.token.length).toBeGreaterThan(20);
    expect(ok.data.me.name).toBe("Bob");
    expect((await post(`${base}/send`, { text: "hi" })).status).toBe(401);
    expect((await post(`${base}/send`, { text: "hi" }, "made-up-token")).status).toBe(401);
    expect((await fetch(`${base}/events?token=nope`)).status).toBe(401);
  });

  it("locks an address out after too many wrong PINs, even for the right PIN", async () => {
    const { room, base, events } = await setup({ pinFailures: 3 });
    const wrong = room.pin === "999999" ? "888888" : "999999";
    for (let i = 0; i < 3; i++) expect((await post(`${base}/join`, { name: "Eve", pin: wrong })).status).toBe(403);
    const locked = await post(`${base}/join`, { name: "Eve", pin: room.pin });
    expect(locked.status).toBe(429);
    expect(events.some((e) => e.type === "notice")).toBe(true);
  });

  it("gives a burst of held-open join requests one guess, not one each", async () => {
    const { room } = await setup({ pinFailures: 5 });
    const net = await import("node:net");
    // Every request sends its headers and one byte of body, then all the bodies arrive at once:
    // the lockout used to be checked before the body, so each request got a guess.
    const guesses = Array.from({ length: 40 }, (_, i) => String(100000 + i));
    guesses[30] = room.pin;
    const sockets = guesses.map((pin) => {
      const body = JSON.stringify({ name: "Eve", pin });
      const socket = net.connect(room.port, "127.0.0.1");
      let data = "";
      const done = new Promise((resolve) => {
        socket.on("data", (d) => (data += d));
        socket.on("close", () => resolve(/HTTP\/1.1 (\d+)/.exec(data)?.[1] ?? "none"));
      });
      socket.write(`POST /r/${room.id}/join HTTP/1.1\r\nHost: 127.0.0.1:${room.port}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body[0]}`);
      return { socket, body, done };
    });
    await new Promise((r) => setTimeout(r, 300));
    sockets.forEach(({ socket, body }) => socket.write(body.slice(1)));
    const statuses = await Promise.all(sockets.map((s) => s.done));
    expect(statuses.filter((s) => s === "200")).toHaveLength(0);
    expect(statuses.filter((s) => s === "403").length).toBeLessThanOrEqual(1);
    expect(statuses.filter((s) => s === "429").length).toBeGreaterThanOrEqual(39);
  });

  it("compares PINs in constant time and generates 6 digits", () => {
    expect(pinMatches("123456", "123456")).toBe(true);
    expect(pinMatches("123456", "123457")).toBe(false);
    expect(pinMatches("123456", "")).toBe(false);
    for (let i = 0; i < 50; i++) expect(generatePin()).toMatch(/^\d{6}$/);
  });

  it("delivers messages between two guests over SSE, with presence and typing", async () => {
    const { room, base, events, hub } = await setup();
    const a = await join(base, "Alice", room.pin);
    const b = await join(base, "Bob", room.pin);
    const sa = listen(base, a.token);
    const sb = listen(base, b.token);
    await sa.waitFor((e) => e.type === "hello");
    await sb.waitFor((e) => e.type === "hello");
    await sa.waitFor((e) => e.type === "presence" && e.data.guests.filter((g) => g.online).length === 2);

    expect((await post(`${base}/send`, { text: "Hello Bob" }, a.token)).status).toBe(200);
    const got = await sb.waitFor((e) => e.type === "message");
    expect(got.data).toMatchObject({ kind: "guest", author: "Alice", text: "Hello Bob", authorId: a.me.id });
    await sa.waitFor((e) => e.type === "message" && e.data.text === "Hello Bob");
    expect(events.some((e) => e.type === "message" && e.message.text === "Hello Bob")).toBe(true);

    await post(`${base}/typing`, {}, b.token);
    await sa.waitFor((e) => e.type === "typing" && e.data.name === "Bob");

    // Host and streamed bot replies reach guests too.
    hub.post(room.id, { kind: "host", text: "Welcome!" });
    await sb.waitFor((e) => e.type === "message" && e.data.kind === "host" && e.data.author === "Dom");
    const bot = hub.post(room.id, { kind: "bot", author: "Ada", botId: "b1", pending: true });
    hub.update(room.id, bot.id, { text: "Thinking about it" });
    hub.update(room.id, bot.id, { text: "Thinking about it… done.", done: true });
    const final = await sa.waitFor((e) => e.type === "update" && e.data.done);
    expect(final.data.text).toBe("Thinking about it… done.");
    expect(hub.get(room.id).messages.find((m) => m.id === bot.id).pending).toBeUndefined();
    sa.close();
    sb.close();
  });

  it("gives late joiners the recent history (capped)", async () => {
    const { room, base } = await setup({ history: 5 });
    const a = await join(base, "Alice", room.pin);
    for (let i = 1; i <= 8; i++) expect((await post(`${base}/send`, { text: `m${i}` }, a.token)).status).toBe(200);
    const c = await join(base, "Carol", room.pin);
    const sc = listen(base, c.token);
    const hello = await sc.waitFor((e) => e.type === "hello");
    expect(hello.data.history.map((m) => m.text)).toEqual(["m4", "m5", "m6", "m7", "m8"]);
    expect(hello.data.room).toMatchObject({ name: "Test room", hostName: "Dom", bots: [{ id: "b1", name: "Ada" }] });
    sc.close();
  });

  it("keeps content as inert text and strips control characters", async () => {
    const { room, base } = await setup();
    const a = await join(base, "<img src=x onerror=alert(1)>", room.pin);
    const sa = listen(base, a.token);
    await sa.waitFor((e) => e.type === "hello");
    const evil = `<script>alert(1)</script>\u0000‮<b>bold</b>`;
    await post(`${base}/send`, { text: evil }, a.token);
    const msg = await sa.waitFor((e) => e.type === "message");
    expect(msg.data.text).toBe("<script>alert(1)</script><b>bold</b>");
    expect(escapeHtml(msg.data.text)).toBe("&lt;script&gt;alert(1)&lt;/script&gt;&lt;b&gt;bold&lt;/b&gt;");
    expect(cleanText(" a\r\nb\u0007 ", 10)).toBe("a\nb");
    // Guest page JS never uses innerHTML.
    const js = await (await fetch(`http://127.0.0.1:${room.port}/room-assets/room.js`)).text();
    expect(js).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
    sa.close();
  });

  it("enforces message size, rate, body size, name and guest limits", async () => {
    const { room, base } = await setup({ maxGuests: 2, guestMessage: 50, messageBurst: 3 });
    const a = await join(base, "Alice", room.pin);
    expect((await post(`${base}/send`, { text: "x".repeat(51) }, a.token)).status).toBe(413);
    expect((await post(`${base}/send`, { text: "   " }, a.token)).status).toBe(400);
    expect((await post(`${base}/send`, "x".repeat(20_000), a.token)).status).toBe(413);
    expect((await post(`${base}/join`, "not json")).status).toBe(400);
    for (let i = 0; i < 3; i++) expect((await post(`${base}/send`, { text: `ok ${i}` }, a.token)).status).toBe(200);
    expect((await post(`${base}/send`, { text: "too fast" }, a.token)).status).toBe(429);
    // Guests can't impersonate the host, a bot or each other.
    const dup = await join(base, "ada", room.pin);
    expect(dup.me.name).toBe("ada (2)");
    const full = await post(`${base}/join`, { name: "Zed", pin: room.pin });
    expect(full.status).toBe(403);
    expect(full.data.error).toMatch(/full/);
    expect((await post(`${base}/join`, { name: "", pin: room.pin })).status).toBe(400);
  });

  it("kicks a guest: their stream ends and their token stops working", async () => {
    const { room, base, hub } = await setup();
    const a = await join(base, "Alice", room.pin);
    const sa = listen(base, a.token);
    await sa.waitFor((e) => e.type === "hello");
    expect(hub.kick(room.id, a.me.id).ok).toBe(true);
    await sa.waitFor((e) => e.type === "kicked");
    expect((await post(`${base}/send`, { text: "still here?" }, a.token)).status).toBe(401);
    expect((await post(`${base}/join`, { name: "Alice", pin: room.pin })).status).toBe(403);
  });

  it("clears history for everyone", async () => {
    const { room, base, hub } = await setup();
    const a = await join(base, "Alice", room.pin);
    await post(`${base}/send`, { text: "one" }, a.token);
    const sa = listen(base, a.token);
    await sa.waitFor((e) => e.type === "hello" && e.data.history.length === 1);
    hub.clear(room.id);
    await sa.waitFor((e) => e.type === "cleared");
    expect(hub.get(room.id).messages).toEqual([]);
    sa.close();
  });

  it("stopping the room closes every connection and the listener", async () => {
    const { room, base, hub } = await setup();
    const a = await join(base, "Alice", room.pin);
    const sa = listen(base, a.token);
    await sa.waitFor((e) => e.type === "hello");
    await hub.stopRoom(room.id);
    await sa.waitFor((e) => e.type === "closed");
    await sa.done;
    expect(sa.ended).toBe(true);
    expect(hub.info().port).toBe(0);
    await expect(fetch(base)).rejects.toThrow();
  });
});

describe("QR encoder", () => {
  it("picks the smallest version and renders an SVG", () => {
    expect(encodeQr("hi").length).toBe(21);
    expect(encodeQr("http://192.168.1.23:8790/r/AbCdEfGhIjKl").length).toBe(29);
    const m = encodeQr("x");
    // Finder pattern corners are dark, separator light.
    expect(m[0][0] && m[0][6] && m[6][0] && !m[7][7]).toBe(true);
    expect(qrSvg("x")).toMatch(/^<svg[^>]+viewBox="0 0 29 29"/);
  });
});

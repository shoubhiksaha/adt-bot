// @vitest-environment node
// The self-hosted relay: pages found on the web can't lead into the private network, API keys don't
// follow a redirect to another site, cloud metadata is never reached, and a bad path can't crash it.
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./index.mjs";
import { isLinkLocal, reachesPrivateNetwork } from "./proxy.mjs";

const servers = [];
afterEach(async () => {
  while (servers.length) await new Promise((r) => servers.pop().close(r));
});

/** A local site; `handle` answers each request. Returns its origin. */
async function site(handle) {
  const server = createServer(handle);
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}

async function relay(proxy = { allowAllHosts: true, loopbackOnly: true }) {
  const { server, url } = await startServer({ port: 0, distDir: "/nonexistent-dist", proxy });
  servers.push(server);
  return url;
}

const via = (relayUrl, target, headers = {}) => fetch(`${relayUrl}/api/proxy`, { headers: { "x-adtbot-target": target, ...headers } });

describe("self-hosted relay", () => {
  it("refuses to read a private address for a page found on the web, but relays it for the user's own servers", async () => {
    const target = await site((_req, res) => res.end("router admin page"));
    const url = await relay();
    expect((await via(url, `${target}/`, { "x-adtbot-public-only": "1" })).status).toBe(403);
    const own = await via(url, `${target}/`);
    expect(own.status).toBe(200);
    expect(await own.text()).toBe("router admin page");
  });

  it("checks every redirect hop of a public-only read", async () => {
    // Not reachable as a public page in a test, so check the rule itself.
    expect(await reachesPrivateNetwork("127.0.0.1")).toBe(true);
    expect(await reachesPrivateNetwork("localhost.")).toBe(true);
    expect(await reachesPrivateNetwork("printer.local")).toBe(true);
    expect(await reachesPrivateNetwork("[::ffff:7f00:1]")).toBe(true);
    expect(await reachesPrivateNetwork("does-not-exist.invalid")).toBe(true);
    expect(await reachesPrivateNetwork("93.184.215.14")).toBe(false);
  });

  it("never reaches link-local addresses (cloud metadata)", async () => {
    expect(isLinkLocal("169.254.169.254")).toBe(true);
    expect(isLinkLocal("[::ffff:169.254.169.254]")).toBe(true);
    expect(isLinkLocal("fe80::1")).toBe(true);
    expect(isLinkLocal("10.0.0.1")).toBe(false);
    const url = await relay();
    expect((await via(url, "http://169.254.169.254/latest/meta-data/")).status).toBe(403);
  });

  it("drops API keys and custom headers when a redirect leads to another site", async () => {
    const seen = [];
    const other = await site((req, res) => {
      seen.push(req.headers);
      res.end("ok");
    });
    const first = await site((req, res) => {
      seen.push(req.headers);
      res.writeHead(302, { location: `${other}/landing` }).end();
    });
    const url = await relay();
    const res = await via(url, `${first}/start`, { authorization: "Bearer sk-secret", "x-api-key": "k-secret", "x-custom": "c", accept: "text/plain" });
    expect(res.status).toBe(200);
    expect(seen[0].authorization).toBe("Bearer sk-secret");
    expect(seen[1].authorization).toBeUndefined();
    expect(seen[1]["x-api-key"]).toBeUndefined();
    expect(seen[1]["x-custom"]).toBeUndefined();
    expect(seen[1].accept).toBe("text/plain");
  });

  it("answers a malformed path instead of crashing", async () => {
    const url = await relay();
    expect((await fetch(`${url}/%`)).status).toBe(400);
    expect((await fetch(`${url}/api/health`)).status).toBe(200);
  });
});

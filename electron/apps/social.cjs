// Slack (with the user's own Slack app token) and X (signed in with the user's own X app) for the bots.
const { text } = require("./common.cjs");

const SLACK = "https://slack.com/api";
const X = "https://api.x.com/2";

function createSocial({ accounts }) {
  const account = (id, provider) => {
    const a = accounts.get(id);
    if (!a || a.provider !== provider) throw new Error(`That ${provider === "x" ? "X" : "Slack"} account isn't connected any more.`);
    return a;
  };

  // Slack ------------------------------------------------------------------------------------

  const names = new Map();
  async function userNames(id) {
    if (names.has(id) && names.get(id).at > Date.now() - 3600_000) return names.get(id).map;
    const map = new Map();
    try {
      const { data } = await accounts.api(id, "GET", `${SLACK}/users.list`, { query: { limit: 500 } });
      for (const u of data?.members ?? []) map.set(u.id, u.real_name || u.name);
    } catch {}
    names.set(id, { at: Date.now(), map });
    return map;
  }

  async function slackChannels({ account: id }) {
    const a = account(id, "slack");
    const { data } = await accounts.api(a.id, "GET", `${SLACK}/conversations.list`, { query: { types: "public_channel,private_channel", exclude_archived: "true", limit: 200 } });
    return (data?.channels ?? []).map((c) => ({ id: c.id, name: `#${c.name}`, member: Boolean(c.is_member), topic: c.topic?.value ?? "" }));
  }

  /** A channel by id or "#name". */
  async function slackChannel(id, ref) {
    const value = text(ref, 100).trim();
    if (/^[CGD][A-Z0-9]{6,}$/.test(value)) return value;
    const name = value.replace(/^#/, "").toLowerCase();
    const found = (await slackChannels({ account: id })).find((c) => c.name.toLowerCase() === `#${name}`);
    if (!found) throw new Error(`No channel called #${name} (or the Slack app isn't in it: invite it with /invite).`);
    return found.id;
  }

  async function slackRead({ account: id, channel, limit, oldest }) {
    const a = account(id, "slack");
    const channelId = await slackChannel(a.id, channel);
    const { data } = await accounts.api(a.id, "GET", `${SLACK}/conversations.history`, { query: { channel: channelId, limit: Math.min(Math.max(Number(limit) || 20, 1), 100), oldest: text(oldest, 40) } });
    const users = await userNames(a.id);
    return {
      channel: channelId,
      messages: (data?.messages ?? [])
        .filter((m) => !m.subtype || m.subtype === "bot_message" || m.subtype === "thread_broadcast")
        .map((m) => ({
          ts: m.ts,
          from: users.get(m.user) ?? m.username ?? m.user ?? "someone",
          text: text(m.text, 4000),
          date: new Date(Number(m.ts) * 1000).toISOString(),
          thread: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : undefined,
          // Posted by an app (ours included): routines watching the channel don't react to it.
          ...(m.bot_id ? { bot: true } : {}),
        })),
    };
  }

  async function slackPost({ account: id, channel, message, thread }) {
    const a = account(id, "slack");
    const body = text(message, 30_000).trim();
    if (!body) throw new Error("Write the message.");
    const channelId = await slackChannel(a.id, channel);
    const { data } = await accounts.api(a.id, "POST", `${SLACK}/chat.postMessage`, { json: { channel: channelId, text: body, ...(thread ? { thread_ts: text(thread, 40) } : {}) } });
    return { channel: channelId, ts: data.ts };
  }

  // X ----------------------------------------------------------------------------------------

  const me = new Map();
  async function xMe(id) {
    if (!me.has(id)) me.set(id, (await accounts.api(id, "GET", `${X}/users/me`)).data.data);
    return me.get(id);
  }
  const posts = (data) => {
    const users = new Map((data?.includes?.users ?? []).map((u) => [u.id, u.username]));
    return (data?.data ?? []).map((t) => ({ id: t.id, from: users.has(t.author_id) ? `@${users.get(t.author_id)}` : t.author_id, text: t.text, date: t.created_at ?? "", link: users.has(t.author_id) ? `https://x.com/${users.get(t.author_id)}/status/${t.id}` : "" }));
  };
  const FIELDS = { "tweet.fields": "created_at,author_id", expansions: "author_id", "user.fields": "username" };

  async function xSearch({ account: id, query, limit }) {
    const a = account(id, "x");
    const q = text(query, 500).trim();
    if (!q) throw new Error("Say what to search for.");
    const { data } = await accounts.api(a.id, "GET", `${X}/tweets/search/recent`, { query: { query: q, max_results: Math.min(Math.max(Number(limit) || 10, 10), 100), ...FIELDS } });
    return posts(data);
  }

  async function xMentions({ account: id, since }) {
    const a = account(id, "x");
    const user = await xMe(a.id);
    const { data } = await accounts.api(a.id, "GET", `${X}/users/${user.id}/mentions`, { query: { max_results: 20, since_id: text(since, 40), ...FIELDS } });
    return { newest: data?.meta?.newest_id ?? text(since, 40), posts: posts(data) };
  }

  async function xPost({ account: id, message, reply_to }) {
    const a = account(id, "x");
    const body = text(message, 4000).trim();
    if (!body) throw new Error("Write the post.");
    const { data } = await accounts.api(a.id, "POST", `${X}/tweets`, { json: { text: body, ...(reply_to ? { reply: { in_reply_to_tweet_id: text(reply_to, 40) } } : {}) } });
    const user = await xMe(a.id).catch(() => null);
    return { id: data.data.id, link: user ? `https://x.com/${user.username}/status/${data.data.id}` : "" };
  }

  async function xMessages({ account: id, since }) {
    const a = account(id, "x");
    const user = await xMe(a.id);
    const { data } = await accounts.api(a.id, "GET", `${X}/dm_events`, { query: { "dm_event.fields": "created_at,sender_id,text,dm_conversation_id", expansions: "sender_id", "user.fields": "username", max_results: 50 } });
    const users = new Map((data?.includes?.users ?? []).map((u) => [u.id, u.username]));
    const all = (data?.data ?? [])
      .filter((e) => e.event_type === "MessageCreate" || e.text)
      .map((e) => ({ id: e.id, from: users.has(e.sender_id) ? `@${users.get(e.sender_id)}` : e.sender_id, mine: e.sender_id === user.id, text: e.text ?? "", date: e.created_at ?? "", conversation: e.dm_conversation_id }));
    const after = text(since, 40);
    const fresh = after ? all.filter((m) => BigInt(m.id) > BigInt(after)) : all;
    return { newest: all.reduce((max, m) => (BigInt(m.id) > BigInt(max || "0") ? m.id : max), after), messages: fresh };
  }

  async function xSendMessage({ account: id, to, message }) {
    const a = account(id, "x");
    const body = text(message, 10_000).trim();
    const handle = text(to, 60).trim().replace(/^@/, "");
    if (!body) throw new Error("Write the message.");
    if (!/^\w{1,15}$/.test(handle)) throw new Error("Say who to message (their @username).");
    const { data: found } = await accounts.api(a.id, "GET", `${X}/users/by/username/${handle}`);
    if (!found?.data?.id) throw new Error(`There's no X account @${handle}.`);
    const { data } = await accounts.api(a.id, "POST", `${X}/dm_conversations/with/${found.data.id}/messages`, { json: { text: body } });
    return { id: data?.data?.dm_event_id ?? "", to: `@${handle}` };
  }

  return { slackChannels, slackRead, slackPost, xSearch, xMentions, xPost, xMessages, xSendMessage };
}

module.exports = { createSocial };

/**
 * The sync loop: a sync shortly after start, every two minutes, and a few seconds after changes
 * (not while a reply is being written). Pull, merge, apply, push; a push that lost a race pulls again.
 */
import { create } from "zustand";
import { detectEnv } from "../../lib/transport";
import { useStore } from "../../lib/store";
import type { Conversation, Message, ProviderConfig } from "../../lib/types";
import { digest, mergeSnapshots, pull, push, seal, slimConversation, type SyncKeys, syncKeys, type SyncSnapshot, unseal } from "../../lib/sync";

export type SyncStatus = { state: "off" | "syncing" | "ok" | "error"; lastSync?: number; error?: string };
export const useSyncStatus = create<SyncStatus>(() => ({ state: "off" }));

let keysFor: { code: string; keys: Promise<SyncKeys> } | null = null;
const keys = (code: string) => {
  if (keysFor?.code !== code) keysFor = { code, keys: syncKeys(code) };
  return keysFor.keys;
};

/** This device's copy. API keys and header values only when "sync keys" is on. */
export function localSnapshot(): SyncSnapshot {
  const { providers, bots, conversations, skills, settings, tombstones, profileUpdatedAt } = useStore.getState();
  const withKeys = settings.sync.keys;
  return {
    v: 1,
    at: Date.now(),
    device: settings.sync.device || "this device",
    providers: providers.map((p): ProviderConfig => (withKeys ? p : { ...p, apiKey: "", headers: p.headers ? Object.fromEntries(Object.keys(p.headers).map((k) => [k, ""])) : undefined })),
    bots,
    conversations: Object.values(conversations)
      .filter((c) => !c.temporary)
      .map(slimConversation),
    skills,
    profile: { userName: settings.userName, about: settings.about, customInstructions: settings.customInstructions, sharedMemory: settings.sharedMemory ?? [], updatedAt: profileUpdatedAt ?? 0 },
    tombstones,
  };
}

const PLACEHOLDER = "(A large picture: it's on the device it was added on.)";

/** Pictures this device has that the merged copy only mentions are put back. */
function keepLocalPictures(merged: Conversation, local: Conversation | undefined): Conversation {
  if (!local) return merged;
  const mine = new Map(local.messages.map((m) => [m.id, m]));
  const messages = merged.messages.map((m): Message => {
    const own = mine.get(m.id);
    if (!own?.attachments || !m.attachments?.some((a) => a.kind === "file" && a.text === PLACEHOLDER)) return m;
    return { ...m, attachments: m.attachments.map((a) => (a.kind === "file" && a.text === PLACEHOLDER ? (own.attachments!.find((x) => x.kind === "image" && x.name === a.name) ?? a) : a)) };
  });
  return { ...merged, messages };
}

/** Puts the merged copy into the app (without stamping anything as changed). */
export function applySnapshot(merged: SyncSnapshot) {
  useStore.setState((s) => {
    const streaming = s.streamingId;
    const conversations: Record<string, Conversation> = {};
    for (const c of merged.conversations) conversations[c.id] = keepLocalPictures(c, s.conversations[c.id]);
    // Private chats and the reply being written stay as they are here.
    for (const c of Object.values(s.conversations)) if (c.temporary || c.id === streaming) conversations[c.id] = c;
    const profileNewer = merged.profile.updatedAt > (s.profileUpdatedAt ?? 0);
    const activeGone = s.activeConversationId && !conversations[s.activeConversationId];
    const activeBotGone = s.activeBotId && !merged.bots.some((b) => b.id === s.activeBotId);
    return {
      providers: merged.providers.map((p) => {
        const mine = s.providers.find((x) => x.id === p.id);
        return mine?.apiKey && !p.apiKey ? { ...p, apiKey: mine.apiKey, headers: mine.headers ?? p.headers } : p;
      }),
      bots: merged.bots,
      conversations,
      skills: merged.skills,
      tombstones: merged.tombstones,
      ...(profileNewer
        ? {
            settings: { ...s.settings, userName: merged.profile.userName, about: merged.profile.about, customInstructions: merged.profile.customInstructions, sharedMemory: merged.profile.sharedMemory },
            profileUpdatedAt: merged.profile.updatedAt,
          }
        : {}),
      ...(activeGone ? { activeConversationId: null } : {}),
      ...(activeBotGone ? { activeBotId: merged.bots[0]?.id ?? null } : {}),
    };
  });
}

let etag = "";
let lastDigest = "";
let running: Promise<void> | null = null;

/** One sync. Resolves when done; errors show in the status. */
export function syncNow(): Promise<void> {
  running ??= (async () => {
    const { settings } = useStore.getState();
    const { enabled, server, code } = settings.sync;
    if (!enabled || !server || !code) {
      useSyncStatus.setState({ state: "off" });
      return;
    }
    useSyncStatus.setState({ state: "syncing", error: undefined });
    try {
      const k = await keys(code);
      const useProxy = settings.useProxy && (await detectEnv()).proxy;
      for (let attempt = 0; attempt < 3; attempt++) {
        const local = localSnapshot();
        const localDigest = await digest(local);
        const remote = await pull(server, k, useProxy, etag);
        let merged = local;
        let ifMatch = etag;
        if (remote === "unchanged") {
          // Nothing new on the server since the last sync: push only if something changed here.
          if (localDigest === lastDigest) break;
        } else if (remote === null) {
          ifMatch = "";
        } else {
          const theirs = await unseal(remote.body, k);
          merged = mergeSnapshots(local, theirs);
          ifMatch = remote.etag;
          etag = remote.etag;
          applySnapshot(merged);
          // The server already has everything this device has.
          if ((await digest(merged)) === (await digest(theirs))) {
            lastDigest = await digest(localSnapshot());
            break;
          }
        }
        const result = await push(server, k, await seal(merged, k), useProxy, ifMatch);
        if (result === "conflict") {
          etag = "";
          continue;
        }
        etag = result;
        lastDigest = await digest(localSnapshot());
        break;
      }
      useSyncStatus.setState({ state: "ok", lastSync: Date.now(), error: undefined });
    } catch (error) {
      useSyncStatus.setState({ state: "error", error: (error as Error).message });
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Forget where the last sync left off (a new code or server). */
export function resetSync() {
  etag = "";
  lastDigest = "";
  keysFor = null;
}

let started = false;

export function startSync() {
  if (started || typeof window === "undefined") return;
  started = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const soon = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (useStore.getState().streamingId) return soon(5000);
      void syncNow();
    }, ms);
  };
  setInterval(() => soon(0), 120_000);
  soon(3000);
  useStore.subscribe((state, previous) => {
    if (!state.settings.sync.enabled) return;
    const changed =
      state.bots !== previous.bots ||
      state.conversations !== previous.conversations ||
      state.skills !== previous.skills ||
      state.providers !== previous.providers ||
      state.tombstones !== previous.tombstones ||
      state.profileUpdatedAt !== previous.profileUpdatedAt;
    if (state.settings.sync !== previous.settings.sync) {
      resetSync();
      soon(500);
    } else if (changed && !running) soon(8000);
  });
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && soon(500));
}

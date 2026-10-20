import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import { desktopInvoke, desktopOn, isDesktop } from "../../lib/desktop";
import { roomSecretsCodec, SecretKeeper } from "../../lib/secrets";
import { useStore } from "../../lib/store";
import type { ToolCallRecord } from "../../lib/types";
import { botsToAnswer, newPin, newRoomId, type RoomGuest, type RoomMessage, type RoomTools } from "./logic";

/** A room the host set up (kept between app runs). */
export type RoomConfig = {
  id: string;
  name: string;
  botIds: string[];
  pin: string;
  /** "mention": bots answer when @mentioned; "all": the first bot answers every message. */
  mode: "mention" | "all";
  tools: RoomTools;
  createdAt: number;
};

/** What the room server reports for a running room. */
export type RoomInfo = {
  id: string;
  name: string;
  pin: string;
  port: number;
  urls: string[];
  localUrl: string | null;
  lanAvailable: boolean;
  qr: string;
  guests: RoomGuest[];
  messages: RoomMessage[];
};

/** A guest asked a bot something while the room allows full tools: the host decides first. */
export type ToolRequest = { id: string; botName: string; guestName: string; text: string; resolve: (full: boolean) => void };

export type LiveRoom = {
  info: RoomInfo;
  messages: RoomMessage[];
  guests: RoomGuest[];
  typing: { name: string; until: number } | null;
  notices: string[];
  /** Bot currently answering. */
  busy: string | null;
  calls: ToolCallRecord[];
  request: ToolRequest | null;
};

type RoomsState = {
  configs: RoomConfig[];
  selectedId: string | null;
  live: Record<string, LiveRoom>;
};

/** Room PINs: in the OS keychain on desktop (src/lib/secrets.ts); the rest stays in localStorage. */
const pins = new SecretKeeper<RoomsState>("rooms", roomSecretsCodec<RoomsState>());

/** Erase all data: room PINs leave the keychain too. */
export const eraseRoomPins = () => pins.clear();
let lastSaved: StorageValue<RoomsState> | null = null;

const roomsStorage: PersistStorage<RoomsState> = {
  getItem: async (name) => {
    const text = typeof localStorage === "undefined" ? null : localStorage.getItem(name);
    if (!text) {
      await pins.open();
      return null;
    }
    const stored = JSON.parse(text) as StorageValue<RoomsState>;
    const state = await pins.load(stored.state, (blanked) => localStorage.setItem(name, JSON.stringify({ ...stored, state: blanked })));
    return { ...stored, state };
  },
  setItem: (name, value) => {
    lastSaved = value;
    if (typeof localStorage !== "undefined") localStorage.setItem(name, JSON.stringify({ ...value, state: pins.forDisk(value.state) }));
  },
  removeItem: (name) => {
    if (typeof localStorage !== "undefined") localStorage.removeItem(name);
  },
};
pins.onFallback = () => lastSaved && roomsStorage.setItem("adtbot-rooms", lastSaved);

export const useRooms = create<RoomsState>()(
  persist(() => ({ configs: [], selectedId: null, live: {} }) as RoomsState, {
    name: "adtbot-rooms",
    storage: roomsStorage,
    partialize: (s) => ({ configs: s.configs, selectedId: s.selectedId }) as RoomsState,
  }),
);

const HISTORY = 200;

function patchLive(id: string, fn: (room: LiveRoom) => Partial<LiveRoom>) {
  useRooms.setState((s) => {
    const room = s.live[id];
    return room ? { live: { ...s.live, [id]: { ...room, ...fn(room) } } } : s;
  });
}

export function notice(id: string, text: string) {
  patchLive(id, (r) => ({ notices: [...r.notices, `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}  ${text}`].slice(-20) }));
}

export function createRoom(): RoomConfig {
  const { bots, activeBotId } = useStore.getState();
  const config: RoomConfig = {
    id: newRoomId(),
    name: "Team room",
    botIds: activeBotId ? [activeBotId] : bots.slice(0, 1).map((b) => b.id),
    pin: newPin(),
    mode: "mention",
    tools: "safe",
    createdAt: Date.now(),
  };
  useRooms.setState((s) => ({ configs: [...s.configs, config], selectedId: config.id }));
  return config;
}

export function updateRoom(id: string, patch: Partial<RoomConfig>) {
  useRooms.setState((s) => ({ configs: s.configs.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
}

export function deleteRoom(id: string) {
  useRooms.setState((s) => ({ configs: s.configs.filter((c) => c.id !== id), selectedId: s.selectedId === id ? null : s.selectedId }));
}

function roomBots(config: RoomConfig) {
  const { bots } = useStore.getState();
  return config.botIds.map((id) => bots.find((b) => b.id === id)).filter((b): b is NonNullable<typeof b> => Boolean(b));
}

function hostName() {
  return useStore.getState().settings.userName.trim() || "Host";
}

function setLive(info: RoomInfo) {
  useRooms.setState((s) => ({
    live: {
      ...s.live,
      [info.id]: {
        info,
        messages: info.messages,
        guests: info.guests,
        typing: null,
        notices: s.live[info.id]?.notices ?? [],
        busy: null,
        calls: [],
        request: null,
      },
    },
  }));
}

export async function startRoom(config: RoomConfig) {
  const info = await desktopInvoke<RoomInfo>("adt:rooms:start", {
    id: config.id,
    name: config.name,
    pin: config.pin,
    hostName: hostName(),
    brand: useStore.getState().settings.brand.name,
    bots: roomBots(config).map((b) => ({ id: b.id, name: b.name })),
  });
  if (info.pin !== config.pin) updateRoom(config.id, { pin: info.pin });
  setLive(info);
}

export async function stopRoom(id: string) {
  abortBots(id);
  await desktopInvoke("adt:rooms:stop", { id });
  useRooms.setState((s) => {
    const live = { ...s.live };
    delete live[id];
    return { live };
  });
}

export const hostSay = (id: string, text: string) => desktopInvoke<RoomMessage>("adt:rooms:send", { id, kind: "host", text });
export const kickGuest = (id: string, guestId: string) => desktopInvoke("adt:rooms:kick", { id, guestId });
export const clearRoom = (id: string) => desktopInvoke("adt:rooms:clear", { id });

// --- Bots answering in rooms --------------------------------------------------------------

const queues = new Map<string, Promise<void>>();
const pendingTurns = new Map<string, number>();
const controllers = new Map<string, Set<AbortController>>();
const MAX_QUEUED = 6;

export function abortBots(id: string) {
  for (const c of controllers.get(id) ?? []) c.abort();
  controllers.delete(id);
  const request = useRooms.getState().live[id]?.request;
  request?.resolve(false);
}

function enqueue(roomId: string, task: (signal: AbortSignal) => Promise<void>) {
  const waiting = pendingTurns.get(roomId) ?? 0;
  if (waiting >= MAX_QUEUED) {
    notice(roomId, "Skipped a bot request: too many are waiting.");
    return;
  }
  pendingTurns.set(roomId, waiting + 1);
  const controller = new AbortController();
  const set = controllers.get(roomId) ?? new Set();
  set.add(controller);
  controllers.set(roomId, set);
  const run = (queues.get(roomId) ?? Promise.resolve())
    .then(() => (controller.signal.aborted ? undefined : task(controller.signal)))
    .catch((error) => notice(roomId, `Bot error: ${(error as Error).message}`))
    .finally(() => {
      pendingTurns.set(roomId, (pendingTurns.get(roomId) ?? 1) - 1);
      controllers.get(roomId)?.delete(controller);
    });
  queues.set(roomId, run);
}

/** Asks the host whether a guest's question may use the bot's full tools. Safe tools otherwise. */
function askHost(roomId: string, botName: string, message: RoomMessage, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (full: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      patchLive(roomId, () => ({ request: null }));
      resolve(full);
    };
    const timer = setTimeout(() => done(false), 120_000);
    signal.addEventListener("abort", () => done(false), { once: true });
    patchLive(roomId, () => ({ request: { id: message.id, botName, guestName: message.author, text: message.text, resolve: done } }));
  });
}

function onMessage(roomId: string, message: RoomMessage) {
  const config = useRooms.getState().configs.find((c) => c.id === roomId);
  if (!config) return;
  const bots = botsToAnswer(message, roomBots(config), config.mode);
  for (const bot of bots) {
    enqueue(roomId, async (signal) => {
      const live = useRooms.getState().live[roomId];
      if (!live) return;
      let tools: RoomTools = config.tools;
      if (tools === "full" && message.kind === "guest") tools = (await askHost(roomId, bot.name, message, signal)) ? "full" : "safe";
      if (signal.aborted) return;
      const { runRoomBot } = await import("./roomBot");
      patchLive(roomId, () => ({ busy: bot.name, calls: [] }));
      try {
        await runRoomBot({
          roomId,
          roomName: config.name,
          hostName: hostName(),
          bot,
          transcript: useRooms.getState().live[roomId]?.messages ?? [],
          tools,
          guest: message.kind === "guest",
          signal,
          onCalls: (calls) => patchLive(roomId, () => ({ calls })),
          onError: (text) => notice(roomId, `${bot.name}: ${text}`),
        });
      } finally {
        patchLive(roomId, () => ({ busy: null }));
      }
    });
  }
}

type RoomEvent =
  | { type: "message"; roomId: string; message: RoomMessage }
  | { type: "update"; roomId: string; id: string; text: string; done: boolean }
  | { type: "presence"; roomId: string; guests: RoomGuest[] }
  | { type: "typing"; roomId: string; who: { id: string; name: string } }
  | { type: "cleared"; roomId: string }
  | { type: "notice"; roomId: string; text: string }
  | { type: "state"; roomId: string; running: boolean };

export function handleRoomEvent(event: RoomEvent) {
  const id = event.roomId;
  switch (event.type) {
    case "message":
      patchLive(id, (r) => ({ messages: [...r.messages, event.message].slice(-HISTORY), typing: r.typing?.name === event.message.author ? null : r.typing }));
      onMessage(id, event.message);
      break;
    case "update":
      patchLive(id, (r) => ({
        messages: r.messages.map((m) => (m.id === event.id ? { ...m, text: event.text, pending: event.done ? undefined : true } : m)),
      }));
      break;
    case "presence":
      patchLive(id, () => ({ guests: event.guests }));
      break;
    case "typing":
      patchLive(id, () => ({ typing: { name: event.who.name, until: Date.now() + 4000 } }));
      break;
    case "cleared":
      patchLive(id, () => ({ messages: [] }));
      break;
    case "notice":
      notice(id, event.text);
      break;
    case "state":
      if (!event.running) {
        abortBots(id);
        useRooms.setState((s) => {
          const live = { ...s.live };
          delete live[id];
          return { live };
        });
      }
      break;
  }
}

let installed = false;

/** Listens for room events (so bots answer even when the Rooms view is closed) and re-syncs running rooms. */
export function installRoomEvents() {
  if (installed || !isDesktop()) return;
  installed = true;
  desktopOn<RoomEvent>("adt:rooms:event", handleRoomEvent);
  void desktopInvoke<RoomInfo[]>("adt:rooms:list")
    .then((rooms) => rooms.forEach(setLive))
    .catch(() => undefined);
}

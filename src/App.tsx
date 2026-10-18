import { Mic } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { ChatView } from "./components/ChatView";
import { FeatureHost } from "./components/FeatureHost";
import "./features";
import { useNav } from "./features/registry";
import type { SettingsTab } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { stopStreaming } from "./lib/chat";
import { selectBot, startNewChat, useStore } from "./lib/store";
import { preferredMode, themeCss } from "./lib/theme";

// Dialogs and the setup screen load on demand, keeping the first paint small.
const SettingsDialog = lazy(() => import("./components/SettingsDialog"));
const BotDialog = lazy(() => import("./components/BotDialog"));
const VoiceMode = lazy(() => import("./components/VoiceMode").then((m) => ({ default: m.VoiceMode })));
const ProviderSetup = lazy(() => import("./components/ProviderSetup").then((m) => ({ default: m.ProviderSetup })));

/** Applies the brand: colours, font, corners, light/dark mode, app name and favicon. */
function useBrand() {
  const theme = useStore((s) => s.settings.theme);
  const brand = useStore((s) => s.settings.brand);
  useEffect(() => {
    let style = document.getElementById("brand-theme") as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = "brand-theme";
      document.head.appendChild(style);
    }
    style.textContent = themeCss(brand.theme);
    const media = matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const brandMode = preferredMode(brand.theme);
      const resolved = theme === "system" ? (brandMode ?? (media.matches ? "light" : "dark")) : theme;
      document.documentElement.dataset.theme = resolved;
      const background = getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", background || (resolved === "light" ? "#fafaf8" : "#0b0c0e"));
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme, brand.theme]);

  useEffect(() => {
    document.title = brand.name || "ADT Bot";
    const icon = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
    if (icon) {
      icon.href = brand.logo || "./icon.svg";
      icon.type = brand.logo ? "image/png" : "image/svg+xml";
    }
  }, [brand.name, brand.logo]);
}

/** Opt-in: listen for "Hey <nickname>" while the app is open and voice mode isn't. */
function useWakeWord(enabled: boolean, onWake: (request: string) => void) {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let watcher: { stop(): void } | null = null;
    let cancelled = false;
    void import("./lib/voice-session").then(async ({ WakeWatcher }) => {
      if (cancelled) return;
      const w = new WakeWatcher(onWake);
      watcher = w;
      try {
        await w.start();
        if (!cancelled) setListening(true);
      } catch {
        setListening(false);
      }
    });
    return () => {
      cancelled = true;
      watcher?.stop();
      setListening(false);
    };
    // onWake is stable for the app's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return listening;
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
}

export function App() {
  useBrand();
  const hydrated = useStore((s) => s.hydrated);
  const hasProvider = useStore((s) => s.providers.length > 0);
  const bots = useStore((s) => s.bots);
  const activeBotId = useStore((s) => s.activeBotId);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [editingBot, setEditingBot] = useState<string | null>(null);
  const [voice, setVoice] = useState<{ request?: string } | null>(null);
  const activeView = useNav((s) => s.view);
  const handsFree = useStore((s) => s.settings.voice.handsFree);
  const brandName = useStore((s) => s.settings.brand.name);
  const brandLogo = useStore((s) => s.settings.brand.logo);
  const wakeListening = useWakeWord(handsFree && !voice && hasProvider, (request) => setVoice({ request }));

  useEffect(() => {
    const open = () => setVoice({});
    window.addEventListener("adt:voice-mode", open);
    return () => window.removeEventListener("adt:voice-mode", open);
  }, []);

  const bot = bots.find((b) => b.id === activeBotId);
  useEffect(() => {
    if (hydrated && !bot && bots[0]) selectBot(bots[0].id);
  }, [hydrated, bot, bots]);

  // Warm up the Markdown renderer once the first screen is up.
  useEffect(() => {
    const warm = () => void import("./components/Markdown");
    const id = "requestIdleCallback" in window ? requestIdleCallback(warm) : setTimeout(warm, 800);
    return () => ("cancelIdleCallback" in window ? cancelIdleCallback(id as number) : clearTimeout(id));
  }, []);

  useEffect(() => {
    const open = (e: Event) => setSettingsTab(((e as CustomEvent).detail as SettingsTab) ?? "general");
    window.addEventListener("adt:open-settings", open);
    return () => window.removeEventListener("adt:open-settings", open);
  }, []);

  // Global shortcuts: ⌘/Ctrl+K search chats, ⌘/Ctrl+Shift+O new chat, "/" focus input, Esc stop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSidebarOpen(true);
        requestAnimationFrame(() => document.getElementById("chat-search")?.focus());
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        const id = useStore.getState().activeBotId;
        if (id) startNewChat(id);
        window.dispatchEvent(new Event("adt:focus-composer"));
      } else if (e.key === "/" && !mod && !isTyping(e.target)) {
        e.preventDefault();
        window.dispatchEvent(new Event("adt:focus-composer"));
      } else if (e.key === "Escape" && useStore.getState().streamingId && !isTyping(e.target)) {
        stopStreaming();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!hydrated) return null;

  const macDesktop = window.adtbotDesktop?.platform === "darwin";

  if (!hasProvider) {
    return (
      <div className={`app${macDesktop ? " desktop-mac" : ""}`}>
        <div className="welcome">
          <div className="welcome-inner">
            <img src={brandLogo || "./icon.svg"} alt="" width={56} height={56} style={{ borderRadius: 14, objectFit: "contain" }} />
            <h1>Welcome to {brandName || "ADT Bot"}</h1>
            <p className="muted" style={{ marginTop: 0 }}>
              Chat with any AI: cloud providers with your own key, local models with no key, or your own private server. Live web search, image
              creation, file reading and memory work with all of them. Everything stays on this device.
            </p>
            <Suspense fallback={<div className="muted small">Loading…</div>}>
              <ProviderSetup />
            </Suspense>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`app${macDesktop ? " desktop-mac" : ""}`}>
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onOpenSettings={() => setSettingsTab("general")}
        onEditBot={setEditingBot}
      />
      {activeView ? (
        <FeatureHost viewId={activeView} onOpenSidebar={() => setSidebarOpen(true)} />
      ) : (
        bot && <ChatView bot={bot} onOpenSidebar={() => setSidebarOpen(true)} onEditBot={() => setEditingBot(bot.id)} />
      )}
      {voice && (
        <Suspense fallback={null}>
          <VoiceMode initialRequest={voice.request} onClose={() => setVoice(null)} />
        </Suspense>
      )}
      {wakeListening && (
        <button type="button" className="wake-indicator" title="Hands-free is on. Click to turn it off." onClick={() => setSettingsTab("voice")}>
          <Mic size={13} /> Listening for wake word
        </button>
      )}
      <Suspense fallback={null}>
        {settingsTab && <SettingsDialog initialTab={settingsTab} onClose={() => setSettingsTab(null)} />}
        {editingBot && <BotDialog botId={editingBot} onClose={() => setEditingBot(null)} />}
      </Suspense>
    </div>
  );
}

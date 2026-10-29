import { useCallback, useEffect, useState } from "react";
import { Section, Toggle } from "../../components/settings/controls";
import { useStore } from "../../lib/store";
import { type MacPermissions, type MacScreenshot, mac } from "./api";
import { deleteRecipe, useRecipes } from "./recipes";
import { TeachTask } from "./TeachTask";
import { isComputerControlDesktop, isLinuxDesktop, isMacDesktop, platformComputerNoun, setMacControlEnabled, useMacControl } from "./store";
import { macTools } from "./tools";

const RISK_LABEL = { read: "never asks", write: "asks per your policy", external: "asks per your policy", destructive: "always asks (unless turned off under Full access)" } as const;

/** Settings → Computer control. */
function PermissionRow({
  ok,
  title,
  status,
  use,
  action,
}: {
  ok: boolean | null;
  title: string;
  status: string;
  use: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="mac-control-perm">
      <span className={`mac-control-dot ${ok === true ? "ok" : ok === false ? "bad" : ""}`} aria-hidden />
      <div>
        <strong>{title}</strong>
        <div className="small muted">
          {status} · {use}
        </div>
      </div>
      {action && (
        <button type="button" className="btn" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

export function MacControlSettings() {
  const enabled = useMacControl((s) => s.enabled);
  const toolsOn = useStore((s) => s.settings.agent.enabled);
  const access = useStore((s) => s.settings.agent.access ?? "restricted");
  const [perms, setPerms] = useState<MacPermissions | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ src: string; note?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const device = platformComputerNoun();
  const refresh = useCallback(() => {
    void mac<MacPermissions>("permissions").then(
      (p) => {
        setPerms(p);
        setError("");
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  // Stay current while this page is open: re-check every few seconds and when the user comes back
  // from System Settings, so a switch flipped there shows up here without pressing anything.
  useEffect(() => {
    if (!isComputerControlDesktop()) return;
    refresh();
    const timer = setInterval(() => document.visibilityState === "visible" && refresh(), 2500);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  const run = (work: Promise<unknown>) => void work.catch((e: Error) => setError(e.message)).finally(refresh);

  if (!isComputerControlDesktop()) {
    return <p className="muted">Controlling the computer is available in the ADT Bot desktop app on macOS, Windows and Linux.</p>;
  }

  const testShot = async () => {
    setBusy(true);
    setError("");
    try {
      const shot = await mac<MacScreenshot>("screenshot", { maxWidth: 640 });
      setPreview({ src: `data:${shot.mediaType};base64,${shot.data}`, note: shot.note });
    } catch (e) {
      setPreview(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const screenOk = perms?.screenRecording === "granted";
  return (
    <div className="mac-control-settings">
      <Toggle
        checked={enabled}
        onChange={setMacControlEnabled}
        title={`Allow bots to control this ${device}`}
        hint={`Bots can take screenshots, move the pointer, click, type and open apps. Clicking and typing ask according to your approval policy (not with Full access); ${device === "Mac" ? "AppleScript and quitting apps" : "quitting apps"} always ask unless you turned that off. A banner with a Stop button shows while a bot is in control.`}
      />
      {enabled && !toolsOn && <p className="small mac-control-warn">"Let bots use tools" is off in Tools &amp; safety, so bots can't use this yet.</p>}
      {access === "sandbox" && <p className="small mac-control-warn">Computer access is set to Sandbox in Tools &amp; safety, so screen control is off.</p>}
      {access === "full" && !enabled && <p className="small muted">Computer access is set to Full access in Tools &amp; safety, so bots can control this {device} even with this off.</p>}

      {isLinuxDesktop() ? (
        <LinuxPermissions perms={perms} busy={busy} error={error} preview={preview} onTest={() => void testShot()} onAllow={() => {
            setBusy(true);
            run(mac("connect").finally(() => setBusy(false)));
          }} />
      ) : !isMacDesktop() ? (
        <WindowsPermissions busy={busy} error={error} preview={preview} onTest={() => void testShot()} />
      ) : (
      <Section title="macOS permissions" hint={`Switch on ${perms?.app ?? "ADT Bot"} in each list in System Settings. This page updates on its own when you come back.`}>
        <PermissionRow
          ok={perms ? perms.accessibility === true : null}
          title="Accessibility"
          status={perms ? (perms.accessibility ? "Allowed" : "Not allowed") : "Checking…"}
          use="needed to click, type and press keys"
          action={{ label: "Open System Settings", onClick: () => run(mac("openSettings", { pane: "accessibility" })) }}
        />
        <PermissionRow
          ok={perms ? screenOk : null}
          title="Screen Recording"
          status={perms ? (perms.screenNeedsRestart ? "Allowed: restart ADT Bot to finish" : screenOk ? "Allowed" : "Not allowed") : "Checking…"}
          use="needed to see other apps' windows"
          action={
            perms?.screenNeedsRestart
              ? { label: "Restart ADT Bot", onClick: () => run(mac("relaunch")) }
              : { label: "Open System Settings", onClick: () => run(mac("openSettings", { pane: "screen-recording" })) }
          }
        />
        <PermissionRow
          ok={perms?.automation === "granted" ? true : perms?.automation === "denied" ? false : null}
          title="Automation"
          status={perms?.automation === "granted" ? "Allowed" : perms?.automation === "denied" ? "Not allowed" : "Not checked yet"}
          use="typing and window titles go through System Events"
          action={
            perms?.automation === "denied"
              ? { label: "Open System Settings", onClick: () => run(mac("openSettings", { pane: "automation" })) }
              : { label: "Check", onClick: () => run(mac("checkAutomation")) }
          }
        />
        <PermissionRow
          ok={perms ? perms.microphone === "granted" : null}
          title="Microphone"
          status={perms ? (perms.microphone === "granted" ? "Allowed" : perms.microphone === "not-determined" ? "Not asked yet" : "Not allowed") : "Checking…"}
          use="needed for voice mode and dictation"
          action={
            perms?.microphone === "granted" ? undefined : { label: perms?.microphone === "not-determined" ? "Allow" : "Open System Settings", onClick: () => run(mac("requestMicrophone")) }
          }
        />
        <div className="btn-row">
          <button type="button" className="btn" onClick={refresh}>
            Check again
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void testShot()}>
            {busy ? "Capturing…" : "Test screenshot"}
          </button>
        </div>
        {error && <p className="small mac-control-warn">{error}</p>}
        {preview && (
          <figure className="mac-control-preview">
            <img src={preview.src} alt="Test screenshot of this Mac" />
            {preview.note && <figcaption className="small muted">{preview.note}</figcaption>}
          </figure>
        )}
      </Section>
      )}

      <Section title="Tools" hint={`Turn the "Control this ${device}" group on or off per bot in its settings.`}>
        <ul className="mac-control-tools small">
          {macTools.map((t) => (
            <li key={t.name}>
              <code>{t.name}</code> <span className="muted">— {VARIABLE_RISK[t.name] ?? RISK_LABEL[t.risk]}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Recipes />
    </div>
  );
}

/** Windows needs no permission for UI Automation; apps run as administrator are the one limit. */
function WindowsPermissions({ busy, error, preview, onTest }: { busy: boolean; error: string; preview: { src: string; note?: string } | null; onTest: () => void }) {
  return (
    <Section title="Windows" hint="Windows needs no extra permission: bots read apps through UI Automation, which is built into Windows.">
      <p className="small muted">
        Apps running as administrator can't be read or controlled unless ADT Bot runs as administrator too. Some apps only show their controls after a moment, or not at all; bots then fall back to screenshots.
      </p>
      <div className="btn-row">
        <button type="button" className="btn" disabled={busy} onClick={onTest}>
          {busy ? "Capturing…" : "Test screenshot"}
        </button>
      </div>
      {error && <p className="small mac-control-warn">{error}</p>}
      {preview && (
        <figure className="mac-control-preview">
          <img src={preview.src} alt="Test screenshot of this PC" />
          {preview.note && <figcaption className="small muted">{preview.note}</figcaption>}
        </figure>
      )}
    </Section>
  );
}

const LINUX_INPUT: Record<string, string> = {
  xtest: "Working",
  portal: "Allowed",
  "portal-saved": "Allowed (the desktop remembers your OK)",
  "portal-needs-approval": "Needs your OK once",
  none: "Not available",
};

/**
 * Linux: what works on this desktop. X11 needs nothing; on Wayland the desktop asks once before a bot
 * can use the pointer and keyboard (and may ask about screenshots).
 */
function LinuxPermissions({
  perms,
  busy,
  error,
  preview,
  onTest,
  onAllow,
}: {
  perms: MacPermissions | null;
  busy: boolean;
  error: string;
  preview: { src: string; note?: string } | null;
  onTest: () => void;
  onAllow: () => void;
}) {
  const l = perms?.linux;
  const wayland = l?.session === "wayland";
  return (
    <Section
      title={wayland ? "Linux (Wayland)" : l?.session === "x11" ? "Linux (X11)" : "Linux"}
      hint="Bots read and press apps' controls through AT-SPI, Linux's accessibility system, and see the screen through screenshots."
    >
      <PermissionRow
        ok={l ? l.atspi : null}
        title="Reading apps"
        status={l ? (l.atspi ? "Working" : "Not available") : "Checking…"}
        use="needed to list apps' controls, press them and fill in fields"
      />
      <PermissionRow
        ok={l ? l.screenshot !== "none" : null}
        title="Screenshots"
        status={l ? (l.screenshot === "none" ? "Not available" : wayland ? "Through the desktop (it may ask the first time)" : "Working") : "Checking…"}
        use="needed to see the screen"
      />
      <PermissionRow
        ok={l ? l.input !== "none" && l.input !== "portal-needs-approval" : null}
        title="Pointer and keyboard"
        status={l ? (LINUX_INPUT[l.input] ?? l.input) : "Checking…"}
        use="needed to click and type"
        action={l?.input === "portal-needs-approval" ? { label: busy ? "Waiting for your OK…" : "Allow control", onClick: onAllow } : undefined}
      />
      <PermissionRow
        ok={l?.ocr ? true : null}
        title="Reading text on screen"
        status={l ? (l.ocr ? "Working" : "Optional: sudo apt install tesseract-ocr (Fedora: sudo dnf install tesseract)") : "Checking…"}
        use="lets bots find words on screen that apps don't report, and click them"
      />
      {l?.input === "portal-needs-approval" && (
        <p className="small muted">
          The desktop shows its own dialog: turn on <strong>Allow Remote Interaction</strong>, keep <strong>Remember This Selection</strong> ticked, and click
          Share. It remembers the answer, and Stop all bots ends the session. Only you can answer the desktop's dialogs: bots can't.
        </p>
      )}
      {(l?.missing.length ?? 0) > 0 && (
        <p className="small mac-control-warn">
          Missing: {l!.missing.join(", ")}. On Ubuntu or Debian: sudo apt install python3-gi gir1.2-atspi-2.0 at-spi2-core (Fedora: sudo dnf install python3-gobject at-spi2-core),
          then restart ADT Bot.
        </p>
      )}
      {l?.error && <p className="small mac-control-warn">{l.error}</p>}
      <p className="small muted">
        Apps made with GTK or Qt, Firefox, Chrome and Electron apps show their controls. Others still work through screenshots and clicks.
        {wayland ? " On Wayland apps can't report where their controls are on screen, so bots press them by name, or click points in a screenshot." : ""}
      </p>
      <div className="btn-row">
        <button type="button" className="btn" disabled={busy} onClick={onTest}>
          {busy ? "Capturing…" : "Test screenshot"}
        </button>
      </div>
      {error && <p className="small mac-control-warn">{error}</p>}
      {preview && (
        <figure className="mac-control-preview">
          <img src={preview.src} alt="Test screenshot of this PC" />
          {preview.note && <figcaption className="small muted">{preview.note}</figcaption>}
        </figure>
      )}
    </Section>
  );
}

/** Tools whose risk depends on what they're asked to do. */
const VARIABLE_RISK: Record<string, string> = {
  mac_open_app: "opening asks per your policy, quitting always asks",
  mac_press: "asks per your policy; delete, pay, sign out and similar always ask",
  mac_set_text: "asks per your policy; typing into a terminal always asks",
  mac_browser: "reading runs on its own; clicking and typing ask per your policy; payments, deletes and passwords always ask",
  mac_recipes: "listing runs on its own; saving asks per your policy",
  mac_recipe_run: "asks like its riskiest step",
  mac_applescript: "follows your Computer access; scripts that delete, quit apps, shut down, need admin rights or run risky shell commands always ask",
};

function Recipes() {
  const recipes = useRecipes((s) => s.recipes);
  return (
    <Section title="Recipes" hint="Tasks a bot worked out once and saved, so it can repeat them quickly the same way. Bots save them after doing something you're likely to ask for again, or teach one yourself.">
      {isMacDesktop() && <TeachTask />}
      {recipes.length ? (
        <ul className="mac-control-recipes">
          {recipes.map((r) => (
            <li key={r.name}>
              <div>
                <strong>{r.name}</strong>
                {r.params.length > 0 && <span className="muted small"> · {r.params.join(", ")}</span>}
                <div className="small muted">
                  {r.description || `${r.steps.length} steps`} · {r.steps.length} steps · {r.runs ? `run ${r.runs} time${r.runs === 1 ? "" : "s"}` : "not run yet"}
                </div>
              </div>
              <button type="button" className="btn danger" onClick={() => deleteRecipe(r.name)} aria-label={`Delete the recipe ${r.name}`}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">None yet. Ask a bot to do something in an app, then “save that as a recipe”.</p>
      )}
    </Section>
  );
}

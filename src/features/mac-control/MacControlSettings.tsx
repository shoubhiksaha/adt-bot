import { useCallback, useEffect, useState } from "react";
import { Section, Toggle } from "../../components/settings/controls";
import { useStore } from "../../lib/store";
import { type MacPermissions, type MacScreenshot, mac } from "./api";
import { isMacDesktop, setMacControlEnabled, useMacControl } from "./store";
import { macTools } from "./tools";

const RISK_LABEL = { read: "never asks", write: "asks per your policy", external: "asks per your policy", destructive: "always asks" } as const;

/** Settings → Computer control. */
export function MacControlSettings() {
  const enabled = useMacControl((s) => s.enabled);
  const toolsOn = useStore((s) => s.settings.agent.enabled);
  const [perms, setPerms] = useState<MacPermissions | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ src: string; note?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setError("");
    void mac<MacPermissions>("status").then(setPerms, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (isMacDesktop()) refresh();
  }, [refresh]);

  if (!isMacDesktop()) {
    return <p className="muted">Controlling the computer is available in the ADT Bot desktop app on macOS.</p>;
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
        title="Allow bots to control this Mac"
        hint="Bots can take screenshots, move the pointer, click, type and open apps. Clicking and typing ask according to your approval policy; AppleScript and quitting apps always ask. A banner with a Stop button shows while a bot is in control."
      />
      {enabled && !toolsOn && <p className="small mac-control-warn">"Let bots use tools" is off in Tools &amp; safety, so bots can't use this yet.</p>}

      <Section title="macOS permissions" hint={`macOS asks you to allow ${perms?.app ?? "ADT Bot"} in System Settings. After granting Screen Recording, quit and reopen the app.`}>
        <div className="mac-control-perm">
          <span className={`mac-control-dot ${perms?.accessibility ? "ok" : "bad"}`} aria-hidden />
          <div>
            <strong>Accessibility</strong>
            <div className="small muted">{perms ? (perms.accessibility ? "Allowed" : "Not allowed") : "Checking…"} · needed to click, type and press keys</div>
          </div>
          <button type="button" className="btn" onClick={() => void mac("openSettings", { pane: "accessibility" })}>
            Open System Settings
          </button>
        </div>
        <div className="mac-control-perm">
          <span className={`mac-control-dot ${screenOk ? "ok" : "bad"}`} aria-hidden />
          <div>
            <strong>Screen Recording</strong>
            <div className="small muted">{perms ? (screenOk ? "Allowed" : `Not allowed (${perms.screenRecording})`) : "Checking…"} · needed to see other apps' windows</div>
          </div>
          <button type="button" className="btn" onClick={() => void mac("openSettings", { pane: "screen-recording" })}>
            Open System Settings
          </button>
        </div>
        <div className="mac-control-perm">
          <span className="mac-control-dot" aria-hidden />
          <div>
            <strong>Automation</strong>
            <div className="small muted">Typing and window titles go through System Events; macOS asks the first time.</div>
          </div>
          <button type="button" className="btn" onClick={() => void mac("openSettings", { pane: "automation" })}>
            Open System Settings
          </button>
        </div>
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

      <Section title="Tools" hint='Turn the "Control this Mac" group on or off per bot in its settings.'>
        <ul className="mac-control-tools small">
          {macTools.map((t) => (
            <li key={t.name}>
              <code>{t.name}</code> <span className="muted">— {t.riskFor ? "opening asks per your policy, quitting always asks" : RISK_LABEL[t.risk]}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

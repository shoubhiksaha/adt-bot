import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { desktopOn, isDesktop } from "../../lib/desktop";
import { useStore } from "../../lib/store";
import { detectEnv, type Platform } from "../../lib/transport";
import { BUILD_VERSION, tokenProblem, updateActions, updates, updateSummary, type UpdateState } from "../../lib/updates";
import { Section, Toggle } from "./controls";

export function AboutSettings() {
  const name = useStore((s) => s.settings.brand.name);
  const desktop = isDesktop();
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [state, setState] = useState<UpdateState | null>(null);
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void detectEnv().then((env) => setPlatform(env.platform));
    if (!desktop) return;
    void updates
      .state()
      .then(setState)
      .catch(() => undefined);
    return desktopOn<UpdateState>("adt:updates:changed", setState);
  }, [desktop]);

  const run = async (action: () => Promise<UpdateState>) => {
    setMessage("");
    try {
      setState(await action());
    } catch (error) {
      setMessage((error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };

  const version = state?.appVersion || BUILD_VERSION;
  const actions = state ? updateActions(state) : { check: false, install: false };
  const problem = tokenProblem(token);

  return (
    <div>
      <Section title={name || "ADT Bot"}>
        <p style={{ margin: 0 }}>Version {version || "unknown"}</p>
        {!desktop && platform && (
          <p className="small muted">
            {platform === "web" ? "The web app updates itself when you reload the page." : "Install a newer build of the app to update it."}
          </p>
        )}
      </Section>

      {desktop && state && (
        <Section title="Updates">
          <p className={`status${state.status === "error" ? " err" : state.status === "available" ? " ok" : ""}`} style={{ marginTop: 0 }}>
            {updateSummary(state)}
          </p>
          {state.status === "downloading" && <progress value={state.percent} max={100} style={{ width: "100%", marginBottom: 10 }} />}
          {!state.unsupported && (
            <>
              <div className="btn-row" style={{ marginBottom: 14 }}>
                <button type="button" className="btn" disabled={!actions.check} onClick={() => void run(updates.check)}>
                  {state.status === "checking" && <Loader2 size={14} className="spin" />} Check for updates
                </button>
                {actions.install && (
                  <button type="button" className="btn primary" onClick={() => void run(updates.install)}>
                    Download and restart
                  </button>
                )}
              </div>
              <Toggle
                checked={state.autoCheck}
                onChange={(enabled) => void run(() => updates.setAuto(enabled))}
                title="Check for updates automatically"
                hint="Once a day. It only tells you; nothing is downloaded or installed until you choose Download and restart."
              />
              {state.source === "feed" ? (
                <p className="small muted">Using the test update feed set in ADT_UPDATE_FEED.</p>
              ) : (
                <div className="field">
                  <label htmlFor="update-token">GitHub token (only needed while the repo is private)</label>
                  <div className="input-group">
                    <input
                      id="update-token"
                      className="input"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={state.token ? "Saved. Paste a new one to replace it." : "github_pat_…"}
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn"
                      disabled={!token.trim() || Boolean(problem)}
                      onClick={() => void run(() => updates.setToken(token)).then(() => setToken(""))}
                    >
                      Save
                    </button>
                    {state.token && (
                      <button type="button" className="btn" onClick={() => void run(() => updates.setToken(""))}>
                        Remove
                      </button>
                    )}
                  </div>
                  <span className="small muted">
                    A fine-grained token with read-only access to this repository's contents.{" "}
                    {state.keychain
                      ? "It's kept in your system keychain and never shown again."
                      : "Your system has no keyring ADT Bot can use, so it's kept only until ADT Bot quits."}
                    {state.token === "session" && " (Saved for this session.)"}
                  </span>
                  {problem && <span className="status err">{problem}</span>}
                </div>
              )}
            </>
          )}
          {message && <p className="status err">{message}</p>}
        </Section>
      )}

      <p className="small muted">
        Free and open source (Apache-2.0). Based on{" "}
        <a href="https://github.com/elie222/rakazo" target="_blank" rel="noreferrer">
          Rakazo
        </a>
        .
      </p>
    </div>
  );
}

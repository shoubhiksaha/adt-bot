// Adapted from OpenBOT (github.com/ashhart/OpenBot), MIT, (c) 2026 OpenBOT contributors.
// (ComputerFrameTerminal: transcript + command box.) Here it streams live output from the bot's container.
import { Loader2, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { computers, newRunId, onOutput } from "./api";

const MAX_TRANSCRIPT = 200_000;

export function ComputerTerminal({ botId, botName, admin, onRan }: { botId: string; botName: string; admin: boolean; onRan?: () => void }) {
  const [output, setOutput] = useState("");
  const [command, setCommand] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [asRoot, setAsRoot] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setOutput("");
    setCommand("");
    setHistory([]);
    setAsRoot(false);
  }, [botId]);

  useEffect(() => {
    if (!runId) return;
    return onOutput((e) => {
      if (e.runId === runId) setOutput((current) => `${current}${e.chunk}`.slice(-MAX_TRANSCRIPT));
    });
  }, [runId]);

  useEffect(() => {
    const el = pre.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  const run = async () => {
    const submitted = command.trim();
    if (!submitted || runId) return;
    const id = newRunId();
    const root = admin && asRoot;
    setCommand("");
    setHistory((h) => [submitted, ...h.filter((c) => c !== submitted)].slice(0, 50));
    setHistoryIndex(-1);
    setOutput((current) => `${current}${current && !current.endsWith("\n") ? "\n" : ""}${root ? "root" : "bot"}@computer:/workspace${root ? "#" : "$"} ${submitted}\n`);
    setRunId(id);
    try {
      const result = await computers.exec(botId, submitted, { runId: id, root, timeoutMs: root ? 600_000 : 300_000 });
      const tail = `${result.output ? "" : "(no output)\n"}${result.truncated ? "[output cut]\n" : ""}${result.timedOut ? "[stopped: took too long]\n" : ""}${result.cancelled ? "[cancelled]\n" : ""}[exit ${result.code}]\n`;
      setOutput((current) => `${current}${current.endsWith("\n") ? "" : "\n"}${tail}`.slice(-MAX_TRANSCRIPT));
    } catch (error) {
      setOutput((current) => `${current}Error: ${(error as Error).message}\n`);
    } finally {
      setRunId(null);
      onRan?.();
    }
  };

  return (
    <section className="cframe-terminal" aria-label={`${botName}'s terminal`}>
      <pre ref={pre} className="cframe-terminal-output" aria-live="polite">
        {output || `Ready. Commands run as the user "bot" inside ${botName}'s computer, in /workspace.\nTry: python3 -c "print(6*7)"\n`}
      </pre>
      <div className="cframe-terminal-input">
        <textarea
          className="input"
          value={command}
          rows={2}
          placeholder={asRoot ? "Root command (e.g. apt-get update && apt-get install -y ffmpeg)" : "Command to run in the computer"}
          aria-label="Command"
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void run();
            } else if (e.key === "ArrowUp" && !command.includes("\n") && history.length) {
              e.preventDefault();
              const i = Math.min(history.length - 1, historyIndex + 1);
              setHistoryIndex(i);
              setCommand(history[i]);
            } else if (e.key === "ArrowDown" && historyIndex >= 0) {
              e.preventDefault();
              const i = historyIndex - 1;
              setHistoryIndex(i);
              setCommand(i >= 0 ? history[i] : "");
            }
          }}
        />
        <div className="cframe-terminal-buttons">
          {runId ? (
            <button type="button" className="btn danger" onClick={() => void computers.cancel(runId)}>
              <Square size={13} /> Stop
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={() => void run()} disabled={!command.trim()}>
              Run
            </button>
          )}
          {runId && <Loader2 size={15} className="spin" aria-label="Running" />}
        </div>
      </div>
      <div className="cframe-terminal-foot small muted">
        {admin ? (
          <label className="toggle compact computers-inline">
            <input type="checkbox" checked={asRoot} onChange={(e) => setAsRoot(e.target.checked)} />
            <span>Run as root (for installing packages)</span>
          </label>
        ) : (
          <span>Runs as a normal user. To install system packages, allow it in Settings → Computers.</span>
        )}
        <button type="button" className="btn computers-link" onClick={() => setOutput("")}>
          Clear
        </button>
      </div>
    </section>
  );
}

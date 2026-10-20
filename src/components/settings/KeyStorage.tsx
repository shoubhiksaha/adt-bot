import { useState } from "react";
import { desktopSecretBridge, keyStorageText, summarizeKeyStorage, useKeyStorage } from "../../lib/secrets";

/** Where keys are kept on this device; a warning when the system keychain can't be used. */
export function KeyStorageNote({ warningsOnly = false }: { warningsOnly?: boolean }) {
  const modes = useKeyStorage((s) => s.modes);
  const [done, setDone] = useState(false);
  const summary = summarizeKeyStorage(modes);
  const warning = summary === "unencrypted" || summary === "locked";
  const text = keyStorageText(summary);
  if (!text || (warningsOnly && !warning)) return null;

  // Keys saved under a keychain key that's gone for good (keychain reset) would stay locked forever.
  const forget = async () => {
    if (!confirm("Delete the saved keys that can't be unlocked? You'll need to enter them again.")) return;
    const bridge = desktopSecretBridge();
    for (const [store, mode] of Object.entries(modes)) if (mode === "locked") await bridge?.clear(store);
    setDone(true);
  };

  return (
    <div className={warning ? "card" : undefined} style={{ marginBottom: 14 }}>
      <p className={`small${warning ? "" : " muted"}`} style={{ margin: 0 }}>
        {summary === "unencrypted" && <strong>Keys aren't encrypted. </strong>}
        {summary === "locked" && <strong>Keys are locked. </strong>}
        {text}
      </p>
      {summary === "locked" &&
        (done ? (
          <p className="small" style={{ marginBottom: 0 }}>
            Deleted. Restart ADT Bot, then enter those keys again.
          </p>
        ) : (
          <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => void forget()}>
            Forget the locked keys
          </button>
        ))}
    </div>
  );
}

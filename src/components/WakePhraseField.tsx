import { updateBot } from "../lib/store";
import type { Bot } from "../lib/types";
import { normalize, wakePhraseOf } from "../lib/voice-commands";

/** A bot's own wake phrase (bot settings, and Settings → Voice for the bot you're talking to). */
export function WakePhraseField({ bot, label = "Wake phrase" }: { bot: Bot; label?: string }) {
  const phrase = bot.wakePhrase ?? "";
  const short = phrase.trim() !== "" && normalize(phrase).replace(/ /g, "").length < 4;
  return (
    <div className="field">
      <label htmlFor={`wake-phrase-${bot.id}`}>{label}</label>
      <input
        id={`wake-phrase-${bot.id}`}
        className="input"
        maxLength={60}
        placeholder={wakePhraseOf({ ...bot, wakePhrase: "" })}
        value={phrase}
        onChange={(e) => updateBot(bot.id, { wakePhrase: e.target.value })}
      />
      {short ? (
        <span className="small error-text">A phrase this short is said by accident, so it may wake the bot when you don't mean it to.</span>
      ) : (
        <span className="small muted">
          What you say to wake it, like “Computer” or “Wake up Friday”, alone or before a request. Empty: “{wakePhraseOf({ ...bot, wakePhrase: "" })}”.
        </span>
      )}
    </div>
  );
}

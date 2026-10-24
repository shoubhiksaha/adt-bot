/**
 * What voice mode lets the bot do to voice mode itself, while it's open (set by VoiceSession).
 * Separate from chat.ts so tools can use it without importing the chat pipeline.
 */
let closer: (() => void) | null = null;

/** Voice mode registers how to close itself once the current reply has been spoken. */
export function setVoiceCloser(close: (() => void) | null) {
  closer = close;
}

export function voiceCloser(): (() => void) | null {
  return closer;
}

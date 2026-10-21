/** Modifier label for shortcuts: ⌘ on Apple devices, Ctrl+ elsewhere. */
export const IS_APPLE = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = IS_APPLE ? "⌘" : "Ctrl+";

/** The new-chat shortcut as each platform writes it. */
export const NEW_CHAT_KEYS = IS_APPLE ? "⇧⌘O" : "Ctrl+Shift+O";

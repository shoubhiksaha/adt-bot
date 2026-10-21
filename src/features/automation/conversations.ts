import { openView } from "../registry";
import { openConversation, uid, useStore } from "../../lib/store";
import type { Conversation } from "../../lib/types";

/** Adds a chat without switching the screen to it (routine runs, delegated tasks). */
export function addBackgroundConversation(botId: string, title: string, temporary = false, origin: Conversation["origin"] = "task"): Conversation {
  const conversation: Conversation = {
    id: uid(),
    botId,
    title: title.length > 60 ? `${title.slice(0, 59)}…` : title,
    messages: [],
    updatedAt: Date.now(),
    // Our own title; the smart titler leaves it alone.
    titled: true,
    temporary: temporary || undefined,
    origin,
  };
  useStore.setState((s) => ({ conversations: { ...s.conversations, [conversation.id]: conversation } }));
  return conversation;
}

/** Leaves any feature screen and shows the chat. */
export function showConversation(conversationId: string) {
  if (!useStore.getState().conversations[conversationId]) return;
  openConversation(conversationId);
  openView(null);
}

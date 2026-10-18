import { useStore } from "../lib/store";
import type { Bot } from "../lib/types";

const isImage = (value: string) => /^(data:image|https?:|\.\/|blob:)/.test(value);

/** An emoji/text avatar, or an image (uploaded logo). */
export function Avatar({ value, size }: { value: string; size?: "lg" | "mini" }) {
  return (
    <span className={`avatar${size === "lg" ? " lg" : ""}${size === "mini" ? " mini" : ""}${isImage(value) ? " has-image" : ""}`}>
      {isImage(value) ? <img src={value} alt="" /> : value}
    </span>
  );
}

/** The bot's avatar, or the brand logo for the main bot when "use logo as avatar" is on. */
export function useBotAvatar(bot: Pick<Bot, "id" | "avatar"> | undefined): string {
  return useStore((s) => {
    if (!bot) return "";
    const { logo, logoAsAvatar } = s.settings.brand;
    return logo && logoAsAvatar && s.bots[0]?.id === bot.id ? logo : bot.avatar;
  });
}

export function BotAvatar({ bot, size }: { bot: Pick<Bot, "id" | "avatar">; size?: "lg" | "mini" }) {
  return <Avatar value={useBotAvatar(bot)} size={size} />;
}

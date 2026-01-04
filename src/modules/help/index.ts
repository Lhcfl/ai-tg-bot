import type { Context } from "@/lib/bot-proxy";

export function Help(ctx: Context) {
  ctx.command({
    command: "help",
    description: "/help 显示帮助信息",
  });

  ctx.bot.onText(/^\/help$/, async (msg) => {
    await ctx.bot.sendMessage(msg.chat.id, "帮助 WIP", {
      reply_to_message_id: msg.message_id,
    });
  });
}

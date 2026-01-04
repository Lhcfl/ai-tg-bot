import type { Context } from "@/lib/bot-proxy";
import { markdownToTelegramHtml } from "@/lib/markdown";

export function Help(ctx: Context) {
  ctx.command(
    {
      command: "help",
      description: "显示帮助信息",
    },
    async (msg) => {
      await ctx.bot.sendMessage(
        msg.chat.id,
        await markdownToTelegramHtml(
          `# 帮助\n\n ${ctx.commands.map((cmd) => `/${cmd.command} ${cmd.description}`).join("\n")}`,
        ),
        {
          reply_to_message_id: msg.message_id,
          parse_mode: "HTML",
        },
      );
    },
  );
}

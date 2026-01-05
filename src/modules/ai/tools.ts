import type { Tool } from "ai";
import type TelegramBot from "node-telegram-bot-api";
import z from "zod";
import type { Context } from "@/lib/bot-proxy";
import { markdownToTelegramHtml } from "@/lib/markdown";

export const SYSTEM_PROMPT_DEFAULT = `你是一个接入了 AI 的群聊机器人。
你会帮助用户回答问题，提供建议，或者进行有趣的对话。`;

export const AutoReplySchema = z.object({
  kind: z.literal("auto_reply"),
  when: z.string(),
  message: z.string(),
});

export const ReplyAfterSchema = z.object({
  timeout: z.number().min(1),
  message: z.string(),
});

export const RememberSchema = z.object({
  message: z.string(),
});

import { createTable } from "@/lib/db";
import { concat } from "@/lib/multiline";

// 定义表结构
export const memoriesTable = createTable("memories", {
  id: { type: "INTEGER", primaryKey: true, autoIncrement: true },
  chat_id: { type: "INTEGER", notNull: true },
  message: { type: "TEXT", notNull: true },
  created_at: { type: "INTEGER", notNull: true },
}).index("idx_memories_chat_id", ["chat_id"]);

export const execsTable = createTable("execs", {
  id: { type: "INTEGER", primaryKey: true, autoIncrement: true },
  chat_id: { type: "INTEGER", notNull: true },
  value: { type: "TEXT", notNull: true },
  created_at: { type: "INTEGER", notNull: true },
}).index("idx_execs_chat_id", ["chat_id"]);

export const promptsTable = createTable("prompts", {
  chat_id: { type: "INTEGER", primaryKey: true },
  value: { type: "TEXT", notNull: true },
  created_at: { type: "INTEGER", notNull: true },
});

export const toolsInit = async ({ db }: Context) => {
  // 创建表
  await memoriesTable.init(db);
  await execsTable.init(db);
  await promptsTable.init(db);
};

export function replaceMessage(msg: TelegramBot.Message, template: string) {
  return template.replaceAll(
    "$username",
    `@${msg.from?.username || msg.from?.first_name}`,
  );
}

function makeTool<T extends Tool>(tool: T): T {
  return tool;
}

export const makeToolSet = (ctx: Context, msg: TelegramBot.Message) => ({
  auto_reply: makeTool({
    description: concat(
      "该工具允许 bot 未来当收到匹配 /{when}/i 这一正则表达式的消息时，自动回复 {message} 的内容。",
      "正则表达式可以使用 $1, $2 等等来引用捕获组。",
      "只有用户明确要求自动回复时，才应当使用该工具。",
      `"kind": "auto_reply" 不可以忽略。`,
    ),
    inputSchema: AutoReplySchema,
    inputExamples: [
      {
        input: {
          kind: "auto_reply",
          when: "^你好$",
          message: "你好！有什么可以帮您的吗？",
        },
      },
    ],
    strict: true,
    async execute(input) {
      await execsTable.insert({
        chat_id: msg.chat.id,
        value: JSON.stringify(input),
        created_at: Date.now(),
      });
      ctx.bot.sendMessage(msg.chat.id, `成功地注册了 auto_reply`, {
        reply_to_message_id: msg.message_id,
      });
      return "ok";
    },
  }),
  reply_after: makeTool({
    description: "在 {timeout} 毫秒后回复一条消息，内容为 {message}。",
    inputSchema: ReplyAfterSchema,
    strict: true,
    async execute(input) {
      ctx.bot.sendMessage(msg.chat.id, `成功地注册了 reply_after`, {
        reply_to_message_id: msg.message_id,
      });
      setTimeout(async () => {
        void ctx.bot.sendMessage(
          msg.chat.id,
          await markdownToTelegramHtml(replaceMessage(msg, input.message)),
          {
            reply_to_message_id: msg.message_id,
            parse_mode: "HTML",
          },
        );
      }, input.timeout);
    },
  }),
  remember: makeTool({
    description: "跨越会话记住一段信息，内容为 {message}。",
    inputSchema: RememberSchema,
    strict: true,
    async execute(input) {
      await memoriesTable.insert({
        chat_id: msg.chat.id,
        message: input.message,
        created_at: Date.now(),
      });
      ctx.bot.sendMessage(msg.chat.id, `记住了 ${input.message}`, {
        reply_to_message_id: msg.message_id,
      });
      return "ok";
    },
  }),
});

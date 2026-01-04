import type { Tool } from "ai";
import type TelegramBot from "node-telegram-bot-api";
import z from "zod";
import type { Context } from "@/lib/bot-proxy";
import { markdownToTelegramHtml } from "@/lib/markdown";

const EXAMPLE = {
  kind: "auto_reply",
  when: "^hello$",
  message: "Hi there! How can I assist you today?",
};

export const SYSTEM_PROMPT_DEFAULT = `你是一个接入了 AI 的群聊机器人。
你会帮助用户回答问题，提供建议，或者进行有趣的对话。`;

export const PROMPT_TOOLS = `
请确保你的回答简洁明了，避免过长的回复。
除非使用工具，你没有记忆。

# 执行工具

你可以在输出中使用语言为 "exec" 的代码块，内部写 JSON，来执行系统命令。例如：

\`\`\`exec
${JSON.stringify(EXAMPLE)}
\`\`\`

除了 "remember" 以外，只有在用户明确说的时候才应该使用工具。
*必须* 确保生成的 JSON 格式正确无误。

# 工具类型

- auto_reply: 以后当收到匹配 {when} 正则表达式的消息时，自动回复 {message} 内容。
  正则表达式可以使用 $1, $2 等来引用捕获组。

- reply_timeout: 在 {timeout} 毫秒后回复一条消息，内容为 {message}。

- remember: 记住一段信息，内容为 {message}。

# 替换

所有 "message" 字段都可以：
- 使用 $username 来引用发送消息的用户名。
- 使用 $1, $2 等来引用正则表达式的捕获组（如果有）。
`;

export const AutoReplySchema = z.object({
  kind: z.literal("auto_reply"),
  when: z.string(),
  message: z.string(),
});

export const ReplyAfterSchema = z.object({
  kind: z.literal("reply_after"),
  timeout: z.number().min(1),
  message: z.string(),
});

export const RememberSchema = z.object({
  kind: z.literal("remember"),
  message: z.string(),
});

export const aiSchema = z.xor([
  AutoReplySchema,
  ReplyAfterSchema,
  RememberSchema,
]);

import { createTable } from "@/lib/db";

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

export const toolsInit = ({ db }: Context) => {
  // 创建表
  memoriesTable.init(db);
  execsTable.init(db);
  promptsTable.init(db);
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
    description:
      "以后当收到匹配 {when} 正则表达式的消息时，自动回复 {message} 内容。正则表达式可以使用 $1, $2 等等来引用捕获组。",
    inputSchema: AutoReplySchema,
    strict: true,
    async execute(input) {
      execsTable.insert({
        chat_id: msg.chat.id,
        value: JSON.stringify(input),
        created_at: Date.now(),
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
    description: "记住一段信息，内容为 {message}。",
    inputSchema: RememberSchema,
    strict: true,
    async execute(input) {
      memoriesTable.insert({
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

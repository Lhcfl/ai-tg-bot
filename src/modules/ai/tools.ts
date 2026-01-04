import type { Context } from "@/lib/bot-proxy";
import type TelegramBot from "node-telegram-bot-api";
import z from "zod";

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

export const execSchema = z.object({
  kind: z.literal("auto_reply"),
  when: z.string(),
  message: z.string(),
});

export const aiSchema = z.xor([
  execSchema,
  z.object({
    kind: z.literal("reply_timeout"),
    timeout: z.number().min(1),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("remember"),
    message: z.string(),
  }),
]);

export const toolsInit = ({ sqlite }: Context) => sqlite`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memories_chat_id ON memories (chat_id);

    CREATE TABLE IF NOT EXISTS execs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_execs_chat_id ON execs (chat_id);
  `;

export function replaceMessage(msg: TelegramBot.Message, template: string) {
  return template.replaceAll(
    "$username",
    `@${msg.from?.username || msg.from?.first_name}`,
  );
}

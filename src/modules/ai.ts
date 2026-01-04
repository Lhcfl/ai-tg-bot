import type { Context } from "@/lib/bot-proxy";
import { parseJSONSafe, safeJsonParseAsync } from "@/lib/json";
import { extractExec, markdownToTelegramHtml } from "@/lib/markdown";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { streamText } from "ai";
import type TelegramBot from "node-telegram-bot-api";
import z, { set } from "zod";

const EXAMPLE = {
  kind: "auto_reply",
  when: "^hello$",
  message: "Hi there! How can I assist you today?",
};

const PROMPT_SYSTEM = `你是一个接入了 AI 的群聊机器人。
你会帮助用户回答问题，提供建议，或者进行有趣的对话。
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

const toolsSchema = z.object({
  kind: z.literal("auto_reply"),
  when: z.string(),
  message: z.string(),
});

const schema = z.xor([
  toolsSchema,
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

function replaceMessage(msg: TelegramBot.Message, template: string) {
  return template.replaceAll(
    "$username",
    `@${msg.from?.username || msg.from?.first_name}`,
  );
}

export async function Ai({ bot, me, config, sqlite }: Context) {
  console.log("[AI] Initializing AI Database...");

  await sqlite`
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

  bot.on("message", async (msg) => {
    const execsRaw: {
      id: number;
      chat_id: number;
      value: string;
      created_at: number;
    }[] = await sqlite`SELECT * FROM execs WHERE chat_id = ${msg.chat.id}`;

    console.log(execsRaw);

    const execsArr = await Promise.all(
      execsRaw.map((x) => safeJsonParseAsync(toolsSchema, x.value)),
    );

    console.log(execsArr);

    for (const execRes of execsArr) {
      if (execRes.success) {
        const exec = execRes.data;
        const regex = new RegExp(exec.when, "i");
        const match = msg.text ? msg.text.match(regex) : null;
        if (match) {
          const response = exec.message.replace(
            /\$(\d+)/g,
            (_, g1) => match[parseInt(g1, 10)] || "",
          );
          await bot.sendMessage(msg.chat.id, replaceMessage(msg, response), {
            reply_to_message_id: msg.message_id,
          });
        }
      }
    }
  });

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || "";
    const from = msg.from;

    console.debug("[msg]", chatId, from?.username, ":", text);

    if (!from || !text) return;

    // Check if the message mentions the bot
    const mentionRegex = new RegExp(`@${me.username}`, "i");
    if (!mentionRegex.test(text)) return;

    // Remove the mention from the text
    const txt = text.replace(mentionRegex, "").trim();

    if (!txt) return;

    async function registerCommand(response: string) {
      const execs = await extractExec(response);
      return Promise.allSettled(
        execs.map(async (x) => {
          const parsed = await safeJsonParseAsync(schema, x);

          if (parsed.success) {
            const exec = parsed.data;
            switch (exec.kind) {
              case "remember": {
                await sqlite`
                    INSERT INTO memories (chat_id, message, created_at)
                    VALUES (${chatId}, ${exec.message}, ${Date.now()});
                  `;
                break;
              }

              case "auto_reply": {
                await sqlite`
                    INSERT INTO execs (chat_id, value, created_at)
                    VALUES (${chatId}, ${x}, ${Date.now()});
                  `;
                break;
              }

              case "reply_timeout": {
                setTimeout(async () => {
                  void bot.sendMessage(
                    chatId,
                    await markdownToTelegramHtml(
                      replaceMessage(msg, exec.message),
                    ),
                    {
                      reply_to_message_id: msg.message_id,
                      parse_mode: "HTML",
                    },
                  );
                }, exec.timeout);
                break;
              }
            }

            void bot.sendMessage(chatId, `成功地注册了一个命令：${exec.kind}`, {
              reply_to_message_id: msg.message_id,
            });
          } else {
            void bot.sendMessage(
              chatId,
              `失败地注册了一个命令 ${x}，错误：${z.prettifyError(parsed.error)}`,
              { reply_to_message_id: msg.message_id },
            );
          }
        }),
      );
    }

    try {
      const openrouter = createOpenRouter({
        apiKey: config.openrouter_api_key,
      });

      // Send initial message
      const sentMessage = await bot.sendMessage(
        chatId,
        "Generating response...",
        { reply_to_message_id: msg.message_id },
      );

      let fullResponse = "";
      let lastResponse = "";
      let lastEditTime = Date.now() - 6000;

      // Use AI to generate response with streaming
      const result = streamText({
        model: openrouter(config.model, {}), // or any model you prefer
        messages: [
          { role: "system", content: PROMPT_SYSTEM },
          {
            role: "user",
            content: `@${msg.from?.username} (${msg.from?.first_name} ${msg.from?.last_name || ""}) 发送了一条消息：${txt}`,
          },
        ],
        headers: {
          "X-Title": `Telegram Bot`,
        },
      });

      // Collect chunks
      for await (const chunk of result.textStream) {
        fullResponse += chunk;
        console.debug(fullResponse);
        const now = Date.now();
        if (
          fullResponse.length - lastResponse.length >= 50 && // Send every 50 new characters
          now - lastEditTime >= 6000 // Edit every 6 seconds
        ) {
          await bot.editMessageText(
            await markdownToTelegramHtml(fullResponse),
            {
              chat_id: chatId,
              message_id: sentMessage.message_id,
              parse_mode: "HTML",
            },
          );
          lastEditTime = now;
          lastResponse = fullResponse;
        }
      }

      // Final edit with complete response
      const telegramHtml = await markdownToTelegramHtml(fullResponse);

      await Promise.all([
        registerCommand(fullResponse),
        bot.editMessageText(telegramHtml, {
          chat_id: chatId,
          message_id: sentMessage.message_id,
          parse_mode: "HTML",
        }),
      ]);
    } catch (error) {
      console.error("Error generating response:", error);
      bot.sendMessage(
        chatId,
        "Sorry, an error occurred while generating the response.",
        { reply_to_message_id: msg.message_id },
      );
    }
  });
}

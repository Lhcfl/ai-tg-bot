import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { type ModelMessage, streamText } from "ai";
import type TelegramBot from "node-telegram-bot-api";
import z from "zod";
import type { Context } from "@/lib/bot-proxy";
import { createCacheRecord } from "@/lib/cache";
import { safeJsonParseAsync } from "@/lib/json";
import { extractExec, markdownToTelegramHtml } from "@/lib/markdown";
import {
  aiSchema,
  execSchema,
  PROMPT_TOOLS,
  replaceMessage,
  SYSTEM_PROMPT_DEFAULT,
  toolsInit,
} from "./tools";

export async function Ai(ctx: Context) {
  console.log("[AI] Initializing AI Database...");

  const { bot, me, config, sqlite } = ctx;

  await toolsInit(ctx);

  const execsCache = createCacheRecord(async (chatId: number) => {
    const execsRaw: {
      id: number;
      chat_id: number;
      value: string;
      created_at: number;
    }[] = await sqlite`SELECT * FROM execs WHERE chat_id = ${chatId}`;

    return Promise.all(
      execsRaw.map((x) => safeJsonParseAsync(execSchema, x.value)),
    );
  });

  const memoriesCache = createCacheRecord(async (chatId: number) => {
    const memories: { id: number; chat_id: number; message: string }[] =
      await sqlite`SELECT * FROM memories WHERE chat_id = ${chatId} ORDER BY created_at DESC LIMIT 10`;

    return memories;
  });

  async function registerCommand(msg: TelegramBot.Message, response: string) {
    const execs = await extractExec(response);
    return Promise.allSettled(
      execs.map(async (x) => {
        const parsed = await safeJsonParseAsync(aiSchema, x);

        if (parsed.success) {
          const exec = parsed.data;
          switch (exec.kind) {
            case "remember": {
              await sqlite`
                    INSERT INTO memories (chat_id, message, created_at)
                    VALUES (${msg.chat.id}, ${exec.message}, ${Date.now()});
                  `;
              break;
            }

            case "auto_reply": {
              await sqlite`
                    INSERT INTO execs (chat_id, value, created_at)
                    VALUES (${msg.chat.id}, ${x}, ${Date.now()});
                  `;

              execsCache(msg.chat.id).invalidate();
              break;
            }

            case "reply_timeout": {
              setTimeout(async () => {
                void bot.sendMessage(
                  msg.chat.id,
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

          void bot.sendMessage(
            msg.chat.id,
            `成功地注册了一个命令：${exec.kind}`,
            {
              reply_to_message_id: msg.message_id,
            },
          );
        } else {
          void bot.sendMessage(
            msg.chat.id,
            `失败地注册了一个命令 ${x}，错误：${z.prettifyError(parsed.error)}`,
            { reply_to_message_id: msg.message_id },
          );
        }
      }),
    );
  }

  bot.onText(/^\/prompt(\s+?[\S\s]+)?/, async (msg, match) => {
    const newPrompt = match?.[1]?.trim();

    await bot.sendMessage(
      msg.chat.id,
      await markdownToTelegramHtml(`当前的系统提示是：\n\n${PROMPT_TOOLS}`),
      {
        reply_to_message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );

    if (newPrompt) {
      await bot.sendMessage(msg.chat.id, `该功能未完成`);
    }
  });

  bot.on("message", async (msg) => {
    const execsArr = await execsCache(msg.chat.id).get();

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
    if (!msg.from || !msg.text) return;

    const condition =
      msg.text.includes(`@${me.username}`) ||
      msg.reply_to_message?.from?.id === me.id;

    if (!condition) return;

    try {
      const openrouter = createOpenRouter({
        apiKey: config.openrouter_api_key,
      });

      // Send initial message
      const sentMessage = await bot.sendMessage(
        msg.chat.id,
        "正在生成回复，请稍候...",
        { reply_to_message_id: msg.message_id },
      );

      const memories = await memoriesCache(msg.chat.id).get();

      function generateMessage(msg?: TelegramBot.Message): ModelMessage[] {
        if (!msg) return [];
        if (!msg.from) return [];
        const from = msg.from;
        if (from.id === me.id) {
          return [
            ...generateMessage(msg.reply_to_message),
            {
              role: "assistant",
              content: `${msg.text}`,
            },
          ];
        } else {
          return [
            ...generateMessage(msg.reply_to_message),
            {
              role: "user",
              content: `@${from.username} (${from.first_name} ${from.last_name || ""}) 发送了一条消息：${msg.text}`,
            },
          ];
        }
      }

      // Use AI to generate response with streaming
      const result = streamText({
        model: openrouter(config.model, {}), // or any model you prefer
        messages: [
          { role: "system", content: SYSTEM_PROMPT_DEFAULT },
          { role: "system", content: PROMPT_TOOLS },
          {
            role: "assistant",
            content: [
              `我的用户名是 @${me.username}。`,
              `我的昵称是 ${me.first_name}。`,
              `我有以下记忆：`,
              ...memories.map((x) => `- ${x.message}`),
            ].join("\n"),
          },
          ...generateMessage(msg),
        ],
        headers: {
          "X-Title": `Telegram Bot`,
        },
      });

      let fullResponse = "";
      let lastResponse = "";
      let lastEditTime = Date.now() - 6000;

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
              chat_id: msg.chat.id,
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
        registerCommand(msg, fullResponse),
        bot.editMessageText(telegramHtml, {
          chat_id: msg.chat.id,
          message_id: sentMessage.message_id,
          parse_mode: "HTML",
        }),
      ]);
    } catch (error) {
      console.error("Error generating response:", error);
      bot.sendMessage(
        msg.chat.id,
        "Sorry, an error occurred while generating the response.",
        { reply_to_message_id: msg.message_id },
      );
    }
  });
}

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { type ModelMessage, streamText } from "ai";
import type TelegramBot from "node-telegram-bot-api";
import type { Context } from "@/lib/bot-proxy";
import { safeJsonParseAsync } from "@/lib/json";
import { markdownToTelegramHtml } from "@/lib/markdown";
import {
  AutoReplySchema,
  execsTable,
  makeToolSet,
  memoriesTable,
  promptsTable,
  replaceMessage,
  SYSTEM_PROMPT_DEFAULT,
  toolsInit,
} from "./tools";

export async function Ai(ctx: Context) {
  console.log("[AI] Initializing AI Database...");

  const { bot, me, config } = ctx;

  await toolsInit(ctx);

  const getExecs = async (chatId: number) => {
    const execsRaw = await execsTable.where`chat_id = ${chatId}`;

    return Promise.all(
      execsRaw.map((x) => safeJsonParseAsync(AutoReplySchema, x.value)),
    );
  };

  const getMemories = async (chatId: number) => {
    const memories =
      await memoriesTable.where`chat_id = ${chatId} ORDER BY created_at DESC LIMIT 50`;

    return memories;
  };

  const getPrompt = async (chatId: number) => {
    const res = await promptsTable.where`chat_id = ${chatId}`;
    return res.at(0)?.value ?? SYSTEM_PROMPT_DEFAULT;
  };

  /** PROMPT */
  bot.onText(/^\/prompt(\s+?[\S\s]+)?/, async (msg, match) => {
    const newPrompt = match?.[1]?.trim();

    const prompt = await getPrompt(msg.chat.id);
    let text = "";

    if (newPrompt) {
      await promptsTable.upsert(
        {
          chat_id: msg.chat.id,
          value: newPrompt,
          created_at: Date.now(),
        },
        "chat_id",
      );

      text = `已成功将 prompt 更新为：${newPrompt}`;
    } else {
      await promptsTable.deleteWhere`chat_id = ${msg.chat.id}`;

      text = `已成功将 prompt 重置为默认值。`;
    }

    await bot.sendMessage(
      msg.chat.id,
      await markdownToTelegramHtml(`旧的 prompt 是：\n\n${prompt}\n\n${text}`),
      {
        reply_to_message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );
  });

  /** AUTO REPLY */
  bot.on("message", async (msg) => {
    const execsArr = await getExecs(msg.chat.id);

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

  /** AI */
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

      const memories = await getMemories(msg.chat.id);
      const prompt = await getPrompt(msg.chat.id);

      console.log("[AI] Using prompt:", prompt);

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
          { role: "system", content: prompt },
          //   { role: "system", content: PROMPT_TOOLS },
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
        tools: makeToolSet(ctx, msg),
        toolChoice: "auto",
        headers: {
          "X-Title": `Telegram Bot`,
        },
      });

      const state = {
        aborted: false,
        currentReasoning: "",
        currentText: "",
        currentTool: "",
        historyTool: {} as Record<string, string>,
        lastSentText: "",
        lastEditTime: 0,
      };

      function generateTextToSend() {
        let txt = "";
        const reasoning = state.currentReasoning.trim();
        if (reasoning && reasoning !== "[REDACTED]") {
          txt += "> ";
          txt += reasoning.replaceAll("\n", "\n> ");
          txt += "\n\n";
        }
        txt += state.currentText;
        if (state.currentTool) {
          txt += "\n```json\n";
          txt += state.historyTool[state.currentTool];
          txt += "\n```";
        }
        return txt || "(...)";
      }

      // Collect chunks
      for await (const chunk of result.fullStream) {
        console.log(chunk);
        switch (chunk.type) {
          case "abort": {
            state.aborted = true;
            break;
          }
          case "reasoning-delta": {
            state.currentReasoning += chunk.text;
            break;
          }
          case "text-delta": {
            state.currentText += chunk.text;
            break;
          }
          case "tool-input-start": {
            state.currentText += `\n(正在使用工具: ${chunk.toolName})`;
            state.currentTool = chunk.toolName;
            state.historyTool[chunk.toolName] = "";
            break;
          }
          case "tool-input-delta": {
            state.historyTool[state.currentTool] += chunk.delta;
            break;
          }
          case "tool-input-end": {
            state.currentTool = "";
            break;
          }
          case "tool-call": {
            break;
          }
        }

        if (state.aborted) break;

        const now = Date.now();
        const textToSend = generateTextToSend();

        if (
          textToSend.length - state.lastSentText.length >= 50 && // Send every 50 new characters
          now - state.lastEditTime >= 6000 // Edit every 6 seconds
        ) {
          await bot.editMessageText(await markdownToTelegramHtml(textToSend), {
            chat_id: msg.chat.id,
            message_id: sentMessage.message_id,
            parse_mode: "HTML",
          });
          state.lastSentText = textToSend;
          state.lastEditTime = now;
        }
      }

      // Final edit with complete response
      const telegramHtml = await markdownToTelegramHtml(generateTextToSend());

      await bot.editMessageText(telegramHtml, {
        chat_id: msg.chat.id,
        message_id: sentMessage.message_id,
        parse_mode: "HTML",
      });
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

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, type ModelMessage, streamText } from "ai";
import type TelegramBot from "node-telegram-bot-api";
import z from "zod";
import type { Context } from "@/lib/bot-proxy";
import { safeJsonParseAsync } from "@/lib/json";
import { markdownToTelegramHtml } from "@/lib/markdown";
import { createMessageCache } from "@/lib/message-cache";
import { getChatKV } from "../kv";
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

  // Create message cache instance with global max window
  const messageCache = createMessageCache(config.max_message_window);

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

  const getMessageWindow = async (chatId: number): Promise<number> => {
    const customWindow = await getChatKV(chatId, "message_window");
    if (customWindow) {
      const parsed = parseInt(customWindow, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        // Ensure it doesn't exceed the global max
        return Math.min(parsed, config.max_message_window);
      }
    }
    return config.max_message_window;
  };

  ctx.command(
    {
      command: "prompt",
      description: "[new prompt] 查看和设置当前聊天的 AI 提示语",
    },
    async (msg, newPrompt) => {
      const prompt = await getPrompt(msg.chat.id);
      let text = "";

      if (newPrompt) {
        await promptsTable.deleteWhere`chat_id = ${msg.chat.id}`;
        await promptsTable.insert({
          chat_id: msg.chat.id,
          value: newPrompt,
          created_at: Date.now(),
        });

        text = `已成功将 prompt 更新为：${newPrompt}`;
      } else {
        await promptsTable.deleteWhere`chat_id = ${msg.chat.id}`;

        text = `已成功将 prompt 重置为默认值。`;
      }

      await bot.sendMessage(
        msg.chat.id,
        await markdownToTelegramHtml(
          `旧的 prompt 是：\n\n${prompt}\n\n${text}`,
        ),
        {
          reply_to_message_id: msg.message_id,
          parse_mode: "HTML",
        },
      );
    },
  );

  ctx.command(
    {
      command: "usage",
      description: "查看当前 API key 的使用统计和费用",
    },
    async (msg) => {
      try {
        const response = await fetch("https://openrouter.ai/api/v1/auth/key", {
          headers: {
            Authorization: `Bearer ${config.openrouter_api_key}`,
          },
        });

        if (!response.ok) {
          await bot.sendMessage(
            msg.chat.id,
            "获取使用统计失败，请检查 API 密钥是否有效。",
            { reply_to_message_id: msg.message_id },
          );
          return;
        }

        const data = (await response.json()) as {
          data: {
            limit?: number;
            usage?: number;
            credits?: number;
          };
        };

        const usage = data.data.usage ?? 0;
        const limit = data.data.limit ?? 0;
        const credits = data.data.credits ?? 0;

        const usageText = `
📊 API 使用统计：
━━━━━━━━━━━━━━━━
💰 剩余额度：$${credits.toFixed(4)}
💸 已花费：$${usage.toFixed(4)}
📈 月度限额：$${limit.toFixed(4)}
${limit > 0 ? `📊 使用率：${((usage / limit) * 100).toFixed(2)}%` : ""}
        `.trim();

        await bot.sendMessage(msg.chat.id, usageText, {
          reply_to_message_id: msg.message_id,
        });
      } catch (error) {
        console.error("Error fetching usage:", error);
        await bot.sendMessage(msg.chat.id, "获取使用统计时出错，请稍后重试。", {
          reply_to_message_id: msg.message_id,
        });
      }
    },
  );

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

  ctx.command(
    {
      command: "listexecs",
      description: "列出当前聊天的所有自动回复规则",
    },
    async (msg) => {
      const execs = await getExecs(msg.chat.id);

      if (execs.length === 0) {
        await bot.sendMessage(msg.chat.id, "当前没有自动回复规则。", {
          reply_to_message_id: msg.message_id,
        });
        return;
      }

      const lines = execs.map((x) =>
        x.success
          ? `- ✔️ \`${x.data.when}\` ➡️ ${x.data.message}`
          : `- ✖️ (${z.prettifyError(x.error)})`,
      );

      await bot.sendMessage(
        msg.chat.id,
        await markdownToTelegramHtml(
          `当前的自动回复规则有：\n\n${lines.join("\n")}`,
        ),
        {
          reply_to_message_id: msg.message_id,
          parse_mode: "HTML",
        },
      );
    },
  );

  ctx.command(
    {
      command: "memories",
      description: "列出当前聊天的所有记忆",
    },
    async (msg) => {
      const memories = await getMemories(msg.chat.id);

      if (memories.length === 0) {
        await bot.sendMessage(msg.chat.id, "当前没有记忆。", {
          reply_to_message_id: msg.message_id,
        });
        return;
      }

      const lines = memories.map(
        (x) =>
          `- (${new Date(x.created_at).toLocaleDateString()}) ${x.message}`,
      );

      await bot.sendMessage(
        msg.chat.id,
        `当前的记忆有：\n\n${lines.join("\n")}`,
        {
          reply_to_message_id: msg.message_id,
        },
      );
    },
  );

  /** AI */
  bot.on("message", async (msg) => {
    if (!msg.from) return;

    if (!msg.text) {
      messageCache.addMessage(msg.chat.id, {
        ...msg,
        text:
          (msg.media_group_id ? "[媒体]" : "[非文本消息]") +
          (msg.caption ? ` 文字说明：${msg.caption}` : ""),
      });
      return;
    }

    // Don't cache commands
    if (msg.text.startsWith("/")) {
      return;
    }

    // Cache user message (non-command messages only)
    messageCache.addMessage(msg.chat.id, msg);

    const condition =
      msg.text.split(" ").includes(`@${me.username}`) ||
      msg.reply_to_message?.from?.id === me.id;

    const openrouter = createOpenRouter({
      apiKey: config.openrouter_api_key,
    });

    if (!condition) {
      const weakerCondition = msg.text.includes("什么");
      if (!weakerCondition || Math.random() < 0.5) {
        return;
      }

      try {
        const aicheck = await generateText({
          model: openrouter("openai/gpt-oss-20b"),
          messages: [
            {
              role: "system",
              content:
                "仅当用户看上去在提问或者寻求帮助时，回复“yes”，否则回复“no”。不要回复其他内容。",
            },
            {
              role: "user",
              content: msg.text,
            },
          ],
        });

        console.log(aicheck);

        if (aicheck.text.trim().toLowerCase() !== "yes") {
          return;
        }
      } catch (error) {
        console.error("Error during AI check:", error);
        return;
      }
    }

    try {
      if (
        config.chat_allow_list &&
        !config.chat_allow_list.includes(msg.chat.id)
      ) {
        return;
      }

      // Send initial message
      const sentMessage = await bot.sendMessage(
        msg.chat.id,
        "正在生成回复，请稍候...",
        { reply_to_message_id: msg.message_id },
      );

      const memories = await getMemories(msg.chat.id);
      const prompt = await getPrompt(msg.chat.id);
      const messageWindow = await getMessageWindow(msg.chat.id);

      console.log("[AI] Using prompt:", prompt);
      console.log("[AI] Using message window:", messageWindow);

      // Get cached messages for context with the configured window size
      const cachedMessages = messageCache
        .getMessages(msg.chat.id)
        .slice(-messageWindow);
      const contextMessages: ModelMessage[] = cachedMessages.map(
        (cachedMsg) => {
          if (cachedMsg.from_id === me.id) {
            return {
              role: "assistant" as const,
              content: cachedMsg.text,
            };
          } else {
            const username = cachedMsg.from_username
              ? `@${cachedMsg.from_username}`
              : cachedMsg.from_first_name;
            const fullName =
              `${cachedMsg.from_first_name} ${cachedMsg.from_last_name || ""}`.trim();
            return {
              role: "user" as const,
              content: `${username} (${fullName}) 发送了一条消息：${cachedMsg.text}`,
            };
          }
        },
      );

      // Use AI to generate response with streaming
      const result = streamText({
        model: openrouter(
          (await getChatKV(msg.chat.id, "model")) ?? config.model,
        ), // or any model you prefer
        messages: [
          { role: "system", content: prompt },
          {
            role: "system",
            content: [
              `你的用户名是 @${me.username}。`,
              `你的昵称是 ${me.first_name}。`,
              `你有以下记忆：`,
              ...memories.map((x) => `- ${x.message}`),
            ].join("\n"),
          },
          ...contextMessages,
        ],
        tools: makeToolSet(ctx, msg),
        toolChoice: "auto",
        headers: {
          "HTTP-Referer": "https://github.com/Lhcfl/ai-tg-bot",
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

      // Cache the AI's response
      const finalText = state.currentText;
      if (finalText) {
        messageCache.addMessage(msg.chat.id, {
          message_id: sentMessage.message_id,
          chat: msg.chat,
          date: Math.floor(Date.now() / 1000),
          from: me,
          text: finalText,
        } as TelegramBot.Message);
      }
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

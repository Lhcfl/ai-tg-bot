import type { Context } from "@/lib/bot-proxy";
import { matchCommand, splitArgs } from "@/lib/command";
import { createTable } from "@/lib/db";

const chatKVs = createTable("chat_kvs", {
  id: { type: "INTEGER", primaryKey: true, autoIncrement: true },
  chat_id: { type: "INTEGER", notNull: true },
  key: { type: "TEXT", notNull: true },
  value: { type: "TEXT", notNull: true },
})
  .index("idx_chat_kvs_chat_id_key", ["chat_id", "key"], true)
  .index("idx_chat_kvs_chat_id", ["chat_id"])
  .index("idx_chat_kvs_key", ["key"]);

export async function getChatKV(
  chatId: number,
  key: string,
): Promise<string | null> {
  const res = await chatKVs.where`chat_id = ${chatId} AND key = ${key}`;
  return res.at(0)?.value ?? null;
}

export async function setChatKV(
  chatId: number,
  key: string,
  value: string,
): Promise<void> {
  await chatKVs.deleteWhere`chat_id = ${chatId} AND key = ${key}`;
  await chatKVs.insert({
    chat_id: chatId,
    key,
    value,
  });
}

export async function deleteChatKV(chatId: number, key: string): Promise<void> {
  await chatKVs.deleteWhere`chat_id = ${chatId} AND key = ${key}`;
}

export function ChatKv(ctx: Context) {
  console.log("[KV] Initializing Chat KV Database...");

  const { sqlite, bot } = ctx;
  chatKVs.init(sqlite);

  ctx.command(
    {
      command: "listkv",
      description: "/listkv 列出当前聊天的所有键值对",
    },
    async (msg) => {
      const kvs = await chatKVs.where`chat_id = ${msg.chat.id}`;
      if (kvs.length === 0) {
        await bot.sendMessage(msg.chat.id, "当前没有任何键值对。", {
          reply_to_message_id: msg.message_id,
        });
        return;
      }

      const lines = kvs.map((kv) => `- ${kv.key}: ${kv.value}`);
      await bot.sendMessage(
        msg.chat.id,
        `当前的键值对有：\n\n${lines.join("\n")}`,
        {
          reply_to_message_id: msg.message_id,
        },
      );
    },
  );

  ctx.command(
    {
      command: "setkv",
      description: "/setkv <key> <val> 设置聊天的键值对",
    },
    async (msg, rest) => {
      const [key, value] = splitArgs(rest);
      if (!key || !value) {
        await bot.sendMessage(
          msg.chat.id,
          "用法：/setkv <key> <value>，请提供键和值。",
          {
            reply_to_message_id: msg.message_id,
          },
        );
        return;
      }

      await setChatKV(msg.chat.id, key, value);
      await bot.sendMessage(msg.chat.id, `已设置键 ${key} 的值为 ${value}。`, {
        reply_to_message_id: msg.message_id,
      });
    },
  );

  ctx.command(
    {
      command: "deletekv",
      description: "/deletekv <key> 删除聊天的键值对",
    },
    async (msg, key) => {
      if (!key) {
        await bot.sendMessage(
          msg.chat.id,
          "用法：/deletekv <key>，请提供键。",
          {
            reply_to_message_id: msg.message_id,
          },
        );
        return;
      }

      await deleteChatKV(msg.chat.id, key);
      await bot.sendMessage(msg.chat.id, `已删除键 ${key} 的键值对。`, {
        reply_to_message_id: msg.message_id,
      });
    },
  );
}

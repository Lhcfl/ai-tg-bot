import { mkBot } from "./lib/bot-proxy";
import { readConfig } from "./lib/config";
import { Ai } from "./modules/ai";
import { Help } from "./modules/help";
import { ChatKv } from "./modules/kv";

async function main() {
  console.log("[core] Reading config...");
  const config = await readConfig();
  console.log("[core] Starting bot...");
  const bot = await mkBot(config);

  bot.use(Help).use(ChatKv).use(Ai);

  await bot.freeze();
  console.log("[core] Bot started.");
}

main().catch(console.error);

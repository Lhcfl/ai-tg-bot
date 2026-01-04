import { mkBot } from "./lib/bot-proxy";
import { readConfig } from "./lib/config";
import { Ai } from "./modules/ai";

async function main() {
  console.log("[core] Reading config...");
  const config = await readConfig();
  console.log("[core] Starting bot...");
  const bot = await mkBot(config);
  bot.use(Ai);
  await bot.freeze();
  console.log("[core] Bot started.");
}

main().catch(console.error);

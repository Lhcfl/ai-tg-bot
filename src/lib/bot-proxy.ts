import TelegramBot from "node-telegram-bot-api";
import type { Config } from "./config";
import { SQL } from "bun";

const sqlite = new SQL({
  adapter: "sqlite",
  filename: "data.sqlite",
  // SQLite-specific options
  create: true, // Create database if it doesn't exist
  readwrite: true, // Open for reading and writing
});

type Plugin = (ctx: Context) => void | Promise<void>;

export class Context {
  public plugins: Plugin[] = [];
  public frozen = false;

  constructor(
    public me: TelegramBot.User,
    public bot: TelegramBot,
    public config: Config,
  ) {}

  use(plugin: Plugin) {
    if (this.frozen) {
      throw new Error("Cannot use plugins on a frozen Context");
    }
    this.plugins.push(plugin);
    return this;
  }

  get sqlite() {
    return sqlite;
  }

  async freeze() {
    this.frozen = true;
    const successful: string[] = [];
    const failed: { name: string; error: unknown }[] = [];

    for (const plugin of this.plugins) {
      console.log(`[plugin] Loading ${plugin.name}...`);

      try {
        await plugin(this);
        successful.push(plugin.name);
      } catch (error) {
        console.error(
          `[ERROR] Failed to load plugin ${plugin.name}:`,
          error instanceof Error ? error.message : error,
        );
        failed.push({ name: plugin.name, error });
      }
    }

    console.log(
      `[plugin] Loaded ${successful.length} of ${this.plugins.length} plugins successfully: `,
      successful,
    );
    if (failed.length > 0) {
      console.log(
        `[plugin] ${failed.length} plugins failed to load: ${failed
          .map((f) => f.name)
          .join(", ")}`,
      );
    }
  }
}

export async function mkBot(config: Config) {
  const bot = new Proxy(
    new TelegramBot(config.telegram_bot_token, { polling: true }),
    {
      get(target, prop) {
        const val = target[prop as keyof TelegramBot];
        if (typeof val === "function") {
          return (...args: unknown[]) => {
            try {
              // biome-ignore lint/complexity/noBannedTypes: bypass
              return (val as Function).apply(target, args);
            } catch (error) {
              if (error instanceof Error) {
                console.error(
                  `[ERROR] Error in ${prop.toString()}:`,
                  error.message,
                );
              } else {
                throw error;
              }
            }
          };
        } else {
          console.error(
            `[ERROR] Property ${prop.toString()} is not a function`,
          );
        }
        return val;
      },
    },
  );

  // Get bot info
  const me = await bot.getMe();
  console.log(`Bot started: @${me.username}`);

  return new Context(me, bot, config);
}

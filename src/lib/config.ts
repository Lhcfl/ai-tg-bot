import { TOML } from "bun";
import z from "zod";

const configSchema = z.object({
  telegram_bot_token: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  openrouter_api_key: z.string().min(1, "OPENROUTER_API_KEY is required"),
  model: z.string().default("openai/gpt-3.5-turbo"),
  app_name: z.string().default("Telegram Bot"),
  chat_allow_list: z.array(z.number()).optional(),
});

export const readConfig = async () => {
  // Load and validate config
  const configFile = Bun.file("config.toml");
  if (!(await configFile.exists())) {
    throw new Error(
      "config.toml not found. Please copy example.config.toml to config.toml and fill in your values.",
    );
  }
  const configText = await configFile.text();
  const rawConfig = TOML.parse(configText);
  const result = await configSchema.safeParseAsync(rawConfig);
  if (!result.success) {
    throw new Error(
      "Invalid configuration in config.toml: \n" +
        z.prettifyError(result.error),
    );
  }
  return result.data;
};

export type Config = z.infer<typeof configSchema>;

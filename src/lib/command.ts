import type TelegramBot from "node-telegram-bot-api";
import z from "zod";

const commandSchema = z.object({
  name: z.string(),
  argc: z.number().min(0).default(0),
  help: z.string().optional(),
});

type Command = z.infer<typeof commandSchema>;

function textMatchCommand({
  text,
  command,
}: {
  text: string;
  command: Command;
}) {
  const firstSpaceIdx_ = text.indexOf(" ");
  const firstSpaceIdx = firstSpaceIdx_ === -1 ? text.length : firstSpaceIdx_;
  const cmdPart = text.slice(0, firstSpaceIdx);
  const argsPart = text.slice(firstSpaceIdx + 1).trim();

  const cmdWithSlash = `/${command.name}`;
  if (cmdPart !== cmdWithSlash) return null;

  return {
    name: command.name,
    args: argsPart,
  };
}

export function matchCommand(msg: TelegramBot.Message, command: Command) {
  if (!msg.text) return null;
  const text = msg.text.trim();
  return textMatchCommand({
    text,
    command,
  });
}

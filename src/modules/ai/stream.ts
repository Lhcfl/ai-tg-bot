import type { StreamTextResult } from "ai";
import { YAML } from "bun";

export async function streamToTelegramText<
  // biome-ignore lint/suspicious/noExplicitAny: 类型体操
  S extends StreamTextResult<any, any>,
>(
  stream: S,
  config: { show_reasoning?: boolean },
  onUpdate: (text: string, final: boolean) => Promise<void>,
) {
  let aborted = false;
  let currentReasoning = "";
  let currentText = "";
  let currentTool = "";
  const toolHistory = {} as Record<string, string>;
  let lastSentText = "";
  let lastEditTime = 0;

  function generateTextToSend() {
    let txt = "";
    const reasoning = currentReasoning.trim();
    if (reasoning && reasoning !== "[REDACTED]" && config.show_reasoning) {
      txt += "> ";
      txt += reasoning.replaceAll("\n", "\n> ");
      txt += "\n\n";
    }
    txt += currentText;
    if (currentTool) {
      txt += "\n```json\n";
      txt += toolHistory[currentTool];
      txt += "\n```";
    }
    return txt || "(...)";
  }

  // Collect chunks
  for await (const chunk of stream.fullStream) {
    switch (chunk.type) {
      case "abort": {
        aborted = true;
        break;
      }
      case "reasoning-delta": {
        currentReasoning += chunk.text;
        break;
      }
      case "text-delta": {
        currentText += chunk.text;
        break;
      }
      case "tool-input-start": {
        currentText += `\n(正在使用工具: ${chunk.toolName})`;
        currentTool = chunk.toolName;
        toolHistory[chunk.toolName] = "";
        break;
      }
      case "tool-input-delta": {
        toolHistory[currentTool] += chunk.delta;
        break;
      }
      case "tool-input-end": {
        currentTool = "";
        break;
      }
      case "tool-call": {
        break;
      }
      case "start-step": {
        console.log(`--- SHOWING REQUEST ---`);
        console.log(YAML.stringify(chunk.request, null, 2));
        break;
      }
      default: {
        console.log(chunk);
      }
    }

    if (aborted) break;

    const now = Date.now();
    const textToSend = generateTextToSend();

    if (
      textToSend.length - lastSentText.length >= 50 && // Send every 50 new characters
      now - lastEditTime >= 6000 // Edit every 6 seconds
    ) {
      await onUpdate(textToSend, false);
      lastSentText = textToSend;
      lastEditTime = now;
    }
  }

  await onUpdate(generateTextToSend(), true);
}

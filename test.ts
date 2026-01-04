import { extractExec, markdownToTelegramHtml } from "./src/lib/markdown";

console.log(await extractExec(await Bun.file("example.md").text()));

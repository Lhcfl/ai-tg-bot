import { markdownToTelegramHtml } from "./src/lib/markdown";

console.log(await markdownToTelegramHtml(await Bun.file("example.md").text()));

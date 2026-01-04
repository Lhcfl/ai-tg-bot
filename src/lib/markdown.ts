import type { Properties, Root } from "hast";
// @ts-expect-error
import { toHtml } from "hast-util-to-html";
import { h } from "hastscript";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type Plugin, unified } from "unified";
import { visit } from "unist-util-visit";

const ALLOWED_TAGS = [
  "b",
  "strong",
  "i",
  "em",
  "u",
  "ins",
  "s",
  "strike",
  "del",
  "pre",
  "code",
  "a",
  "blockquote",
];

// Rehype plugin to convert HTML to Telegram HTML
const rehypeTelegramHtml: Plugin<[], Root> = () => (tree) =>
  visit(tree, "element", (node) => {
    const keepProperties = new Set<keyof Properties>();
    switch (node.tagName) {
      case "code":
        if (node.data?.meta === "in-pre") {
          keepProperties.add("class");
        } else {
          node.tagName = "pre";
        }
        break;
      case "pre": {
        node.tagName = "pre";
        const code = node.children.at(0);
        // Handle code inside pre
        if (code && code.type === "element" && code.tagName === "code") {
          if (Array.isArray(code.properties?.className)) {
            const lang = code.properties.className.find(
              (it) => typeof it === "string" && it.startsWith("language-"),
            );
            code.properties = { ...node.properties, class: lang };
            code.data = { meta: "in-pre" };
          }
        } else {
          node.tagName = "span";
        }
        break;
      }
      case "a":
        keepProperties.add("href");
        break;
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        // Convert headings to bold text with underline
        node.tagName = "u";
        break;
      case "li": {
        const firstNonWhitespaceChild = node.children.find(
          (child) =>
            child.type !== "text" || (child.value && child.value.trim() !== ""),
        );

        if (firstNonWhitespaceChild?.type === "text") {
          node.children.unshift(h("span", "• "));
        }
        break;
      }
      default:
        if (!ALLOWED_TAGS.includes(node.tagName)) {
          node.tagName = "span";
        }
    }

    // Clean up properties
    node.properties = Object.fromEntries(
      Object.entries(node.properties || {}).filter(([key]) =>
        keepProperties.has(key as keyof Properties),
      ),
    );
  });

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeTelegramHtml)
  .use(rehypeSanitize, {
    tagNames: [...ALLOWED_TAGS, "pre", "code"],
    attributes: {
      a: ["href"],
      code: ["class"],
    },
  })
  .use(function () {
    this.compiler = (tree) =>
      toHtml(tree, {
        characterReferences: {
          subset: ["<", ">", "&"],
          useNamedReferences: true,
        },
      });
  })
  .freeze();

export async function markdownToTelegramHtml(
  markdown: string,
): Promise<string> {
  const result = await processor.process(markdown);
  return result.toString();
}

const mdparser = unified().use(remarkParse);
export async function extractExec(markdown: string) {
  const root = mdparser.parse(markdown);
  const res: string[] = [];

  visit(root, "code", (code) => {
    if (code.lang === "exec") {
      res.push(code.value);
    }
  });

  return res;
}

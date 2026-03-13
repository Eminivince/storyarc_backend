import sanitizeHtml from "sanitize-html";
import { parse } from "node-html-parser";

const richTextTagPattern = /<\/?[a-z][\s\S]*>/i;

const sanitizeConfig: sanitizeHtml.IOptions = {
  allowedAttributes: {
    a: ["href", "rel", "target"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedTags: [
    "a",
    "blockquote",
    "br",
    "em",
    "h1",
    "h2",
    "h3",
    "li",
    "ol",
    "p",
    "strong",
    "ul",
  ],
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", {
      rel: "noopener noreferrer nofollow",
      target: "_blank",
    }),
    b: "strong",
    i: "em",
  },
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function looksLikeRichTextHtml(value: string) {
  return richTextTagPattern.test(value.trim());
}

function wrapPlainTextAsHtml(value: string) {
  return value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

function getRoot(html: string) {
  return parse(`<body>${html}</body>`).querySelector("body");
}

export function normalizeRichTextDocument(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  const candidate = looksLikeRichTextHtml(trimmed)
    ? trimmed
    : wrapPlainTextAsHtml(trimmed);

  return sanitizeHtml(candidate, sanitizeConfig).trim();
}

export function richTextToBlocks(value: string) {
  const normalized = normalizeRichTextDocument(value);

  if (!normalized) {
    return [];
  }

  const root = getRoot(normalized);

  if (!root) {
    return [];
  }

  return root.childNodes
    .flatMap((node) => {
      if (node.nodeType === 3) {
        const text = node.rawText.trim();

        return text ? [`<p>${escapeHtml(text)}</p>`] : [];
      }

      const html = node.toString().trim();

      return html ? [html] : [];
    })
    .filter(Boolean);
}

export function richTextToPlainText(value: string) {
  const normalized = normalizeRichTextDocument(value);

  if (!normalized) {
    return "";
  }

  const root = getRoot(normalized);
  const text = root?.textContent ?? "";

  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

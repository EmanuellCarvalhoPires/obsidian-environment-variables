// Atlassian Document Format (ADF) to Markdown converter.
// Converts rich text ADF trees (used by Jira and Confluence) into simple Markdown.

/**
 * Converts an ADF node (or document) to a simple Markdown string.
 * Supports paragraphs, headings, bullet/ordered lists, code blocks, links, mentions,
 * hard breaks, bold (strong), italic (em), and inline code.
 * For unknown nodes, recursively extracts and concatenates children's text.
 */
export function adfToMarkdown(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node !== "object") return "";

  if (Array.isArray(node)) {
    return node.map((child) => adfToMarkdown(child)).join("");
  }

  const n = node as Record<string, unknown>;
  const type = typeof n.type === "string" ? n.type : "";
  const content = Array.isArray(n.content) ? n.content : [];

  switch (type) {
    case "doc":
      return content
        .map((c) => adfToMarkdown(c))
        .filter((s) => s.length > 0)
        .join("\n\n");

    case "paragraph":
      return content.map((c) => adfToMarkdown(c)).join("");

    case "heading": {
      const attrs = (n.attrs ?? {}) as { level?: number };
      const level = typeof attrs.level === "number" && attrs.level >= 1 && attrs.level <= 6 ? attrs.level : 1;
      const text = content.map((c) => adfToMarkdown(c)).join("");
      return `${"#".repeat(level)} ${text}`;
    }

    case "bulletList":
      return content
        .map((item) => renderListItem(item, "- "))
        .filter((s) => s.length > 0)
        .join("\n");

    case "orderedList":
      return content
        .map((item, index) => renderListItem(item, `${index + 1}. `))
        .filter((s) => s.length > 0)
        .join("\n");

    case "listItem":
      return content.map((c) => adfToMarkdown(c)).join("\n");

    case "codeBlock": {
      const attrs = (n.attrs ?? {}) as { language?: string };
      const lang = typeof attrs.language === "string" ? attrs.language : "";
      const code =
        content.length > 0
          ? content.map((c) => adfToMarkdown(c)).join("")
          : typeof n.text === "string"
            ? n.text
            : "";
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }

    case "text": {
      const rawText = typeof n.text === "string" ? n.text : "";
      if (!rawText) return "";
      const marks = Array.isArray(n.marks)
        ? (n.marks as Array<{ type: string; attrs?: Record<string, unknown> }>)
        : [];
      return applyMarks(rawText, marks);
    }

    case "mention": {
      const attrs = (n.attrs ?? {}) as { id?: string; text?: string };
      if (attrs.text) {
        return attrs.text.startsWith("@") ? attrs.text : `@${attrs.text}`;
      }
      if (attrs.id) {
        return `@${attrs.id}`;
      }
      return "@unknown";
    }

    case "hardBreak":
      return "\n";

    case "blockquote": {
      const inner = content.map((c) => adfToMarkdown(c)).join("\n");
      return inner
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    }

    case "rule":
      return "---";

    default:
      // Unknown node: extract text from children or direct text property
      if (content.length > 0) {
        return content.map((c) => adfToMarkdown(c)).join("");
      }
      if (typeof n.text === "string") {
        return n.text;
      }
      return "";
  }
}

/** Renders a listItem element with the appropriate list prefix (e.g. "- " or "1. "). */
function renderListItem(item: unknown, prefix: string): string {
  if (!item || typeof item !== "object") return "";
  const n = item as Record<string, unknown>;
  const content = Array.isArray(n.content) ? n.content : [];
  if (content.length === 0) return `${prefix}`;

  const renderedBlocks = content.map((child) => {
    const childObj = child as Record<string, unknown>;
    if (childObj?.type === "bulletList" || childObj?.type === "orderedList") {
      const nested = adfToMarkdown(child);
      return nested
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
    }
    return adfToMarkdown(child);
  });

  const [first, ...rest] = renderedBlocks;
  if (rest.length === 0) {
    return `${prefix}${first}`;
  }
  const restIndented = rest.map((block) =>
    block
      .split("\n")
      .map((line) => (line.startsWith("  ") ? line : `  ${line}`))
      .join("\n"),
  );
  return `${prefix}${first}\n${restIndented.join("\n")}`;
}

/** Applies formatting marks to a text string in inside-out order: code -> em -> strong -> strike -> link. */
function applyMarks(text: string, marks: Array<{ type: string; attrs?: Record<string, unknown> }>): string {
  if (!text) return "";
  const order: Record<string, number> = { code: 1, em: 2, strong: 3, strike: 4, link: 5 };
  const sorted = [...marks].sort((a, b) => (order[a.type] ?? 99) - (order[b.type] ?? 99));

  let res = text;
  for (const mark of sorted) {
    switch (mark.type) {
      case "code":
        res = `\`${res}\``;
        break;
      case "em":
        res = `*${res}*`;
        break;
      case "strong":
        res = `**${res}**`;
        break;
      case "strike":
        res = `~~${res}~~`;
        break;
      case "link": {
        const href =
          typeof mark.attrs?.href === "string"
            ? mark.attrs.href
            : typeof mark.attrs?.url === "string"
              ? mark.attrs.url
              : "";
        res = `[${res}](${href})`;
        break;
      }
      default:
        break;
    }
  }
  return res;
}

/** Returns true if a value is an ADF document root. */
export function isAdfDoc(val: unknown): boolean {
  if (!val || typeof val !== "object") return false;
  const obj = val as Record<string, unknown>;
  return obj.type === "doc" && Array.isArray(obj.content);
}

/** Returns true if a value is any ADF node. */
export function isAdfNode(val: unknown): boolean {
  if (!val || typeof val !== "object") return false;
  const obj = val as Record<string, unknown>;
  if (typeof obj.type !== "string") return false;
  return Array.isArray(obj.content) || typeof obj.text === "string" || obj.type === "hardBreak";
}

/**
 * Converts ADF fields in an object to Markdown strings.
 * If `paths` is provided, converts the ADF nodes at those dot-separated field paths.
 * If `paths` is omitted or empty, deep-walks the object and converts any ADF document root.
 * Other values or absent fields remain intact.
 */
export function convertAdfFields(obj: unknown, paths?: string[]): unknown {
  if (obj === null || obj === undefined) return obj;

  if (paths && paths.length > 0) {
    let result: unknown = obj;
    for (const rawPath of paths) {
      const trimmed = rawPath.trim();
      if (!trimmed) continue;
      const segments = trimmed.split(".").filter(Boolean);
      if (segments.length === 0) continue;
      result = convertAtPath(result, segments);
    }
    return result;
  }

  return convertAllAdf(obj);
}

function convertAtPath(target: unknown, segments: string[]): unknown {
  if (target === null || target === undefined || typeof target !== "object") {
    return target;
  }
  if (Array.isArray(target)) {
    return target.map((item) => convertAtPath(item, segments));
  }
  if (segments.length === 0) {
    return isAdfNode(target) ? adfToMarkdown(target) : target;
  }

  const [head, ...tail] = segments;
  const record = target as Record<string, unknown>;
  if (!(head in record)) {
    return target;
  }

  const cloned = { ...record };
  if (tail.length === 0) {
    const val = record[head];
    if (Array.isArray(val)) {
      cloned[head] = (val as unknown[]).map((item: unknown): unknown => (isAdfNode(item) ? adfToMarkdown(item) : item));
    } else if (isAdfNode(val)) {
      cloned[head] = adfToMarkdown(val);
    }
  } else {
    cloned[head] = convertAtPath(record[head], tail);
  }
  return cloned;
}

function convertAllAdf(target: unknown): unknown {
  if (target === null || target === undefined) return target;
  if (isAdfDoc(target)) {
    return adfToMarkdown(target);
  }
  if (Array.isArray(target)) {
    return target.map(convertAllAdf);
  }
  if (typeof target === "object") {
    const rec = target as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      out[k] = convertAllAdf(v);
    }
    return out;
  }
  return target;
}

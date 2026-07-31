import type { BrowserElementRef, SnapshotResult } from "./types.js";

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "checkbox", "radio", "combobox",
  "listbox", "menuitem", "option", "searchbox", "switch", "tab",
  "menuitemcheckbox", "menuitemradio", "spinbutton", "slider",
]);

const CONTENT_ROLES = new Set([
  "heading", "paragraph", "listitem", "cell", "row", "img", "figure",
  "article", "navigation", "banner", "main", "form", "label",
]);

interface RawSnapshotNode {
  ref: number;
  tag: string;
  role: string;
  name: string;
  selector: string;
  text: string;
}

/** Wraps untrusted page content in delimiters for prompt-injection hardening. */
export function wrapUntrusted(content: string, label = "page_content"): string {
  return `<untrusted_${label}>\n${content}\n</untrusted_${label}>`;
}

function truncateToTokenCap(text: string, tokenCap: number): { text: string; truncated: boolean } {
  const maxChars = tokenCap * 4;
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, maxChars)}\n\n… [snapshot truncated at ~${tokenCap} tokens]`,
    truncated: true,
  };
}

function formatRefLine(node: RawSnapshotNode): string {
  const label = node.name ? `"${node.name}"` : node.text ? `"${node.text.slice(0, 80)}"` : "";
  const role = node.role || node.tag;
  return `[${node.ref}] ${role}${label ? ` ${label}` : ""}`;
}

/**
 * Builds a markdown snapshot from raw DOM nodes collected via page.evaluate.
 */
export function buildSnapshotMarkdown(
  url: string,
  title: string,
  nodes: RawSnapshotNode[],
  tokenCap: number,
): SnapshotResult {
  const refs = new Map<number, BrowserElementRef>();
  const lines: string[] = [
    `# Page: ${url}`,
    `Title: ${title || "(no title)"}`,
    "",
  ];

  for (const node of nodes) {
    refs.set(node.ref, {
      ref: node.ref,
      tag: node.tag,
      role: node.role,
      name: node.name,
      selector: node.selector,
    });
    lines.push(formatRefLine(node));
  }

  const raw = lines.join("\n");
  const { text, truncated } = truncateToTokenCap(raw, tokenCap);
  return { markdown: text, refs, truncated, url, title };
}

/** JS source injected into the page to collect interactive/visible elements. */
export const SNAPSHOT_COLLECTOR_SCRIPT = `(() => {
  const INTERACTIVE = new Set(${JSON.stringify([...INTERACTIVE_ROLES])});
  const CONTENT = new Set(${JSON.stringify([...CONTENT_ROLES])});
  const nodes = [];
  let ref = 0;

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getRole(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") return "heading";
    if (tag === "p") return "paragraph";
    if (tag === "li") return "listitem";
    if (tag === "img") return "img";
    if (tag === "nav") return "navigation";
    if (tag === "form") return "form";
    if (tag === "label") return "label";
    return tag;
  }

  function getName(el) {
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("alt") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      (el.textContent || "").trim().slice(0, 120) ||
      ""
    );
  }

  function buildSelector(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    const testId = el.getAttribute("data-testid");
    if (testId) return '[data-testid="' + testId.replace(/"/g, '\\\\"') + '"]';
    const parts = [];
    let current = el;
    while (current && current.nodeType === 1 && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          part += ":nth-of-type(" + idx + ")";
        }
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let el = walker.currentNode;
  while (el) {
    if (el instanceof HTMLElement && isVisible(el)) {
      const role = getRole(el);
      const tag = el.tagName.toLowerCase();
      const interactive = INTERACTIVE.has(role) || tag === "a" || tag === "button" || tag === "input" || tag === "textarea" || tag === "select";
      const content = CONTENT.has(role) || tag === "h1" || tag === "h2" || tag === "h3";
      if (interactive || content) {
        ref += 1;
        el.setAttribute("data-harness-ref", String(ref));
        nodes.push({
          ref,
          tag,
          role,
          name: getName(el),
          selector: '[data-harness-ref="' + ref + '"]',
          text: (el.textContent || "").trim().slice(0, 120),
        });
      }
    }
    el = walker.nextNode();
  }
  return nodes;
})()`;

export type SnapshotCollectorResult = RawSnapshotNode[];

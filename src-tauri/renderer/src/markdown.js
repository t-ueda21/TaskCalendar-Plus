/**
 * markdown.js
 *
 * AIの回答を表示するための、小さなMarkdown→HTML変換。DOMに依存しない(scripts/test-markdown.mjs でテストする)。
 * 最初にHTMLをすべてエスケープしてから記法だけを変換するため、回答にHTMLが含まれていても実行されない。
 * 対応: 見出し(#〜###)、太字(**)、斜体(*)、インラインコード(`)、コードブロック(```)、
 *       箇条書き(- * ・、字下げで入れ子)、番号付きリスト(1.)、引用(>)、表(| a | b |)、区切り線(---)、
 *       リンク([文字](http/httpsのURL))。
 */

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 1行の中の記法(エスケープ済みの文字列に対して適用する)。 */
function renderInline(escaped) {
  const codes = [];
  let out = escaped.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url}">${label}</a>`)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, "$1<em>$2</em>");
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

const BULLET_RE = /^(\s*)(?:[-*+]\s+|・\s*)(.*)$/;
const ORDERED_RE = /^(\s*)\d+[.)]\s+(.*)$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function splitTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => renderInline(cell.trim()));
}

/** 箇条書き・番号付きリストを、字下げの深さに応じて入れ子のHTMLにする。 */
function renderList(items) {
  let html = "";
  const stack = []; // { indent, tag }
  items.forEach(({ indent, tag, content }) => {
    while (stack.length && indent < stack[stack.length - 1].indent) {
      html += `</li></${stack.pop().tag}>`;
    }
    const top = stack[stack.length - 1];
    if (!top || indent > top.indent) {
      html += `<${tag}><li>`;
      stack.push({ indent, tag });
    } else {
      if (top.tag !== tag) {
        html += `</li></${stack.pop().tag}><${tag}><li>`;
        stack.push({ indent, tag });
      } else {
        html += "</li><li>";
      }
    }
    html += renderInline(content);
  });
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

export function renderMarkdown(text) {
  const lines = escapeHtml(String(text ?? "").replace(/\r\n?/g, "\n")).split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i += 1;
      blocks.push(`<pre><code>${body.join("\n")}</code></pre>`);
      continue;
    }
    if (!line.trim()) { i += 1; continue; }

    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      blocks.push(`<div class="mdHeading mdH${level}">${renderInline(heading[2])}</div>`);
      i += 1;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push("<hr>");
      i += 1;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[i + 1])) {
      const header = splitTableRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitTableRow(lines[i++]));
      blocks.push(`<table><thead><tr>${header.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
      const items = [];
      while (i < lines.length) {
        const bullet = lines[i].match(BULLET_RE);
        const ordered = lines[i].match(ORDERED_RE);
        const m = bullet || ordered;
        if (!m) break;
        items.push({ indent: m[1].replace(/\t/g, "  ").length, tag: bullet ? "ul" : "ol", content: m[2] });
        i += 1;
      }
      blocks.push(renderList(items));
      continue;
    }
    if (/^\s*&gt;\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) body.push(renderInline(lines[i++].replace(/^\s*&gt;\s?/, "")));
      blocks.push(`<blockquote>${body.join("<br>")}</blockquote>`);
      continue;
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim()
      && !/^\s*(#{1,6}\s|```|&gt;)/.test(lines[i])
      && !BULLET_RE.test(lines[i]) && !ORDERED_RE.test(lines[i])) {
      paragraph.push(renderInline(lines[i++]));
    }
    blocks.push(`<p>${paragraph.join("<br>")}</p>`);
  }
  return blocks.join("");
}

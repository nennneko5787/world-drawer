// wd-markdown.js — お知らせ本文用の小さな安全なMarkdown描画。
// 依存なし (CDN不要)。classic script (使う側より先に読む)。
// 対応: [text](url)・素のURLの自動リンク・**太字**・__太字__・*斜体*・
// ~~取消線~~・`code`・```fence```・#見出し・-箇条書き・1.番号付き・>引用・---区切り。
// 単独 `_斜体_` は snake_case 誤爆防止のため非対応。
// 安全策: 入力全体を先にHTMLエスケープし、生成タグ (a/strong/em/code/pre/
// blockquote/ul/ol/li/h1-h6/hr/p/br/del) のみ出力する。生HTMLは通さない。
// URLは http/https/mailto とサイト内 (/path・#frag) のみリンク化する
// (javascript:/data: 等はただの文字列のまま)。
"use strict";
(function () {
  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  // hrefとして安全なら正規化済みURLを返し、だめならnull。
  function safeHref(u) {
    let raw = String(u || "").trim();
    if (!raw || /[\s<>]/.test(raw)) return null;
    raw = raw.replace(/&amp;/g, "&");
    if (/^(https?:\/\/|mailto:)/i.test(raw)) {
      if (/^https?:\/\//i.test(raw) && !/^https?:\/\/[^/]+/i.test(raw)) return null;
      return raw;
    }
    // サイト内リンク (/help・#frag)。//host は外部扱いのため除外。
    if ((raw[0] === "/" && raw[1] !== "/") || raw[0] === "#") return raw;
    return null;
  }

  function anchor(textEsc, href) {
    return '<a href="' + escAttr(href) + '" target="_blank" rel="noopener noreferrer">' + textEsc + "</a>";
  }

  // 末尾の .,;:!? と余分な ) を落とす (URL自動リンク用)。
  function trimUrlTail(u) {
    let s = u.replace(/[.,;:!?]+$/, "");
    while (s.endsWith(")")) {
      const open = (s.match(/\(/g) || []).length;
      const close = (s.match(/\)/g) || []).length;
      if (close > open) s = s.slice(0, -1);
      else break;
    }
    return s;
  }

  function renderInline(escaped) {
    const stash = [];
    const put = (html) => "\x00MD" + (stash.push(html) - 1) + "\x00";
    let s = escaped;

    // `code` (リンク・装飾より先に退避)
    s = s.replace(/`([^`\n]+?)`/g, (_, code) => put("<code>" + code + "</code>"));

    // [text](url "title?") — titleは捨てる
    s = s.replace(/\[([^\]\n]+?)\]\(([^)\s\n]+)(?:\s+&quot;.*?&quot;)?\)/g, (_, text, url) => {
      const href = safeHref(url);
      if (href === null) return _;
      return put(anchor(text, href));
    });

    // <https://...> 形
    s = s.replace(/&lt;(https?:\/\/[^<>\s]+?)&gt;/g, (_, url) => {
      const href = safeHref(url);
      if (href === null) return _;
      return put(anchor(escHtml(url.replace(/&amp;/g, "&")), href));
    });

    // 素のURL
    s = s.replace(/https?:\/\/[^\s<>"')\]]+/g, (m) => {
      const url = trimUrlTail(m);
      if (!url) return m;
      const tail = m.slice(url.length);
      const href = safeHref(url);
      if (href === null) return m;
      return put(anchor(escHtml(url.replace(/&amp;/g, "&")), href)) + tail;
    });

    // 装飾 (strong→em→del の順。_単独の斜体は扱わない)
    s = s.replace(/(\*\*|__)(.+?)\1/g, "<strong>$2</strong>");
    s = s.replace(/\*([^*\n]+?)\*/g, "<em>$1</em>");
    s = s.replace(/~~([^~\n]+?)~~/g, "<del>$1</del>");

    // 退避を戻す
    s = s.replace(/\x00MD(\d+)\x00/g, (_, i) => stash[Number(i)] ?? "");
    return s;
  }

  function isHr(line) {
    return /^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
  }

  function renderBlock(block) {
    const lines = block.split("\n");
    const first = lines[0];

    // 見出し (# + 半角空白)。残り行は段落として続けず別ブロック化はせず、
    // 素直に先頭行だけ見出し・残りは段落にする。
    let m = first.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      const lv = m[1].length;
      let out = "<h" + lv + ">" + renderInline(m[2]) + "</h" + lv + ">";
      if (lines.length > 1) out += renderBlock(lines.slice(1).join("\n"));
      return out;
    }
    if (lines.length === 1 && isHr(first)) return "<hr>";

    // 箇条書き
    if (lines.every((l) => /^[-*+]\s+\S/.test(l))) {
      return "<ul>" + lines.map((l) => "<li>" + renderInline(l.replace(/^[-*+]\s+/, "")) + "</li>").join("") + "</ul>";
    }
    // 番号付き
    if (lines.every((l) => /^\d+[.)]\s+\S/.test(l))) {
      return "<ol>" + lines.map((l) => "<li>" + renderInline(l.replace(/^\d+[.)]\s+/, "")) + "</li>").join("") + "</ol>";
    }
    // 引用
    if (lines.every((l) => /^&gt; ?/.test(l))) {
      const inner = lines.map((l) => l.replace(/^&gt; ?/, "")).join("\n");
      return "<blockquote>" + renderInline(inner).replace(/\n/g, "<br>") + "</blockquote>";
    }
    // 段落 (単改行は <br>)
    return "<p>" + renderInline(block).replace(/\n/g, "<br>") + "</p>";
  }

  function wdMarkdown(src) {
    const text = String(src || "").replace(/\r\n?/g, "\n");
    if (!text.trim()) return "";
    // ```fence``` を先に退避 (中身は装飾・リンク化しない)
    const fences = [];
    const noFence = text.replace(/^```[^\n]*\n([\s\S]*?)(?:^```\s*$|\Z)/gm, (_, code) => {
      return "\x00FENCE" + (fences.push(code.replace(/\n$/, "")) - 1) + "\x00";
    });
    const escaped = escHtml(noFence);
    // 空行でブロック分割 (fence行は単独ブロックになるよう前後改行を足す)
    const withMarks = escaped.replace(/\x00FENCE(\d+)\x00/g, "\n\n\x00FENCE$1\x00\n\n");
    const blocks = withMarks.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
    const html = blocks
      .map((b) => {
        const fm = b.match(/^\x00FENCE(\d+)\x00$/);
        if (fm) return "<pre><code>" + escHtml(fences[Number(fm[1])] ?? "") + "</code></pre>";
        return renderBlock(b);
      })
      .join("");
    return html;
  }

  window.wdMarkdown = wdMarkdown;
})();

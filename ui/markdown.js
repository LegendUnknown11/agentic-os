// Light markdown for AI turns. The transcript rendered every model's raw
// text through textContent, so a reply that said "**do X**, then `y()`"
// showed the literal asterisks and backticks instead of the emphasis the
// model actually wrote — every CLI (Claude, Codex, Agy, opencode) answers in
// markdown, so displaying it as plain text was always wrong, not a style
// choice.
//
// No dependency: this covers the handful of constructs a team's turns
// actually use (bold, italic, inline/fenced code, links, lists) in a few
// dozen lines. Anything fancier (tables, nested blockquotes) falls through
// to plain paragraphs, which is exactly what happened before this file
// existed — a regression floor, not a new failure mode.
//
// Escape-first, placeholder-protect, THEN transform: text is HTML-escaped
// before any markdown rule runs, so every capture group a regex pulls out of
// the model's own text is already inert. Code spans are pulled out before
// bold/italic/link rules run so `**not bold**` inside a code span stays
// literal, exactly like every other markdown renderer.

const escapeHtml = (s) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Only http(s) may become a clickable link — anything else (javascript:, data:) stays plain text. */
const safeHref = (url) => /^https?:\/\//i.test(url) ? url : null;

export function mdToHtml(text) {
  const escaped = escapeHtml(text);

  // 1. Fenced code blocks first — everything inside is verbatim, including
  // characters that look like other markdown. \0 cannot occur in real text,
  // so the token can only ever match the line it replaced — no accidental
  // collision with the model's own prose.
  const blocks = [];
  let out = escaped.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(code.replace(/\n$/, ''));
    return `\0B${blocks.length - 1}\0`;
  });

  // 2. Inline code spans, same protection. These stay inline (inside
  // whatever paragraph or list item they sit in), unlike fenced blocks.
  const spans = [];
  out = out.replace(/`([^`\n]+)`/g, (_, code) => {
    spans.push(code);
    return `\0S${spans.length - 1}\0`;
  });

  // 3. Links, bold, italic — safe now, everything left is either the model's
  // own escaped prose or a placeholder token.
  //
  // vault: is not a real scheme — it never reaches the network or an <a>'s
  // real href. It's a citation the app intercepts (see app.js's delegated
  // click handler) and routes to the Notes panel, so a member can point the
  // user straight at the note it drew an answer from.
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    if (/^vault:/i.test(url)) return `<a href="#" class="vault-link" data-vault="${url.slice(6)}">${label}</a>`;
    const href = safeHref(url);
    return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : m;
  });
  out = out.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
  // CommonMark's own rule for a lone "*": no space just inside either
  // delimiter, or "a * b * c" (a literal aside, spaced on both sides) reads
  // as emphasis around " b ".
  out = out.replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, '<em>$1</em>');

  // 4. Blocks: consecutive "- "/"* " lines become one <ul>, "1. " lines one
  // <ol>, a fenced-block token is its own block (never wrapped in a <p>),
  // blank-line-separated runs of anything else become <p>, and a lone
  // newline inside a paragraph becomes <br> so a model's own line breaks
  // survive without every line turning into its own block.
  const lines = out.split('\n');
  const html = [];
  let list = null; // 'ul' | 'ol' | null
  let para = [];
  const flushPara = () => {
    if (para.length) { html.push(`<p>${para.join('<br>')}</p>`); para = []; }
  };
  const closeList = () => { if (list) { html.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    const fenced = /^\0B(\d+)\0$/.exec(line.trim());
    const bullet = /^\s*[-*]\s+(.+)/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)/.exec(line);
    if (fenced) {
      closeList();
      flushPara();
      html.push(`<pre><code>${blocks[+fenced[1]]}</code></pre>`);
    } else if (bullet || ordered) {
      flushPara();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) { closeList(); html.push(`<${kind}>`); list = kind; }
      html.push(`<li>${(bullet ?? ordered)[1]}</li>`);
    } else if (line.trim() === '') {
      closeList();
      flushPara();
    } else {
      closeList();
      para.push(line);
    }
  }
  closeList();
  flushPara();

  return html.join('').replace(/\0S(\d+)\0/g, (_, i) => `<code>${spans[+i]}</code>`);
}

// Light markdown rendering for AI turns: escape-first, then bold/italic/
// code/links/lists — never raw HTML from a model's own text.
//   node test/t-markdown.js
import { strict as a } from 'node:assert';
import { mdToHtml } from '../ui/markdown.js';

// --- HTML in the model's own text must never become a tag -----------------
a.equal(mdToHtml('<script>alert(1)</script>'),
  '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');

// --- inline emphasis --------------------------------------------------
a.equal(mdToHtml('**do X**, then run it'), '<p><strong>do X</strong>, then run it</p>');
a.equal(mdToHtml('this is *important*'), '<p>this is <em>important</em></p>');
a.match(mdToHtml('a * b * c'), /<p>a \* b \* c<\/p>/, 'a lone asterisk pair with spaces is not italic');

// --- inline code: verbatim, not re-parsed for markdown ------------------
a.equal(mdToHtml('call `foo()` next'), '<p>call <code>foo()</code> next</p>');
a.equal(mdToHtml('`**not bold**`'), '<p><code>**not bold**</code></p>',
  'markdown syntax inside a code span must stay literal');
a.equal(mdToHtml('`<b>`'), '<p><code>&lt;b&gt;</code></p>', 'HTML inside a code span stays escaped too');

// --- fenced code blocks --------------------------------------------------
a.equal(mdToHtml('```\nlet x = 1;\n```'), '<pre><code>let x = 1;</code></pre>');
a.equal(mdToHtml('```js\nlet x = 1;\n```'), '<pre><code>let x = 1;</code></pre>',
  'a language tag on the fence must not leak into the code');

// --- links: only http(s) becomes clickable -------------------------------
a.equal(mdToHtml('see [the docs](https://example.com/x)'),
  '<p>see <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">the docs</a></p>');
a.equal(mdToHtml('[click me](javascript:alert(1))'), '<p>[click me](javascript:alert(1))</p>',
  'a non-http(s) scheme must not become a link');

// --- vault: links are intercepted client-side, never a real href ----------
a.equal(mdToHtml('see [Model Guidance](vault:References/Model%20Guidance.md)'),
  '<p>see <a href="#" class="vault-link" data-vault="References/Model%20Guidance.md">Model Guidance</a></p>');
a.equal(mdToHtml('[x](vault:notes/a"b.md)'),
  '<p><a href="#" class="vault-link" data-vault="notes/a&quot;b.md">x</a></p>',
  'a quote in a vault path lands in the attribute already-escaped, not a breakout');

// --- lists -----------------------------------------------------------
a.equal(mdToHtml('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
a.equal(mdToHtml('1. first\n2. second'), '<ol><li>first</li><li>second</li></ol>');
a.equal(mdToHtml('- one\n\nplain para'), '<ul><li>one</li></ul><p>plain para</p>',
  'a list must close before an unrelated paragraph starts');

// --- paragraphs and line breaks -------------------------------------------
a.equal(mdToHtml('line one\nline two'), '<p>line one<br>line two</p>',
  'a single newline inside a paragraph is a line break, not a new block');
a.equal(mdToHtml('first para\n\nsecond para'), '<p>first para</p><p>second para</p>');

console.log('t-markdown.js OK — escaped first, code spans protected, only http(s) links, lists close cleanly');

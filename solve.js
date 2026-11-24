// solve.js — a faster drop-in for makefun-site 1.0.0.
//
// Same output, byte for byte: same templates, same Markdown subset, same
// front matter rules, same refusal/report messages, same slug and date
// rules. Speed comes from:
//  - front matter parsed by scanning line boundaries (no full split of the
//    text, no re-join of the body; the \r normalisation is skipped when
//    the text holds no \r);
//  - a fused single-pass Markdown renderer (no token objects): plain-text
//    runs are buffered and escaped once per run, and emphasis/strong/link
//    closers are found with indexOf plus a backslash-parity test instead of
//    a per-character scan;
//  - templates parsed once per build and rendered by an optimised
//    tree-walk: scope objects are allocated once per for-node visit and
//    mutated across iterations, lookups use null-prototype data objects
//    (a missing key reads as undefined), and templates whose output depends
//    only on site/tags/recent are rendered once per build and cached, as
//    are single-dependency templates (e.g. the post card, keyed by the
//    post object) — all decided by a dependency analysis at build time;
//  - slugify cached per build; each source's word count is computed once
//    and reused by its card and its page.
//
// No network, no randomness, no time dependence: two runs on the same input
// produce identical output.

export function run(input) {
  return build(input);
}

// ---------------------------------------------------------------- helpers

const INCLUDE_DEPTH = 8;
const REPORT_FILE = 'build-report.txt';

const RESERVED = ['posts', 'tags', 'page'];
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WORDS = /\S+/g;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
];
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function slugify(text, cache) {
  let out = cache.get(text);
  if (out !== undefined) return out;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let slug = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = slug.length > 0;
      continue;
    }
    if (gap) slug += '-';
    gap = false;
    slug += keep;
  }
  slug = slug.slice(0, 64).replace(/-+$/, '');
  out = slug === '' ? 'untitled' : slug;
  cache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date) {
  const parts = date.split('-');
  return `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function dirOf(path) {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

// A scope-visible data object: null prototype, so a template lookup's
// "missing key" test (reads as undefined) is exactly an own-property test.
function o() {
  return Object.create(null);
}

// ---------------------------------------------------------------- templates
//
// Parser: the vendor's lib/template.js, ported verbatim in behaviour — same
// tokens, same stack-based parse, same TemplateError messages (each carries
// the template's name), same node shapes.

class TemplateError extends Error {}

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH.test(text)) {
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      }
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({
        t: raw ? 'raw' : 'var',
        path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()),
      });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open))
      && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) {
          throw new TemplateError(`template "${name}": an else outside an if`);
        }
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body
          : parent.kind === 'for' ? parent.body
          : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) {
        body.push({ kind: 'include', name: m[1] });
      } else {
        throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
      }
    }
  }
  if (stack.length > 1) {
    throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  }
  return root.body;
}

// ---------------------------------------------------------------- template render

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Lookup: all data objects are built with a null prototype and never hold
// an explicit undefined, so a missing key reads as undefined — exactly the
// vendor's own-property check. Arrays are the one exception (prototype
// members like .map must not resolve), so they keep the hasOwn test.
function lookup(scope, path) {
  let s = scope;
  let v;
  const first = path[0];
  while (s !== null) {
    v = s.vars[first];
    if (v !== undefined) break;
    s = s.parent;
  }
  if (s === null) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object') return undefined;
    if (Array.isArray(v)) {
      if (!Object.hasOwn(v, path[k])) return undefined;
    } else if (v[path[k]] === undefined) {
      return undefined;
    }
    v = v[path[k]];
  }
  return v;
}

// Dependency analysis: which root names can a template's output depend on?
// `bound` is the set of names bound by enclosing for-loops in this template.
// Returns a Set of unbound first names, or null when the analysis cannot be
// trusted (an include cycle).
function analyzeNodes(nodes, templates, bound, visiting) {
  const deps = new Set();
  for (const n of nodes) {
    switch (n.kind) {
      case 'var':
      case 'raw':
      case 'if':
        if (!bound.has(n.path[0])) deps.add(n.path[0]);
        break;
      case 'for':
        if (!bound.has(n.path[0])) deps.add(n.path[0]);
        break;
      case 'include': {
        if (visiting.has(n.name)) return null;
        const child = templates.get(n.name);
        if (child === undefined) break;
        visiting.add(n.name);
        const childDeps = analyzeNodes(child, templates, bound, visiting);
        visiting.delete(n.name);
        if (childDeps === null) return null;
        for (const d of childDeps) deps.add(d);
        break;
      }
      default:
        break;
    }
    if (n.kind === 'if') {
      const thenDeps = analyzeNodes(n.then, templates, bound, visiting);
      if (thenDeps === null) return null;
      for (const d of thenDeps) deps.add(d);
      if (n.else !== null) {
        const elseDeps = analyzeNodes(n.else, templates, bound, visiting);
        if (elseDeps === null) return null;
        for (const d of elseDeps) deps.add(d);
      }
    }
    if (n.kind === 'for') {
      const inner = new Set(bound);
      inner.add(n.name);
      inner.add('loop');
      const bodyDeps = analyzeNodes(n.body, templates, inner, visiting);
      if (bodyDeps === null) return null;
      for (const d of bodyDeps) deps.add(d);
    }
  }
  return deps;
}

const CONSTANT_NAMES = new Set(['site', 'tags', 'recent']);

function analyzeTemplates(templates) {
  const memo = new Map();
  for (const name of templates.keys()) {
    const visiting = new Set([name]);
    const deps = analyzeNodes(templates.get(name), templates, new Set(), visiting);
    if (deps === null) {
      memo.set(name, null);
      continue;
    }
    let nonConstant = null;
    let count = 0;
    for (const d of deps) {
      if (!CONSTANT_NAMES.has(d)) {
        count++;
        nonConstant = d;
      }
    }
    if (count === 0) {
      memo.set(name, { const: true, cache: new Map() });
    } else if (count === 1 && nonConstant !== 'loop') {
      memo.set(name, { key: nonConstant, cache: new Map() });
    } else {
      memo.set(name, null);
    }
  }
  return memo;
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One scope object and one loop object per visit of this node,
        // mutated across iterations (rendering is synchronous depth-first,
        // so no live reference survives an iteration).
        const vars = o();
        const loop = o();
        vars.loop = loop;
        const frame = { vars, parent: scope };
        const len = xs.length;
        loop.length = len;
        for (let k = 0; k < len; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === len - 1;
          renderNodes(n.body, frame, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        if (depth >= INCLUDE_DEPTH) break;
        const child = ctx.templates.get(n.name);
        if (child === undefined) break;
        const plan = ctx.memo.get(n.name);
        if (plan === null) {
          renderNodes(child, scope, ctx, depth + 1, out);
          break;
        }
        const at = depth + 1;
        if (plan.const) {
          let html = plan.cache.get(at);
          if (html === undefined) {
            const tmp = [];
            renderNodes(child, scope, ctx, at, tmp);
            html = tmp.join('');
            plan.cache.set(at, html);
          }
          out.push(html);
        } else {
          // Single-dependency memo: the rendered output is a function of
          // one value (plus site/tags/recent, which are fixed per build).
          const value = lookup(scope, [plan.key]);
          let byDepth = plan.cache.get(at);
          if (byDepth === undefined) {
            byDepth = new Map();
            plan.cache.set(at, byDepth);
          }
          let html = byDepth.get(value);
          if (html === undefined) {
            const tmp = [];
            renderNodes(child, scope, ctx, at, tmp);
            html = tmp.join('');
            byDepth.set(value, html);
          }
          out.push(html);
        }
        break;
      }
      default:
        break;
    }
  }
}

function render(ctx, name, vars) {
  const nodes = ctx.templates.get(name);
  if (nodes === undefined) return null;
  const scope = { vars, parent: null };
  const out = [];
  renderNodes(nodes, scope, ctx, 0, out);
  return out.join('');
}

// ---------------------------------------------------------------- front matter
//
// The vendor's lib/frontmatter.js, with the text scanned by line boundaries
// instead of split('\n') + slice + join, so the body is never copied twice.
// Same errors, same check order, same values.

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) {
      return { error: 'a quoted string is not closed' };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true }
        : raw === 'false' ? { value: false }
        : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

// Parses one source's front matter: { data, body } or { error } with the
// first refusal reason, exactly as the vendor reports it.
function parseFrontMatter(text) {
  // First line must be exactly '---'.
  let lineEnd = text.indexOf('\n');
  if (lineEnd === -1) lineEnd = text.length;
  if (text.slice(0, lineEnd) !== '---') return { error: 'no front matter' };
  const data = {};
  let lineNo = 1; // 1-based; the opening '---' is line 1
  let pos = lineEnd + 1;
  let closeFound = false;
  let bodyStart = text.length;
  while (pos <= text.length) {
    let end = text.indexOf('\n', pos);
    if (end === -1) end = text.length;
    const line = text.slice(pos, end);
    if (line === '---') {
      closeFound = true;
      bodyStart = end < text.length ? end + 1 : text.length;
      break;
    }
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) {
      // blank or comment line: skipped
    } else {
      const m = LINE.exec(line);
      if (m === null) return { error: `line ${lineNo + 1} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (end === text.length) break;
    pos = end + 1;
    lineNo++;
  }
  if (!closeFound) return { error: 'the front matter is not closed' };
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- Markdown
//
// The vendor's lib/markdown.js, fused into one pass over the body: a line
// cursor walks the string with indexOf, so no lines array and no token
// objects are materialised. Same blocks, same inline rules, same output.

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE = /^>/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const BLANK = /^[ \t]*$/;

function trimLine(line) {
  const n = line.length;
  if (n === 0) return line;
  const first = line.charCodeAt(0);
  const last = line.charCodeAt(n - 1);
  if (first !== 32 && first !== 9 && last !== 32 && last !== 9) return line;
  return line.replace(/^[ \t]+|[ \t]+$/g, '');
}

function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

// Whether `line` ends a paragraph: a blank line, a fence, a heading or a
// thematic break. Each test only matches lines opening on one character,
// so the first character decides which test can even apply.
function endsParagraph(line) {
  const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
  if (c0 === -1 || c0 === 32 || c0 === 9) return BLANK.test(line);
  if (c0 === 96) return FENCE_OPEN.test(line);
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return HR.test(line);
  return false;
}

// Number of backslashes immediately before position j in s.
function backslashesBefore(s, j) {
  let k = 0;
  for (let t = j - 1; t >= 0 && s[t] === '\\'; t--) k++;
  return k;
}

// First index >= from of `what` whose first character is not escaped, or -1.
// Equivalent to the vendor's character-by-character scan: a character is
// escaped exactly when preceded by an odd run of backslashes.
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    if (backslashesBefore(s, j) % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

// First single `*` at or after `from` that is not escaped and not beside
// another `*`, or -1. Same rule as the vendor's findSingleStar.
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (backslashesBefore(s, j) % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

// Index of the next inline-markup character (`\`, backtick, `*`, `[`) at or
// after `from`, or s.length. Four native scans beat a per-character loop
// when most of a paragraph is plain text.
function nextSpecial(s, from) {
  let j = s.length;
  const b = s.indexOf('\\', from);
  if (b !== -1 && b < j) j = b;
  const t = s.indexOf('`', from);
  if (t !== -1 && t < j) j = t;
  const a = s.indexOf('*', from);
  if (a !== -1 && a < j) j = a;
  const l = s.indexOf('[', from);
  if (l !== -1 && l < j) j = l;
  return j;
}

function renderInline(s, link) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    // Plain run up to the next markup character. A backslash not followed
    // by an escapable character is itself plain text, so the run extends
    // past it.
    let j = nextSpecial(s, i);
    while (j < n && s[j] === '\\' && (j + 1 >= n || !ESCAPABLE.has(s[j + 1]))) {
      j = nextSpecial(s, j + 1);
    }
    if (j > i) out += escapeHtml(s.slice(i, j));
    if (j >= n) break;
    i = j;
    const c = s[i];
    if (c === '\\') {
      out += escapeHtml(s[i + 1]);
      i += 2;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        out += '<code>' + escapeHtml(s.slice(i + 1, k)) + '</code>';
        i = k + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          out += '<strong>' + renderInline(s.slice(i + 2, k), link) + '</strong>';
          i = k + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1);
      if (k > i + 1) {
        out += '<em>' + renderInline(s.slice(i + 1, k), link) + '</em>';
        i = k + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', i + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      out += '<a href="' + escapeHtml(link(target)) + '">'
        + renderInline(s.slice(i + 1, k), link) + '</a>';
      i = m + 1;
      continue;
    }
    out += '[';
    i++;
  }
  return out;
}

// Renders one source body. env: { link(target) } — the link resolver for
// this source. Returns { html, toc, excerpt }.
function renderMarkdown(body, env, slugCache) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;

  let p = 0;
  const n = body.length;
  let cur = null;
  const adv = () => {
    if (p >= n) {
      cur = null;
      return;
    }
    const nl = body.indexOf('\n', p);
    if (nl === -1) {
      cur = body.slice(p);
      p = n;
    } else {
      cur = body.slice(p, nl);
      p = nl + 1;
    }
  };

  adv();
  while (cur !== null) {
    const line = cur;
    // Each block test only matches lines opening on one character, so the
    // first character decides which test can even apply.
    const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
    if (c0 === -1 || c0 === 32 || c0 === 9) {
      if (BLANK.test(line)) {
        adv();
        continue;
      }
    }
    const fence = c0 === 96 ? FENCE_OPEN.exec(line) : null;
    if (fence !== null) {
      const codeLines = [];
      adv();
      while (cur !== null && !FENCE_CLOSE.test(cur)) {
        codeLines.push(cur);
        adv();
      }
      adv();
      const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
      blocks.push(`<pre><code${cls}>${codeLines.map((l) => `${escapeHtml(l)}\n`).join('')}</code></pre>`);
      continue;
    }
    const heading = c0 === 35 ? headingOf(line) : null;
    if (heading !== null) {
      adv();
      const id = uniqueSlug(slugify(heading.text, slugCache), ids);
      const html = renderInline(heading.text, env.link);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) {
        const entry = o();
        entry.level = heading.depth;
        entry.id = id;
        entry.html = html;
        toc.push(entry);
      }
      continue;
    }
    if ((c0 === 45 || c0 === 42) && HR.test(line)) {
      adv();
      blocks.push('<hr>');
      continue;
    }
    if (c0 === 62) {
      const quoteLines = [];
      while (cur !== null && QUOTE.test(cur)) {
        quoteLines.push(cur.replace(/^> ?/, ''));
        adv();
      }
      const kept = quoteLines.map(trimLine).filter((l) => l !== '');
      blocks.push(kept.length === 0
        ? '<blockquote>\n</blockquote>'
        : `<blockquote>\n<p>${renderInline(kept.join('\n'), env.link)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = (c0 === 45 || c0 === 42) ? BULLET.exec(line) : null;
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (cur !== null) {
        const m = marker.exec(cur);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          adv();
        } else if (CONTINUED.test(cur)) {
          items[items.length - 1].push(trimLine(cur));
          adv();
        } else {
          break;
        }
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const start = isOrdered ? Number(ordered[1]) : 1;
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let inner = '';
      for (const parts of items) {
        inner += `<li>${renderInline(parts.join('\n'), env.link)}</li>\n`;
      }
      blocks.push(`${open}\n${inner}</${tag}>`);
      continue;
    }
    // Paragraph.
    const para = [trimLine(line)];
    adv();
    while (cur !== null && !endsParagraph(cur)) {
      para.push(trimLine(cur));
      adv();
    }
    const html = renderInline(para.join('\n'), env.link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return {
    html: blocks.map((b) => `${b}\n`).join(''),
    toc,
    excerpt: excerpt === null ? '' : excerpt,
  };
}

// ---------------------------------------------------------------- pipeline

function build(input) {
  const site = input.site;
  const base = site.base_url.replace(/\/+$/, '');
  const slugCache = new Map();

  // Templates: parse in code-unit order of name; unparsable ones are
  // reported (the error already names the template) and left out.
  const report = [];
  const templates = new Map();
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (e) {
      if (e instanceof TemplateError) {
        report.push(e.message);
      } else {
        throw e;
      }
    }
  }
  const memo = analyzeTemplates(templates);
  const ctx = { templates, memo };

  // Sources: files is an array of { path, content }, sorted by path in
  // code-unit order; a source that is not .md is static.
  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, text });
    } else {
      statics.push({ path: f.path, content: f.content });
    }
  }
  const staticPaths = new Set(statics.map((f) => f.path));

  // Front matter.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    const data = fm.data;
    s.data = data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks.
  const takenByDir = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? RESERVED : []);
      takenByDir.set(dir, taken);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), taken);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, with each source's link environment.
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const rendered = renderMarkdown(s.body, env, slugCache);
    s.html = rendered.html;
    s.toc = rendered.toc;
    s.excerpt = rendered.excerpt;
    s.words = (s.body.match(WORDS) ?? []).length;
  }

  // Collections: posts newest first, then by slug; newer/older neighbours.
  const posts = kept.filter((s) => s.post).sort((x, y) => {
    const byDate = byCodeUnits(y.data.date, x.data.date);
    return byDate !== 0 ? byDate : byCodeUnits(x.slug, y.slug);
  });
  for (let k = 0; k < posts.length; k++) {
    const p = posts[k];
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by slug, each named as first met walking the posts in
  // collection order, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = o();
        tag.name = name;
        tag.slug = slug;
        tag.url = `${base}/tags/${slug}/`;
        tag.posts = [];
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing
  // (url "") where no post has it.
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      const tag = bySlug.get(slug);
      if (tag !== undefined) return tag;
      const fallback = o();
      fallback.name = name;
      fallback.slug = slug;
      fallback.url = '';
      fallback.posts = [];
      return fallback;
    });
  }
  const tagObjects = [...bySlug.values()].sort((x, y) => {
    if (x.posts.length !== y.posts.length) return y.posts.length - x.posts.length;
    return byCodeUnits(x.slug, y.slug);
  });
  const allTags = tagObjects.map((t) => {
    const tag = o();
    tag.name = t.name;
    tag.slug = t.slug;
    tag.url = t.url;
    tag.count = t.posts.length;
    return tag;
  });

  // Cards and pages.
  function cardOf(s) {
    const card = o();
    card.title = s.data.title;
    card.url = s.url;
    card.date = s.data.date ?? '';
    card.date_long = s.data.date === undefined ? '' : longDate(s.data.date);
    card.summary = s.data.summary ?? '';
    card.excerpt = s.excerpt;
    card.reading_minutes = Math.max(1, Math.ceil(s.words / 200));
    card.tags = s.tagRefs.map((t) => {
      const tag = o();
      tag.name = t.name;
      tag.slug = t.slug;
      tag.url = t.url;
      return tag;
    });
    return card;
  }
  function linkOf(s) {
    if (s === null) return null;
    const link = o();
    link.title = s.data.title;
    link.url = s.url;
    link.date = s.data.date ?? '';
    link.date_long = s.data.date === undefined ? '' : longDate(s.data.date);
    return link;
  }
  function pageOf(s) {
    const page = cardOf(s);
    page.slug = s.slug;
    page.content = s.html;
    page.toc = s.toc;
    page.newer = linkOf(s.newer ?? null);
    page.older = linkOf(s.older ?? null);
    page.is_post = s.post;
    return page;
  }
  function tagOf(t) {
    const tag = o();
    tag.name = t.name;
    tag.slug = t.slug;
    tag.url = t.url;
    tag.count = t.posts.length;
    tag.posts = t.posts.map((p) => cards.get(p));
    return tag;
  }
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const siteVars = o();
  siteVars.title = site.title;
  siteVars.base_url = base;
  const recent = posts.slice(0, site.recent).map((p) => cards.get(p));

  const output = {};
  for (const s of kept) {
    const vars = o();
    vars.site = siteVars;
    vars.tags = allTags;
    vars.recent = recent;
    vars.page = pageOf(s);
    output[`${s.outDir}/index.html`] = render(ctx, s.layout, vars);
  }
  const pages = kept.length - posts.length;

  // Index pages.
  const per = site.per_page;
  const totalPages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= totalPages; k++) {
    const pager = o();
    pager.number = k;
    pager.total = totalPages;
    pager.url = indexUrl(k);
    pager.newer_url = k === 1 ? '' : indexUrl(k - 1);
    pager.older_url = k === totalPages ? '' : indexUrl(k + 1);
    const vars = o();
    vars.site = siteVars;
    vars.tags = allTags;
    vars.recent = recent;
    vars.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
    vars.pager = pager;
    const html = render(ctx, 'index', vars);
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }

  // Tag pages.
  for (const t of tagObjects) {
    const vars = o();
    vars.site = siteVars;
    vars.tags = allTags;
    vars.recent = recent;
    vars.tag = tagOf(t);
    const html = render(ctx, 'tag', vars);
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }

  // Tags index.
  {
    const vars = o();
    vars.site = siteVars;
    vars.tags = allTags;
    vars.recent = recent;
    const html = render(ctx, 'tags', vars);
    if (html !== null) output['tags/index.html'] = html;
  }

  // Static files.
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) {
      report.push(`shadowed ${f.path}: a built page has its path`);
      continue;
    }
    output[f.path] = f.content;
  }

  // Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${pages} pages, ${posts.length} posts, ${tagObjects.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;

  return output;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

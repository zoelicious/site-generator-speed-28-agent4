// Zero-Alloc Site Engine — a faster drop-in for makefun-site 1.0.0.
// Written from scratch against the makefun-site README and reference code.
// Design: minimal allocation in the hot paths.
//  - Markdown is rendered in one direct pass over its lines (no token objects,
//    no intermediate block arrays); inline markup works on (string, lo, hi)
//    ranges so nested strong/em/link text never allocates a substring.
//  - HTML escaping has a fast path: plain segments are pushed as-is.
//  - Slugs are cached per build (one Map, created fresh inside run()).
//  - Templates render into one shared string array per page; loop scopes are
//    plain frames pushed/popped on a stack, with no closures per page.
//  - No cache survives a run(): every build is a pure function of its input.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SPECIAL_RE = /[&<>"']/g;
const SPECIAL_TEST = /[&<>"']/;

/** Push s[lo,hi) escaped into out; plain segments go through untouched. */
function escPush(out, s, lo, hi) {
  if (lo >= hi) return;
  SPECIAL_RE.lastIndex = lo;
  let m = SPECIAL_RE.exec(s);
  if (m === null || m.index >= hi) { out.push(s.slice(lo, hi)); return; }
  let seg = lo;
  while (m !== null && m.index < hi) {
    if (m.index > seg) out.push(s.slice(seg, m.index));
    out.push(ESC[m[0]]);
    seg = m.index + 1;
    m = SPECIAL_RE.exec(s);
  }
  if (hi > seg) out.push(s.slice(seg, hi));
}

/** Escape a whole string, returning it unchanged when it needs nothing. */
function escStr(s) {
  if (!SPECIAL_TEST.test(s)) return s;
  const out = [];
  escPush(out, s, 0, s.length);
  return out.join('');
}

const SLUG_MAX = 64;
const MARK_RE = /\p{M}/gu;

/** The slug of `text`, exactly as makefun-site defines it. */
function slugifyRaw(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < plain.length; i++) {
    if (plain.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  if (!ascii) plain = plain.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

function wordsOf(text) {
  // Runs of non-whitespace, counted by hand: String.match would build an
  // array of every word. Whitespace here is exactly JS \s.
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 || c === 160 || c === 5760 ||
      (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
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
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  // Lines are walked with indexOf('\n'); the body is a slice, never a join.
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let from = text === '---' ? 3 : 4; // just past the opening '---' line
  let closeLine = -1;
  let closeEnd = -1;
  let lineNo = 1;
  while (true) {
    const nl = text.indexOf('\n', from);
    const end = nl === -1 ? text.length : nl;
    if (text.slice(from, end) === '---') {
      closeLine = lineNo;
      closeEnd = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    from = nl + 1;
    lineNo++;
  }
  const data = {};
  from = text === '---' ? 3 : 4;
  for (let i = 1; i < closeLine; i++) {
    const nl = text.indexOf('\n', from);
    const line = text.slice(from, nl);
    from = nl + 1;
    if (/^[ \t]*$/.test(line) || line[0] === '#') continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, colon);
    let okKey = true;
    for (let k = 0; k < key.length; k++) {
      const c = key[k];
      if (!((c >= 'a' && c <= 'z') || c === '_')) { okKey = false; break; }
    }
    if (!okKey) return { error: `line ${i + 1} is not "key: value"` };
    let raw;
    if (colon === line.length - 1) raw = '';
    else if (line[colon + 1] === ' ') raw = line.slice(colon + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    raw = raw.replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const CONTINUED_RE = /^ {2,}\S/;

const trimLine = (line) => {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
};

function isBlank(line) {
  if (line === '') return true;
  const c = line[0];
  if (c !== ' ' && c !== '\t') return false;
  for (let i = 1; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** Fence opener: language string ('' when none) or undefined when not a fence. */
function fenceOpen(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return undefined;
  let i = 3;
  while (i < line.length) {
    const c = line[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') i++;
    else break;
  }
  const langEnd = i;
  for (; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return undefined;
  }
  return line.slice(3, langEnd);
}

function fenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** Heading: { depth, text } or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  if (line[n] !== ' ' && line[n] !== '\t') return null;
  let end = line.length;
  while (end > n && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  let start = n;
  while (start < end && (line[start] === ' ' || line[start] === '\t')) start++;
  if (start >= end) return null;
  return { depth: n, text: line.slice(start, end) };
}

function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== undefined || headingOf(line) !== null || isHr(line);
}

function findUnescaped(s, what, from, hi) {
  let j = from;
  while (j + what.length <= hi) {
    if (s[j] === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) { j += 2; continue; }
    if (s.startsWith(what, j)) return j;
    j++;
  }
  return -1;
}

function findSingleStar(s, from, hi) {
  let j = from;
  while (j < hi) {
    const c = s[j];
    if (c === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) { j += 2; continue; }
    if (c !== '*') { j++; continue; }
    if (s[j + 1] === '*') { j += 2; continue; }
    return j;
  }
  return -1;
}

/** Render s[lo,hi) inline into out; link(target) resolves a link target. */
function inlineRange(out, s, lo, hi, link) {
  // Fast path: no markup trigger at all — one escaped push, no per-char loop.
  let first = -1;
  for (let k = 0; k < 4; k++) {
    const p = s.indexOf('\\`[*'[k], lo);
    if (p !== -1 && p < hi && (first === -1 || p < first)) first = p;
  }
  if (first === -1) { escPush(out, s, lo, hi); return; }
  let i = first;
  let seg = lo;
  while (i < hi) {
    const c = s[i];
    if (c === '\\' && i + 1 < hi && ESCAPABLE.has(s[i + 1])) {
      escPush(out, s, seg, i);
      const n = s[i + 1];
      out.push(n === '>' ? '&gt;' : n);
      i += 2;
      seg = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < hi && j > i + 1) {
        escPush(out, s, seg, i);
        out.push('<code>');
        escPush(out, s, i + 1, j);
        out.push('</code>');
        i = j + 1;
        seg = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j !== -1 && j > i + 2) {
          escPush(out, s, seg, i);
          out.push('<strong>');
          inlineRange(out, s, i + 2, j, link);
          out.push('</strong>');
          i = j + 2;
          seg = i;
        } else {
          escPush(out, s, seg, i);
          out.push('**');
          i += 2;
          seg = i;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j !== -1 && j > i + 1) {
        escPush(out, s, seg, i);
        out.push('<em>');
        inlineRange(out, s, i + 1, j, link);
        out.push('</em>');
        i = j + 1;
        seg = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, hi);
      let m = -1;
      if (k !== -1 && s[k + 1] === '(') {
        const p = s.indexOf(')', k + 2);
        if (p !== -1 && p < hi) m = p;
      }
      if (m !== -1) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !/\s/.test(target)) {
          escPush(out, s, seg, i);
          out.push('<a href="');
          const href = link(target);
          escPush(out, href, 0, href.length);
          out.push('">');
          inlineRange(out, s, i + 1, k, link);
          out.push('</a>');
          i = m + 1;
          seg = i;
          continue;
        }
      }
      i++;
      continue;
    }
    i++;
  }
  escPush(out, s, seg, hi);
}

function inlineStr(s, link) {
  const out = [];
  inlineRange(out, s, 0, s.length, link);
  return out.join('');
}

/**
 * Render a Markdown body. Returns { html, toc, excerpt }.
 * `link` resolves link targets; `slugOf` is the build's cached slugify.
 * Blocks are written straight into one output array (no per-block strings).
 */
function renderMarkdown(src, link, slugOf) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceOpen(line);
    if (lang !== undefined) {
      i++;
      out.push(lang === '' ? '<pre><code>' : `<pre><code class="language-${escStr(lang)}">`);
      while (i < n && !fenceClose(lines[i])) {
        escPush(out, lines[i], 0, lines[i].length);
        out.push('\n');
        i++;
      }
      i++;
      out.push('</code></pre>', '\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugOf(heading.text), ids);
      const tmp = [];
      inlineRange(tmp, heading.text, 0, heading.text.length, link);
      const html = tmp.join('');
      out.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>`, '\n');
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { out.push('<hr>', '\n'); i++; continue; }
    if (line[0] === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') {
        const l = lines[i++];
        body.push(l[1] === ' ' ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>', '\n');
      else {
        const joined = kept.join('\n');
        out.push('<blockquote>\n<p>');
        inlineRange(out, joined, 0, joined.length, link);
        out.push('</p>\n</blockquote>', '\n');
      }
      continue;
    }
    // List?
    let bullet = false;
    let ordered = null;
    if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') bullet = true;
    else {
      let d = 0;
      while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
      if (d >= 1 && d <= 9 && line[d] === '.' && line[d + 1] === ' ') ordered = { start: Number(line.slice(0, d)), text: line.slice(d + 2) };
    }
    if (bullet || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      let start = 1;
      if (isOrdered) start = ordered.start;
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          let d = 0;
          while (d < l.length && l[d] >= '0' && l[d] <= '9') d++;
          if (d >= 1 && d <= 9 && l[d] === '.' && l[d + 1] === ' ') {
            items.push([trimLine(l.slice(d + 2))]);
            i++;
            continue;
          }
        } else if ((l[0] === '-' || l[0] === '*') && l[1] === ' ') {
          items.push([trimLine(l.slice(2))]);
          i++;
          continue;
        }
        if (CONTINUED_RE.test(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      out.push(isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n');
      for (const parts of items) {
        const text = parts.join('\n');
        out.push('<li>');
        inlineRange(out, text, 0, text.length, link);
        out.push('</li>\n');
      }
      out.push(`</${tag}>`, '\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    out.push('<p>');
    const mark = out.length;
    inlineRange(out, text, 0, text.length, link);
    if (excerpt === null) excerpt = out.slice(mark).join('');
    out.push('</p>', '\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
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
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
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
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(frames, path) {
  let v;
  for (let f = frames.length - 1; f >= 0; f--) {
    if (Object.hasOwn(frames[f], path[0])) {
      v = frames[f][path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) out += ', ';
      out += textOf(v[k]);
    }
    return out;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, frames, templates, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escStr(textOf(lookup(frames, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(frames, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(frames, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, frames, templates, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(frames, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const frame = { loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          frame[n.name] = xs[k];
          frames.push(frame);
          renderNodes(n.body, frames, templates, depth, out);
          frames.pop();
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, frames, templates, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const slugOf = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) {
      s = slugifyRaw(text);
      slugCache.set(text, s);
    }
    return s;
  };

  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of path.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter and the drop checks, in order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  const linkCtx = { dir: '', path: '' };
  const link = (target) => {
    const c0 = target[0];
    if (c0 === '/' || c0 === '#') return target;
    // Scheme? [A-Za-z][A-Za-z0-9+.-]*: — scan by hand, no regex per link.
    if ((c0 >= 'A' && c0 <= 'Z') || (c0 >= 'a' && c0 <= 'z')) {
      let k = 1;
      while (k < target.length) {
        const ch = target[k];
        if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '+' || ch === '.' || ch === '-') k++;
        else break;
      }
      if (target[k] === ':') return target;
    }
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const path = rel === '' ? null : resolvePath(linkCtx.dir, rel);
    if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
    if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
    broken.add(`broken-link ${linkCtx.path} -> ${target}`);
    return target;
  };
  for (const s of sources) {
    linkCtx.dir = dirOf(s.path);
    linkCtx.path = s.path;
    const md = renderMarkdown(s.body, link, slugOf);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (const name of tags) {
      const slug = slugOf(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOf(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugOf(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardCache = new Map();
  const cardOf = (s) => {
    let c = cardCache.get(s);
    if (c !== undefined) return c;
    c = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    cardCache.set(s, c);
    return c;
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    const frames = [{ site, tags: allTags, recent, ...vars }];
    renderNodes(nodes, frames, templates, 0, out);
    return out.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

// YAML 子集解析器：只为读本项目的配置而写，刻意不追求完整 YAML 规范。
// 支持：缩进映射、序列（含 "- key: v" 形式）、行内列表 [a, b]、块标量 | 与 >、
//      引号字符串、布尔/null/数字、行尾注释。
// 不支持（也不需要）：锚点/别名、多文档、复杂行内映射、标签、flow 嵌套超过一层。
//
// 设计取舍：不引第三方库，是因为客户内网常常装不上 npm 包；
// 而一个 180 行的确定性解析器，比"配置读不出来"这种故障好维护得多。

/** 去掉行尾注释：# 前面必须是空白，且在引号外 */
function stripComment(s) {
  let quote = null;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (quote) {
      if (quote === '"' && c === '\\') { k++; continue; }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (k === 0 || /\s/.test(s[k - 1]))) {
      return s.slice(0, k);
    }
  }
  return s;
}

/** 把 "- key: value" 规范化为裸 dash + 缩进映射，简化后续递归 */
function normalize(lines) {
  const out = [];
  for (const line of lines) {
    const m = /^(\s*)-(?:\s+(.*))?$/.exec(line);
    if (m) {
      const indent = m[1].length;
      const content = (m[2] ?? '').replace(/\s+$/, '');
      const isMapEntry = content && !/^["'[{>|]/.test(content) && /^[^:#]+?:(?:\s|$)/.test(content);
      if (isMapEntry) {
        out.push(' '.repeat(indent) + '-');
        out.push(' '.repeat(indent + 2) + content);
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

function indentOf(s) {
  let n = 0;
  while (n < s.length && s[n] === ' ') n++;
  return n;
}

function splitTopLevel(s, sep = ',') {
  const parts = [];
  let quote = null;
  let depth = 0;
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (quote) {
      cur += c;
      if (quote === '"' && c === '\\') { cur += s[++k] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '' || parts.length) parts.push(cur);
  return parts;
}

function scalar(s) {
  const t = s.trim();
  if (t === '') return null;
  if (t === '[]') return [];
  if (t === '{}') return {};
  if (t[0] === '"' && t.at(-1) === '"') {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }
  if (t[0] === "'" && t.at(-1) === "'") return t.slice(1, -1).replace(/''/g, "'");
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d*\.\d+$/.test(t)) return Number(t);
  return t;
}

function parseInline(s) {
  const t = s.trim();
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner).map((p) => parseInline(p));
  }
  if (t.startsWith('{') && t.endsWith('}')) {
    const inner = t.slice(1, -1).trim();
    const obj = {};
    if (!inner) return obj;
    for (const p of splitTopLevel(inner)) {
      const mm = /^([^:]+):(.*)$/.exec(p);
      if (mm) obj[mm[1].trim().replace(/^["']|["']$/g, '')] = parseInline(mm[2]);
    }
    return obj;
  }
  return scalar(t);
}

export function parseYaml(text, { file = '<yaml>' } = {}) {
  const raw = normalize(String(text).replace(/\r\n?/g, '\n').split('\n'));
  let i = 0;

  const blank = (s) => stripComment(s).trim() === '';

  function peek() {
    while (i < raw.length && blank(raw[i])) i++;
    if (i >= raw.length) return null;
    const stripped = stripComment(raw[i]).replace(/\s+$/, '');
    if (stripped.trim() === '') { i++; return peek(); }
    return { text: stripped.trim(), indent: indentOf(stripped), line: i + 1 };
  }

  function readBlockScalar(parentIndent, folded) {
    const start = i;
    const collected = [];
    while (i < raw.length) {
      const line = raw[i];
      if (line.trim() === '') { collected.push(''); i++; continue; }
      if (indentOf(line) <= parentIndent) break;
      collected.push(line.slice(parentIndent + 2 > indentOf(line) ? 0 : parentIndent + 2));
      i++;
    }
    // 去掉尾部空行
    while (collected.length && collected.at(-1).trim() === '') collected.pop();
    if (!collected.length) return '';
    return folded ? collected.join(' ').replace(/\s+/g, ' ').trim() : collected.join('\n');
  }

  function parseNode(minIndent) {
    const l = peek();
    if (!l) return null;
    if (l.indent < minIndent) return null;
    return l.text === '-' || l.text.startsWith('- ') ? parseSeq(l.indent) : parseMap(l.indent);
  }

  function parseSeq(indent) {
    const arr = [];
    for (;;) {
      const l = peek();
      if (!l || l.indent !== indent) break;
      if (!(l.text === '-' || l.text.startsWith('- '))) break;
      const content = l.text === '-' ? '' : l.text.slice(1).trim();
      i++;
      if (content === '') {
        const child = peek();
        arr.push(child && child.indent > indent ? parseNode(child.indent) : null);
        continue;
      }
      arr.push(parseInline(content));
    }
    return arr;
  }

  function parseMap(indent) {
    const obj = {};
    for (;;) {
      const l = peek();
      if (!l) break;
      if (l.indent < indent) break;
      if (l.indent > indent) {
        throw new Error(`${file}:${l.line} 意外的缩进（同级应为 ${indent} 空格，实际 ${l.indent}）`);
      }
      if (l.text === '-' || l.text.startsWith('- ')) break;
      const m = /^([^:#]+?):(?:\s+(.*))?$/.exec(l.text);
      if (!m) throw new Error(`${file}:${l.line} 无法解析为 key: value -> ${l.text}`);
      const key = m[1].trim();
      let rest = (m[2] ?? '').trim();
      i++;

      if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-' || rest === '|+' || rest === '>+') {
        obj[key] = readBlockScalar(indent, rest[0] === '>');
        continue;
      }
      if (rest === '') {
        const child = peek();
        if (!child) { obj[key] = null; continue; }
        if (child.indent > indent) obj[key] = parseNode(child.indent);
        else if (child.indent === indent && (child.text === '-' || child.text.startsWith('- '))) obj[key] = parseSeq(indent);
        else obj[key] = null;
        continue;
      }
      if (rest.startsWith('&') || rest.startsWith('*')) {
        // 锚点/别名不支持，退化为字符串，避免静默错解
        obj[key] = rest;
        continue;
      }
      obj[key] = parseInline(rest);
    }
    return obj;
  }

  const first = peek();
  if (!first) return {};
  const value = parseNode(first.indent);
  return value ?? {};
}

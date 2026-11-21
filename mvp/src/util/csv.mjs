// CSV 读写（RFC4180 子集）：追溯矩阵与索引表都是 CSV，工具消费、人也能看。

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quote = false;
  const s = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; } else { quote = false; }
      } else cur += c;
      continue;
    }
    if (c === '"') { quote = true; continue; }
    if (c === ',') { row.push(cur); cur = ''; continue; }
    if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; continue; }
    cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

const esc = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows) {
  return rows.map((r) => r.map(esc).join(',')).join('\n') + '\n';
}

export function readCsvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { header: [], rows: [] };
  const header = rows[0];
  return {
    header,
    rows: rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))),
  };
}

/** 追加一行到 CSV 文本，保持表头不变；缺列补空，多列忽略（避免破坏下游解析） */
export function appendRow(text, record) {
  const { header, rows } = readCsvObjects(text);
  if (!header.length) return toCsv([Object.keys(record).map((k) => k), Object.values(record).map((v) => v)]);
  const line = header.map((h) => record[h] ?? '');
  return toCsv([header, ...rows.map((r) => header.map((h) => r[h])), line]);
}

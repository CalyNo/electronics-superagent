import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsv, readCsvObjects, appendRow } from '../src/util/csv.mjs';

test('CSV：往返保持字段与引号', () => {
  const rows = [['a', 'b'], ['1', '包含,逗号'], ['2', '含"引号"']];
  const text = toCsv(rows);
  assert.deepEqual(parseCsv(text), rows);
});

test('CSV：去掉 BOM，避免首列取不到值', () => {
  const parsed = readCsvObjects('\uFEFFid,title\nDOC-1,测试\n');
  assert.equal(parsed.header[0], 'id');
  assert.equal(parsed.rows[0].id, 'DOC-1');
});

test('CSV：追加行保持表头顺序', () => {
  const out = appendRow('id,name\nA,一\n', { id: 'B', name: '二' });
  const parsed = readCsvObjects(out);
  assert.deepEqual(parsed.header, ['id', 'name']);
  assert.deepEqual(parsed.rows.map((r) => r.id), ['A', 'B']);
});

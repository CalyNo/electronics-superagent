import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveModelConfig, gatewayFromConfig, maskKey, nullGateway, DEFAULT_MODEL_FILE,
} from '../src/executor/model.mjs';

const KEY = 'sk-1234567890abcdefghijklmnop';

async function writeModelFile(text) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'esa-model-'));
  const file = path.join(dir, 'model.yml');
  await fs.writeFile(file, text, 'utf8');
  return file;
}

test('默认配置文件位于用户主目录，不在仓库内', () => {
  assert.equal(path.basename(DEFAULT_MODEL_FILE), 'model.yml');
  assert.equal(path.basename(path.dirname(DEFAULT_MODEL_FILE)), '.superagent');
  assert.ok(!DEFAULT_MODEL_FILE.includes(process.cwd()), '默认路径不应落在工作目录里');
});

test('只配环境变量即可生效', async () => {
  const env = {
    SUPERAGENT_MODEL_BASE_URL: 'https://api.example.com/v1/',
    SUPERAGENT_MODEL_API_KEY: KEY,
    SUPERAGENT_MODEL_NAME: 'chat-x',
  };
  const cfg = await resolveModelConfig({ env, file: path.join(os.tmpdir(), 'no-such-model.yml') });
  assert.equal(cfg.baseUrl, 'https://api.example.com/v1', '末尾斜杠应被去掉');
  assert.equal(cfg.model, 'chat-x');
  assert.equal(cfg.source, 'env');
  const gw = gatewayFromConfig(cfg);
  assert.equal(gw.name, 'http:chat-x');
  assert.equal(gw.configured, true);
});

test('只配文件也能生效', async () => {
  const file = await writeModelFile(`baseUrl: https://api.deepseek.com/v1\nmodel: deepseek-chat\napiKey: "${KEY}"\n`);
  const cfg = await resolveModelConfig({ env: {}, file });
  assert.equal(cfg.source, 'file');
  assert.equal(cfg.apiKey, KEY);
  assert.equal(gatewayFromConfig(cfg).configured, true);
});

test('环境变量按字段覆盖文件，不是整体替换', async () => {
  const file = await writeModelFile(`baseUrl: https://file.example/v1\nmodel: file-model\napiKey: "file-key"\n`);
  const cfg = await resolveModelConfig({ env: { SUPERAGENT_MODEL_NAME: 'env-model' }, file });
  assert.equal(cfg.baseUrl, 'https://file.example/v1', '未覆盖的字段回落到文件');
  assert.equal(cfg.model, 'env-model', '提供的字段以环境变量为准');
  assert.equal(cfg.keySource, `file:${file}`);
});

test('文件只写 apiKeyEnv：密钥值留在环境变量里', async () => {
  const file = await writeModelFile(`baseUrl: https://api.deepseek.com/v1\nmodel: deepseek-chat\napiKeyEnv: MY_KEY\n`);
  const cfg = await resolveModelConfig({ env: { MY_KEY: KEY }, file });
  assert.equal(cfg.apiKey, KEY);
  assert.equal(cfg.keySource, 'env:MY_KEY');
});

test('引用的环境变量为空时给出可读警告', async () => {
  const file = await writeModelFile(`baseUrl: https://api.deepseek.com/v1\napiKeyEnv: MISSING_KEY\n`);
  const cfg = await resolveModelConfig({ env: {}, file });
  assert.equal(cfg.apiKey, '');
  assert.ok(cfg.warnings.some((w) => w.includes('MISSING_KEY')));
  assert.equal(gatewayFromConfig(cfg).configured, false);
});

test('配置文件存在但缺字段时提示缺什么', async () => {
  const file = await writeModelFile('model: deepseek-chat\n');
  const cfg = await resolveModelConfig({ env: {}, file });
  assert.ok(cfg.warnings.some((w) => w.includes('baseUrl') && w.includes('apiKey')));
});

test('完全没配置：退化为 nullGateway，不抛错', async () => {
  const cfg = await resolveModelConfig({ env: {}, file: path.join(os.tmpdir(), 'nope.yml') });
  assert.equal(cfg.source, 'none');
  assert.equal(gatewayFromConfig(cfg), nullGateway);
  const out = await nullGateway.generate({ prompt: 'x' });
  assert.equal(out.text, null);
  assert.match(out.reason, /未配置/);
});

test('密钥掩码只露首尾，不足以复用', () => {
  const masked = maskKey(KEY);
  assert.match(masked, /^sk-1\*{4}/);
  assert.ok(!masked.includes(KEY));
  assert.equal(maskKey(''), '(未设置)');
  assert.equal(maskKey('short'), '*****');
});

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCodebaseOverview, readCodeSnippet, searchCodebase } from '../src/codebaseData.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fixtureDirectory;
let outsideDirectory;
let fixturePath;
const fakeKey = ['sk', 'proj', 'A'.repeat(40)].join('-');
const fakeAccessKey = ['AKIA', 'B'.repeat(16)].join('');
const marker = ['inspection', 'fixture', 'visible'].join('_');

before(async () => {
  fixtureDirectory = await fs.mkdtemp(path.join(repository, 'test', 'inspection-fixture-'));
  outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'inspection-outside-'));
  fixturePath = path.relative(repository, path.join(fixtureDirectory, 'source.js'));
  await fs.mkdir(path.join(fixtureDirectory, '.agents'));
  await fs.mkdir(path.join(fixtureDirectory, 'config'));
  await fs.writeFile(path.join(fixtureDirectory, 'source.js'), [
    `export const marker = '${marker}';`,
    'const apiKey = process.env.OPENAI_API_KEY;',
    `const embedded = '${fakeKey}';`,
    `const aws = '${fakeAccessKey}';`,
    "const clientSecret = 'synthetic-placeholder';",
    '-----BEGIN PRIVATE KEY-----',
    'synthetic-placeholder',
    '-----END PRIVATE KEY-----',
  ].join('\n'));
  await fs.writeFile(path.join(fixtureDirectory, '.agents', 'instructions.md'), 'hidden fixture');
  await fs.writeFile(path.join(fixtureDirectory, 'config', 'settings.json'), '{}');
  await fs.writeFile(path.join(fixtureDirectory, 'credentials.json'), '{}');
  await fs.writeFile(path.join(outsideDirectory, 'outside.js'), 'outside fixture');
  await fs.symlink(path.join(outsideDirectory, 'outside.js'), path.join(fixtureDirectory, 'escape.js'));
});

after(async () => {
  await Promise.all([
    fixtureDirectory && fs.rm(fixtureDirectory, { recursive: true, force: true }),
    outsideDirectory && fs.rm(outsideDirectory, { recursive: true, force: true }),
  ]);
});

test('inspection keeps source and line numbers while redacting embedded credentials', async () => {
  const result = await readCodeSnippet({ filePath: fixturePath });
  assert.equal(result.ok, true);
  assert.equal(result.totalLines, 8);
  assert.equal(result.snippet[1].text, 'const apiKey = process.env.OPENAI_API_KEY;');
  assert.deepEqual(result.snippet.map(({ line }) => line), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(result.snippet.filter(({ text }) => text.includes('[REDACTED]')).length, 6);
  assert.equal(JSON.stringify(result).includes(fakeKey), false);
  assert.equal(JSON.stringify(result).includes(fakeAccessKey), false);
  assert.equal(JSON.stringify(result).includes('synthetic-placeholder'), false);
});

test('overview excludes hidden, configuration, credential, and symlink files', async () => {
  const overview = await getCodebaseOverview({ maxFiles: 100 });
  assert.ok(overview.files.some(({ path: filePath }) => filePath === fixturePath));
  assert.equal(overview.files.some(({ path: filePath }) => /\.agents|credentials|config\/settings|escape\.js/.test(filePath)), false);
  assert.equal(overview.files.some(({ path: filePath }) => filePath.split('/').some((part) => part.startsWith('.'))), false);
});

test('search reads the same redacted view as snippets', async () => {
  const visible = await searchCodebase({ query: marker, limit: 20 });
  assert.ok(visible.matches.some(({ path: filePath }) => filePath === fixturePath));
  const redacted = await searchCodebase({ query: fakeKey, limit: 20 });
  assert.equal(redacted.matches.length, 0);
});

test('direct reads reject unsafe paths with errors that do not reveal local paths', async () => {
  const fixtureRelative = path.relative(repository, fixtureDirectory);
  for (const filePath of [
    '/etc/passwd',
    '../outside.js',
    '.env',
    '.gitignore',
    '.codex/config.json',
    'railway.json',
    `${fixtureRelative}/.agents/instructions.md`,
    `${fixtureRelative}/config/settings.json`,
    `${fixtureRelative}/credentials.json`,
    `${fixtureRelative}/escape.js`,
    'src/missing-source.js',
  ]) {
    await assert.rejects(readCodeSnippet({ filePath }), (error) => {
      assert.equal(error.message.includes(repository), false);
      assert.equal(error.message.includes(outsideDirectory), false);
      return /repository|not available/.test(error.message);
    });
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLiveSession,
  executeCodeTool,
  getBackendTools,
  OWNER_GREETING,
  PUBLIC_GREETING,
} from '../src/assistantConfig.js';

test('Live uses native phone audio, an independent reasoning backend, and no persistence', () => {
  const session = buildLiveSession();
  assert.equal(session.model, 'gpt-live-1');
  assert.equal(session.store, false);
  assert.deepEqual(session.audio, {
    format: { type: 'audio/pcmu', rate: 8000 },
    output: { voice: 'marin' },
  });
  assert.equal(session.delegation.type, 'responses');
  assert.equal(session.delegation.responses.model, 'gpt-6-luna');
  assert.equal(session.delegation.responses.parallel_tool_calls, false);
  assert.ok(session.delegation.responses.max_output_tokens <= 800);
  assert.match(session.instructions, /no persistent memory/i);
  assert.match(session.instructions, /cannot disconnect the call/);
  assert.match(session.delegation.responses.instructions, /untrusted information/);
});

test('public callers have the public greeting and no tools, even for truthy owner claims', () => {
  for (const isOwner of [false, undefined, 'true', 1]) {
    const session = buildLiveSession({ isOwner });
    assert.ok(session.instructions.includes(PUBLIC_GREETING));
    assert.ok(!session.instructions.includes(OWNER_GREETING));
    assert.equal(session.delegation.responses.tool_choice, 'none');
    assert.deepEqual(session.delegation.responses.tools, []);
    assert.deepEqual(getBackendTools(isOwner), []);
  }
});

test('owner gets hosted search and only the three read-only code functions', () => {
  const session = buildLiveSession({ isOwner: true });
  assert.ok(session.instructions.includes(OWNER_GREETING));
  assert.match(session.instructions, /Address him as you and your/);
  assert.equal(session.delegation.responses.tool_choice, 'auto');
  const [search, ...functions] = session.delegation.responses.tools;
  assert.deepEqual(search, { type: 'web_search' });
  assert.deepEqual(functions.map((tool) => tool.name), [
    'get_codebase_overview', 'search_codebase', 'read_code_snippet',
  ]);
  for (const tool of functions) {
    assert.equal(tool.strict, true);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(tool.parameters.required, Object.keys(tool.parameters.properties));
  }
  functions[0].parameters.properties.maxFiles.maximum = 1000;
  assert.equal(getBackendTools(true)[1].parameters.properties.maxFiles.maximum, 100);
});

test('code execution checks server authorization and the function allowlist independently', async () => {
  assert.equal((await executeCodeTool('read_code_snippet', { filePath: 'package.json' })).reason, 'unauthorized');
  assert.equal((await executeCodeTool('read_code_snippet', {}, { isOwner: 'true' })).reason, 'unauthorized');
  assert.equal((await executeCodeTool('write_file', {}, { isOwner: true })).reason, 'unknown_tool');
  assert.equal((await executeCodeTool('constructor', {}, { isOwner: true })).reason, 'unknown_tool');
  assert.equal((await executeCodeTool('search_codebase', { query: 'ab', command: 'anything' }, { isOwner: true })).reason, 'invalid_arguments');
  assert.equal((await executeCodeTool('search_codebase', { query: 'x' }, { isOwner: true })).reason, 'invalid_arguments');
  assert.equal((await executeCodeTool('get_codebase_overview', { maxFiles: 1000 }, { isOwner: true })).reason, 'invalid_arguments');
});

test('authorized source inspection returns bounded current files and rejects escapes', async () => {
  const result = await executeCodeTool('read_code_snippet', {
    filePath: 'package.json', startLine: 1, endLine: 2,
  }, { isOwner: true });
  assert.equal(result.ok, true);
  assert.equal(result.path, 'package.json');
  assert.equal(result.snippet.length, 2);
  assert.equal(result.snippet[0].line, 1);
  const outside = await executeCodeTool('read_code_snippet', {
    filePath: '../package.json', startLine: null, endLine: null,
  }, { isOwner: true });
  assert.equal(outside.ok, false);
  assert.equal(outside.reason, 'code_inspection_failed');
  const cancelled = await executeCodeTool('get_codebase_overview', {}, {
    isOwner: true, signal: AbortSignal.abort(),
  });
  assert.equal(cancelled.reason, 'cancelled');
});

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
  assert.match(session.instructions, /warm, gentle, relaxed voice/);
  assert.match(session.delegation.responses.instructions, /untrusted information/);
});

test('public callers have the public greeting and the same protected tools', () => {
  const recognized = buildLiveSession({ isOwner: true });
  for (const isOwner of [false, undefined, 'true', 1]) {
    const session = buildLiveSession({ isOwner });
    assert.ok(session.input[0].content[0].text.includes(PUBLIC_GREETING));
    assert.ok(!session.input[0].content[0].text.includes(OWNER_GREETING));
    assert.equal(session.delegation.responses.tool_choice, 'auto');
    assert.deepEqual(session.delegation.responses.tools, getBackendTools());
    assert.deepEqual(session.delegation.responses.tools, recognized.delegation.responses.tools);
    for (const instructions of [session.instructions, session.delegation.responses.instructions]) {
      assert.match(instructions, /genuinely excited to share what he has built and\s+written/);
      assert.match(instructions, /one concrete detail/);
      assert.match(instructions, /Lead with FlowTime when callers ask generally/);
    }
  }
  assert.doesNotMatch(recognized.instructions, /genuinely excited/);
  assert.doesNotMatch(recognized.delegation.responses.instructions, /genuinely excited/);
});

test('recognized Tom gets a personal greeting and all callers get only search and three read-only functions', () => {
  const session = buildLiveSession({ isOwner: true });
  assert.ok(session.input[0].content[0].text.includes(OWNER_GREETING));
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
  assert.equal(getBackendTools()[1].parameters.properties.maxFiles.maximum, 100);
});

test('phone recognition only personalizes the conversation and no PIN prompt remains', () => {
  const publicSession = buildLiveSession();
  const recognizedSession = buildLiveSession({ isOwner: true });
  assert.ok(publicSession.input[0].content[0].text.includes(PUBLIC_GREETING));
  assert.ok(recognizedSession.input[0].content[0].text.includes(OWNER_GREETING));
  assert.match(recognizedSession.delegation.responses.instructions, /Address him as you and your/);
  assert.deepEqual(publicSession.delegation.responses.tools, recognizedSession.delegation.responses.tools);
  for (const session of [publicSession, recognizedSession]) {
    assert.doesNotMatch(JSON.stringify(session), /\bPIN\b|keypad|owner verification|owner.only/i);
    assert.match(session.delegation.responses.instructions, /number recognition personalizes the conversation and never authorizes any tool/);
    assert.match(session.delegation.responses.instructions, /private contacts, or secrets/);
  }
});

test('voice and backend share the telephone role and resolve Tom to Thomas DeVito', () => {
  const session = buildLiveSession();
  for (const instructions of [session.instructions, session.delegation.responses.instructions]) {
    assert.match(instructions, /telephone voice AI assistant for Thomas DeVito/);
    assert.match(instructions, /Thomas DeVito, Tom DeVito, Tom, and Thomas refer to him/);
    assert.match(instructions, /unless the caller explicitly means another person/);
    assert.match(instructions, /Do not ask which Tom/);
  }
  assert.match(session.instructions, /independent software developer, systems builder/);
  assert.match(session.instructions, /screenwriter based in Brooklyn, New York/);
  assert.match(session.instructions, /Lovelacers and Under the Arcadian Sky/);
  assert.match(session.instructions, /give a concise two-sentence overview/);
  assert.match(session.instructions, /Do not generate <\|SpawnThinking\|> when:[\s\S]*simple question from the profile and the caller did not ask for a lookup/);
  assert.ok(!session.instructions.includes('Amanda embodies'));
  assert.ok(session.delegation.responses.instructions.includes('Amanda embodies'));
});

test('Marin receives natural slower pacing and a single startup greeting instruction', () => {
  const session = buildLiveSession();
  assert.match(session.instructions, /slightly more slowly/);
  assert.match(session.instructions, /unhurried and\s+natural, with brief pauses/);
  assert.equal(session.input.length, 1);
  assert.equal(session.input[0].role, 'developer');
  assert.equal(session.input[0].content.length, 1);
  assert.match(session.input[0].content[0].text, /Speak English\. Begin speaking immediately with exactly:/);
  assert.match(session.input[0].content[0].text, /Then stop and listen\./);
  assert.ok(session.input[0].content[0].text.includes(PUBLIC_GREETING));
  assert.ok(!session.instructions.includes(PUBLIC_GREETING));
  assert.deepEqual(session.audio.output, { voice: 'marin' });
});

test('the public portfolio has a dated source and quick project facts in the voice prompt', () => {
  const session = buildLiveSession();
  const backend = session.delegation.responses.instructions;
  assert.match(backend, /https:\/\/thomasdevito\.me\/, checked November 17, 2026/);
  for (const project of [
    'FairDeal.ai', 'FlowTime', 'Blndr/CompositeVault', 'GoTube', 'GoPod',
    'GoPulse Core Protocol', 'HeadlineHarmonies', 'FilmPulse', 'GoPulse', 'Hyper_Rank',
    'FlowPath:', 'FlowPath Studio:',
  ]) assert.ok(backend.includes(project), project);
  assert.match(backend, /Verify current status,\s+availability/);
  assert.match(session.instructions, /FilmPulse takes a film mood/);
  assert.ok(!session.instructions.includes('TMDB'));
});

test('voice and backend share FlowTime mechanics, iPhone status, and the featured voice projects', () => {
  const session = buildLiveSession();
  for (const instructions of [session.instructions, session.delegation.responses.instructions]) {
    assert.match(instructions, /at least three people[\s\S]*one to three days/);
    assert.match(instructions, /screen time or choose a phone pickup goal/);
    assert.match(instructions, /upload screenshots at the end, and\s+FlowTime verifies/);
    assert.match(instructions, /profile streaks and badges as a way for people to show off/);
    assert.match(instructions, /optionally\s+choose a charity[\s\S]*if they go over their\s+limit/);
    assert.match(instructions, /without donations/);
    assert.match(instructions, /FlowTime is a web app\. Tom is preparing an iPhone version for his first App Store\s+submission/);
    assert.match(instructions, /check for an official release before saying\s+callers can download it/);
    assert.match(instructions, /FlowPath News, listed as FlowPath/);
    assert.match(instructions, /FlowPath Studio lets people design and publish[\s\S]*the interface can\s+change as they talk/);
  }
});

test('explicit searches and current facts trigger source-backed delegation for every caller', () => {
  for (const isOwner of [false, true]) {
    const { instructions, delegation: { responses } } = buildLiveSession({ isOwner });
    assert.match(instructions, /Generate <\|SpawnThinking\|> when:\s+- The caller asks you to search/);
    assert.match(instructions, /Wait for the result before giving facts/);
    assert.match(responses.instructions, /Use web search when explicitly asked/);
    assert.match(responses.instructions, /official project sites or public project repositories/);
    assert.match(responses.instructions, /Exclude caller phone numbers, private\s+details/);
    assert.match(responses.instructions, /return citations, and name the sources/);
  }
});

test('all callers can inspect approved files while the function allowlist and argument limits remain enforced', async () => {
  const source = await executeCodeTool('read_code_snippet', { filePath: 'package.json', startLine: 1, endLine: 2 });
  assert.equal(source.ok, true);
  assert.equal((await executeCodeTool('write_file')).reason, 'unknown_tool');
  assert.equal((await executeCodeTool('constructor')).reason, 'unknown_tool');
  assert.equal((await executeCodeTool('search_codebase', { query: 'ab', command: 'anything' })).reason, 'invalid_arguments');
  assert.equal((await executeCodeTool('search_codebase', { query: 'x' })).reason, 'invalid_arguments');
  assert.equal((await executeCodeTool('get_codebase_overview', { maxFiles: 1000 })).reason, 'invalid_arguments');
});

test('source inspection returns bounded current files and rejects escapes and sensitive files', async () => {
  const result = await executeCodeTool('read_code_snippet', {
    filePath: 'package.json', startLine: 1, endLine: 2,
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, 'package.json');
  assert.equal(result.snippet.length, 2);
  assert.equal(result.snippet[0].line, 1);
  const outside = await executeCodeTool('read_code_snippet', {
    filePath: '../package.json', startLine: null, endLine: null,
  });
  assert.equal(outside.ok, false);
  assert.equal(outside.reason, 'code_inspection_failed');
  const sensitive = await executeCodeTool('read_code_snippet', {
    filePath: '.env', startLine: null, endLine: null,
  });
  assert.equal(sensitive.reason, 'code_inspection_failed');
  const cancelled = await executeCodeTool('get_codebase_overview', {}, {
    signal: AbortSignal.abort(),
  });
  assert.equal(cancelled.reason, 'cancelled');
});

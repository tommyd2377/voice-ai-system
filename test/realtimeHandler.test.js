import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBargeInController,
  getRealtimeToolsForCaller,
  searchWeb,
} from '../src/realtimeHandler.js';

test('external callers get only caller-intake tool, while owner gets web search', () => {
  const externalToolNames = getRealtimeToolsForCaller(false).map((tool) => tool.name);
  const ownerToolNames = getRealtimeToolsForCaller(true).map((tool) => tool.name);

  assert.deepEqual(externalToolNames, ['create_taskdeck_caller_intake_task']);
  assert.equal(ownerToolNames.includes('search_web'), true);
  assert.equal(ownerToolNames.includes('create_taskdeck_task'), true);
});

test('web search uses mocked Responses API and returns summary with sources', async (t) => {
  const previousModel = process.env.OPENAI_WEB_SEARCH_MODEL;
  const previousContextSize = process.env.OPENAI_WEB_SEARCH_CONTEXT_SIZE;
  const previousMaxToolCalls = process.env.OPENAI_WEB_SEARCH_MAX_TOOL_CALLS;
  const previousMaxOutputTokens = process.env.OPENAI_WEB_SEARCH_MAX_OUTPUT_TOKENS;
  const previousReasoningEffort = process.env.OPENAI_WEB_SEARCH_REASONING_EFFORT;
  delete process.env.OPENAI_WEB_SEARCH_MODEL;
  delete process.env.OPENAI_WEB_SEARCH_CONTEXT_SIZE;
  delete process.env.OPENAI_WEB_SEARCH_MAX_TOOL_CALLS;
  delete process.env.OPENAI_WEB_SEARCH_MAX_OUTPUT_TOKENS;
  delete process.env.OPENAI_WEB_SEARCH_REASONING_EFFORT;
  t.after(() => {
    if (previousModel === undefined) delete process.env.OPENAI_WEB_SEARCH_MODEL;
    else process.env.OPENAI_WEB_SEARCH_MODEL = previousModel;
    if (previousContextSize === undefined) delete process.env.OPENAI_WEB_SEARCH_CONTEXT_SIZE;
    else process.env.OPENAI_WEB_SEARCH_CONTEXT_SIZE = previousContextSize;
    if (previousMaxToolCalls === undefined) delete process.env.OPENAI_WEB_SEARCH_MAX_TOOL_CALLS;
    else process.env.OPENAI_WEB_SEARCH_MAX_TOOL_CALLS = previousMaxToolCalls;
    if (previousMaxOutputTokens === undefined) delete process.env.OPENAI_WEB_SEARCH_MAX_OUTPUT_TOKENS;
    else process.env.OPENAI_WEB_SEARCH_MAX_OUTPUT_TOKENS = previousMaxOutputTokens;
    if (previousReasoningEffort === undefined) delete process.env.OPENAI_WEB_SEARCH_REASONING_EFFORT;
    else process.env.OPENAI_WEB_SEARCH_REASONING_EFFORT = previousReasoningEffort;
  });

  let requestBody;
  const result = await searchWeb(
    { query: 'latest Realtime API docs' },
    {
      apiKey: 'test-key',
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            output: [
              {
                type: 'web_search_call',
                action: {
                  sources: [{ title: 'OpenAI Docs', url: 'https://developers.openai.com/api/docs/guides/realtime' }],
                },
              },
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: 'Realtime sessions are the right fit for live voice agents.',
                    annotations: [
                      {
                        type: 'url_citation',
                        title: 'Realtime and audio',
                        url: 'https://developers.openai.com/api/docs/guides/realtime',
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        };
      },
    }
  );

  assert.equal(requestBody.model, 'gpt-4.1-mini');
  assert.equal(requestBody.tools[0].type, 'web_search');
  assert.equal(requestBody.tools[0].search_context_size, 'low');
  assert.equal(requestBody.tool_choice, 'required');
  assert.equal(requestBody.max_tool_calls, 1);
  assert.equal(requestBody.max_output_tokens, 220);
  assert.equal(requestBody.store, false);
  assert.match(requestBody.instructions, /quick public web lookup/);
  assert.equal(result.ok, true);
  assert.match(result.summary, /live voice agents/);
  assert.deepEqual(result.sources, [
    {
      title: 'OpenAI Docs',
      url: 'https://developers.openai.com/api/docs/guides/realtime',
    },
  ]);
});

test('web search times out stalled Responses API calls', async () => {
  await assert.rejects(
    searchWeb(
      { query: 'slow search' },
      {
        apiKey: 'test-key',
        timeoutMs: 5,
        fetchImpl: async (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      }
    ),
    /timed out after 5ms/
  );
});

test('barge-in debounce ignores short noise and cancels sustained speech', () => {
  let timerCallback = null;
  let bargeIns = 0;
  const controller = createBargeInController({
    graceMs: 500,
    onBargeIn: () => {
      bargeIns += 1;
    },
    setTimeoutFn: (callback) => {
      timerCallback = callback;
      return { id: 'timer' };
    },
    clearTimeoutFn: () => {
      timerCallback = null;
    },
  });

  controller.handleSpeechStarted();
  assert.equal(controller.isUserSpeaking(), true);
  controller.handleSpeechStopped();
  assert.equal(controller.isUserSpeaking(), false);
  assert.equal(timerCallback, null);
  assert.equal(bargeIns, 0);

  controller.handleSpeechStarted();
  assert.equal(typeof timerCallback, 'function');
  timerCallback();
  assert.equal(bargeIns, 1);
});

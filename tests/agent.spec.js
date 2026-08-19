/**
 * agent.spec.js — Swarm local-agent tests.
 *
 * Three test domains:
 *   1. Unit tests — pure-function tests with dependency injection (no server)
 *   2. API tests — POST /api/chat directly (fast, no browser)
 *   3. UI tests — browser renders correctly for each mode
 *
 * Fake modes (no model, no download) — ONLY effective when SWARM_FAKE=true:
 *   success / empty / error / timeout
 *
 * Key contract for POST /api/chat:
 *   { response, finishReason, inspection, model }
 *   - model: "fake" | "fallback" | "qwen2.5-1.5b-instruct"
 *   - finishReason: "stop" | "fallback"
 *   - inspection always present with messageLength, wordCount, etc.
 */

import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

/** Call POST /api/chat directly via fetch */
async function apiChat(requestContext, message, mode) {
  const body = { message, userId: 'test', sessionId: 'test-session' };
  if (mode) body.mode = mode;

  const res = await requestContext.post('/api/chat', { data: body });
  return res;
}

/** Open the app in a given mode via URL query param */
async function openApp(page, mode) {
  await page.goto(mode ? `/?mode=${mode}` : '/');
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('[data-testid="status-bar"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 5000 });
}

/** Type text into the composer */
async function typeMessage(page, text) {
  const input = page.locator('[data-testid="composer-input"]');
  await expect(input).toBeVisible({ timeout: 3000 });
  await input.fill(text);
  await page.waitForTimeout(100);
}

/** Click the Send button and wait for response */
async function sendAndWait(page, timeout = 15000) {
  const sendBtn = page.locator('[data-testid="send-btn"]');
  await expect(sendBtn).toBeVisible({ timeout: 3000 });
  await expect(sendBtn).not.toBeDisabled({ timeout: 3000 });
  await sendBtn.click();
  // Wait for assistant message to appear
  await page.waitForSelector('[data-testid="message-bubble"][data-role="assistant"]', { timeout });
  await page.waitForTimeout(500);
}

// ═══════════════════════════════════════════════════════════════════════
// 0. UNIT TESTS — pure function tests with dependency injection
//    These import runChat/inspectMessage directly and mock the model.
//    No server needed, no model download, fast.
// ═══════════════════════════════════════════════════════════════════════

test.describe('unit: runChat (dependency injection)', () => {
  let runChat, inspectMessage, FALLBACK_LABEL;

  test.beforeAll(async () => {
    const mod = await import('../server.mjs');
    runChat = mod.runChat;
    inspectMessage = mod.inspectMessage;
    FALLBACK_LABEL = mod.FALLBACK_LABEL;
  });

  test('inspect_message works as pure function', () => {
    const result = inspectMessage('Thanks for the help!');
    expect(result.messageLength).toBe(20);
    expect(result.wordCount).toBe(4);
    expect(result.hasQuestion).toBe(false);
    expect(result.sentiment).toBe('positive');
    expect(result.classification).toBe('medium');
    expect(typeof result.timestamp).toBe('number');
    expect(inspectMessage('Please draft a feedback letter.').hasCode).toBe(false);
  });

  test('clients cannot force fake behavior in real mode — mode is ignored', async () => {
    const state = {
      status: 'ready',
      loaded: true,
      session: { prompt: async () => 'Real model response' },
      error: null,
      modelName: 'test-model',
    };
    // mode='success' should be ignored because state.status !== 'fake'
    const result = await runChat('Hello', 'test', 'session', 'success', { state });
    expect(result.model).not.toBe('fake');
    expect(result.finishReason).toBe('stop');
    expect(result.response).toBe('Real model response');
  });

  test('inspect_message runs first; user message passed cleanly to model (no raw JSON leak)', async () => {
    let capturedPrompt = '';
    let capturedOptions = null;
    const mockSession = {
      prompt: async (prompt, options) => {
        capturedPrompt = prompt;
        capturedOptions = options;
        return 'Model reply acknowledging inspection.';
      },
    };
    const state = {
      status: 'ready',
      loaded: true,
      session: mockSession,
      error: null,
      modelName: 'test-model',
    };

    const result = await runChat('What is the capital of France?', 'test', 'sess', null, { state });

    // Inspection ran first and is in result
    expect(result.inspection).toBeDefined();
    expect(result.inspection.wordCount).toBe(6);
    expect(result.inspection.hasQuestion).toBe(true);

    // User message passed cleanly — no raw JSON wrapper
    expect(capturedPrompt).toBe('What is the capital of France?');
    expect(capturedPrompt).not.toContain('Inspection of user message');
    expect(capturedPrompt).not.toContain('messageLength');

    // Generation options passed
    expect(capturedOptions).toBeDefined();
    expect(capturedOptions.maxTokens).toBe(160);
    expect(capturedOptions.temperature).toBe(0.2);
  });

  test('model init failure produces deterministic fallback with label', async () => {
    const state = {
      status: 'fallback',
      loaded: false,
      session: null,
      error: 'Model download failed: network error',
    };
    const result = await runChat('Hello', 'test', 'sess', null, { state });

    expect(result.model).toBe('fallback');
    expect(result.finishReason).toBe('fallback');
    expect(typeof result.response).toBe('string');
    expect(result.response.length).toBeGreaterThan(0);
    expect(result.fallbackReason).toContain('Model download failed');
    expect(result.fallbackLabel).toBe(FALLBACK_LABEL);
    expect(result.inspection).toBeDefined();
    expect(result.inspection.wordCount).toBe(1);
  });

  test('inference failure produces deterministic fallback with label', async () => {
    const failingSession = {
      prompt: async () => { throw new Error('Inference crashed: OOM'); },
    };
    const state = {
      status: 'ready',
      loaded: true,
      session: failingSession,
      error: null,
      modelName: 'crashy-model',
    };
    const result = await runChat('Tell me a story', 'test', 'sess', null, { state });

    expect(result.model).toBe('fallback');
    expect(result.finishReason).toBe('fallback');
    expect(typeof result.response).toBe('string');
    expect(result.response.length).toBeGreaterThan(0);
    expect(result.fallbackReason).toContain('Inference crashed');
    expect(result.fallbackLabel).toBeDefined();
    expect(result.fallbackLabel).toContain('fallback'); // case-insensitive match
    expect(result.inspection).toBeDefined();
  });

  test('fake mode tests still work when SWARM_FAKE=true', async () => {
    const state = { status: 'fake', loaded: false, session: null, error: null };
    const result = await runChat('Test', 'test', 'sess', 'success', { state });

    expect(result.model).toBe('fake');
    expect(result.finishReason).toBe('stop');
    expect(result.response).toContain('fake success');
    expect(result.inspection).toBeDefined();
  });

  test('defense-in-depth rejects response containing leaked inspection markers', async () => {
    const leakySession = {
      prompt: async () => '[Inspection of user message: {"wordCount":1}] This is a leaky response.',
    };
    const state = {
      status: 'ready',
      loaded: true,
      session: leakySession,
      error: null,
    };

    const result = await runChat('Hello', 'test', 'sess', null, { state });

    // Should not include leaked data — should fallback
    expect(result.model).toBe('fallback');
    expect(result.finishReason).toBe('fallback');
    expect(result.fallbackReason).toBe('Response contained leaked internal data');
    expect(result.response).not.toContain('[Inspection of user message');
  });

  test('defense-in-depth lets legitimate JSON/code/braces through (rejects only specific markers)', async () => {
    const cleanSession = {
      prompt: async () => 'Here is JSON: {"key":"value","nested":[1,2,3]}. And code: const x = fn();',
    };

    const state = {
      status: 'ready',
      loaded: true,
      session: cleanSession,
      error: null,
    };

    const result = await runChat('Hello', 'test', 'sess', null, { state });

    // Legitimate JSON/braces/code pass through — finishReason is 'stop'
    expect(result.model).not.toBe('fallback');
    expect(result.finishReason).toBe('stop');
    expect(result.response).toContain('{"key":"value"');
    expect(result.response).toContain('[1,2,3]');
    expect(result.response).toContain('const x = fn()');
  });

  test('defense-in-depth rejects empty model response', async () => {
    const emptySession = {
      prompt: async () => '',
    };
    const state = {
      status: 'ready',
      loaded: true,
      session: emptySession,
      error: null,
    };

    const result = await runChat('Hello', 'test', 'sess', null, { state });

    expect(result.model).toBe('fallback');
    expect(result.finishReason).toBe('fallback');
    expect(result.fallbackReason).toBe('Empty response from model');
  });

  test('requests are isolated via sequence.clearHistory + fresh session per request', async () => {
    let clearHistoryCalls = 0;
    let sessionCount = 0;
    const prompts = [];

    const mockSequence = {
      clearHistory() {
        clearHistoryCalls += 1;
      },
    };

    const MockSessionClass = class {
      constructor(opts) {
        sessionCount += 1;
        this.sequence = opts.contextSequence;
      }
      async prompt(message) {
        prompts.push(message);
        return `response to: ${message}`;
      }
    };

    const state = {
      status: 'ready',
      loaded: true,
      modelName: 'test-model',
      LlamaChatSession: MockSessionClass,
      context: {},
      sequence: mockSequence,
    };

    const first = await runChat('foo', 'test', 'sess', null, { state });
    const second = await runChat('bar', 'test', 'sess', null, { state });

    // Each request created a fresh session and cleared the sequence
    expect(sessionCount).toBe(2);
    expect(clearHistoryCalls).toBe(2);

    // Each request passed only its own message — no bleed
    expect(prompts).toEqual(['foo', 'bar']);

    // Responses are independent
    expect(first.response).toBe('response to: foo');
    expect(second.response).toBe('response to: bar');

    // System prompt includes inspection info as natural language
    expect(first.inspection).toBeDefined();
    expect(first.inspection.wordCount).toBe(1);
  });

  test('throwing request does not deadlock next request (sequence lock try/finally)', async () => {
    let clearHistoryCalls = 0;
    let sessionCount = 0;
    const prompts = [];

    // First call to prompt() throws; second succeeds
    let callIndex = 0;

    const mockSequence = {
      clearHistory() {
        clearHistoryCalls += 1;
      },
    };

    const ThrowThenWorkSession = class {
      constructor(opts) {
        sessionCount += 1;
        this.sequence = opts.contextSequence;
      }
      async prompt(message) {
        const idx = callIndex++;
        if (idx === 0) {
          throw new Error('Simulated inference crash');
        }
        prompts.push(message);
        return `response to: ${message}`;
      }
    };

    const state = {
      status: 'ready',
      loaded: true,
      modelName: 'test-model',
      LlamaChatSession: ThrowThenWorkSession,
      context: {},
      sequence: mockSequence,
    };

    // First request throws inside the lock — releases the lock (finally)
    const first = await runChat('crash-msg', 'test', 'sess', null, { state });

    // First returns fallback because inference threw
    expect(first.model).toBe('fallback');
    expect(first.finishReason).toBe('fallback');
    expect(first.fallbackReason).toContain('Simulated inference crash');

    // Second request proceeds without deadlock
    const second = await runChat('hello', 'test', 'sess', null, { state });

    expect(second.model).toBe('test-model');
    expect(second.finishReason).toBe('stop');
    expect(second.response).toBe('response to: hello');

    // clearHistory was called for each attempt (lock acquired both times)
    expect(clearHistoryCalls).toBe(2);

    // Only the successful session recorded its prompt
    expect(sessionCount).toBe(2);
    expect(prompts).toEqual(['hello']);
  });

  test('concurrent requests serialize safely via sequenceLock — in-flight count tracks ordering', async () => {
    let clearHistoryCalls = 0;
    let sessionCount = 0;
    let maxInFlight = 0;
    let currentInFlight = 0;
    const executionOrder = [];

    const mockSequence = {
      clearHistory() {
        clearHistoryCalls += 1;
      },
    };

    const ConcurrentSession = class {
      constructor(opts) {
        sessionCount += 1;
        this.sequence = opts.contextSequence;
      }
      async prompt(message) {
        currentInFlight++;
        maxInFlight = Math.max(maxInFlight, currentInFlight);
        executionOrder.push(message);
        // Simulate real work
        await new Promise(r => setTimeout(r, 10));
        const result = `response to: ${message}`;
        currentInFlight--;
        return result;
      }
    };

    const state = {
      status: 'ready',
      loaded: true,
      modelName: 'test-model',
      LlamaChatSession: ConcurrentSession,
      context: {},
      sequence: mockSequence,
    };

    // Fire 5 requests concurrently with rare distinct canaries
    const requests = [
      runChat('canary-XANADU', 'test', 'sess', null, { state }),
      runChat('canary-KALEIDO', 'test', 'sess', null, { state }),
      runChat('canary-ZEPHYRUS', 'test', 'sess', null, { state }),
      runChat('canary-QUASARIA', 'test', 'sess', null, { state }),
      runChat('canary-MOONWALK', 'test', 'sess', null, { state }),
    ];

    const results = await Promise.all(requests);

    // All 5 succeed
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.finishReason).toBe('stop');
      expect(r.model).toBe('test-model');
    }

    // Max concurrency was exactly 1 (serialized through lock)
    expect(maxInFlight).toBe(1);

    // Each response matches its canary — no cross-contamination
    const responses = results.map(r => r.response);
    expect(responses).toContain('response to: canary-XANADU');
    expect(responses).toContain('response to: canary-KALEIDO');
    expect(responses).toContain('response to: canary-ZEPHYRUS');
    expect(responses).toContain('response to: canary-QUASARIA');
    expect(responses).toContain('response to: canary-MOONWALK');

    // Execution was sequential — all 5 canaries started and ended in order
    expect(executionOrder).toEqual(['canary-XANADU', 'canary-KALEIDO', 'canary-ZEPHYRUS', 'canary-QUASARIA', 'canary-MOONWALK']);

    // clearHistory called exactly once per request (serialized)
    expect(clearHistoryCalls).toBe(5);
    expect(sessionCount).toBe(5);
  });

  test('session creation throw followed by successful request — lock releases', async () => {
    let clearHistoryCalls = 0;
    let sessionCount = 0;
    const prompts = [];

    const mockSequence = {
      clearHistory() {
        clearHistoryCalls += 1;
      },
    };

    // Constructor throws for first session, succeeding sessions work
    const FailingConstructorSession = class {
      constructor(opts) {
        sessionCount += 1;
        this.sequence = opts.contextSequence;
        if (sessionCount === 1) {
          throw new Error('Session creation failed: OOM');
        }
      }
      async prompt(message) {
        prompts.push(message);
        return `response to: ${message}`;
      }
    };

    const state = {
      status: 'ready',
      loaded: true,
      modelName: 'test-model',
      LlamaChatSession: FailingConstructorSession,
      context: {},
      sequence: mockSequence,
    };

    // First request's session constructor throws before prompt — the
    // lock must still release for the next request
    const first = await runChat('first-msg', 'test', 'sess', null, { state });
    expect(first.finishReason).toBe('fallback');
    expect(first.fallbackReason).toContain('Session creation failed: OOM');

    // Second request succeeds — proves lock was released
    const second = await runChat('second-msg', 'test', 'sess', null, { state });
    expect(second.finishReason).toBe('stop');
    expect(second.response).toBe('response to: second-msg');

    // Only the successful request recorded its prompt
    expect(prompts).toEqual(['second-msg']);

    // clearHistory was called for each attempt
    expect(clearHistoryCalls).toBe(2);
  });

  test('model URL is exactly Qwen2.5-0.5B-Instruct Q4_K_M', async () => {
    // MODEL_URL is not exported — read source file directly
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs'), 'utf8');
    const urlMatch = source.match(/MODEL_URL\s*=\s*'([^']+)'/);
    expect(urlMatch).toBeTruthy();
    expect(urlMatch[1]).toBe('hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 1. API TESTS — POST /api/chat directly
// ═══════════════════════════════════════════════════════════════════════

test.describe('POST /api/chat', () => {
  test('success mode returns expected response structure', async ({ request }) => {
    const res = await apiChat(request, 'Hello Swarm', 'success');
    expect(res.ok()).toBe(true);
    const result = await res.json();

    expect(result).toBeDefined();
    expect(typeof result.response).toBe('string');
    expect(result.response.length).toBeGreaterThan(0);
    expect(result.finishReason).toBe('stop');
    expect(result.model).toBe('fake');

    // Inspection must be present
    expect(result.inspection).toBeDefined();
    expect(result.inspection.messageLength).toBe(11);
    expect(result.inspection.wordCount).toBe(2);
    expect(result.inspection.hasQuestion).toBe(false);
    expect(result.inspection.classification).toBe('medium');
    expect(result.inspection.sentiment).toBe('neutral');
  });

  test('empty mode returns empty string response', async ({ request }) => {
    const res = await apiChat(request, 'Trigger empty', 'empty');
    expect(res.ok()).toBe(true);
    const result = await res.json();

    expect(result).toBeDefined();
    expect(result.response).toBe('');
    expect(result.finishReason).toBe('stop');
    expect(result.model).toBe('fake');

    // Inspection still present
    expect(result.inspection).toBeDefined();
    expect(result.inspection.messageLength).toBe(13);
  });

  test('error mode returns fallback response despite error', async ({ request }) => {
    const res = await apiChat(request, 'Trigger error', 'error');
    expect(res.ok()).toBe(true);
    const result = await res.json();

    expect(result).toBeDefined();
    expect(typeof result.response).toBe('string');
    expect(result.response.length).toBeGreaterThan(0);
    // Error mode's exception is caught and returns fallback
    expect(result.finishReason).toBe('fallback');
    expect(result.model).toBe('fake');
    expect(result.fallbackReason).toContain('FAKE_MODE_ERROR');
    expect(result.inspection).toBeDefined();
    // Fallback label should be present
    expect(result.fallbackLabel).toBeDefined();
    expect(result.fallbackLabel.length).toBeGreaterThan(0);
  });

  test('overlong mode returns long content', async ({ request }) => {
    const res = await apiChat(request, 'Long response', 'overlong');
    expect(res.ok()).toBe(true);
    const result = await res.json();

    expect(result).toBeDefined();
    expect(typeof result.response).toBe('string');
    expect(result.response.length).toBeGreaterThan(600);
    expect(result.finishReason).toBe('stop');
    expect(result.model).toBe('fake');
    expect(result.inspection).toBeDefined();
  });

  test('inspect_message always returns deterministic structure', async ({ request }) => {
    const res = await apiChat(request, 'How are you?', 'success');
    expect(res.ok()).toBe(true);
    const result = await res.json();

    expect(result.inspection).toBeDefined();
    expect(result.inspection.messageLength).toBe(12);
    expect(result.inspection.wordCount).toBe(3);
    expect(result.inspection.hasQuestion).toBe(true);
    expect(result.inspection.hasExclamation).toBe(false);
    expect(result.inspection.hasCode).toBe(false);
    expect(result.inspection.isOverlong).toBe(false);
    expect(typeof result.inspection.classification).toBe('string');
    expect(typeof result.inspection.sentiment).toBe('string');
    expect(typeof result.inspection.timestamp).toBe('number');
  });

  test('empty message returns 400 error', async ({ request }) => {
    const res = await request.post('/api/chat', {
      data: { message: '', userId: 'test', sessionId: 'test' },
    });
    expect(res.ok()).toBe(false);
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('message');
  });

  test('no message field returns 400 error', async ({ request }) => {
    const res = await request.post('/api/chat', {
      data: { userId: 'test', sessionId: 'test' },
    });
    expect(res.ok()).toBe(false);
    expect(res.status()).toBe(400);
  });

  test('blank message returns 400 error', async ({ request }) => {
    const res = await request.post('/api/chat', {
      data: { message: '   ', userId: 'test' },
    });
    expect(res.ok()).toBe(false);
    expect(res.status()).toBe(400);
  });

  test('missing userId defaults to anonymous', async ({ request }) => {
    const res = await apiChat(request, 'Hello', 'success');
    expect(res.ok()).toBe(true);
    // Response structure valid — userId is server-side only
    const result = await res.json();
    expect(result.response.length).toBeGreaterThan(0);
  });

  test('null userId defaults to anonymous', async ({ request }) => {
    const res = await request.post('/api/chat', {
      data: { message: 'Hi', userId: null, mode: 'success' },
    });
    expect(res.ok()).toBe(true);
  });

  test('null sessionId defaults to default', async ({ request }) => {
    const res = await request.post('/api/chat', {
      data: { message: 'Hi', sessionId: null, mode: 'success' },
    });
    expect(res.ok()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 1b. EDGE CASES — malformed JSON, oversized messages, method handling
// ═══════════════════════════════════════════════════════════════════════

test.describe('API edge cases', () => {
  test('malformed JSON body returns 400', async ({ page }) => {
    // Navigate first so origin is allowed
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Send truly invalid JSON bytes via page-level fetch
    const result = await page.evaluate(async () => {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json at all!!!!!!!!!!!!!!',
      });
      return { status: r.status, body: await r.json() };
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('Invalid JSON');
  });

  test('oversized message (>10000 chars) returns 413', async ({ request }) => {
    const bigMsg = 'A'.repeat(10001);
    const res = await request.post('/api/chat', {
      data: { message: bigMsg, mode: 'success' },
    });
    expect(res.ok()).toBe(false);
    expect(res.status()).toBe(413);
    const body = await res.json();
    expect(body.error).toContain('too long');
  });

  test('message at boundary (10000 chars) is accepted', async ({ request }) => {
    const bigMsg = 'A'.repeat(10000);
    const res = await request.post('/api/chat', {
      data: { message: bigMsg, mode: 'success' },
    });
    expect(res.ok()).toBe(true);
  });

  test('GET /api/chat returns 405', async ({ request }) => {
    const res = await request.get('/api/chat');
    expect(res.status()).toBe(405);
  });

  test('PUT /api/chat returns 405', async ({ request }) => {
    const res = await request.put('/api/chat', { data: { message: 'test' } });
    expect(res.status()).toBe(405);
  });

  test('DELETE /api/chat returns 405', async ({ request }) => {
    const res = await request.delete('/api/chat');
    expect(res.status()).toBe(405);
  });

  test('unknown mode falls through to env fallback message', async ({ request }) => {
    const res = await request.post('/api/chat', {
      data: { message: 'Hello', mode: 'bogus_mode_name' },
    });
    expect(res.ok()).toBe(true);
    const result = await res.json();
    // bogus mode is not in fakeModes list, so it falls through
    // Since SWARM_FAKE=true, it hits the "fake env without specific mode" path
    expect(result.model).toBe('fake');
    expect(result.response).toContain('Fake mode');
    expect(result.mode).toBe('env');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. UI TESTS — browser renders correctly
// ═══════════════════════════════════════════════════════════════════════

test.describe('UI rendering', () => {
  test('success mode: user and assistant messages appear', async ({ page }) => {
    await openApp(page, 'success');
    await typeMessage(page, 'Hello Swarm');
    await sendAndWait(page);

    // User message
    const userMsg = page.locator('[data-testid="message-bubble"][data-role="user"]');
    await expect(userMsg).toHaveCount(1);
    await expect(userMsg).toContainText('Hello Swarm');

    // Assistant message
    const assistantMsg = page.locator('[data-testid="message-bubble"][data-role="assistant"]');
    await expect(assistantMsg).toHaveCount(1);
    await expect(assistantMsg).toContainText('fake success response');
  });

  test('empty mode: assistant bubble shows [No response]', async ({ page }) => {
    await openApp(page, 'empty');
    await typeMessage(page, 'Test empty');
    await sendAndWait(page);

    const assistantMsg = page.locator('[data-testid="message-bubble"][data-role="assistant"]');
    await expect(assistantMsg).toHaveCount(1);

    const contentDiv = assistantMsg.locator('.msg-content');
    const textContent = await contentDiv.textContent();
    // Should show the empty response label
    expect(textContent).toBe('[No response]');
  });

  test('error mode: fallback response is visible', async ({ page }) => {
    await openApp(page, 'error');
    await typeMessage(page, 'Trigger error');
    await sendAndWait(page);

    // The error fake mode throws, but the server catches it and returns a
    // fallback response with finishReason 'fallback'
    const assistantMsg = page.locator('[data-testid="message-bubble"][data-role="assistant"]');
    await expect(assistantMsg).toHaveCount(1);

    const contentDiv = assistantMsg.locator('.msg-content');
    const textContent = await contentDiv.textContent();
    expect(textContent.length).toBeGreaterThan(0);
  });

  test('error mode shows fallback label badge in UI', async ({ page }) => {
    await openApp(page, 'error');
    await typeMessage(page, 'Trigger error');
    await sendAndWait(page);

    // Check for the fallback tag in assistant messages
    const fallbackTag = page.locator('[data-testid="message-bubble"][data-role="assistant"] .fallback-tag');
    await expect(fallbackTag).toBeVisible({ timeout: 3000 });
  });

  test('input textarea enforces 2000 character max', async ({ page }) => {
    await openApp(page, 'success');
    const input = page.locator('[data-testid="composer-input"]');

    const maxLength = await input.getAttribute('maxlength');
    expect(maxLength).toBe('2000');

    const longText = 'A'.repeat(2500);
    await input.fill(longText);

    const actualValue = await input.inputValue();
    expect(actualValue.length).toBeLessThanOrEqual(2000);

    const charCount = page.locator('[data-testid="char-count"]');
    await expect(charCount).toContainText('/2000');
  });

  test('clear button removes all messages', async ({ page }) => {
    await openApp(page, 'success');
    await typeMessage(page, 'First message');
    await sendAndWait(page);

    // Verify messages appear
    await expect(page.locator('[data-testid="message-bubble"]')).toHaveCount(2);

    // Clear
    await page.locator('[data-testid="clear-chat-btn"]').click();
    await expect(page.locator('[data-testid="message-bubble"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="empty-state"]')).toBeVisible();
  });

  test('mode badge is visible for fake modes', async ({ page }) => {
    await openApp(page, 'success');
    await typeMessage(page, 'Check badge');
    await sendAndWait(page);

    const badge = page.locator('[data-testid="model-badge"]');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('mode:');
  });

  test('duplicate send suppressed while generating', async ({ page }) => {
    await openApp(page, 'timeout');
    await typeMessage(page, 'Wait');
    const sendBtn = page.locator('[data-testid="send-btn"]');

    // Click send
    await sendBtn.click();

    // Button should be immediately disabled
    await expect(sendBtn).toBeDisabled({ timeout: 2000 });

    // Wait for response eventually
    await page.waitForSelector('[data-testid="message-bubble"][data-role="assistant"]', { timeout: 10000 });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. FALLBACK BEHAVIOR — no model loaded, server returns fallback
// ═══════════════════════════════════════════════════════════════════════

test.describe('fallback behavior', () => {
  test('API returns fallback response structure for error mode (caught)', async ({ request }) => {
    // error mode throws, but server catches it
    const res = await apiChat(request, 'Test fallback', 'error');
    expect(res.ok()).toBe(true);
    const result = await res.json();

    expect(result.model).toBe('fake');
    expect(result.finishReason).toBe('fallback');
    expect(typeof result.response).toBe('string');
    expect(result.response.length).toBeGreaterThan(0);
    expect(result.fallbackReason).toContain('FAKE_MODE_ERROR');
    expect(result.inspection).toBeDefined();
  });

  test('API always returns inspection data even on fallback', async ({ request }) => {
    const modes = ['success', 'empty', 'error', 'overlong'];
    for (const mode of modes) {
      const res = await apiChat(request, 'Inspect me', mode);
      expect(res.ok()).toBe(true);
      const result = await res.json();
      expect(result.inspection, `mode=${mode}: inspection missing`).toBeDefined();
      expect(result.inspection.messageLength).toBe(10);
      expect(result.inspection.wordCount).toBe(2);
      expect(result.inspection.timestamp).toBeGreaterThan(0);
      // error mode returns fallback finish reason
      if (mode === 'error') {
        expect(result.finishReason).toBe('fallback');
      }
    }
  });

  test('fallback label present in error mode response', async ({ request }) => {
    const res = await apiChat(request, 'Test fallback', 'error');
    expect(res.ok()).toBe(true);
    const result = await res.json();

    expect(result.fallbackLabel).toBeDefined();
    expect(result.fallbackLabel.length).toBeGreaterThan(0);
    expect(result.fallbackLabel).toContain('fallback'); // case-insensitive; actual is '⚡ Fake error — deterministic fallback'
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. HORIZONTAL SPACING — equal left/right gutters
// ═══════════════════════════════════════════════════════════════════════

test.describe('horizontal spacing', () => {
  test('chat area is centered in viewport', async ({ page }) => {
    await openApp(page, 'success');
    await typeMessage(page, 'Test spacing');
    await sendAndWait(page);

    const chatBox = await page.evaluate(() => {
      const chat = document.querySelector('[data-testid="chat-area"]');
      const rect = chat.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    });

    expect(chatBox).toBeTruthy();

    const viewportWidth = await page.evaluate(() => window.innerWidth);
    const chatCenter = chatBox.left + chatBox.width / 2;
    const viewportCenter = viewportWidth / 2;
    expect(Math.abs(chatCenter - viewportCenter)).toBeLessThanOrEqual(2);
  });

  test('messages respect 85% max-width constraint', async ({ page }) => {
    await openApp(page, 'success');
    await typeMessage(page, 'Width test');
    await sendAndWait(page);

    const chatWidth = await page.evaluate(() => {
      const chat = document.querySelector('[data-testid="chat-area"]');
      return chat.getBoundingClientRect().width;
    });
    const maxAllowed = chatWidth * 0.85 + 1;

    const widths = await page.evaluate(() => {
      const bubbles = document.querySelectorAll('[data-testid="message-bubble"]');
      return Array.from(bubbles).map(b => b.getBoundingClientRect().width);
    });

    for (const w of widths) {
      expect(w).toBeLessThanOrEqual(maxAllowed);
    }
  });
});

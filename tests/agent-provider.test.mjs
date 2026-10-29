import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeepSeekProvider } from '../backend/src/agent/providers/deepseek.js';
import { checkRateLimit, reserveModelCall, finishModelCall, getUsage } from '../backend/src/agent/rate-limit.js';


test('provider migrates retired chat configuration and sends non-thinking Chat Completions requests', async () => {
  const originalFetch = globalThis.fetch;
  const originalModel = process.env.DEEPSEEK_MODEL;
  try {
    const messages = [{ role: 'user', content: '为什么更新左边界？' }];
    for (const [configured, expected] of [[undefined, 'deepseek-flash'], ['deepseek-chat', 'deepseek-flash'], ['  deepseek-chat  ', 'deepseek-flash'], ['deepseek-v4-pro', 'deepseek-v4-pro']]) {
      if (configured === undefined) delete process.env.DEEPSEEK_MODEL;
      else process.env.DEEPSEEK_MODEL = configured;
      globalThis.fetch = async (url, options) => {
        assert.equal(url, 'https://api.deepseek.com/v1/chat/completions');
        assert.equal(options.method, 'POST');
        assert.equal(options.headers.Authorization, 'Bearer dummy');
        const body = JSON.parse(options.body);
        assert.equal(body.model, expected);
        assert.deepEqual(body.messages, messages);
        assert.deepEqual(body.thinking, { type: 'disabled' });
        assert.equal(body.max_tokens, 1024);
        assert.equal(body.stream, false);
        return { ok: true, json: async () => ({ choices: [{ message: { content: '中点值小于目标。' } }] }) };
      };
      const result = await new DeepSeekProvider('dummy').chat(messages);
      assert.equal(result.content, '中点值小于目标。');
      assert.equal(result.model, expected);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalModel === undefined) delete process.env.DEEPSEEK_MODEL;
    else process.env.DEEPSEEK_MODEL = originalModel;
  }
});

test('provider timeout covers headers AND JSON body, including uncooperative fetch', async () => {
  const original = globalThis.fetch;
  try {
    for (const phase of ['headers', 'body']) {
      let signal;
      globalThis.fetch = async (_url, options) => {
        signal = options.signal;
        if (phase === 'headers') return new Promise(() => {});
        return { ok: true, json: () => new Promise(() => {}) };
      };
      await assert.rejects(new DeepSeekProvider('dummy').chat([], { timeoutMs: 15 }), /MODEL_TIMEOUT/);
      assert.equal(signal.aborted, true);
    }
  } finally { globalThis.fetch = original; }
});

test('provider reports unknown/invalid usage and redacts upstream diagnostics', async () => {
  const original = globalThis.fetch;
  try {
    for (const usage of [undefined, {}, { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 }]) {
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage }) });
      const result = await new DeepSeekProvider('dummy').chat([]);
      assert.equal(result.usage, null);
      assert.equal(result.cost, null);
    }
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'secret-key-diagnostic' });
    await assert.rejects(new DeepSeekProvider('dummy').chat([]), error => error.message === 'MODEL_CALL_FAILED');
    process.env.MODEL_INPUT_CNY_PER_MILLION = '1';
    process.env.MODEL_OUTPUT_CNY_PER_MILLION = '2';
    assert.equal(new DeepSeekProvider('dummy').estimateCost({ prompt_tokens: 1, completion_tokens: 1 }), 0.000003);
  } finally { globalThis.fetch = original; }
});

test('source rate limit cannot be reset by session, user agent or forwarded headers', () => {
  process.env.RATE_LIMIT_MAX = '2';
  const req = { socket: { remoteAddress: 'audit-source' }, headers: {} };
  assert.equal(checkRateLimit(req, 'one').allowed, true);
  assert.equal(checkRateLimit(req, 'two').allowed, true);
  req.headers = { 'x-forwarded-for': 'new-ip', 'user-agent': 'new-browser', 'x-session-id': 'three' };
  assert.equal(checkRateLimit(req, 'three').allowed, false);
  assert.equal(checkRateLimit({ socket: { remoteAddress: 'other-source' }, headers: {} }).allowed, true);
});

test('budget reservations survive module reload, block concurrency, and settle once', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'agent-budget-'));
  try {
    process.env.AGENT_BUDGET_FILE = join(temp, 'budget.json');
    process.env.MODEL_CALL_RESERVE_CNY = '0.05';
    process.env.BUDGET_DAILY_YUAN = '0.11';
    process.env.MODEL_TEST_BUDGET_CNY = '0.11';
    process.env.BUDGET_ENABLED = 'true';
    process.env.RATE_LIMIT_DAILY_TOKENS = '1000';
    const req = { socket: { remoteAddress: 'budget-source' }, headers: {} };
    const a = reserveModelCall(req, 'a', 10), b = reserveModelCall(req, 'b', 10);
    assert.equal(a.allowed, true); assert.equal(b.allowed, true);
    assert.equal(reserveModelCall(req, 'c', 10).code, 'BUDGET_EXCEEDED');
    const reloaded = await import('../backend/src/agent/rate-limit.js?restart-budget-test');
    assert.equal(reloaded.reserveModelCall(req, 'after-restart', 10).code, 'BUDGET_EXCEEDED');
    finishModelCall(a.receipt, { tokens: 5, cost: 0.001, elapsedMs: 12 });
    finishModelCall(a.receipt, { tokens: 5, cost: 0.001 });
    assert.equal(getUsage(req, 'a').requests, 1);
    assert.equal(getUsage(req, 'a').tokensUsed, 5);
    assert.equal(getUsage(req, 'a').costUsed, 0.001);
    finishModelCall(b.receipt, { tokens: 7, cost: null });
    assert.equal(getUsage(req, 'b').tokensUsed, 7);
    assert.equal(getUsage(req, 'b').costUsed, null);
    const c = reserveModelCall(req, 'c', 10);
    assert.equal(c.allowed, true);
    finishModelCall(c.receipt, { failed: true, elapsedMs: 15 });
    assert.equal(getUsage(req, 'c').costUsed, null);
    assert.equal(getUsage(req, 'c').tokensUsed, null);
    assert.equal(getUsage(req, 'c').failures, 1);
    assert.ok(JSON.parse(readFileSync(process.env.AGENT_BUDGET_FILE)).totalCommitted > 0.1 - 1e-9);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('daily token reservations are independent of minute windows and sessions', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'agent-token-'));
  try {
    process.env.AGENT_BUDGET_FILE = join(temp, 'budget.json');
    process.env.RATE_LIMIT_DAILY_TOKENS = '8';
    process.env.BUDGET_ENABLED = 'false';
    process.env.RATE_LIMIT_WINDOW_MS = '1';
    const req = { socket: { remoteAddress: 'token-source' }, headers: {} };
    assert.equal(reserveModelCall(req, 'one', 5).allowed, true);
    checkRateLimit(req);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(checkRateLimit(req).allowed, true);
    assert.equal(reserveModelCall(req, 'new-session', 5).code, 'TOKEN_LIMIT_EXCEEDED');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

import { getRun } from '../runs/store.js';
import { checkRateLimit, reserveModelCall, finishModelCall, recordMockCall } from './rate-limit.js';
import { guardOutput } from './output-guard.js';
import { buildPrompt } from './prompt.js';
import { conversations, validateConversation } from './conversation.js';

export async function handleAgentExplain(parsedBody, ctx = {}) {
  if (!validateConversation(parsedBody)) return { status: 400, body: { error: { code: 'INVALID_INPUT', message: 'conversationId与turnId须同时提供，且为8至80位字母、数字或连接符。' } } };
  const run = typeof parsedBody?.runId === 'string' ? getRun(parsedBody.runId) : null;
  // Keep the original endpoint validation/errors for legacy and invalid callers.
  if (!run || !Number.isSafeInteger(parsedBody?.stepIndex) || parsedBody.stepIndex < 0 || parsedBody.stepIndex >= run.steps.length ||
      typeof parsedBody.question !== 'string' || !parsedBody.question.trim() || parsedBody.question.length > 2000 ||
      (parsedBody.hintLevel !== undefined && ![1,2,3].includes(parsedBody.hintLevel))) return explain(parsedBody, ctx);
  const turn = conversations.begin(parsedBody, ctx.req);
  if (turn.error) return turn.error;
  if (turn.cached) return turn.cached;
  const execution = { ...ctx, history: turn.history };
  try {
    const result = await explain(parsedBody, execution);
    // Store successful replies even when no knowledge card was retrieved.
    if (result.status === 200 && typeof result.body.answer === 'string' && result.body.answer.trim()) turn.commit(result);
    return result;
  } finally { turn.release(); }
}

async function explain(parsedBody, ctx = {}) {
  const mode = ctx.mode || 'mock';
  const req = ctx.req;
  const bodySessionId = parsedBody?.sessionId;

  // ===== 统一校验（所有模式共用）=====
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return { status: 400, body: { error: { code: 'INVALID_INPUT', message: '请求体必须为 JSON 对象' } } };
  }

  const { runId, stepIndex, question, hintLevel } = parsedBody;

  if (typeof runId !== 'string' || !runId.trim()) {
    return { status: 400, body: { error: { code: 'INVALID_INPUT', message: 'runId 为必填字符串' } } };
  }
  if (hintLevel !== undefined) {
    if (!Number.isInteger(hintLevel) || hintLevel < 1 || hintLevel > 3) {
      return { status: 400, body: { error: { code: 'INVALID_INPUT', message: 'hintLevel 必须为 1、2 或 3' } } };
    }
  }

  // ===== P2 FIX: 索引类型校验，禁止任何类型转换 =====
  if (stepIndex === undefined || stepIndex === null) {
    return { status: 400, body: { error: { code: 'INVALID_INPUT', message: 'stepIndex 为必填' } } };
  }
  if (typeof stepIndex !== 'number' || !Number.isSafeInteger(stepIndex) || stepIndex < 0) {
    return { status: 400, body: { error: { code: 'INVALID_INPUT', message: 'stepIndex 必须为非负整数（禁止字符串等类型转换）' } } };
  }
  const idx = stepIndex; // 直接用原值，不再 Number()

  if (typeof question !== 'string' || !question.trim() || question.length > 2000) {
    return { status: 400, body: { error: { code: 'INVALID_INPUT', message: 'question 必须为1至2000字符的非空字符串' } } };
  }

  const level = hintLevel === undefined ? 1 : hintLevel;

  // ===== 查询真实步骤 =====
  const run = getRun(runId);
  if (!run) {
    return { status: 404, body: { error: { code: 'RUN_NOT_FOUND', message: 'run 不存在或已过期，请重新运行算法' } } };
  }
  const steps = Array.isArray(run.steps) ? run.steps : [];
  if (idx >= steps.length) {
    return { status: 400, body: { error: { code: 'STEP_OUT_OF_RANGE', message: `stepIndex 越界，该 run 共 ${steps.length} 步（0-${steps.length - 1}）` } } };
  }
  const step = steps[idx] || {};
  const arr = Array.isArray(step.array) ? step.array : [];
  const target = step.target;
  const left = step.variables?.left;
  const right = step.variables?.right;
  const mid = step.variables?.mid;
  const ev = step.event;
  const stepNo = step.stepIndex ?? idx;

  if (process.env.RATE_LIMIT !== 'false' && req) {
    const limit = checkRateLimit(req);
    if (!limit.allowed) return { status: 429, body: { error: { code: 'RATE_LIMIT_EXCEEDED', message: '请求过于频繁，请稍后再试', retryAfter: Math.ceil(limit.resetIn / 1000) } } };
  }
  if (mode !== 'real') recordMockCall(req, bodySessionId);
  // Compatibility metadata: chat does not read or cite the knowledge catalog.
  const metadata = { sourceRefs: [], knowledgeUsed: false,
    retrieval: { method: 'none', status: 'disabled', matchedCardIds: [], contextCardId: null, matches: [] } };
  const stepRefs = [{ runId, stepIndex: idx, event: ev, left, right, mid, array: arr, target }];

  // Every valid question in real mode goes to the provider after quota checks.
  // ===== 真实模型模式 =====
  if (mode === 'real') {
    let receipt;
    const startedAt = Date.now();
    try {
      const { DeepSeekProvider } = await import('./providers/deepseek.js');
      const provider = new DeepSeekProvider();
      const messages = buildPrompt(run, step, level, question, ctx.history || []);
      const maxTokens = 1024;
      const maximumTokens = Buffer.byteLength(JSON.stringify(messages), 'utf8') + maxTokens + 256;
      const allocation = reserveModelCall(req, bodySessionId, maximumTokens);
      if (!allocation.allowed) return { status: allocation.code === 'BUDGET_UNAVAILABLE' ? 503 : 429, body: { error: { code: allocation.code, message: '模型调用额度不足或预算记录不可用，请检查后端配置' } } };
      receipt = allocation.receipt;
      // P2 FIX: 不再硬编码 15000，读 MODEL_TIMEOUT_MS
      const timeoutMs = Number(process.env.MODEL_TIMEOUT_MS) || 15000;
      const result = await provider.chat(messages, { timeoutMs, maxTokens });
      const elapsedMs = Date.now() - startedAt;

      const guard = guardOutput(result.content);
      if (!guard.valid && !guard.truncated) throw new Error('MODEL_CALL_FAILED');
      const finalAnswer = guard.valid ? result.content : guard.truncated;

      finishModelCall(receipt, { tokens: result.usage?.totalTokens ?? null, cost: result.cost ?? null, elapsedMs });

      return {
        status: 200,
        body: {
          runId,
          stepIndex: idx,
          hintLevel: level,
          answer: finalAnswer,
          stepRefs,
          ...metadata,
          usage: {
            model: result.model || provider.model,
            cost: result.cost ?? null,
            costCurrency: 'CNY',
            costBasis: result.cost == null ? null : '按后端配置单价估算，非实际账单',
            mock: false,
            tokens: result.usage || null,
            elapsedMs
          }
        }
      };
    } catch (err) {
      finishModelCall(receipt, { elapsedMs: Date.now() - startedAt, failed: true });
      if (err.message === 'MODEL_TIMEOUT') {
        // P2 FIX: 移除"已降级为 Mock"的误导文案
        return { status: 504, body: { error: { code: 'MODEL_TIMEOUT', message: '模型响应超时，请稍后重试', degraded: false } } };
      }
      return { status: 502, body: { error: { code: 'MODEL_CALL_FAILED', message: '模型调用失败，请稍后重试' } } };
    }
  }

  // ===== Mock 模式 =====
  const prefix = '[Mock开发模式] ';
  let answer = '';

  if (typeof left === 'number' && typeof right === 'number' && left > right) {
    answer = `${prefix}候选区间已为空（left=${left} > right=${right}），查找结束，返回 -1（not-found）。`;
  } else if (level === 1) {
    answer = `${prefix}当前步骤（第${stepNo + 1}步）：事件为 ${ev}，区间 [${left}, ${right}]`;
    if (typeof mid === 'number') {
      answer += `，mid=${mid}`;
      if (arr.length > mid) answer += `，A[${mid}]=${arr[mid]}`;
    }
    answer += `。目标值为 ${target}。`;
  } else if (level === 2) {
    answer = `${prefix}步骤 ${stepNo + 1} 事件 ${ev}：候选区间 [${left}, ${right}]`;
    if (typeof mid === 'number') answer += `，mid=${mid}，A[${mid}]=${arr[mid] ?? '?'}`;
    answer += `。目标 ${target}。`;
    if (ev === 'probe') answer += ' 正在比较目标与中间元素。';
    else if (ev === 'move-left') answer += ' 更新左边界。';
    else if (ev === 'move-right') answer += ' 更新右边界。';
    else if (ev === 'found') answer += ' 找到目标，查找成功。';
    else if (ev === 'not-found') answer += ' 候选区间已空，查找结束。';
    else if (ev === 'init') answer += ' 初始化查找区间。';
  } else {
    let next = '下一步继续二分查找流程。';
    if (arr.length === 0) next = '数组为空，查找直接结束（not-found）。';
    else if (ev === 'init') next = '初始化完成，下一步将计算 mid 并与目标比较。';
    else if (ev === 'probe') {
      const value = arr[mid];
      next = value === target ? '下一步：命中（found），返回当前中点下标。'
        : value < target ? '下一步：更新左边界（left=mid+1）。'
          : '下一步：更新右边界（right=mid-1）。';
    }
    else if (ev === 'move-left') next = '已更新左边界，下一步重新计算 mid。';
    else if (ev === 'move-right') next = '已更新右边界，下一步重新计算 mid。';
    else if (ev === 'found') next = '已找到目标，查找成功结束。';
    else if (ev === 'not-found') next = '查找结束，目标不在数组中。';

    answer = `${prefix}步骤 ${stepNo + 1} 事件 ${ev}：区间 [${left}, ${right}]`;
    if (typeof mid === 'number') answer += `，mid=${mid}，A[${mid}]=${arr[mid] ?? '?'}`;
    answer += `。目标 ${target}。${next}`;
  }


  return {
    status: 200,
    body: {
      runId,
      stepIndex: idx,
      hintLevel: level,
      answer,
      stepRefs,
          ...metadata,
      usage: { model: 'mock', cost: 0, mock: true }
    }
  };
}

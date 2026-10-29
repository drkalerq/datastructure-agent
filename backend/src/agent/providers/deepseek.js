export class DeepSeekProvider {
  constructor(apiKey) {
    this.apiKey = apiKey || process.env.DEEPSEEK_API_KEY;
    if (!this.apiKey) throw new Error('MODEL_NOT_CONFIGURED');
    const configuredModel = process.env.DEEPSEEK_MODEL?.trim();
    // The retired chat alias may remain in an existing local .env.
    this.model = !configuredModel || configuredModel === 'deepseek-chat' ? 'deepseek-flash' : configuredModel;
    this.timeoutMs = Number(process.env.MODEL_TIMEOUT_MS) || 15000;
  }

  async chat(messages, options = {}) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('MODEL_TIMEOUT')); }, options.timeoutMs || this.timeoutMs);
    });
    try {
      const request = (async () => {
        const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: this.model, messages, temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens ?? 1024, stream: false, thinking: { type: 'disabled' } }),
          signal: controller.signal
        });
        // Do not echo upstream bodies (which may include sensitive diagnostic data).
        if (!response.ok) throw new Error('MODEL_CALL_FAILED');
        const data = await response.json();
        const raw = data.usage;
        const validUsage = raw && [raw.prompt_tokens, raw.completion_tokens, raw.total_tokens]
          .every(n => Number.isSafeInteger(n) && n >= 0) && raw.total_tokens === raw.prompt_tokens + raw.completion_tokens;
        const usage = validUsage ? { promptTokens: raw.prompt_tokens, completionTokens: raw.completion_tokens, totalTokens: raw.total_tokens } : null;
        return { content: data.choices?.[0]?.message?.content || '', model: data.model || this.model,
          cost: validUsage ? this.estimateCost(raw) : null, usage };
      })();
      return await Promise.race([request, timeout]);
    } catch (err) {
      if (controller.signal.aborted || err.message === 'MODEL_TIMEOUT') throw new Error('MODEL_TIMEOUT');
      throw new Error('MODEL_CALL_FAILED');
    } finally { clearTimeout(timer); }
  }

  estimateCost(usage) {
    const input = Number(process.env.MODEL_INPUT_CNY_PER_MILLION);
    const output = Number(process.env.MODEL_OUTPUT_CNY_PER_MILLION);
    if (!process.env.MODEL_INPUT_CNY_PER_MILLION || !process.env.MODEL_OUTPUT_CNY_PER_MILLION ||
        !Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) return null;
    // Preserve small costs; rounding each call to four decimals loses real usage.
    return (usage.prompt_tokens * input + usage.completion_tokens * output) / 1000000;
  }
}

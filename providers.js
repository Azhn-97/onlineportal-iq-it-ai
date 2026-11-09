import Anthropic from '@anthropic-ai/sdk';

// Провайдер интерфейсі:
//   stream({ model, system, messages, maxTokens, effort, signal, onText }) -> { stopReason: 'end' | 'length' | 'refusal' }
//   friendlyError(err) -> пайдаланушыға көрсетілетін қазақша мәтін

export function createAnthropicProvider(apiKey) {
  const client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  return {
    name: 'anthropic',
    async stream({ model, system, messages, maxTokens, effort, signal, onText }) {
      const stream = client.messages.stream(
        { model, max_tokens: maxTokens, output_config: { effort }, system, messages },
        { signal },
      );
      stream.on('text', onText);
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') return { stopReason: 'refusal' };
      return { stopReason: final.stop_reason === 'max_tokens' ? 'length' : 'end' };
    },
    friendlyError(err) {
      if (err instanceof Anthropic.AuthenticationError) return 'API кілті жарамсыз. Баптаулардан кілтті тексеріңіз.';
      if (err instanceof Anthropic.RateLimitError) return 'ЖИ сервисінің сұраныс лимиті толды. Сәлден кейін қайталаңыз.';
      if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message)) return 'Anthropic есебінде қаражат жеткіліксіз.';
      if (err instanceof Anthropic.APIError && (err.status ?? 0) >= 500) return 'ЖИ сервисі уақытша қолжетімсіз. Кейінірек қайталаңыз.';
      return 'Жауап алу кезінде қате шықты. Кейінірек қайталап көріңіз.';
    },
  };
}

/** Ollama: модель осы компьютерде жұмыс істейді, API кілті қажет емес. */
export function createOllamaProvider({ baseUrl, numCtx }) {
  const base = baseUrl.replace(/\/+$/, '');

  class OllamaError extends Error {
    constructor(message, kind) { super(message); this.kind = kind; }
  }

  return {
    name: 'ollama',
    baseUrl: base,

    /** Ollama қосулы ма және модель жүктелген бе. */
    async status(model) {
      try {
        const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
        if (!res.ok) return { reachable: false, modelInstalled: false, installed: [] };
        const data = await res.json();
        const installed = (data.models ?? []).map((m) => m.name);
        const modelInstalled = installed.some((n) => n === model || n === `${model}:latest`);
        return { reachable: true, modelInstalled, installed };
      } catch {
        return { reachable: false, modelInstalled: false, installed: [] };
      }
    },

    async stream({ model, system, messages, maxTokens, signal, onText }) {
      let res;
      try {
        res = await fetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({
            model,
            stream: true,
            messages: [{ role: 'system', content: system }, ...messages],
            options: { num_ctx: numCtx, num_predict: Math.min(maxTokens, Math.floor(numCtx * 0.6)), temperature: 0.6 },
          }),
        });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        throw new OllamaError(String(err.cause?.code || err.message), 'unreachable');
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new OllamaError(text, res.status === 404 ? 'model' : 'http');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let doneReason = 'stop';
      const handle = (line) => {
        if (!line.trim()) return;
        const obj = JSON.parse(line);
        if (obj.error) throw new OllamaError(obj.error, /not found/i.test(obj.error) ? 'model' : 'http');
        if (obj.message?.content) onText(obj.message.content);
        if (obj.done) doneReason = obj.done_reason || 'stop';
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        lines.forEach(handle);
      }
      handle(buf);
      return { stopReason: doneReason === 'length' ? 'length' : 'end' };
    },

    friendlyError(err, model) {
      if (err?.kind === 'unreachable') return `Ollama-ға қосыла алмадым (${base}). Ollama бағдарламасын іске қосыңыз.`;
      if (err?.kind === 'model') return `«${model}» моделі жүктелмеген. Терминалда орындаңыз: ollama pull ${model}`;
      return 'Жергілікті модель қате қайтарды. Ollama терминалындағы хабарламаны қараңыз.';
    },
  };
}

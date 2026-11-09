import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseSystem, chatSystem, assistantTools, materialTypes } from './prompts.js';
import { createAnthropicProvider, createOllamaProvider } from './providers.js';
import { createStore } from './db.js';
import { registerRoutes, attachUser, requireAuth, originCheck } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const APP_NAME = process.env.APP_NAME || 'Педагог көмекшісі';
const RATE_LIMIT = Number(process.env.RATE_LIMIT) || 30; // бір IP-ге минутына ЖИ сұраныс саны
const MAX_MESSAGES = 50;
const MAX_CHARS = 40000;

// ---------- Провайдер: Claude (API кілтімен) немесе Ollama (жергілікті, кілтсіз) ----------
const serverKey = process.env.ANTHROPIC_API_KEY;
const PROVIDER = process.env.PROVIDER || (serverKey ? 'anthropic' : 'ollama');
if (!['anthropic', 'ollama'].includes(PROVIDER)) {
  console.error(`PROVIDER мәні қате: «${PROVIDER}». «anthropic» немесе «ollama» болуы керек.`);
  process.exit(1);
}
const MODELS = {
  anthropic: process.env.MODEL || 'claude-sonnet-5-5',
  ollama: process.env.OLLAMA_MODEL || 'gemma3:12b',
};
const ollama = createOllamaProvider({
  baseUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
  numCtx: Number(process.env.OLLAMA_NUM_CTX) || 8192,
});
const serverAnthropic = serverKey ? createAnthropicProvider() : null;

const VALID_USER_KEY = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
/** Сұраныс үшін провайдерді таңдайды; null — ЖИ бапталмаған. */
function resolveProvider(req) {
  const userKey = req.get('x-user-api-key');
  // Баптаулардан жеке кілт енгізілсе (серверде кілт жоқ және Ollama міндеттелмеген болса)
  if (!serverKey && userKey && VALID_USER_KEY.test(userKey) && process.env.PROVIDER !== 'ollama') {
    return { provider: createAnthropicProvider(userKey), model: MODELS.anthropic };
  }
  if (PROVIDER === 'ollama') return { provider: ollama, model: MODELS.ollama };
  return serverAnthropic ? { provider: serverAnthropic, model: MODELS.anthropic } : null;
}

let statusCache = { at: 0, value: null };
async function providerInfo() {
  const base = {
    name: APP_NAME,
    provider: PROVIDER,
    model: MODELS[PROVIDER],
    userKeyAllowed: !serverKey && process.env.PROVIDER !== 'ollama', // Баптаулардан жеке Claude кілтін енгізуге болады
  };
  if (PROVIDER === 'anthropic') {
    return { ...base, configured: Boolean(serverKey), hint: 'API кілті жоқ. «Баптаулар» бөлімінде кілтті енгізіңіз (немесе серверде .env файлына жазыңыз).' };
  }
  if (Date.now() - statusCache.at > 4000) statusCache = { at: Date.now(), value: await ollama.status(MODELS.ollama) };
  const s = statusCache.value;
  const hint = !s.reachable
    ? `Ollama табылмады (${ollama.baseUrl}). Ollama-ны орнатып, іске қосыңыз: https://ollama.com`
    : !s.modelInstalled
      ? `«${MODELS.ollama}» моделі жүктелмеген. Терминалда орындаңыз: ollama pull ${MODELS.ollama}`
      : '';
  return { ...base, configured: s.reachable && s.modelInstalled, hint, ollama: { reachable: s.reachable, modelInstalled: s.modelInstalled } };
}

// mode бойынша: жауап ұзындығы және ойлау тереңдігі
const MODES = {
  chat: { maxTokens: 4096, effort: 'low' },
  assistant: { maxTokens: 8000, effort: 'medium' },
  material: { maxTokens: 16000, effort: 'medium' },
};

const store = createStore(process.env.DB_PATH || path.join(__dirname, 'data', 'app.db'));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '3mb' }));
app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
app.use(originCheck);
app.use(attachUser(store));
app.use(express.static(path.join(__dirname, 'public')));

const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
function rateLimit(req, res, next) {
  const n = (hits.get(req.user.id) || 0) + 1;
  hits.set(req.user.id, n);
  if (n > RATE_LIMIT) return res.status(429).json({ error: 'Сұраныс тым көп. Бір минуттан кейін қайталаңыз.' });
  next();
}

const clean = (v, max = 80) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const kindsFor = (mode) => (mode === 'assistant' ? assistantTools : mode === 'material' ? materialTypes : null);

function validate({ mode, kind, messages }) {
  if (!Object.hasOwn(MODES, mode)) return false;
  const kinds = kindsFor(mode);
  if (kinds && !Object.hasOwn(kinds, kind)) return false;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) return false;
  let total = 0;
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim()) return false;
    total += m.content.length;
  }
  return total <= MAX_CHARS && messages[0].role === 'user' && messages[messages.length - 1].role === 'user';
}

function buildSystem(mode, kind, user) {
  const parts = [baseSystem(APP_NAME), mode === 'chat' ? chatSystem : kindsFor(mode)[kind]];
  const facts = [
    clean(user.name) && `аты — ${clean(user.name)}`,
    clean(user.subject) && `пәні — ${clean(user.subject)}`,
    clean(user.school) && `мектебі — ${clean(user.school)}`,
  ].filter(Boolean);
  if (facts.length) parts.push(`Мұғалім туралы (қажет жерінде ғана қолдан): ${facts.join('; ')}.`);
  return parts.join('\n\n');
}

app.get('/api/info', async (_req, res) => {
  res.json({ ...(await providerInfo()), assistantTools: Object.keys(assistantTools), materialTypes: Object.keys(materialTypes) });
});

registerRoutes(app, store);

app.post('/api/ai', requireAuth, rateLimit, async (req, res) => {
  const body = req.body ?? {};
  if (!validate(body)) return res.status(400).json({ error: 'Қате сұраныс форматы.' });

  const picked = resolveProvider(req);
  if (!picked) return res.status(503).json({ error: (await providerInfo()).hint });
  const { provider, model } = picked;

  const { mode, kind, messages } = body;
  const cfg = MODES[mode];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const ac = new AbortController();
  res.on('close', () => ac.abort());

  try {
    const { stopReason } = await provider.stream({
      model,
      system: buildSystem(mode, kind, req.user),
      messages: messages.map(({ role, content }) => ({ role, content })),
      maxTokens: cfg.maxTokens,
      effort: cfg.effort,
      signal: ac.signal,
      onText: (text) => send('delta', { text }),
    });
    if (stopReason === 'refusal') send('error', { error: 'Бұл сұрауға жауап бере алмаймын. Тақырыпты немесе сөздерді өзгертіп көріңіз.' });
    else send('done', { truncated: stopReason === 'length' });
  } catch (err) {
    if (!ac.signal.aborted) {
      console.error(`${provider.name} қатесі:`, err?.status ?? err?.kind ?? '', err?.message || err);
      send('error', { error: provider.friendlyError(err, model) });
    }
  } finally {
    res.end();
  }
});

app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status === 413 ? 413 : err.status === 400 ? 400 : 500;
  res.status(status).json({ error: status === 413 ? 'Деректер тым үлкен.' : status === 400 ? 'Қате сұраныс форматы.' : 'Сервер қатесі.' });
});

app.listen(PORT, async () => {
  const info = await providerInfo();
  console.log(`${APP_NAME}: http://localhost:${PORT}  (ЖИ: ${PROVIDER}, модель: ${info.model})`);
  if (!info.configured) console.warn(`Ескерту: ${info.hint}`);
});

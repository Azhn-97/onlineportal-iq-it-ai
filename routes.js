import { randomBytes, createHash, scrypt, timingSafeEqual, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const SESSION_DAYS = 30;
const LOGIN_RE = /^[\p{L}\p{N}._@-]{3,40}$/u;
const MAX_ITEMS = 2000;
const KINDS = new Set(['material', 'assistant', 'chat']);

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const fail = (res, status, error) => res.status(status).json({ error });

async function derive(password, salt) {
  return (await scryptAsync(password.normalize('NFKC'), salt, 64)).toString('hex');
}
async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: await derive(password, salt) };
}
async function verifyPassword(password, salt, hash) {
  const a = Buffer.from(await derive(password, salt), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
const DUMMY = { salt: 'a'.repeat(32), hash: 'b'.repeat(128) };

function limiter(max) {
  const hits = new Map();
  setInterval(() => hits.clear(), 60_000).unref();
  return (req, res, next) => {
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
    if (n > max) return fail(res, 429, 'Сұраныс тым көп. Бір минуттан кейін қайталаңыз.');
    next();
  };
}

function readCookie(req, name) {
  for (const part of (req.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Cross-site POST/PUT/DELETE сұранысын тоқтатады (Origin хосты сайттың хостымен сәйкес болуы керек). */
export function originCheck(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { /* қате Origin */ }
    if (host !== req.get('host')) return fail(res, 403, 'Рұқсат етілмеген сұраныс көзі.');
  }
  next();
}

export function attachUser(store) {
  return (req, _res, next) => {
    const token = readCookie(req, 'sid');
    req.user = token ? store.userBySession(sha256(token)) ?? null : null;
    req.sessionToken = token;
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return fail(res, 401, 'Алдымен жүйеге кіріңіз.');
  next();
}

const publicUser = (u) => ({ id: u.id, login: u.login, name: u.name, subject: u.subject, school: u.school });

function validLibraryItem(it) {
  return it && typeof it.id === 'string' && it.id.length <= 64 && KINDS.has(it.kind)
    && typeof it.title === 'string' && typeof it.content === 'string' && it.content.length <= 400_000
    && Number.isFinite(it.createdAt) && Number.isFinite(it.updatedAt);
}

function validChat(c) {
  return c && typeof c.id === 'string' && c.id.length <= 64 && typeof c.title === 'string' && Array.isArray(c.messages)
    && c.messages.length <= 400
    && c.messages.every((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length <= 100_000)
    && Number.isFinite(c.updatedAt);
}

export function registerRoutes(app, store) {
  setInterval(() => store.purgeSessions(), 3_600_000).unref();
  store.purgeSessions();
  const authLimit = limiter(12);

  function startSession(req, res, userId) {
    const token = randomBytes(32).toString('base64url');
    store.createSession(sha256(token), userId, Date.now() + SESSION_DAYS * 86_400_000);
    const secure = req.secure || process.env.COOKIE_SECURE === '1';
    res.append('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
  }

  app.post('/api/auth/register', authLimit, async (req, res) => {
    if (process.env.ALLOW_REGISTRATION === '0') return fail(res, 403, 'Тіркелу өшірілген. Әкімшіге хабарласыңыз.');
    const code = process.env.REGISTRATION_CODE;
    if (code && req.body?.code !== code) return fail(res, 403, 'Тіркелу коды дұрыс емес.');

    const login = str(req.body?.login, 40);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!LOGIN_RE.test(login)) return fail(res, 400, 'Логин 3–40 таңба: әріп, сан, нүкте, сызықша немесе @.');
    if (password.length < 8 || password.length > 200) return fail(res, 400, 'Құпиясөз кемінде 8 таңба болуы керек.');
    if (store.userByLogin(login)) return fail(res, 409, 'Бұл логин бос емес.');

    const user = { id: randomUUID(), login, name: str(req.body?.name, 80), subject: str(req.body?.subject, 80), school: str(req.body?.school, 80), ...(await hashPassword(password)) };
    try {
      store.createUser(user);
    } catch {
      return fail(res, 409, 'Бұл логин бос емес.');
    }
    startSession(req, res, user.id);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/login', authLimit, async (req, res) => {
    const login = str(req.body?.login, 40);
    const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : '';
    const row = login ? store.userByLogin(login) : null;
    const ok = await verifyPassword(password, row?.salt ?? DUMMY.salt, row?.hash ?? DUMMY.hash);
    if (!row || !ok) return fail(res, 401, 'Логин немесе құпиясөз дұрыс емес.');
    startSession(req, res, row.id);
    res.json({ user: publicUser(row) });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.sessionToken) store.deleteSession(sha256(req.sessionToken));
    res.append('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  // Сессия + барлық деректер бір сұраныспен
  app.get('/api/me', (req, res) => {
    if (!req.user) return res.json({ user: null, registration: { open: process.env.ALLOW_REGISTRATION !== '0', needsCode: Boolean(process.env.REGISTRATION_CODE) } });
    res.json({ user: publicUser(req.user), library: store.library(req.user.id), chats: store.chats(req.user.id) });
  });

  app.put('/api/me/profile', requireAuth, (req, res) => {
    const p = { name: str(req.body?.name, 80), subject: str(req.body?.subject, 80), school: str(req.body?.school, 80) };
    store.updateProfile(req.user.id, p);
    res.json({ user: { ...publicUser(req.user), ...p } });
  });

  app.delete('/api/me/data', requireAuth, (req, res) => {
    store.clearData(req.user.id);
    res.json({ ok: true });
  });

  app.put('/api/library/:id', requireAuth, (req, res) => {
    const it = req.body;
    if (!validLibraryItem(it) || it.id !== req.params.id) return fail(res, 400, 'Құжат форматы дұрыс емес.');
    if (store.libraryCount(req.user.id) >= MAX_ITEMS) return fail(res, 413, 'Кітапхана толды.');
    store.upsertLibrary(req.user.id, { ...it, title: it.title.slice(0, 300), type: typeof it.type === 'string' ? it.type.slice(0, 40) : '' });
    res.json({ ok: true });
  });
  app.delete('/api/library/:id', requireAuth, (req, res) => {
    store.deleteLibrary(req.user.id, req.params.id);
    res.json({ ok: true });
  });

  app.put('/api/chats/:id', requireAuth, (req, res) => {
    const c = req.body;
    if (!validChat(c) || c.id !== req.params.id) return fail(res, 400, 'Чат форматы дұрыс емес.');
    if (store.chatCount(req.user.id) >= MAX_ITEMS) return fail(res, 413, 'Чат тарихы толды.');
    store.upsertChat(req.user.id, { ...c, title: c.title.slice(0, 100) });
    res.json({ ok: true });
  });
  app.delete('/api/chats/:id', requireAuth, (req, res) => {
    store.deleteChat(req.user.id, req.params.id);
    res.json({ ok: true });
  });
}

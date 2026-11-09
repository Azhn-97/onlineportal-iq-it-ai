import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/** SQLite базасы: мұғалімдер, сессиялар, кітапхана, чаттар. */
export function createStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      login TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      school TEXT NOT NULL DEFAULT '',
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS library (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      messages TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    );
  `);

  const q = {
    userByLogin: db.prepare('SELECT * FROM users WHERE login = ?'),
    insertUser: db.prepare('INSERT INTO users (id, login, name, subject, school, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    updateProfile: db.prepare('UPDATE users SET name = ?, subject = ?, school = ? WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'),
    sessionUser: db.prepare('SELECT u.id, u.login, u.name, u.subject, u.school FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    libList: db.prepare('SELECT * FROM library WHERE user_id = ? ORDER BY updated_at DESC'),
    libCount: db.prepare('SELECT COUNT(*) AS n FROM library WHERE user_id = ?'),
    libUpsert: db.prepare(`INSERT INTO library (id, user_id, kind, type, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, id) DO UPDATE SET kind = excluded.kind, type = excluded.type, title = excluded.title, content = excluded.content, updated_at = excluded.updated_at`),
    libDelete: db.prepare('DELETE FROM library WHERE user_id = ? AND id = ?'),
    libClear: db.prepare('DELETE FROM library WHERE user_id = ?'),
    chatList: db.prepare('SELECT * FROM chats WHERE user_id = ? ORDER BY updated_at DESC'),
    chatCount: db.prepare('SELECT COUNT(*) AS n FROM chats WHERE user_id = ?'),
    chatUpsert: db.prepare(`INSERT INTO chats (id, user_id, title, messages, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, id) DO UPDATE SET title = excluded.title, messages = excluded.messages, updated_at = excluded.updated_at`),
    chatDelete: db.prepare('DELETE FROM chats WHERE user_id = ? AND id = ?'),
    chatClear: db.prepare('DELETE FROM chats WHERE user_id = ?'),
  };

  const libRow = (r) => ({ id: r.id, kind: r.kind, type: r.type, title: r.title, content: r.content, createdAt: r.created_at, updatedAt: r.updated_at });
  const chatRow = (r) => ({ id: r.id, title: r.title, messages: JSON.parse(r.messages), updatedAt: r.updated_at });

  return {
    userByLogin: (login) => q.userByLogin.get(login),
    createUser: (u) => q.insertUser.run(u.id, u.login, u.name, u.subject, u.school, u.salt, u.hash, Date.now()),
    updateProfile: (id, p) => q.updateProfile.run(p.name, p.subject, p.school, id),

    createSession: (tokenHash, userId, expiresAt) => q.insertSession.run(tokenHash, userId, expiresAt),
    userBySession: (tokenHash) => q.sessionUser.get(tokenHash, Date.now()),
    deleteSession: (tokenHash) => q.deleteSession.run(tokenHash),
    purgeSessions: () => q.purgeSessions.run(Date.now()),

    library: (userId) => q.libList.all(userId).map(libRow),
    libraryCount: (userId) => q.libCount.get(userId).n,
    upsertLibrary: (userId, it) => q.libUpsert.run(it.id, userId, it.kind, it.type, it.title, it.content, it.createdAt, it.updatedAt),
    deleteLibrary: (userId, id) => q.libDelete.run(userId, id),

    chats: (userId) => q.chatList.all(userId).map(chatRow),
    chatCount: (userId) => q.chatCount.get(userId).n,
    upsertChat: (userId, c) => q.chatUpsert.run(c.id, userId, c.title, JSON.stringify(c.messages), c.updatedAt),
    deleteChat: (userId, id) => q.chatDelete.run(userId, id),

    clearData(userId) { q.libClear.run(userId); q.chatClear.run(userId); },
  };
}

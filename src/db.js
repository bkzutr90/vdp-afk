const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const cfg = require('./config');

fs.mkdirSync(cfg.dataDir, { recursive: true });
const db = new Database(path.join(cfg.dataDir, 'bot.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS levels (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    xp       INTEGER NOT NULL DEFAULT 0,
    level    INTEGER NOT NULL DEFAULT 0,
    messages INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_levels_xp ON levels (guild_id, xp DESC);

  CREATE TABLE IF NOT EXISTS backgrounds (
    user_id    TEXT PRIMARY KEY,
    image      BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS afk_channels (
    guild_id   TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL
  );
`);

module.exports = { db };

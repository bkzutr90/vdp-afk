const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const cfg = require('./config');

fs.mkdirSync(cfg.dataDir, { recursive: true });
const dbPath = path.join(cfg.dataDir, 'bot.db');
const isNewDb = !fs.existsSync(dbPath);
const db = new Database(dbPath);
console.log(`[db] ${dbPath} (${isNewDb ? 'database BARU' : 'database lama dipakai'})`);
if (isNewDb && process.env.RAILWAY_ENVIRONMENT && !process.env.DATA_DIR) {
  console.warn('[db] PERINGATAN: DATA_DIR belum diisi di Railway. Data (level, background, channel AFK) akan hilang tiap redeploy. Pasang Volume di /data dan set DATA_DIR=/data.');
}
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

  CREATE TABLE IF NOT EXISTS tempvoice_settings (
    guild_id           TEXT PRIMARY KEY,
    trigger_channel_id TEXT NOT NULL,
    category_id        TEXT
  );

  CREATE TABLE IF NOT EXISTS tempvoice_channels (
    channel_id TEXT PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    owner_id   TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS afk_channels (
    guild_id   TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL
  );
`);

// Migrasi: kolom panel pusat untuk voice sementara (aman dijalankan berulang)
for (const col of ['panel_channel_id TEXT', 'panel_message_id TEXT']) {
  try {
    db.exec(`ALTER TABLE tempvoice_settings ADD COLUMN ${col}`);
  } catch {
    // kolom sudah ada
  }
}

module.exports = { db };

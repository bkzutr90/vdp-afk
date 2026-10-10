const { db } = require('./db');

// XP yang dibutuhkan untuk naik dari level L ke L+1 (rumus ala MEE6)
const xpForLevel = (l) => 5 * l * l + 50 * l + 100;

// Dari total XP -> level, XP di level itu, dan XP yang dibutuhkan untuk level berikutnya
function levelFromXp(total) {
  let level = 0;
  let remaining = total;
  while (remaining >= xpForLevel(level)) {
    remaining -= xpForLevel(level);
    level++;
  }
  return { level, current: remaining, needed: xpForLevel(level) };
}

const selUser = db.prepare('SELECT xp, level, messages FROM levels WHERE guild_id=? AND user_id=?');
const upsert = db.prepare(`
  INSERT INTO levels (guild_id, user_id, xp, level, messages) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(guild_id, user_id) DO UPDATE SET
    xp = excluded.xp,
    level = excluded.level,
    messages = levels.messages + excluded.messages
`);
const selRank = db.prepare('SELECT COUNT(*) + 1 AS r FROM levels WHERE guild_id=? AND xp>?');
const selTop = db.prepare('SELECT user_id, xp, level FROM levels WHERE guild_id=? ORDER BY xp DESC, user_id LIMIT ? OFFSET ?');
const selCount = db.prepare('SELECT COUNT(*) AS c FROM levels WHERE guild_id=?');

function addXp(guildId, userId, amount, isMessage = true) {
  const row = selUser.get(guildId, userId) || { xp: 0, level: 0 };
  const xp = row.xp + amount;
  const { level } = levelFromXp(xp);
  upsert.run(guildId, userId, xp, level, isMessage ? 1 : 0);
  return { xp, level, leveledUp: level > row.level };
}

const getUser = (guildId, userId) => selUser.get(guildId, userId) || { xp: 0, level: 0, messages: 0 };
const rankOf = (guildId, xp) => selRank.get(guildId, xp).r;
const top = (guildId, limit, offset) => selTop.all(guildId, limit, offset);
const count = (guildId) => selCount.get(guildId).c;

module.exports = { xpForLevel, levelFromXp, addXp, getUser, rankOf, top, count };

const cfg = require('./config');

// Kirim pesan naik level. Tujuan: LEVELUP_CHANNEL_ID kalau diisi, kalau tidak ke channel cadangan
// (channel tempat user chat, atau chat bawaan voice channel untuk XP voice).
function announceLevelUp(guild, userId, level, fallbackChannelId) {
  if (!cfg.levelUpMessages) return;
  const ch =
    (cfg.levelUpChannelId && guild.channels.cache.get(cfg.levelUpChannelId)) ||
    (fallbackChannelId && guild.channels.cache.get(fallbackChannelId));
  if (!ch?.isTextBased()) return;
  ch.send({ content: `🎉 <@${userId}> naik ke **level ${level}**!`, allowedMentions: { users: [userId] } }).catch((err) =>
    console.warn('[levelup] gagal kirim pesan:', err.message)
  );
}

module.exports = { announceLevelUp };

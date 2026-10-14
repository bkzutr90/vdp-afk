const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const cfg = require('./config');
const { db } = require('./db');

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_PING = { parse: [] };

db.exec(`
  CREATE TABLE IF NOT EXISTS invite_joins (
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    inviter_id TEXT,
    code       TEXT,
    source     TEXT NOT NULL,            -- invite | vanity | unknown
    joined_at  INTEGER NOT NULL,
    left_at    INTEGER,
    fake       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_invite_joins_inviter ON invite_joins (guild_id, inviter_id);
`);

// ---------------------------------------------------------------- cache invite
// guildId -> Map(code -> { uses, maxUses, inviterId, deletedAt? })
const cache = new Map();

const toEntry = (inv) => ({ uses: inv.uses ?? 0, maxUses: inv.maxUses ?? 0, inviterId: inv.inviter?.id || null });

async function snapshot(guild) {
  try {
    const list = await guild.invites.fetch();
    cache.set(guild.id, new Map(list.map((inv) => [inv.code, toEntry(inv)])));
  } catch (err) {
    console.warn(`[invite] gagal ambil invite ${guild.name}: ${err.message} (butuh izin Manage Server)`);
    cache.set(guild.id, new Map());
  }
}

/** Bandingkan invite sekarang dengan cache untuk mencari invite yang dipakai. */
async function detectInvite(guild) {
  const before = cache.get(guild.id) || new Map();
  let list;
  try {
    list = await guild.invites.fetch();
  } catch {
    return { source: 'unknown', code: null, inviterId: null };
  }
  const after = new Map(list.map((inv) => [inv.code, toEntry(inv)]));
  cache.set(guild.id, after);

  // 1) invite yang jumlah pemakaiannya bertambah
  for (const [code, a] of after) {
    const prev = before.get(code)?.uses ?? 0;
    if (a.uses > prev) return { source: 'invite', code, inviterId: a.inviterId };
  }

  // 2) invite sekali pakai / mencapai batas pakai langsung terhapus oleh Discord
  const now = Date.now();
  for (const [code, b] of before) {
    if (after.has(code) || b.maxUses <= 0 || b.uses + 1 < b.maxUses) continue;
    if (b.deletedAt && now - b.deletedAt > 10_000) continue; // dihapus manual sebelumnya, bukan karena dipakai
    return { source: 'invite', code, inviterId: b.inviterId };
  }

  // 3) vanity URL
  if (guild.vanityURLCode) return { source: 'vanity', code: guild.vanityURLCode, inviterId: null };

  return { source: 'unknown', code: null, inviterId: null };
}

// ---------------------------------------------------------------- antrian per server (join bersamaan tidak saling menimpa)
const queues = new Map();
function enqueue(guildId, fn) {
  const p = (queues.get(guildId) || Promise.resolve()).then(fn).catch((err) => console.error('[invite] error:', err));
  queues.set(guildId, p);
  return p;
}

// ---------------------------------------------------------------- statistik
function statsOf(guildId, userId) {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN fake = 1 THEN 1 ELSE 0 END) AS fake,
              SUM(CASE WHEN fake = 0 AND left_at IS NOT NULL THEN 1 ELSE 0 END) AS left
         FROM invite_joins WHERE guild_id = ? AND inviter_id = ?`
    )
    .get(guildId, userId);
  const total = r.total || 0;
  const fake = r.fake || 0;
  const left = r.left || 0;
  return { total, fake, left, active: total - fake - left };
}

function topInviters(guildId, limit = 10) {
  const rows = db
    .prepare(
      `SELECT inviter_id,
              COUNT(*) AS total,
              SUM(CASE WHEN fake = 1 THEN 1 ELSE 0 END) AS fake,
              SUM(CASE WHEN fake = 0 AND left_at IS NOT NULL THEN 1 ELSE 0 END) AS left
         FROM invite_joins WHERE guild_id = ? AND inviter_id IS NOT NULL GROUP BY inviter_id`
    )
    .all(guildId);
  return rows
    .map((r) => ({ id: r.inviter_id, total: r.total, fake: r.fake || 0, left: r.left || 0, active: r.total - (r.fake || 0) - (r.left || 0) }))
    .sort((a, b) => b.active - a.active || b.total - a.total)
    .slice(0, limit);
}

const joinRow = (guildId, userId) => db.prepare('SELECT * FROM invite_joins WHERE guild_id=? AND user_id=?').get(guildId, userId);

// ---------------------------------------------------------------- log ke channel
async function sendLog(client, payload) {
  if (!cfg.inviteChannelId) return;
  const channel = await client.channels.fetch(cfg.inviteChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  await channel.send({ ...payload, allowedMentions: NO_PING }).catch((err) => console.warn('[invite] gagal kirim log:', err.message));
}

function describeSource(d) {
  if (d.source === 'vanity') return `vanity URL (\`${d.code}\`)`;
  if (d.source === 'invite') return d.inviterId ? `<@${d.inviterId}> (\`${d.code}\`)` : `invite \`${d.code}\``;
  return 'tidak diketahui';
}

// ---------------------------------------------------------------- event
function startInviteTracker(client) {
  // Isi cache awal
  for (const guild of client.guilds.cache.values()) snapshot(guild);

  client.on('guildCreate', (guild) => snapshot(guild));
  client.on('guildDelete', (guild) => cache.delete(guild.id));

  client.on('inviteCreate', (inv) => {
    if (!inv.guild) return;
    const map = cache.get(inv.guild.id) || new Map();
    map.set(inv.code, toEntry(inv));
    cache.set(inv.guild.id, map);
  });

  // Jangan dihapus langsung: invite sekali pakai terhapus tepat saat dipakai, dan masih dibutuhkan untuk deteksi.
  client.on('inviteDelete', (inv) => {
    const entry = cache.get(inv.guild?.id)?.get(inv.code);
    if (entry) entry.deletedAt = Date.now();
  });

  client.on('guildMemberAdd', (member) => {
    if (member.user.bot) return;
    enqueue(member.guild.id, async () => {
      const d = await detectInvite(member.guild);
      const accountDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
      const fake = accountDays < cfg.inviteFakeDays || d.inviterId === member.id ? 1 : 0;

      db.prepare(
        `INSERT OR REPLACE INTO invite_joins (guild_id, user_id, inviter_id, code, source, joined_at, left_at, fake)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
      ).run(member.guild.id, member.id, d.inviterId, d.code, d.source, Date.now(), fake);

      // Dihitung setelah insert, jadi join ini sudah ikut terhitung (1, lalu 2, 3, 4, ...)
      const total = d.inviterId ? statsOf(member.guild.id, d.inviterId).total : null;

      const embed = new EmbedBuilder()
        .setColor(fake ? 0xe67e22 : 0x2ecc71)
        .setTitle('📥 Member Baru')
        .setThumbnail(member.displayAvatarURL({ extension: 'png', size: 128 }))
        .setDescription(`${member} bergabung.` + (fake ? '\n⚠️ Ditandai **fake** (akun terlalu baru / mengundang diri sendiri).' : ''))
        .addFields(
          { name: 'Diundang oleh', value: describeSource(d), inline: true },
          { name: 'Total', value: total !== null ? `**${total}**` : '-', inline: true }
        )
        .setTimestamp();
      await sendLog(client, { embeds: [embed] });
    });
  });

  client.on('guildMemberRemove', (member) => {
    if (member.user?.bot) return;
    enqueue(member.guild.id, async () => {
      db.prepare('UPDATE invite_joins SET left_at=? WHERE guild_id=? AND user_id=?').run(Date.now(), member.guild.id, member.id);
      const row = joinRow(member.guild.id, member.id);
      const by = row?.inviter_id ? `<@${row.inviter_id}>` : row?.source === 'vanity' ? 'vanity URL' : 'tidak diketahui';

      const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('📤 Member Keluar')
        .setDescription(`<@${member.id}> (${member.user?.tag || member.id}) keluar.\nSebelumnya diundang oleh: ${by}`)
        .setTimestamp();
      await sendLog(client, { embeds: [embed] });
    });
  });
}
// ---------------------------------------------------------------- /invites
const command = {
  data: new SlashCommandBuilder()
    .setName('invites')
    .setDescription('Statistik undangan member')
    .addSubcommand((s) =>
      s
        .setName('check')
        .setDescription('Lihat jumlah undangan seseorang (kosong = kamu)')
        .addUserOption((o) => o.setName('user').setDescription('User yang ingin dilihat'))
    )
    .addSubcommand((s) => s.setName('top').setDescription('Leaderboard pengundang terbanyak')),
  async execute(i) {
    const sub = i.options.getSubcommand();

    if (sub === 'check') {
      const target = i.options.getUser('user') || i.user;
      const s = statsOf(i.guildId, target.id);
      const row = joinRow(i.guildId, target.id);
      const invitedBy = row?.inviter_id ? `<@${row.inviter_id}>` : row?.source === 'vanity' ? 'vanity URL' : row ? 'tidak diketahui' : 'belum tercatat';

      const embed = new EmbedBuilder()
        .setColor(cfg.accent)
        .setTitle(`📨 Undangan ${target.globalName || target.username}`)
        .setThumbnail(target.displayAvatarURL({ extension: 'png', size: 128 }))
        .addFields(
          { name: 'Aktif', value: String(s.active), inline: true },
          { name: 'Total', value: String(s.total), inline: true },
          { name: 'Keluar', value: String(s.left), inline: true },
          { name: 'Fake', value: String(s.fake), inline: true },
          { name: 'Diundang oleh', value: invitedBy, inline: true }
        );
      return i.reply({ embeds: [embed], allowedMentions: NO_PING });
    }

    const rows = topInviters(i.guildId);
    const medal = ['🥇', '🥈', '🥉'];
    const lines = rows.map((r, idx) => `${medal[idx] || `**${idx + 1}.**`} <@${r.id}> — **${r.active}** aktif • ${r.total} total • ${r.left} keluar • ${r.fake} fake`);
    const embed = new EmbedBuilder()
      .setColor(cfg.accent)
      .setTitle('🏆 Leaderboard Undangan')
      .setDescription(lines.join('\n') || '_Belum ada data undangan._');
    return i.reply({ embeds: [embed], allowedMentions: NO_PING });
  },
};

module.exports = { command, startInviteTracker };

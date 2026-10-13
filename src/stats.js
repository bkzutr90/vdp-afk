const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const cfg = require('./config');
const { db } = require('./db');

const EPHEMERAL = MessageFlags.Ephemeral;

const CATEGORY_NAME = '-------| SERVER STATS |-------';
const UPDATE_MS = 10 * 60_000; // Discord membatasi rename channel: 2x / 10 menit per channel

db.exec(`
  CREATE TABLE IF NOT EXISTS stats_channels (
    guild_id    TEXT PRIMARY KEY,
    category_id TEXT NOT NULL,
    all_id      TEXT NOT NULL,
    members_id  TEXT NOT NULL,
    bots_id     TEXT NOT NULL
  );
`);

const getRow = (guildId) => db.prepare('SELECT * FROM stats_channels WHERE guild_id=?').get(guildId);
const allRows = () => db.prepare('SELECT * FROM stats_channels').all();
const delRow = (guildId) => db.prepare('DELETE FROM stats_channels WHERE guild_id=?').run(guildId);

// ---------------------------------------------------------------- hitung
async function countStats(guild) {
  const total = guild.memberCount;
  let bots;

  if (cfg.statsUseMembersIntent) {
    // Akurat, tapi butuh "Server Members Intent" aktif di Developer Portal + GatewayIntentBits.GuildMembers
    try {
      const members = await guild.members.fetch();
      bots = members.filter((m) => m.user.bot).size;
    } catch (err) {
      console.warn('[stats] fetch members gagal, pakai hitungan role bot:', err.message);
    }
  }
  if (bots === undefined) {
    // Tanpa intent privileged: tiap bot yang di-invite punya role "managed" miliknya sendiri
    await guild.roles.fetch().catch(() => {});
    bots = guild.roles.cache.filter((r) => r.managed && r.tags?.botId).size;
  }

  bots = Math.min(bots, total);
  return { all: total, members: Math.max(total - bots, 0), bots };
}

const names = (s) => ({
  all: `All Members: ${s.all}`,
  members: `Members: ${s.members}`,
  bots: `Bots: ${s.bots}`,
});

// ---------------------------------------------------------------- update
async function updateGuild(client, row) {
  const guild = client.guilds.cache.get(row.guild_id);
  if (!guild) return false;

  const wanted = names(await countStats(guild));
  const targets = { all: row.all_id, members: row.members_id, bots: row.bots_id };
  let missing = 0;

  for (const [key, id] of Object.entries(targets)) {
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (!ch) {
      missing++;
      continue;
    }
    if (ch.name !== wanted[key]) {
      await ch.setName(wanted[key], 'Update server stats').catch((err) => console.warn('[stats] rename gagal:', err.message));
    }
  }
  if (missing === 3) delRow(guild.id); // semua channel sudah dihapus manual
  return true;
}

async function runStatsUpdate(client) {
  for (const row of allRows()) {
    try {
      await updateGuild(client, row);
    } catch (err) {
      console.warn('[stats] update gagal:', err.message);
    }
  }
}

function startStats(client) {
  const tick = () => runStatsUpdate(client).catch((err) => console.error('[stats] error:', err));
  tick();
  setInterval(tick, UPDATE_MS).unref();
}

// ---------------------------------------------------------------- setup / remove
async function createStats(guild) {
  const me = await guild.members.fetchMe();
  const botTarget = me.roles.botRole || me;
  const R = { reason: 'Server stats setup' };

  const s = await countStats(guild);
  const n = names(s);

  // @everyone boleh lihat tapi tidak boleh join (ikon gembok); bot tetap punya akses penuh
  const overwrites = [
    { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] },
    {
      id: botTarget.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels],
    },
  ];

  const category = await guild.channels.create({
    name: CATEGORY_NAME,
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites,
    position: 0, // paling atas
    reason: R.reason,
  });

  const make = (name) =>
    guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: overwrites,
      reason: R.reason,
    });

  const all = await make(n.all);
  const members = await make(n.members);
  const bots = await make(n.bots);

  db.prepare(
    `INSERT INTO stats_channels (guild_id, category_id, all_id, members_id, bots_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET category_id=excluded.category_id, all_id=excluded.all_id, members_id=excluded.members_id, bots_id=excluded.bots_id`
  ).run(guild.id, category.id, all.id, members.id, bots.id);

  return { category, s };
}

async function removeStats(guild) {
  const row = getRow(guild.id);
  if (!row) return false;
  for (const id of [row.all_id, row.members_id, row.bots_id, row.category_id]) {
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (ch) await ch.delete('Server stats removed').catch(() => {});
  }
  delRow(guild.id);
  return true;
}

// ---------------------------------------------------------------- /serverstats
const command = {
  data: new SlashCommandBuilder()
    .setName('serverstats')
    .setDescription('Atur statistik member server (voice channel terkunci)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('setup').setDescription('Buat kategori SERVER STATS (All Members, Members, Bots)'))
    .addSubcommand((s) => s.setName('update').setDescription('Perbarui angka sekarang'))
    .addSubcommand((s) => s.setName('remove').setDescription('Hapus kategori dan channel statistik')),
  async execute(i) {
    const sub = i.options.getSubcommand();
    await i.deferReply({ flags: EPHEMERAL });

    if (sub === 'setup') {
      if (getRow(i.guildId)) {
        return i.editReply('ℹ️ Server stats sudah ada. Pakai `/serverstats update` untuk memperbarui, atau `/serverstats remove` lalu setup ulang.');
      }
      try {
        const { s } = await createStats(i.guild);
        return i.editReply(`✅ Server stats dibuat.\nAll Members: **${s.all}** • Members: **${s.members}** • Bots: **${s.bots}**\nAngka diperbarui otomatis tiap 10 menit.`);
      } catch (err) {
        console.error('[stats] setup gagal:', err);
        return i.editReply(`❌ Gagal membuat channel: \`${String(err.message).slice(0, 200)}\`\nPastikan bot punya izin **Manage Channels**.`);
      }
    }

    if (sub === 'update') {
      const row = getRow(i.guildId);
      if (!row) return i.editReply('Belum ada server stats. Pakai `/serverstats setup`.');
      await updateGuild(i.client, row);
      return i.editReply('✅ Diperbarui. (Discord membatasi rename channel, jadi perubahan bisa tertunda beberapa menit kalau baru saja diganti.)');
    }

    const ok = await removeStats(i.guild);
    return i.editReply(ok ? '🗑️ Server stats dihapus.' : 'Belum ada server stats.');
  },
};

module.exports = { command, startStats };

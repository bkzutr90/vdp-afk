// Voice sementara (join-to-create): member masuk ke channel pemicu -> bot membuat voice pribadi dan memindahkan member ke sana.
// Channel dihapus otomatis saat kosong. Pemilik bisa mengatur nama, limit, kunci, dan izin lewat /tempvoice.
const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db } = require('./db');
const cfg = require('./config');

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_PING = { parse: [] };
const OWNER_PERMS = { ViewChannel: true, Connect: true, Speak: true, ManageChannels: true, MoveMembers: true };
const CREATE_COOLDOWN_MS = 5_000;
const RENAME_LIMIT = 2; // batas Discord: 2x ganti nama per 10 menit per channel
const RENAME_WINDOW_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 5 * 60_000;
const MIN_AGE_BEFORE_SWEEP_MS = 30_000;

// ------------------------------------------------------------------ database
const getSettings = (g) => db.prepare('SELECT trigger_channel_id, category_id FROM tempvoice_settings WHERE guild_id=?').get(g);
const setSettings = (g, trigger, category) =>
  db
    .prepare(
      'INSERT INTO tempvoice_settings (guild_id, trigger_channel_id, category_id) VALUES (?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET trigger_channel_id=excluded.trigger_channel_id, category_id=excluded.category_id'
    )
    .run(g, trigger, category);
const delSettings = (g) => db.prepare('DELETE FROM tempvoice_settings WHERE guild_id=?').run(g);

const getTemp = (ch) => db.prepare('SELECT channel_id, guild_id, owner_id, created_at FROM tempvoice_channels WHERE channel_id=?').get(ch);
const getTempByOwner = (g, u) => db.prepare('SELECT channel_id FROM tempvoice_channels WHERE guild_id=? AND owner_id=?').get(g, u);
const addTemp = (ch, g, owner) => db.prepare('INSERT OR REPLACE INTO tempvoice_channels (channel_id, guild_id, owner_id, created_at) VALUES (?, ?, ?, ?)').run(ch, g, owner, Date.now());
const setOwner = (ch, owner) => db.prepare('UPDATE tempvoice_channels SET owner_id=? WHERE channel_id=?').run(owner, ch);
const delTemp = (ch) => db.prepare('DELETE FROM tempvoice_channels WHERE channel_id=?').run(ch);
const listTemp = () => db.prepare('SELECT channel_id, guild_id, created_at FROM tempvoice_channels').all();

// ------------------------------------------------------------------ util
// Orang (bukan bot) yang sedang ada di sebuah voice channel. Member yang datanya belum ter-cache dianggap manusia (aman: channel tidak terhapus salah).
const humansIn = (guild, channelId) =>
  [...guild.voiceStates.cache.values()].filter((s) => s.channelId === channelId && !s.member?.user?.bot);

const creating = new Set();
const lastCreate = new Map();
const renameLog = new Map(); // channelId -> [timestamp]

async function deleteIfEmpty(guild, channelId, { force = false } = {}) {
  const row = getTemp(channelId);
  if (!row) return;
  const ch = guild.channels.cache.get(channelId);
  if (!ch) return delTemp(channelId);
  if (!force && humansIn(guild, channelId).length > 0) return;
  delTemp(channelId);
  await ch.delete('Voice sementara kosong').catch((err) => console.warn('[tempvoice] gagal hapus channel:', err.message));
}

async function transferOwner(ch, oldOwnerId, newMember, announce) {
  setOwner(ch.id, newMember.id);
  await ch.permissionOverwrites.edit(newMember.id, OWNER_PERMS).catch(() => {});
  await ch.permissionOverwrites.delete(oldOwnerId).catch(() => {});
  if (announce) {
    ch.send({ content: `👑 ${newMember} sekarang menjadi pemilik channel ini.`, allowedMentions: { users: [newMember.id] } }).catch(() => {});
  }
}

// ------------------------------------------------------------------ event: join / leave
async function handleJoinTrigger(member) {
  const guild = member.guild;
  const settings = getSettings(guild.id);
  if (!settings) return;
  if (creating.has(member.id) || Date.now() - (lastCreate.get(member.id) || 0) < CREATE_COOLDOWN_MS) return;

  creating.add(member.id);
  lastCreate.set(member.id, Date.now());
  try {
    // Sudah punya voice sementara -> pindahkan ke sana, jangan buat baru
    const existing = getTempByOwner(guild.id, member.id);
    if (existing) {
      const old = guild.channels.cache.get(existing.channel_id);
      if (old) {
        await member.voice.setChannel(old).catch(() => {});
        return;
      }
      delTemp(existing.channel_id);
    }

    const trigger = guild.channels.cache.get(settings.trigger_channel_id);
    const parentId = settings.category_id || trigger?.parentId || null;
    const name = (cfg.tempVoiceName.replace('{user}', member.displayName).trim() || `Voice ${member.displayName}`).slice(0, 100);

    const ch = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: parentId,
      userLimit: trigger?.userLimit || 0,
      reason: `Voice sementara untuk ${member.user.tag}`,
    });
    addTemp(ch.id, guild.id, member.id);
    await ch.permissionOverwrites.edit(member.id, OWNER_PERMS).catch((err) => console.warn('[tempvoice] gagal set izin pemilik:', err.message));

    try {
      await member.voice.setChannel(ch);
    } catch {
      // Member keburu keluar sebelum dipindah
      await deleteIfEmpty(guild, ch.id, { force: true });
    }
  } catch (err) {
    console.warn('[tempvoice] gagal membuat voice:', err.message);
  } finally {
    creating.delete(member.id);
  }
}

async function handleLeave(guild, channelId, userId) {
  const row = getTemp(channelId);
  if (!row) return;
  const ch = guild.channels.cache.get(channelId);
  if (!ch) return delTemp(channelId);

  const humans = humansIn(guild, channelId);
  if (humans.length === 0) return deleteIfEmpty(guild, channelId, { force: true });

  // Pemilik keluar tapi masih ada orang -> oper kepemilikan
  if (row.owner_id === userId) {
    const next = humans.find((s) => s.member && !s.member.user.bot);
    if (next) await transferOwner(ch, userId, next.member, true);
  }
}

// Hapus voice sementara yang kosong / sudah tidak ada (setelah restart bot, atau sebagai jaring pengaman berkala)
async function sweep(client) {
  for (const row of listTemp()) {
    const guild = client.guilds.cache.get(row.guild_id);
    if (!guild) continue;
    if (Date.now() - row.created_at < MIN_AGE_BEFORE_SWEEP_MS) continue;
    await deleteIfEmpty(guild, row.channel_id);
  }
}

function startTempVoice(client) {
  client.on('voiceStateUpdate', async (oldS, newS) => {
    try {
      if (newS.channelId && newS.channelId !== oldS.channelId) {
        const settings = getSettings(newS.guild.id);
        const member = newS.member;
        if (settings && member && !member.user.bot && newS.channelId === settings.trigger_channel_id) await handleJoinTrigger(member);
      }
      if (oldS.channelId && oldS.channelId !== newS.channelId) await handleLeave(oldS.guild, oldS.channelId, oldS.id);
    } catch (err) {
      console.warn('[tempvoice] error:', err.message);
    }
  });

  client.on('channelDelete', (ch) => {
    if (getTemp(ch.id)) delTemp(ch.id);
    const s = ch.guildId && getSettings(ch.guildId);
    if (s && s.trigger_channel_id === ch.id) delSettings(ch.guildId);
  });

  sweep(client).catch((err) => console.warn('[tempvoice] sweep gagal:', err.message));
  setInterval(() => sweep(client).catch(() => {}), SWEEP_EVERY_MS).unref();
  console.log('[tempvoice] aktif');
}

// ------------------------------------------------------------------ command
function ownedChannel(i) {
  const vc = i.member?.voice?.channel;
  if (!vc) return { error: '❌ Masuk ke voice sementara milikmu dulu.' };
  const row = getTemp(vc.id);
  if (!row) return { error: '❌ Channel voice ini bukan voice sementara.' };
  if (row.owner_id !== i.user.id) return { error: `❌ Hanya pemilik (<@${row.owner_id}>) yang bisa mengatur channel ini.` };
  return { vc, row };
}

const command = {
  data: new SlashCommandBuilder()
    .setName('tempvoice')
    .setDescription('Voice sementara (join-to-create)')
    .addSubcommand((s) =>
      s
        .setName('setup')
        .setDescription('(Admin) Atur channel pemicu voice sementara')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Voice channel pemicu (kosong = bot membuatkan "➕ Buat Voice")').addChannelTypes(ChannelType.GuildVoice)
        )
        .addChannelOption((o) =>
          o.setName('category').setDescription('Kategori tempat voice sementara dibuat (kosong = sama dengan channel pemicu)').addChannelTypes(ChannelType.GuildCategory)
        )
    )
    .addSubcommand((s) => s.setName('disable').setDescription('(Admin) Matikan fitur voice sementara'))
    .addSubcommand((s) =>
      s.setName('name').setDescription('Ganti nama voice sementara kamu').addStringOption((o) => o.setName('nama').setDescription('Nama baru').setRequired(true).setMaxLength(100))
    )
    .addSubcommand((s) =>
      s
        .setName('limit')
        .setDescription('Batasi jumlah orang (0 = tanpa batas)')
        .addIntegerOption((o) => o.setName('jumlah').setDescription('0 - 99').setMinValue(0).setMaxValue(99).setRequired(true))
    )
    .addSubcommand((s) => s.setName('lock').setDescription('Kunci channel: orang lain tidak bisa masuk'))
    .addSubcommand((s) => s.setName('unlock').setDescription('Buka kunci channel'))
    .addSubcommand((s) =>
      s.setName('permit').setDescription('Izinkan seseorang masuk (berguna saat dikunci)').addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
    )
    .addSubcommand((s) =>
      s.setName('transfer').setDescription('Serahkan kepemilikan ke orang di channel ini').addUserOption((o) => o.setName('user').setDescription('Pemilik baru').setRequired(true))
    ),

  async execute(i) {
    const sub = i.options.getSubcommand();

    // ---- admin
    if (sub === 'setup' || sub === 'disable') {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: '❌ Hanya yang punya izin **Manage Server** yang bisa memakai ini.', flags: EPHEMERAL });
      }
      if (sub === 'disable') {
        delSettings(i.guildId);
        return i.reply({ content: '✅ Voice sementara dimatikan. Channel yang sudah ada akan terhapus sendiri saat kosong.', flags: EPHEMERAL });
      }

      const me = i.guild.members.me;
      const missing = ['ManageChannels', 'MoveMembers'].filter((p) => !me.permissions.has(PermissionFlagsBits[p]));
      if (missing.length) return i.reply({ content: `❌ Bot butuh izin: **${missing.join(', ')}**. Beri izin itu ke role bot lalu coba lagi.`, flags: EPHEMERAL });

      await i.deferReply({ flags: EPHEMERAL });
      const category = i.options.getChannel('category');
      let trigger = i.options.getChannel('channel');
      try {
        if (!trigger) {
          trigger = await i.guild.channels.create({
            name: '➕ Buat Voice',
            type: ChannelType.GuildVoice,
            parent: category?.id ?? null,
            reason: 'Channel pemicu voice sementara',
          });
        }
        setSettings(i.guildId, trigger.id, category?.id ?? null);
      } catch (err) {
        return i.editReply(`❌ Gagal mengatur: \`${String(err.message).slice(0, 200)}\``);
      }
      return i.editReply(
        `✅ Aktif! Siapa pun yang masuk ke <#${trigger.id}> akan dibuatkan voice pribadi.\nKategori voice sementara: ${category ? `**${category.name}**` : 'sama dengan channel pemicu'}.`
      );
    }

    // ---- pemilik channel
    const own = ownedChannel(i);
    if (own.error) return i.reply({ content: own.error, flags: EPHEMERAL });
    const { vc } = own;

    if (sub === 'name') {
      const name = i.options.getString('nama', true).trim().slice(0, 100);
      if (!name) return i.reply({ content: '❌ Nama tidak boleh kosong.', flags: EPHEMERAL });
      const now = Date.now();
      const recent = (renameLog.get(vc.id) || []).filter((t) => now - t < RENAME_WINDOW_MS);
      if (recent.length >= RENAME_LIMIT) {
        const wait = Math.ceil((RENAME_WINDOW_MS - (now - recent[0])) / 60_000);
        return i.reply({ content: `⏳ Discord membatasi ganti nama 2x per 10 menit. Coba lagi sekitar ${wait} menit.`, flags: EPHEMERAL });
      }
      await i.deferReply({ flags: EPHEMERAL });
      await vc.setName(name, `Diganti oleh ${i.user.tag}`);
      renameLog.set(vc.id, [...recent, now]);
      return i.editReply(`✅ Nama channel diganti menjadi **${name}**.`);
    }

    if (sub === 'limit') {
      const n = i.options.getInteger('jumlah', true);
      await vc.setUserLimit(n);
      return i.reply({ content: n ? `✅ Batas channel: **${n}** orang.` : '✅ Batas channel dihapus.', flags: EPHEMERAL });
    }

    if (sub === 'lock') {
      await vc.permissionOverwrites.edit(i.guild.id, { Connect: false });
      return i.reply({ content: '🔒 Channel dikunci. Yang sudah di dalam tetap bisa tinggal. Pakai `/tempvoice permit` untuk mengizinkan seseorang masuk.', flags: EPHEMERAL });
    }

    if (sub === 'unlock') {
      await vc.permissionOverwrites.edit(i.guild.id, { Connect: null });
      return i.reply({ content: '🔓 Channel dibuka kembali.', flags: EPHEMERAL });
    }

    if (sub === 'permit') {
      const user = i.options.getUser('user', true);
      await vc.permissionOverwrites.edit(user.id, { ViewChannel: true, Connect: true });
      return i.reply({ content: `✅ ${user} boleh masuk ke channel ini.`, flags: EPHEMERAL, allowedMentions: NO_PING });
    }

    if (sub === 'transfer') {
      const user = i.options.getUser('user', true);
      if (user.bot) return i.reply({ content: '❌ Tidak bisa menyerahkan ke bot.', flags: EPHEMERAL });
      if (user.id === i.user.id) return i.reply({ content: '❌ Kamu sudah jadi pemilik.', flags: EPHEMERAL });
      const target = [...i.guild.voiceStates.cache.values()].find((s) => s.id === user.id && s.channelId === vc.id);
      if (!target) return i.reply({ content: '❌ User itu harus berada di channel ini dulu.', flags: EPHEMERAL });
      const member = target.member || (await i.guild.members.fetch(user.id).catch(() => null));
      if (!member) return i.reply({ content: '❌ Data user tidak ditemukan.', flags: EPHEMERAL });
      await transferOwner(vc, i.user.id, member, false);
      return i.reply({ content: `👑 Kepemilikan diserahkan ke ${member}.`, flags: EPHEMERAL, allowedMentions: NO_PING });
    }
  },
};

module.exports = { command, startTempVoice };

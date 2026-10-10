// Voice sementara (join-to-create): member masuk ke channel pemicu -> bot membuat voice pribadi dan memindahkan member ke sana.
// Channel dihapus otomatis saat kosong. Ada SATU panel tombol pusat di sebuah channel khusus; tombolnya mengatur voice milik
// orang yang menekan. (Command /tempvoice tetap tersedia sebagai alternatif.)
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const { db } = require('./db');
const cfg = require('./config');

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_PING = { parse: [] };
const OWNER_PERMS = { ViewChannel: true, Connect: true, Speak: true, ManageChannels: true, MoveMembers: true };
const TRIGGER_NAME = '➕ Buat Temp Voice';
const PANEL_CHANNEL_NAME = '🎛️-temp-voice';
const CREATE_COOLDOWN_MS = 5_000;
const RENAME_LIMIT = 2; // batas Discord: 2x ganti nama per 10 menit per channel
const RENAME_WINDOW_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 5 * 60_000;
const MIN_AGE_BEFORE_SWEEP_MS = 30_000;

// ------------------------------------------------------------------ database
const getSettings = (g) =>
  db.prepare('SELECT trigger_channel_id, category_id, panel_channel_id, panel_message_id FROM tempvoice_settings WHERE guild_id=?').get(g);
const setSettings = (g, trigger, category) =>
  db
    .prepare(
      'INSERT INTO tempvoice_settings (guild_id, trigger_channel_id, category_id) VALUES (?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET trigger_channel_id=excluded.trigger_channel_id, category_id=excluded.category_id'
    )
    .run(g, trigger, category);
const setPanelInfo = (g, channelId, messageId) => db.prepare('UPDATE tempvoice_settings SET panel_channel_id=?, panel_message_id=? WHERE guild_id=?').run(channelId, messageId, g);
const delSettings = (g) => db.prepare('DELETE FROM tempvoice_settings WHERE guild_id=?').run(g);

const getTemp = (ch) => db.prepare('SELECT channel_id, guild_id, owner_id, created_at FROM tempvoice_channels WHERE channel_id=?').get(ch);
const getTempsByOwner = (g, u) => db.prepare('SELECT channel_id FROM tempvoice_channels WHERE guild_id=? AND owner_id=?').all(g, u);
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

// Voice sementara milik user. Kalau punya lebih dari satu, pilih yang sedang ia tempati.
function ownedByUser(guild, userId) {
  const rows = getTempsByOwner(guild.id, userId);
  const chans = [];
  for (const r of rows) {
    const ch = guild.channels.cache.get(r.channel_id);
    if (ch) chans.push(ch);
    else delTemp(r.channel_id);
  }
  if (!chans.length) return null;
  const currentId = guild.voiceStates.cache.get(userId)?.channelId;
  return chans.find((c) => c.id === currentId) || chans[0];
}

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

// Ganti nama dengan batas Discord (2x / 10 menit). Mengembalikan teks error, atau null kalau berhasil.
async function renameChannel(ch, rawName, tag) {
  const name = rawName.trim().slice(0, 100);
  if (!name) return '❌ Nama tidak boleh kosong.';
  const now = Date.now();
  const recent = (renameLog.get(ch.id) || []).filter((t) => now - t < RENAME_WINDOW_MS);
  if (recent.length >= RENAME_LIMIT) {
    const wait = Math.ceil((RENAME_WINDOW_MS - (now - recent[0])) / 60_000);
    return `⏳ Discord membatasi ganti nama 2x per 10 menit. Coba lagi sekitar ${wait} menit.`;
  }
  await ch.setName(name, `Diganti oleh ${tag}`);
  renameLog.set(ch.id, [...recent, now]);
  return null;
}

// ------------------------------------------------------------------ panel pusat
const panelEmbed = (triggerId) =>
  new EmbedBuilder()
    .setColor(cfg.accent)
    .setTitle('🎛️ Panel Temp Voice')
    .setDescription(`Masuk ke <#${triggerId}> untuk membuat voice pribadi. Setelah punya voice sendiri, atur lewat tombol di bawah.\nTombol ini hanya mengatur **voice milikmu**.`)
    .addFields({
      name: 'Tombol',
      value:
        '🔒 **Kunci** — orang lain tidak bisa masuk\n' +
        '🔓 **Buka** — buka kunci\n' +
        '👥 **Batas Orang** — atur jumlah maksimal\n' +
        '✏️ **Ganti Nama** — ubah nama channel\n' +
        '👑 **Serahkan** — pindahkan kepemilikan\n' +
        'ℹ️ **Info** — lihat status voice kamu',
    });

const panelRows = () => [
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tv:lock').setLabel('Kunci').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('tv:unlock').setLabel('Buka').setEmoji('🔓').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('tv:limit').setLabel('Batas Orang').setEmoji('👥').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tv:rename').setLabel('Ganti Nama').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tv:transfer').setLabel('Serahkan').setEmoji('👑').setStyle(ButtonStyle.Primary)
  ),
  new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('tv:info').setLabel('Info').setEmoji('ℹ️').setStyle(ButtonStyle.Secondary)),
];

async function fetchTextChannel(guild, id) {
  if (!id) return null;
  const ch = guild.channels.cache.get(id) || (await guild.channels.fetch(id).catch(() => null));
  return ch?.isTextBased() ? ch : null;
}

async function deleteOldPanel(guild, settings) {
  if (!settings?.panel_channel_id || !settings.panel_message_id) return;
  const ch = await fetchTextChannel(guild, settings.panel_channel_id);
  const old = ch && (await ch.messages.fetch(settings.panel_message_id).catch(() => null));
  await old?.delete().catch(() => {});
}

// Kirim (atau kirim ulang) panel pusat ke channel panel yang tersimpan
async function sendCentralPanel(guild) {
  const s = getSettings(guild.id);
  if (!s?.panel_channel_id) return { ok: false, error: 'Channel panel belum diatur. Jalankan `/tempvoice setup`.' };
  const ch = await fetchTextChannel(guild, s.panel_channel_id);
  if (!ch) return { ok: false, error: 'Channel panel tidak ditemukan. Jalankan `/tempvoice setup` lagi.' };
  await deleteOldPanel(guild, s);
  const msg = await ch.send({ embeds: [panelEmbed(s.trigger_channel_id)], components: panelRows(), allowedMentions: NO_PING }).catch((err) => {
    console.warn('[tempvoice] gagal kirim panel:', err.message);
    return null;
  });
  if (!msg) return { ok: false, error: `Bot tidak bisa mengirim pesan di <#${ch.id}>. Beri izin **View Channel**, **Send Messages**, dan **Embed Links**.` };
  setPanelInfo(guild.id, ch.id, msg.id);
  return { ok: true, channel: ch };
}

// Saat bot menyala: kalau pesan panel hilang, kirim ulang
async function ensurePanels(client) {
  for (const guild of client.guilds.cache.values()) {
    const s = getSettings(guild.id);
    if (!s?.panel_channel_id) continue;
    const ch = await fetchTextChannel(guild, s.panel_channel_id);
    if (!ch) {
      setPanelInfo(guild.id, null, null);
      continue;
    }
    const msg = s.panel_message_id && (await ch.messages.fetch(s.panel_message_id).catch(() => null));
    if (!msg) await sendCentralPanel(guild);
  }
}

// Interaksi panel: tombol, modal, dan menu pilih. customId: tv:<aksi>
async function handleTempVoiceInteraction(i) {
  const action = i.customId.split(':')[1];
  const guild = i.guild;
  if (!guild) return;

  const ch = ownedByUser(guild, i.user.id);
  if (!ch) {
    const s = getSettings(guild.id);
    const where = s ? `<#${s.trigger_channel_id}>` : 'channel pemicu voice sementara';
    return i.reply({ content: `❌ Kamu belum punya voice sementara. Masuk ke ${where} dulu untuk membuatnya.`, flags: EPHEMERAL });
  }

  // ---- tombol
  if (i.isButton()) {
    if (action === 'lock' || action === 'unlock') {
      await i.deferReply({ flags: EPHEMERAL });
      const lock = action === 'lock';
      await ch.permissionOverwrites.edit(guild.id, { Connect: lock ? false : null });
      return i.editReply(lock ? `🔒 <#${ch.id}> dikunci. Yang sudah di dalam tetap bisa tinggal. Pakai \`/tempvoice permit\` untuk mengizinkan seseorang masuk.` : `🔓 <#${ch.id}> dibuka kembali.`);
    }

    if (action === 'limit') {
      return i.showModal(
        new ModalBuilder()
          .setCustomId('tv:limitm')
          .setTitle('Batas Orang')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('value')
                .setLabel('Jumlah orang (0 = tanpa batas)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMinLength(1)
                .setMaxLength(2)
                .setValue(String(ch.userLimit || 0))
            )
          )
      );
    }

    if (action === 'rename') {
      return i.showModal(
        new ModalBuilder()
          .setCustomId('tv:renamem')
          .setTitle('Ganti Nama Channel')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('value')
                .setLabel('Nama baru')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMinLength(1)
                .setMaxLength(100)
                .setValue(ch.name.slice(0, 100))
            )
          )
      );
    }

    if (action === 'transfer') {
      const options = humansIn(guild, ch.id)
        .filter((s) => s.id !== i.user.id && s.member && !s.member.user.bot)
        .slice(0, 25)
        .map((s) => ({ label: s.member.displayName.slice(0, 100), value: s.id }));
      if (!options.length) return i.reply({ content: `❌ Tidak ada orang lain di <#${ch.id}> untuk diberi kepemilikan.`, flags: EPHEMERAL });
      const menu = new StringSelectMenuBuilder().setCustomId('tv:transfers').setPlaceholder('Pilih pemilik baru').addOptions(options);
      return i.reply({ content: 'Pilih siapa yang akan menjadi pemilik baru:', components: [new ActionRowBuilder().addComponents(menu)], flags: EPHEMERAL });
    }

    if (action === 'info') {
      const locked = ch.permissionOverwrites.cache.get(guild.id)?.deny.has(PermissionFlagsBits.Connect) ?? false;
      const embed = new EmbedBuilder()
        .setColor(locked ? 0xe74c3c : 0x2ecc71)
        .setTitle('ℹ️ Voice milikmu')
        .addFields(
          { name: 'Channel', value: `<#${ch.id}>`, inline: true },
          { name: 'Status', value: locked ? '🔒 Terkunci' : '🔓 Terbuka', inline: true },
          { name: 'Batas orang', value: ch.userLimit ? `${ch.userLimit} orang` : 'Tanpa batas', inline: true },
          { name: 'Orang di dalam', value: String(humansIn(guild, ch.id).length), inline: true }
        );
      return i.reply({ embeds: [embed], flags: EPHEMERAL });
    }
    return;
  }

  // ---- modal
  if (i.isModalSubmit()) {
    const raw = i.fields.getTextInputValue('value').trim();
    if (action === 'limitm') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 99) return i.reply({ content: '❌ Masukkan angka bulat 0 sampai 99.', flags: EPHEMERAL });
      await i.deferReply({ flags: EPHEMERAL });
      await ch.setUserLimit(n);
      return i.editReply(n ? `✅ Batas <#${ch.id}>: **${n}** orang.` : `✅ Batas <#${ch.id}> dihapus.`);
    }
    if (action === 'renamem') {
      await i.deferReply({ flags: EPHEMERAL });
      const err = await renameChannel(ch, raw, i.user.tag);
      return i.editReply(err || `✅ Nama channel diganti menjadi **${raw.slice(0, 100)}**.`);
    }
    return;
  }

  // ---- menu pilih (serahkan kepemilikan)
  if (i.isStringSelectMenu() && action === 'transfers') {
    await i.deferUpdate();
    const targetId = i.values[0];
    const state = humansIn(guild, ch.id).find((s) => s.id === targetId);
    const member = state?.member || (state ? await guild.members.fetch(targetId).catch(() => null) : null);
    if (!member || member.user.bot) return i.editReply({ content: '❌ Orang itu sudah tidak ada di channel ini.', components: [] });
    await transferOwner(ch, i.user.id, member, true);
    return i.editReply({ content: `👑 Kepemilikan <#${ch.id}> diserahkan ke ${member}.`, components: [], allowedMentions: NO_PING });
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
    const existing = ownedByUser(guild, member.id);
    if (existing) {
      await member.voice.setChannel(existing).catch(() => {});
      return;
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

  // Pemilik keluar tapi masih ada orang -> oper kepemilikan (utamakan yang belum punya voice sementara)
  if (row.owner_id === userId) {
    const known = humans.filter((s) => s.member && !s.member.user.bot);
    const next = known.find((s) => !getTempsByOwner(guild.id, s.id).length) || known[0];
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
    if (!s) return;
    if (s.trigger_channel_id === ch.id) delSettings(ch.guildId);
    else if (s.panel_channel_id === ch.id) setPanelInfo(ch.guildId, null, null);
  });

  sweep(client).catch((err) => console.warn('[tempvoice] sweep gagal:', err.message));
  ensurePanels(client).catch((err) => console.warn('[tempvoice] cek panel gagal:', err.message));
  setInterval(() => sweep(client).catch(() => {}), SWEEP_EVERY_MS).unref();
  console.log('[tempvoice] aktif');
}

// ------------------------------------------------------------------ command
const command = {
  data: new SlashCommandBuilder()
    .setName('tempvoice')
    .setDescription('Voice sementara (join-to-create)')
    .addSubcommand((s) =>
      s
        .setName('setup')
        .setDescription(`(Admin) Aktifkan voice sementara: membuat "${TRIGGER_NAME}" dan channel panel`)
        .addChannelOption((o) =>
          o.setName('channel').setDescription(`Voice channel pemicu (kosong = bot membuat "${TRIGGER_NAME}")`).addChannelTypes(ChannelType.GuildVoice)
        )
        .addChannelOption((o) =>
          o.setName('category').setDescription('Kategori tempat voice sementara dibuat (kosong = sama dengan channel pemicu)').addChannelTypes(ChannelType.GuildCategory)
        )
        .addChannelOption((o) =>
          o
            .setName('panel_channel')
            .setDescription(`Channel tempat panel tombol (kosong = bot membuat "${PANEL_CHANNEL_NAME}")`)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice)
        )
    )
    .addSubcommand((s) => s.setName('panel').setDescription('(Admin) Kirim ulang panel tombol ke channel panel'))
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
    if (sub === 'setup' || sub === 'disable' || sub === 'panel') {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: '❌ Hanya yang punya izin **Manage Server** yang bisa memakai ini.', flags: EPHEMERAL });
      }

      if (sub === 'disable') {
        const s = getSettings(i.guildId);
        if (s) await deleteOldPanel(i.guild, s);
        delSettings(i.guildId);
        return i.reply({ content: '✅ Voice sementara dimatikan. Channel yang sudah ada akan terhapus sendiri saat kosong.', flags: EPHEMERAL });
      }

      if (sub === 'panel') {
        await i.deferReply({ flags: EPHEMERAL });
        const res = await sendCentralPanel(i.guild);
        return i.editReply(res.ok ? `✅ Panel dikirim ulang di <#${res.channel.id}>.` : `❌ ${res.error}`);
      }

      // ---- setup
      const me = i.guild.members.me;
      const missing = ['ManageChannels', 'MoveMembers'].filter((p) => !me.permissions.has(PermissionFlagsBits[p]));
      if (missing.length) return i.reply({ content: `❌ Bot butuh izin: **${missing.join(', ')}**. Beri izin itu ke role bot lalu coba lagi.`, flags: EPHEMERAL });

      await i.deferReply({ flags: EPHEMERAL });
      const category = i.options.getChannel('category');
      let trigger = i.options.getChannel('channel');
      let panelCh = i.options.getChannel('panel_channel');
      const made = [];
      try {
        const previous = getSettings(i.guildId);

        // Channel pemicu: pakai pilihan, atau pemicu lama kalau masih ada, atau buat baru
        const previousTrigger = previous && i.guild.channels.cache.get(previous.trigger_channel_id);
        if (!trigger && previousTrigger) trigger = previousTrigger;
        if (!trigger) {
          trigger = await i.guild.channels.create({ name: TRIGGER_NAME, type: ChannelType.GuildVoice, parent: category?.id ?? null, reason: 'Channel pemicu voice sementara' });
          made.push(`<#${trigger.id}>`);
        }
        const keepCategory = previousTrigger && trigger === previousTrigger ? previous.category_id : null;
        setSettings(i.guildId, trigger.id, category?.id ?? keepCategory);

        // Channel panel: pakai pilihan, atau yang lama kalau masih ada, atau buat baru
        const previousPanel = previous?.panel_channel_id ? i.guild.channels.cache.get(previous.panel_channel_id) : null;
        if (!panelCh && previousPanel) panelCh = previousPanel;
        if (!panelCh) {
          panelCh = await i.guild.channels.create({
            name: PANEL_CHANNEL_NAME,
            type: ChannelType.GuildText,
            parent: category?.id ?? trigger.parentId ?? null,
            topic: 'Atur voice sementara milikmu lewat tombol di bawah',
            reason: 'Channel panel voice sementara',
          });
          made.push(`<#${panelCh.id}>`);
          // Rapikan: member hanya bisa klik tombol, tidak bisa chat. Bot diberi izin sendiri supaya tetap bisa kirim panel.
          try {
            await panelCh.permissionOverwrites.edit(me.id, { ViewChannel: true, SendMessages: true, EmbedLinks: true });
            await panelCh.permissionOverwrites.edit(i.guild.id, { SendMessages: false, AddReactions: false });
          } catch (err) {
            console.warn('[tempvoice] gagal mengatur izin channel panel:', err.message);
          }
        }
        // Panel lama di channel lain dihapus, lalu simpan channel panel yang baru
        if (previous && previous.panel_channel_id !== panelCh.id) await deleteOldPanel(i.guild, previous);
        setPanelInfo(i.guildId, panelCh.id, previous?.panel_channel_id === panelCh.id ? previous.panel_message_id : null);
      } catch (err) {
        return i.editReply(`❌ Gagal mengatur: \`${String(err.message).slice(0, 200)}\``);
      }

      const res = await sendCentralPanel(i.guild);
      return i.editReply(
        `✅ Voice sementara aktif!\n` +
          `• Channel pemicu: <#${trigger.id}>${made.includes(`<#${trigger.id}>`) ? ' (baru dibuat)' : ''}\n` +
          `• Channel panel: <#${panelCh.id}>${made.includes(`<#${panelCh.id}>`) ? ' (baru dibuat)' : ''}${res.ok ? '' : `\n⚠️ ${res.error}`}\n` +
          `• Kategori voice sementara: ${category ? `**${category.name}**` : 'sama dengan channel pemicu'}`
      );
    }

    // ---- pemilik channel
    const vc = ownedByUser(i.guild, i.user.id);
    if (!vc) return i.reply({ content: '❌ Kamu belum punya voice sementara. Masuk ke channel pemicu dulu untuk membuatnya.', flags: EPHEMERAL });

    if (sub === 'name') {
      await i.deferReply({ flags: EPHEMERAL });
      const nama = i.options.getString('nama', true);
      const err = await renameChannel(vc, nama, i.user.tag);
      return i.editReply(err || `✅ Nama channel diganti menjadi **${nama.trim().slice(0, 100)}**.`);
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

module.exports = { command, startTempVoice, handleTempVoiceInteraction };

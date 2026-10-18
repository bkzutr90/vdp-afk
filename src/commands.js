const {
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');
const cfg = require('./config');
const { db } = require('./db');
const xp = require('./xp');
const { renderRankCard, processBackground } = require('./card');
const { setAfk, stopAfk, statusOf } = require('./voice');

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_PING = { parse: [] };
const MAX_BG_BYTES = 8 * 1024 * 1024;
const PER_PAGE = 10;

const commands = new Map();
const def = (data, execute) => commands.set(data.name, { data, execute });

// ------------------------------------------------------------------ util
const getBg = (userId) => db.prepare('SELECT image FROM backgrounds WHERE user_id=?').get(userId)?.image || null;
const saveBg = (userId, img) =>
  db.prepare('INSERT INTO backgrounds (user_id, image, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET image=excluded.image, updated_at=excluded.updated_at').run(userId, img, Date.now());
const deleteBg = (userId) => db.prepare('DELETE FROM backgrounds WHERE user_id=?').run(userId).changes;

async function fetchBuffer(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ /rank
def(
  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Tampilkan level & XP kamu (atau user lain)')
    .addUserOption((o) => o.setName('user').setDescription('User yang ingin dilihat (kosong = kamu)')),
  async (i) => {
    const target = i.options.getUser('user') || i.user;
    if (target.bot) return i.reply({ content: '❌ Bot tidak punya level.', flags: EPHEMERAL });
    await i.deferReply();

    const row = xp.getUser(i.guildId, target.id);
    const { level, current, needed } = xp.levelFromXp(row.xp);
    const member = i.options.getMember('user') || (target.id === i.user.id ? i.member : null);
    const name = member?.displayName || target.globalName || target.username;

    const avatar = await fetchBuffer(target.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true }));
    const png = await renderRankCard({
      name,
      avatar,
      level,
      rank: xp.rankOf(i.guildId, row.xp),
      current,
      needed,
      background: getBg(target.id),
    });
    return i.editReply({ files: [new AttachmentBuilder(png, { name: 'rank.png' })] });
  }
);

// ------------------------------------------------------------------ /leaderboard
function leaderboardPage(guildId, wantedPage, myRank) {
  const total = xp.count(guildId);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const page = Math.min(Math.max(wantedPage, 0), pages - 1);
  const rows = xp.top(guildId, PER_PAGE, page * PER_PAGE);
  const medal = ['🥇', '🥈', '🥉'];
  const lines = rows.map((r, idx) => {
    const pos = page * PER_PAGE + idx + 1;
    return `${medal[pos - 1] || `**${pos}.**`} <@${r.user_id}> — Level **${r.level}** • ${r.xp.toLocaleString('id-ID')} XP`;
  });

  const embed = new EmbedBuilder()
    .setColor(cfg.accent)
    .setTitle('🏆 Leaderboard Level')
    .setDescription(lines.join('\n') || '_Belum ada data. Ayo ngobrol dulu!_')
    .setFooter({ text: `Halaman ${page + 1}/${pages} • ${total} user • Peringkatmu: #${myRank}` });

  const btn = (id, emoji, disabled) => new ButtonBuilder().setCustomId(id).setEmoji(emoji).setStyle(ButtonStyle.Secondary).setDisabled(disabled);
  const components =
    pages > 1
      ? [
          new ActionRowBuilder().addComponents(
            btn('lb_first', '⏮️', page === 0),
            btn('lb_prev', '◀️', page === 0),
            new ButtonBuilder().setCustomId('lb_page').setLabel(`${page + 1}/${pages}`).setStyle(ButtonStyle.Primary).setDisabled(true),
            btn('lb_next', '▶️', page === pages - 1),
            btn('lb_last', '⏭️', page === pages - 1)
          ),
        ]
      : [];
  return { payload: { embeds: [embed], components, allowedMentions: NO_PING }, page, pages };
}

def(
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Tampilkan leaderboard level server')
    .addIntegerOption((o) => o.setName('halaman').setDescription('Nomor halaman').setMinValue(1)),
  async (i) => {
    const myRank = xp.rankOf(i.guildId, xp.getUser(i.guildId, i.user.id).xp);
    const first = leaderboardPage(i.guildId, (i.options.getInteger('halaman') || 1) - 1, myRank);
    await i.reply(first.payload);
    if (first.pages <= 1) return;

    let page = first.page;
    const msg = await i.fetchReply();
    const collector = msg.createMessageComponentCollector({ time: 120_000 });
    collector.on('collect', async (b) => {
      if (b.user.id !== i.user.id) {
        return b.reply({ content: 'Jalankan `/leaderboard` sendiri untuk ganti halaman.', flags: EPHEMERAL }).catch(() => {});
      }
      const target = { lb_first: 0, lb_prev: page - 1, lb_next: page + 1, lb_last: Infinity }[b.customId];
      if (target === undefined) return;
      const r = leaderboardPage(i.guildId, target, myRank);
      page = r.page;
      await b.update(r.payload).catch(() => {});
    });
    collector.on('end', () => i.editReply({ components: [] }).catch(() => {}));
  }
);

// ------------------------------------------------------------------ /background
const reportCooldown = new Map(); // "pelapor:target" -> timestamp

def(
  new SlashCommandBuilder()
    .setName('background')
    .setDescription('Atur background kartu level kamu')
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Pasang gambar sebagai background kartu level')
        .addAttachmentOption((o) => o.setName('image').setDescription('Gambar PNG/JPG/WEBP/GIF (maks 8 MB)').setRequired(true))
    )
    .addSubcommand((s) => s.setName('view').setDescription('Lihat background kartu level kamu saat ini'))
    .addSubcommand((s) => s.setName('delete').setDescription('Hapus background kartu level kamu'))
    .addSubcommand((s) =>
      s
        .setName('report')
        .setDescription('Laporkan background user yang melanggar aturan')
        .addUserOption((o) => o.setName('user').setDescription('Pemilik background').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Alasan laporan').setRequired(true).setMaxLength(300))
    ),
  async (i) => {
    const sub = i.options.getSubcommand();

    if (sub === 'set') {
      const att = i.options.getAttachment('image', true);
      if (!/^image\/(png|jpe?g|webp|gif)$/i.test(att.contentType || '')) {
        return i.reply({ content: '❌ File harus gambar PNG, JPG, WEBP, atau GIF.', flags: EPHEMERAL });
      }
      if (att.size > MAX_BG_BYTES) return i.reply({ content: '❌ Ukuran gambar maksimal 8 MB.', flags: EPHEMERAL });
      let host = '';
      try {
        host = new URL(att.url).hostname;
      } catch {}
      if (!/(^|\.)(discordapp\.com|discordapp\.net|discord\.com)$/.test(host)) {
        return i.reply({ content: '❌ Gambar harus diunggah langsung ke Discord.', flags: EPHEMERAL });
      }

      await i.deferReply({ flags: EPHEMERAL });
      const raw = await fetchBuffer(att.url);
      if (!raw || raw.length > MAX_BG_BYTES) return i.editReply('❌ Gagal mengunduh gambar. Coba lagi.');
      let jpg;
      try {
        jpg = await processBackground(raw);
      } catch {
        return i.editReply('❌ Gambar tidak bisa diproses. Coba file lain.');
      }
      saveBg(i.user.id, jpg);
      return i.editReply({
        content: '✅ Background diperbarui. Cek hasilnya dengan `/rank`.\nPelanggaran aturan (konten dewasa, kekerasan, dll.) bisa membuat background dihapus.',
        files: [new AttachmentBuilder(jpg, { name: 'background.jpg' })],
      });
    }

    if (sub === 'view') {
      const img = getBg(i.user.id);
      if (!img) return i.reply({ content: 'Kamu belum punya background. Pasang dengan `/background set`.', flags: EPHEMERAL });
      return i.reply({ content: 'Background kartu level kamu:', files: [new AttachmentBuilder(img, { name: 'background.jpg' })], flags: EPHEMERAL });
    }

    if (sub === 'delete') {
      if (!deleteBg(i.user.id)) return i.reply({ content: 'Kamu belum punya background.', flags: EPHEMERAL });
      return i.reply({ content: '🗑️ Background dihapus. Kartu kembali ke tampilan default.', flags: EPHEMERAL });
    }

    if (sub === 'report') {
      const target = i.options.getUser('user', true);
      const reason = i.options.getString('reason', true);
      if (target.id === i.user.id) return i.reply({ content: '❌ Kamu tidak bisa melaporkan dirimu sendiri. Pakai `/background delete` kalau ingin menghapus.', flags: EPHEMERAL });
      if (!cfg.reportChannelId) return i.reply({ content: '❌ Fitur laporan belum diatur oleh admin (REPORT_CHANNEL_ID).', flags: EPHEMERAL });

      const img = getBg(target.id);
      if (!img) return i.reply({ content: '❌ User itu tidak memiliki background.', flags: EPHEMERAL });

      const key = `${i.user.id}:${target.id}`;
      if (Date.now() - (reportCooldown.get(key) || 0) < 10 * 60_000) {
        return i.reply({ content: '⏳ Kamu baru saja melaporkan user ini. Tunggu beberapa menit.', flags: EPHEMERAL });
      }

      const channel = await i.client.channels.fetch(cfg.reportChannelId).catch(() => null);
      if (!channel?.isTextBased()) return i.reply({ content: '❌ Channel laporan tidak ditemukan. Hubungi admin.', flags: EPHEMERAL });

      const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('🚩 Laporan Background')
        .addFields(
          { name: 'Pemilik background', value: `${target} (\`${target.id}\`)`, inline: true },
          { name: 'Pelapor', value: `${i.user}`, inline: true },
          { name: 'Alasan', value: reason }
        )
        .setImage('attachment://reported.jpg')
        .setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bgr:rm:${target.id}`).setLabel('Hapus background').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('bgr:ok').setLabel('Abaikan').setStyle(ButtonStyle.Secondary)
      );
      try {
        await channel.send({ embeds: [embed], components: [row], files: [new AttachmentBuilder(img, { name: 'reported.jpg' })], allowedMentions: NO_PING });
      } catch (err) {
        console.warn('[report] gagal kirim laporan:', err.message);
        return i.reply({ content: '❌ Gagal mengirim laporan. Hubungi admin.', flags: EPHEMERAL });
      }
      reportCooldown.set(key, Date.now());
      return i.reply({ content: '✅ Laporan terkirim ke moderator. Terima kasih!', flags: EPHEMERAL });
    }
  }
);

// Tombol di pesan laporan (khusus moderator)
async function handleButton(i) {
  if (!i.customId.startsWith('bgr:')) return false;
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    await i.reply({ content: '❌ Hanya moderator yang bisa memakai tombol ini.', flags: EPHEMERAL });
    return true;
  }
  const [, action, userId] = i.customId.split(':');
  let note;
  if (action === 'rm') {
    const removed = deleteBg(userId);
    note = removed ? `🗑️ Background dihapus oleh ${i.user}` : `ℹ️ Background sudah tidak ada (diperiksa ${i.user})`;
  } else {
    note = `✅ Laporan diabaikan oleh ${i.user}`;
  }
  const embed = EmbedBuilder.from(i.message.embeds[0]).setFooter({ text: note.replace(/<@!?\d+>/g, i.user.tag) });
  await i.update({ embeds: [embed], components: [], allowedMentions: NO_PING });
  return true;
}

// ------------------------------------------------------------------ /afk (voice 24 jam)
def(
  new SlashCommandBuilder()
    .setName('afk')
    .setDescription('Atur bot AFK di voice channel 24 jam')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('join')
        .setDescription('Bot masuk ke voice channel dan menjaganya terus (auto-rejoin)')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Voice channel (kosong = channel voice kamu)').addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        )
    )
    .addSubcommand((s) => s.setName('leave').setDescription('Keluarkan bot dari voice dan matikan mode AFK'))
    .addSubcommand((s) => s.setName('status').setDescription('Lihat status koneksi voice bot')),
  async (i) => {
    const sub = i.options.getSubcommand();

    if (sub === 'join') {
      const channel = i.options.getChannel('channel') || i.member?.voice?.channel;
      if (!channel) return i.reply({ content: '❌ Pilih voice channel, atau masuk ke voice dulu.', flags: EPHEMERAL });
      await i.deferReply({ flags: EPHEMERAL });
      try {
        await setAfk(i.guildId, channel.id);
        return i.editReply(`✅ Bot AFK di **${channel.name}**. Kalau terputus, bot masuk lagi otomatis (dicek tiap 30 detik).`);
      } catch (err) {
        return i.editReply(`❌ Gagal masuk: \`${String(err.message).slice(0, 200)}\``);
      }
    }

    if (sub === 'leave') {
      stopAfk(i.guildId);
      return i.reply({ content: '👋 Bot keluar dari voice. Mode AFK dimatikan.', flags: EPHEMERAL });
    }

    const st = statusOf(i.guildId);
    return i.reply({
      content: st.channelId ? `🎧 Menjaga <#${st.channelId}> • status: **${st.state}**` : 'Mode AFK tidak aktif. Pakai `/afk join`.',
      flags: EPHEMERAL,
    });
  }
);

// ------------------------------------------------------------------ /tempvoice
const { command: tempvoiceCommand } = require('./tempvoice');
commands.set(tempvoiceCommand.data.name, tempvoiceCommand);

// ------------------------------------------------------------------ /selfrole (role Boy/Girl)
const { command: selfroleCommand } = require('./selfrole');
commands.set(selfroleCommand.data.name, selfroleCommand);

// ------------------------------------------------------------------ /serverstats
const { command: statsCommand } = require('./stats');
commands.set(statsCommand.data.name, statsCommand);

// ------------------------------------------------------------------ /invites
const { command: inviteCommand } = require('./invite');
commands.set(inviteCommand.data.name, inviteCommand);

module.exports = { commands, handleButton };

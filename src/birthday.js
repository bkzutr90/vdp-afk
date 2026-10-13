const {
  EmbedBuilder,
  SlashCommandBuilder,
  ActionRowBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');
const cfg = require('./config');
const { db } = require('./db');

const EPHEMERAL = MessageFlags.Ephemeral;

// ---------------------------------------------------------------- parsing & db
/** Terima "DD/MM", "DD-MM", "DD/MM/YYYY", "DD-MM-YYYY". Return {day, month, year|null} atau null. */
function parseBirthday(input) {
  const m = String(input || '').trim().match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{4}))?$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = m[3] ? Number(m[3]) : null;
  if (month < 1 || month > 12 || day < 1) return null;
  // 29 Feb dianggap valid (tahun kabisat 2024 dipakai sebagai acuan jumlah hari)
  const maxDay = new Date(Date.UTC(2024, month, 0)).getUTCDate();
  if (day > maxDay) return null;
  if (year !== null && (year < 1940 || year > new Date().getFullYear() - 5)) return null;
  return { day, month, year };
}

function saveBirthday(guildId, userId, { day, month, year }) {
  db.prepare(
    `INSERT INTO birthdays (guild_id, user_id, day, month, year) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET day=excluded.day, month=excluded.month, year=excluded.year`
  ).run(guildId, userId, day, month, year);
}

const getBirthday = (guildId, userId) =>
  db.prepare('SELECT * FROM birthdays WHERE guild_id=? AND user_id=?').get(guildId, userId);
const deleteBirthday = (guildId, userId) =>
  db.prepare('DELETE FROM birthdays WHERE guild_id=? AND user_id=?').run(guildId, userId).changes;

// ---------------------------------------------------------------- field modal (dipakai di verifikasi)
/** ActionRow berisi input tanggal lahir, untuk ditambahkan ke modal verifikasi. */
function birthdayInputRow(required = true) {
  return new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('birthday')
      .setLabel('Tanggal ulang tahun (DD/MM atau DD/MM/YYYY)')
      .setPlaceholder('contoh: 17/08 atau 17/08/2004')
      .setStyle(TextInputStyle.Short)
      .setMinLength(3)
      .setMaxLength(10)
      .setRequired(required)
  );
}

// ---------------------------------------------------------------- scheduler
function todayParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: cfg.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

async function runBirthdayCheck(client) {
  const { year, month, day } = todayParts();
  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

  // Yang lahir 29 Feb dirayakan 28 Feb di tahun non-kabisat
  const rows =
    month === 2 && day === 28 && !isLeap(year)
      ? db.prepare('SELECT * FROM birthdays WHERE month=2 AND day IN (28, 29) AND last_greeted_year < ?').all(year)
      : db.prepare('SELECT * FROM birthdays WHERE month=? AND day=? AND last_greeted_year < ?').all(month, day, year);
  if (!rows.length) return;

  const channel = await client.channels.fetch(cfg.birthdayChannelId).catch(() => null);
  if (!channel?.isTextBased()) {
    console.warn('[birthday] channel ucapan tidak ditemukan / bot tidak punya akses');
    return;
  }

  for (const r of rows) {
    // Pastikan user masih ada di server
    const guild = client.guilds.cache.get(r.guild_id);
    const member = guild ? await guild.members.fetch(r.user_id).catch(() => null) : null;
    if (!member) continue;

    const age = r.year ? year - r.year : null;
    const embed = new EmbedBuilder()
      .setColor(cfg.accent)
      .setTitle('🎂 Selamat Ulang Tahun!')
      .setDescription(
        `Selamat ulang tahun <@${r.user_id}>! 🎉🥳\n` +
          (age ? `Selamat memasuki usia **${age}** tahun!\n` : '') +
          `Semoga panjang umur, sehat selalu, dan makin sukses. Dari kami semua di **${guild.name}** 💙`
      )
      .setThumbnail(member.displayAvatarURL({ extension: 'png', size: 256 }))
      .setTimestamp();

    try {
      await channel.send({
        content: `🎉 <@${r.user_id}>`,
        embeds: [embed],
        allowedMentions: { users: [r.user_id] },
      });
      db.prepare('UPDATE birthdays SET last_greeted_year=? WHERE guild_id=? AND user_id=?').run(year, r.guild_id, r.user_id);
    } catch (err) {
      console.warn('[birthday] gagal kirim ucapan:', err.message);
    }
  }
}

function startBirthday(client) {
  const tick = () => runBirthdayCheck(client).catch((err) => console.error('[birthday] error:', err));
  tick(); // cek langsung saat bot online (kalau bot restart di hari H)
  setInterval(tick, 10 * 60_000).unref(); // tiap 10 menit; last_greeted_year mencegah dobel
}

// ---------------------------------------------------------------- /birthday
const command = {
  data: new SlashCommandBuilder()
    .setName('birthday')
    .setDescription('Atur tanggal ulang tahunmu')
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Isi / ubah tanggal ulang tahun')
        .addStringOption((o) => o.setName('tanggal').setDescription('DD/MM atau DD/MM/YYYY, contoh 17/08').setRequired(true))
    )
    .addSubcommand((s) => s.setName('view').setDescription('Lihat tanggal ulang tahun yang tersimpan'))
    .addSubcommand((s) => s.setName('delete').setDescription('Hapus tanggal ulang tahunmu')),
  async execute(i) {
    const sub = i.options.getSubcommand();

    if (sub === 'set') {
      const parsed = parseBirthday(i.options.getString('tanggal', true));
      if (!parsed) {
        return i.reply({ content: '❌ Format salah. Pakai `DD/MM` atau `DD/MM/YYYY`, contoh `17/08`.', flags: EPHEMERAL });
      }
      saveBirthday(i.guildId, i.user.id, parsed);
      return i.reply({
        content: `✅ Tersimpan: **${parsed.day}/${parsed.month}${parsed.year ? '/' + parsed.year : ''}**`,
        flags: EPHEMERAL,
      });
    }

    if (sub === 'view') {
      const b = getBirthday(i.guildId, i.user.id);
      return i.reply({
        content: b
          ? `🎂 Ulang tahunmu: **${b.day}/${b.month}${b.year ? '/' + b.year : ''}**`
          : 'Kamu belum mengisi. Pakai `/birthday set`.',
        flags: EPHEMERAL,
      });
    }

    return i.reply({
      content: deleteBirthday(i.guildId, i.user.id) ? '🗑️ Tanggal ulang tahun dihapus.' : 'Kamu belum mengisi tanggal ulang tahun.',
      flags: EPHEMERAL,
    });
  },
};

module.exports = { command, startBirthday, parseBirthday, saveBirthday, birthdayInputRow, runBirthdayCheck };

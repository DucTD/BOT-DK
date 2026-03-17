require('dotenv').config();

/* ================= DEBUG ================= */
console.log("🔥 FILE INDEX.JS ĐANG CHẠY");
console.log("================ ENV DEBUG ================");
console.log("TOKEN:", process.env.TOKEN ? "OK" : "NULL");
console.log("GUILD_ID:", process.env.GUILD_ID);
console.log("ADMIN_CHANNEL_ID:", process.env.ADMIN_CHANNEL_ID);
console.log("===========================================");

/* ================= IMPORT ================= */
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  EmbedBuilder
} = require('discord.js');

const fs = require('fs');
const QRCode = require('qrcode');

const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

/* ================= DISCORD ================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

/* ================= CONSTANT ================= */
const DAY = 86400000;

/* ================= ROLE CONFIG ================= */
const ROLE_BY_PLAN = {
  '1m': process.env.ROLE_1T_ID,
  '6m': process.env.ROLE_6T_ID,
  '1y': process.env.ROLE_1Y_ID
};

const ROLE_WAIT_BY_PLAN = {
  '1m': process.env.ROLE_WAIT_1T_ID,
  '6m': process.env.ROLE_WAIT_6T_ID,
  '1y': process.env.ROLE_WAIT_1Y_ID
};

/* ================= PRICE ================= */
const PRICE_VN = { '1m': 2000000, '6m': 10000000, '1y': 18000000 };
const PRICE_JP = { '1m': 12000, '6m': 60000, '1y': 108000 };

/* ================= PAYMENT ================= */
const PAYMENT = {
  VN: {
    bankBin: '970407',
    accountNumber: '86196868888',
    accountName: 'NGUYEN DUY THINH'
  }
};

/* ================= DATABASE ================= */
const DB_FILE = './members.json';

let members = fs.existsSync(DB_FILE)
  ? JSON.parse(fs.readFileSync(DB_FILE))
  : {};

const saveDB = () =>
  fs.writeFileSync(DB_FILE, JSON.stringify(members, null, 2));

/* ================= UTIL ================= */
const addMonths = (base, m) => {
  const d = new Date(base);
  d.setMonth(d.getMonth() + m);
  return d.getTime();
};

const planToMonth = p => (p === '6m' ? 6 : p === '1y' ? 12 : 1);

/* ================= ROLE ================= */
async function updateWaitingRole(guild, userId, plan) {
  const m = await guild.members.fetch(userId).catch(() => null);
  if (!m) return;

  for (const r of Object.values(ROLE_WAIT_BY_PLAN))
    await m.roles.remove(r).catch(() => {});

  await m.roles.add(ROLE_WAIT_BY_PLAN[plan]).catch(() => {});
}

async function updateFinalRole(guild, userId, plan) {
  const m = await guild.members.fetch(userId).catch(() => null);
  if (!m) return;

  for (const r of [
    ...Object.values(ROLE_BY_PLAN),
    ...Object.values(ROLE_WAIT_BY_PLAN)
  ]) {
    await m.roles.remove(r).catch(() => {});
  }

  await m.roles.add(ROLE_BY_PLAN[plan]).catch(() => {});
}

/* ================= READY ================= */
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

/* ================= INTERACTION ================= */
client.on(Events.InteractionCreate, async i => {

  if (!i.isButton()) return;

  const id = i.user.id;

  if (!members[id]) members[id] = { expireAt: 0 };

  /* chọn gói */
  if (['1m', '6m', '1y'].includes(i.customId)) {

    members[id].plan = i.customId;
    saveDB();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pay').setLabel('Thanh toán').setStyle(ButtonStyle.Primary)
    );

    return i.reply({
      ephemeral: true,
      content: 'Bấm để thanh toán:',
      components: [row]
    });
  }

  /* thanh toán */
  if (i.customId === 'pay') {

    const amount = PRICE_VN[members[id].plan];
    members[id].transferNote = `DISCORD_${id}`;
    saveDB();

    const qr = await QRCode.toBuffer(`BANK:970407|ACC:86196868888|AMOUNT:${amount}|NOTE:${members[id].transferNote}`);

    return i.reply({
      ephemeral: true,
      content: `💰 ${amount.toLocaleString()} VND\n📝 ${members[id].transferNote}`,
      files: [{ attachment: qr, name: 'qr.png' }]
    });
  }

});

/* ================= DM BILL ================= */
client.on(Events.MessageCreate, async message => {

  if (message.guild) return;
  if (message.author.bot) return;

  const id = message.author.id;

  if (!members[id]?.plan)
    return message.reply('❌ Bạn chưa chọn gói.');

  if (message.attachments.size === 0)
    return message.reply('📸 Gửi ảnh bill.');

  const file = message.attachments.first();

  const res = await fetch(file.url);
  const buffer = Buffer.from(await res.arrayBuffer());

  if (!fs.existsSync('./uploads'))
    fs.mkdirSync('./uploads');

  const path = `./uploads/${id}.png`;
  fs.writeFileSync(path, buffer);

  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  await updateWaitingRole(guild, id, members[id].plan);

  const adminCh = await client.channels.fetch(process.env.ADMIN_CHANNEL_ID);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`approve_${id}`).setLabel('Approve').setStyle(ButtonStyle.Success)
  );

  await adminCh.send({
    content: `Bill từ <@${id}>`,
    files: [{ attachment: path }],
    components: [row]
  });

  message.reply('✅ Đã gửi admin.');
});

/* ================= APPROVE ================= */
client.on(Events.InteractionCreate, async i => {

  if (!i.isButton()) return;

  if (!i.customId.startsWith('approve_')) return;

  const id = i.customId.split('_')[1];
  const m = members[id];

  const now = Date.now();

  m.expireAt = m.expireAt > now
    ? addMonths(m.expireAt, planToMonth(m.plan))
    : addMonths(now, planToMonth(m.plan));

  m.remind23 = false;
  m.remind25 = false;

  saveDB();

  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  await updateFinalRole(guild, id, m.plan);

  i.reply({ content: 'Approved', ephemeral: true });
});

/* ================= REMINDER ================= */
setInterval(async () => {

  const now = new Date();

  for (const id in members) {

    const m = members[id];
    if (!m.expireAt) continue;

    const expire = new Date(m.expireAt);

    if (
      expire.getMonth() === now.getMonth() &&
      expire.getFullYear() === now.getFullYear()
    ) {

      /* ngày 23 */
      if (now.getDate() === 23 && !m.remind23) {

        const user = await client.users.fetch(id).catch(() => null);
        if (user) user.send('🔔 Sắp hết hạn!');

        m.remind23 = true;
        saveDB();
      }

      /* ngày 25 */
      if (now.getDate() === 25 && !m.remind25) {

        const user = await client.users.fetch(id).catch(() => null);

        if (user) {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('1m').setLabel('1m').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('6m').setLabel('6m').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('1y').setLabel('1y').setStyle(ButtonStyle.Primary)
          );

          user.send({ content: 'Gia hạn:', components: [row] });
        }

        m.remind25 = true;
        saveDB();
      }

    }

  }

}, 60 * 60 * 1000);

/* ================= LOGIN ================= */

console.log("👉 BEFORE LOGIN");

client.login(process.env.TOKEN)
  .then(() => console.log("🚀 LOGIN SUCCESS"))
  .catch(err => console.error("❌ LOGIN ERROR:", err));

console.log("👉 AFTER LOGIN");

/* ================= KEEP ALIVE ================= */
require('http')
  .createServer((_, res) => res.end('OK'))
  .listen(process.env.PORT || 3000);

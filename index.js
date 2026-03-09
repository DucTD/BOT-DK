require('dotenv').config();

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

/* ================= PAYMENT INFO ================= */
const PAYMENT = {
  VN: {
    bankName: 'Vietcombank',
    bankBin: '970436',
    accountName: 'NGUYEN VAN A',
    accountNumber: '0123456789'
  },
  JP: {
    bank: 'MUFG Bank',
    branch: 'Shinjuku',
    accountNumber: '1234567',
    accountName: 'NGUYEN VAN A'
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

/* ================= VIETQR ================= */

function generateVietQR({ bin, account, amount, note }) {

  const payload =
`00020101021138540010A00000072701240006${bin}0108${account}0208QRIBFTTA530370454${amount}5802VN6220${note.length}${note}6304`;

  return payload;
}

/* ================= ROLE LOGIC ================= */

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

/* ================= INTERACTION ================= */

client.on(Events.InteractionCreate, async i => {

  if (!i.isButton()) return;

  const id = i.user.id;

  if (!members[id]) members[id] = { expireAt: 0 };

  /* PLAN SELECT */

  if (['1m', '6m', '1y'].includes(i.customId)) {

    members[id].plan = i.customId;

    saveDB();

    const row = new ActionRowBuilder().addComponents(

      new ButtonBuilder()
        .setCustomId('pay_VN')
        .setLabel('🇻🇳 VN')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId('pay_JP')
        .setLabel('🇯🇵 JP')
        .setStyle(ButtonStyle.Primary)

    );

    return i.reply({
      ephemeral: true,
      content: 'Chọn quốc gia thanh toán:',
      components: [row]
    });
  }

  /* PAYMENT SELECT */

  if (i.customId.startsWith('pay_')) {

    const c = i.customId.split('_')[1];

    members[id].payCountry = c;
    members[id].transferNote = `DISCORD_${id}`;

    saveDB();

    const row = new ActionRowBuilder().addComponents(

      new ButtonBuilder()
        .setCustomId('confirm_paid')
        .setLabel('✅ Tôi đã chuyển khoản')
        .setStyle(ButtonStyle.Success)

    );

    let amount;
    let qrContent;

    if (c === 'VN') {

      amount = PRICE_VN[members[id].plan];

      qrContent = generateVietQR({
        bin: PAYMENT.VN.bankBin,
        account: PAYMENT.VN.accountNumber,
        amount,
        note: members[id].transferNote
      });

    }

    if (c === 'JP') {

      amount = PRICE_JP[members[id].plan];

      qrContent =
`BANK:${PAYMENT.JP.bank}
BRANCH:${PAYMENT.JP.branch}
ACC:${PAYMENT.JP.accountNumber}
NAME:${PAYMENT.JP.accountName}
AMOUNT:${amount}
NOTE:${members[id].transferNote}`;

    }

    const qrImage = await QRCode.toBuffer(qrContent);

    const embed = new EmbedBuilder()

      .setTitle('💳 Thông tin thanh toán')
      .setDescription(
`💰 ${amount.toLocaleString()} ${c === 'VN' ? 'VND' : 'JPY'}

📝 ${members[id].transferNote}

Sau khi chuyển khoản hãy bấm nút bên dưới`
      )
      .setImage('attachment://qr.png');

    return i.reply({
      ephemeral: true,
      embeds: [embed],
      files: [{ attachment: qrImage, name: 'qr.png' }],
      components: [row]
    });
  }

  /* USER CONFIRM PAID */

  if (i.customId === 'confirm_paid') {

    try {

      await i.user.send(
`📸 Vui lòng gửi ảnh bill tại đây (DM)`
      );

      return i.reply({
        ephemeral: true,
        content: '📩 Tôi đã gửi DM cho bạn.'
      });

    } catch {

      return i.reply({
        ephemeral: true,
        content: '❌ Không thể gửi DM.'
      });

    }
  }

  /* ADMIN APPROVE */

  if (i.customId.startsWith('approve_')) {

    const uid = i.customId.split('_')[1];
    const m = members[uid];

    if (!m?.plan)
      return i.reply({ content: 'User lỗi', ephemeral: true });

    const now = Date.now();

    m.expireAt = m.expireAt > now
      ? addMonths(m.expireAt, planToMonth(m.plan))
      : addMonths(now, planToMonth(m.plan));

    m.remind23 = false;
    m.remind25 = false;

    saveDB();

    const guild = await client.guilds.fetch(process.env.GUILD_ID);

    await updateFinalRole(guild, uid, m.plan);

    const user = await client.users.fetch(uid).catch(() => null);

    if (user)
      user.send(`✅ Gói ${m.plan} đã được duyệt!`);

    return i.reply({ content: 'Approved', ephemeral: true });
  }

  /* ADMIN REJECT */

  if (i.customId.startsWith('reject_')) {

    delete members[i.customId.split('_')[1]];

    saveDB();

    return i.reply({
      content: 'Rejected',
      ephemeral: true
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

  if (!file.contentType?.startsWith('image/'))
    return message.reply('❌ Chỉ chấp nhận ảnh.');

  if (!fs.existsSync('./uploads'))
    fs.mkdirSync('./uploads');

  const ext = file.name.split('.').pop();

  const filePath = `./uploads/${id}_${Date.now()}.${ext}`;

  const res = await fetch(file.url);
  const buffer = Buffer.from(await res.arrayBuffer());

  fs.writeFileSync(filePath, buffer);

  members[id].billFile = filePath;

  saveDB();

  const guild = await client.guilds.fetch(process.env.GUILD_ID);

  await updateWaitingRole(guild, id, members[id].plan);

  const adminCh =
    await client.channels.fetch(process.env.ADMIN_CHANNEL_ID);

  const row = new ActionRowBuilder().addComponents(

    new ButtonBuilder()
      .setCustomId(`approve_${id}`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId(`reject_${id}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger)

  );

  await adminCh.send({

    content:
`🧾 BILL
👤 <@${id}>
📦 ${members[id].plan}
🌏 ${members[id].payCountry}
📝 ${members[id].transferNote}`,

    files: [{ attachment: filePath }],

    components: [row]

  });

  return message.reply('✅ Đã gửi bill cho admin.');
});

/* ================= RENEW SYSTEM ================= */

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

      if (now.getDate() === 23 && !m.remind23) {

        const user = await client.users.fetch(id).catch(() => null);

        if (user)
          user.send('🔔 Membership của bạn sắp hết hạn.');

        m.remind23 = true;

        saveDB();
      }

      if (now.getDate() === 25 && !m.remind25) {

        const user = await client.users.fetch(id).catch(() => null);

        if (user) {

          const row = new ActionRowBuilder().addComponents(

            new ButtonBuilder()
              .setCustomId('1m')
              .setLabel('1 Month')
              .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
              .setCustomId('6m')
              .setLabel('6 Months')
              .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
              .setCustomId('1y')
              .setLabel('1 Year')
              .setStyle(ButtonStyle.Primary)

          );

          user.send({
            content: '💳 Chọn gói để gia hạn:',
            components: [row]
          });

        }

        m.remind25 = true;

        saveDB();
      }

    }

  }

}, 60 * 60 * 1000);

/* ================= AUTO CLEAN ================= */

setInterval(async () => {

  const now = Date.now();

  const guild = await client.guilds.fetch(process.env.GUILD_ID);

  for (const id in members) {

    if (members[id].expireAt && now > members[id].expireAt + 2 * DAY) {

      const m = await guild.members.fetch(id).catch(() => null);

      if (m) {

        for (const r of [
          ...Object.values(ROLE_BY_PLAN),
          ...Object.values(ROLE_WAIT_BY_PLAN)
        ]) {
          await m.roles.remove(r).catch(() => {});
        }

      }

      delete members[id];

      saveDB();
    }

  }

}, 60 * 60 * 1000);

/* ================= START ================= */

client.login(process.env.TOKEN);

require('http')
  .createServer((_, res) => res.end('OK'))
  .listen(process.env.PORT || 3000);

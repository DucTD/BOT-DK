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
const express = require('express');
const fs = require('fs');
const QRCode = require('qrcode');
const { createQR } = require('vietqr'); // VietQR EMV QR code
const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

/* ================= APP ================= */
const app = express();
const PORT = process.env.PORT || 3000;

/* ================= DATABASE ================= */
const DB_FILE = './members.json';
let members = {};

const loadDB = async () => {
  try {
    if (fs.existsSync(DB_FILE)) {
      members = JSON.parse(await fs.promises.readFile(DB_FILE));
    }
  } catch (err) {
    console.error("❌ Lỗi đọc DB:", err);
    members = {};
  }
};

const saveDB = async () => {
  try {
    await fs.promises.writeFile(DB_FILE, JSON.stringify(members, null, 2));
  } catch (err) {
    console.error("❌ Lỗi ghi DB:", err);
  }
};
loadDB();

/* ================= CONFIG ================= */
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

const PRICE_VN = { '1m': 2000000, '6m': 11000000, '1y': 22000000 };
const PRICE_JP = { '1m': 11000, '6m': 60500, '1y': 121000 };

const PAYMENT_VN = {
  bankName: "Techcombank",
  bankBin: '970407',
  accountNumber: '86196868888',
  accountName: 'NGUYEN DUY THINH'
};

const PAYMENT_JP = {
  bankName: "三井住友銀行",
  branch: "目白支店　(メジロ) 677",
  accountNumber: "6970894",
  accountName: "グエンズイテイン"
};

/* ================= UTIL ================= */
const addMonths = (base, m) => {
  const d = new Date(base);
  d.setMonth(d.getMonth() + m);
  return d.getTime();
};

const planToMonth = p => (p === '6m' ? 6 : p === '1y' ? 12 : 1);

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

/* ================= ROLE FUNC ================= */
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

  for (const r of [...Object.values(ROLE_BY_PLAN), ...Object.values(ROLE_WAIT_BY_PLAN)])
    await m.roles.remove(r).catch(() => {});

  await m.roles.add(ROLE_BY_PLAN[plan]).catch(() => {});
}

async function removeExpiredRole(guild, userId) {
  const m = await guild.members.fetch(userId).catch(() => null);
  if (!m) return;

  for (const r of Object.values(ROLE_BY_PLAN))
    await m.roles.remove(r).catch(() => {});
}

/* ================= READY ================= */
client.once(Events.ClientReady, () => {
  console.log(`✅ Bot ready: ${client.user.tag}`);
  runReminders(); // check ngay khi start
});

/* ================= MENU + BILL ================= */
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  // ===== MENU VIP =====
  if (message.content === "!vip") {
    const embed = new EmbedBuilder()
      .setTitle("📝 ĐĂNG KÝ THÀNH VIÊN KEMINVEST")
      .setDescription(`Kính gửi quý thành viên mới và cũ.

• Hệ thống hiện tại là **bot tự động hỗ trợ thanh toán phí nhóm**.  
• Để tiếp tục sử dụng đầy đủ quyền hạn và tiện ích trong nhóm.
• Vui lòng lựa chọn các gói bên dưới để hoàn tất quy trình một cách nhanh chóng và thuận tiện.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Trân trọng cảm ơn ❤️_`)
      .setColor("#5865F2")
      .addFields(
        { name: "⭐ 1 Tháng", value: "2.000.000đ / 11.000¥" },
        { name: "⭐ 6 Tháng", value: "11.000.000đ / 60.500¥" },
        { name: "⭐ 1 Năm", value: "22.000.000đ / 121.000¥" }
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('1m').setLabel('1 Tháng').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('6m').setLabel('6 Tháng').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('1y').setLabel('1 Năm').setStyle(ButtonStyle.Danger)
    );

    return message.channel.send({ embeds: [embed], components: [row] });
  }

  // ===== NHẬN BILL ===== (DM)
  if (message.guild) return;

  const id = message.author.id;
  if (!members[id]?.plan)
    return message.reply('❌ Bạn chưa chọn gói thành viên.');

  if (message.attachments.size === 0)
    return message.reply('📸 Gửi ảnh bill.');

  const file = message.attachments.first();
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['png','jpg','jpeg'].includes(ext))
    return message.reply('❌ Chỉ chấp nhận file png/jpg.');

  const res = await fetch(file.url);
  const buffer = Buffer.from(await res.arrayBuffer());

  if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

  const path = `./uploads/${id}_${Date.now()}.png`;
  fs.writeFileSync(path, buffer);

  const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
  if (!guild) return;

  await updateWaitingRole(guild, id, members[id].plan);

  const adminCh = await client.channels.fetch(process.env.ADMIN_CHANNEL_ID).catch(() => null);
  if (!adminCh) return;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`approve_${id}`).setLabel('Approve').setStyle(ButtonStyle.Success)
  );

  await adminCh.send({
    content: `Bill từ <@${id}>`,
    files: [{ attachment: path }],
    components: [row]
  });

  message.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("✅ Đã gửi ảnh bill")
        .setDescription("Cảm ơn bạn đã thanh toán. Bạn vui lòng chờ admin duyệt nhé")
        .setColor("#00C853")
    ]
  });
});

/* ================= BUTTON ================= */
client.on(Events.InteractionCreate, async i => {
  if (!i.isButton()) return;

  const id = i.user.id;
  if (!members[id]) members[id] = { expireAt: 0 };

  // ===== CHỌN GÓI =====
  if (['1m','6m','1y'].includes(i.customId)) {
    members[id].plan = i.customId;
    saveDB();

    const embed = new EmbedBuilder()
      .setTitle("💰 Thanh toán")
      .setDescription("Chọn phương thức thanh toán")
      .setColor("#00C853");

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pay_vn').setLabel('🇻🇳 VNĐ').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('pay_jp').setLabel('🇯🇵 JPY').setStyle(ButtonStyle.Success)
    );

    return i.reply({ embeds: [embed], components: [row], ephemeral: true });
  }

  // ===== PAY VN (EMV VietQR, tự động tiền theo gói) =====
  if (i.customId === 'pay_vn') {
    const amount = PRICE_VN[members[id].plan];
    members[id].currency = 'VN';
    members[id].transferNote = `DISCORD_${id}`;
    saveDB();

    // Tạo QR VietQR chuẩn
    const qrData = createQR({
      accountName: PAYMENT_VN.accountName,
      accountNumber: PAYMENT_VN.accountNumber,
      bankCode: PAYMENT_VN.bankBin,
      amount: amount,
      addInfo: members[id].transferNote
    });

    const qrBuffer = await QRCode.toBuffer(qrData);

    const embed = new EmbedBuilder()
      .setTitle("🇻🇳 Thanh toán VNĐ")
      .setDescription(
        `💰 ${amount.toLocaleString()} VND\n👤 ${PAYMENT_VN.accountName}\n📝 ${members[id].transferNote}`
      )
      .setColor("#FFD700")
      .setImage("attachment://qr.png");

    return i.reply({
      embeds: [embed],
      files: [{ attachment: qrBuffer, name: 'qr.png' }],
      ephemeral: true
    });
  }

  // ===== PAY JP =====
  if (i.customId === 'pay_jp') {
    const amount = PRICE_JP[members[id].plan];
    members[id].currency = 'JP';
    saveDB();

    const embed = new EmbedBuilder()
      .setTitle("🇯🇵 Thanh toán JPY")
      .addFields(
        { name: "Số tiền", value: `${amount} JPY` },
        { name: "Ngân hàng", value: PAYMENT_JP.bankName },
        { name: "STK", value: PAYMENT_JP.accountNumber }
      )
      .setColor("#4CAF50");

    return i.reply({ embeds: [embed], ephemeral: true });
  }

  // ===== APPROVE =====
  if (i.customId.startsWith('approve_')) {
    const uid = i.customId.split('_')[1];
    if (!members[uid]) return i.reply({ content: "❌ User không tồn tại", ephemeral: true });

    const m = members[uid];
    const now = Date.now();

    m.expireAt = m.expireAt > now
      ? addMonths(m.expireAt, planToMonth(m.plan))
      : addMonths(now, planToMonth(m.plan));

    m.remind23 = false;

    // cache username/avatar
    try {
      const user = await client.users.fetch(uid);
      m.username = user.username;
      m.avatar = user.displayAvatarURL();
    } catch {}

    saveDB();

    const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
    if (!guild) return;

    await updateFinalRole(guild, uid, m.plan);

    return i.reply({ content: '✅ Approved', ephemeral: true });
  }
});

/* ================= REMINDER ================= */
async function runReminders() {
  const now = new Date();
  const nowTime = Date.now();
  if (!members._system) members._system = {};

  const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
  if (!guild) return;

  const list = await guild.members.fetch();

  // ====== NGÀY 23 ======
  if (now.getDate() === 23 && members._system.last23 !== key) {
    members._system.last23 = key;
    saveDB();

    for (const m of list.values()) {
      try {
        if (m.user.bot) continue;
        if (m.roles.cache.has(process.env.VIP_ROLE_ID)) continue;
        if (m.roles.cache.has(process.env.ADMIN_ROLE_ID)) continue;

        await m.send({
          embeds: [
            new EmbedBuilder()
              .setTitle("⚠️ Sắp hết hạn VIP")
              .setDescription("Gói thành viên của bạn sắp hết hạn rồi, bạn gia hạn trước ngày 25 nhé!")
              .setColor("#FFA000")
          ]
        }).catch(() => {});

        await new Promise(r => setTimeout(r, 800));
      } catch {}
    }
  }

  // ====== NGÀY 25 ======
  if (now.getDate() === 25 && members._system.last25 !== key) {
    members._system.last25 = key;
    saveDB();

    const waitingRoles = Object.values(ROLE_WAIT_BY_PLAN);

    for (const m of list.values()) {
      try {
        if (m.user.bot) continue;
        if (m.roles.cache.has(process.env.ADMIN_ROLE_ID)) continue;
        if (m.roles.cache.has(process.env.VIP_ROLE_ID)) continue;
        if (waitingRoles.some(r => m.roles.cache.has(r))) continue;

        await m.send({
          embeds: [
            new EmbedBuilder()
              .setTitle("⏰ HẠN CHÓT GIA HẠN VIP")
              .setDescription("🚨 Hôm nay là ngày cuối! Bạn chưa gia hạn VIP, vui lòng gia hạn ngay trước khi bị xóa quyền vào ngày 27.")
              .setColor("#FF0000")
          ]
        }).catch(() => {});

        await new Promise(r => setTimeout(r, 800));
      } catch {}
    }
  }

  // ====== NGÀY 27 ======
  if (now.getDate() === 27 && members._system.last27 !== key) {
    members._system.last27 = key;
    saveDB();

    for (const id in members) {
      if (id === '_system') continue;
      const m = members[id];
      if (m.expireAt && m.expireAt < nowTime) {
        await removeExpiredRole(guild, id);
      }
    }
  }
}

// Reminder mỗi 1 giờ
setInterval(runReminders, 3600000);

/* ================= DASHBOARD ================= */
app.get('/dashboard', async (req, res) => {
  let totalVN = 0, totalJP = 0;
  let active = 0, expired = 0;
  const now = Date.now();
  let rows = "";

  for (const id in members) {
    if (id === '_system') continue;
    const m = members[id];

    if (m.plan && m.currency === 'VN') totalVN += PRICE_VN[m.plan] || 0;
    if (m.plan && m.currency === 'JP') totalJP += PRICE_JP[m.plan] || 0;

    if (m.expireAt && m.expireAt > now) active++;
    else expired++;

    const username = m.username || id;
    const avatar = m.avatar || '';

    rows += `
      <tr>
        <td><img src="${avatar}" width="30"/> ${username}</td>
        <td>${m.plan || '-'}</td>
        <td>${m.expireAt ? new Date(m.expireAt).toLocaleDateString() : '-'}</td>
      </tr>
    `;
  }

  res.send(`
  <html><body style="background:#0f172a;color:#fff;font-family:sans-serif">
  <h1>Dashboard</h1>
  VN: ${totalVN} | JP: ${totalJP} <br>
  Active: ${active} | Expired: ${expired}
  <table border="1" width="100%">${rows}</table>
  </body></html>
  `);
});

/* ================= START ================= */
app.listen(PORT, () => console.log("🌐 Dashboard running"));
client.login(process.env.TOKEN);

process.on('unhandledRejection', err => console.error('❌ Unhandled Rejection:', err.stack || err));
process.on('uncaughtException', err => console.error('❌ Uncaught Exception:', err.stack || err));

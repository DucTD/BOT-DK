require('dotenv').config();
const cron = require('node-cron');
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
const { createQR } = require('vietqr');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

/* ================= DATABASE ================= */
const DB_FILE = './members.json';
let members = {};

const loadDB = async () => {
  try { if (fs.existsSync(DB_FILE)) members = JSON.parse(await fs.promises.readFile(DB_FILE)); }
  catch (err) { console.error("❌ Lỗi đọc DB:", err); members = {}; }
};
const saveDB = async () => {
  try { await fs.promises.writeFile(DB_FILE, JSON.stringify(members, null, 2)); }
  catch (err) { console.error("❌ Lỗi ghi DB:", err); }
};
loadDB();
setInterval(saveDB, 5 * 60 * 1000);

/* ================= CONFIG ================= */
const ROLE_BY_PLAN = {
  '1m': process.env.ROLE_1T_ID,
  '6m': process.env.ROLE_6T_ID,
  '1y': process.env.ROLE_1Y_ID
};
const PRICE_VN = { '1m': 2000000, '6m': 11000000, '1y': 22000000 };
const PRICE_JP = { '1m': 11000, '6m': 60500, '1y': 121000 };
const PAYMENT_VN = { bankName: "Techcombank", bankBin: '970407', accountNumber: '86196868888', accountName: 'NGUYEN DUY THINH' };
const PAYMENT_JP = { bankName: "三井住友銀行", branch: "目白支店　(メジロ) 677", accountNumber: "6970894", accountName: "グエンズイテイン" };

const addMonths = (base, m) => { const d = new Date(base); d.setMonth(d.getMonth() + m); return d.getTime(); };
const planToMonth = p => (p === '6m' ? 6 : p === '1y' ? 12 : 1);

/* ================= ROLE FUNC ================= */
async function updateFinalRole(guild, userId, plan) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;
  for (const r of Object.values(ROLE_BY_PLAN)) await member.roles.remove(r).catch(() => {});
  await member.roles.add(ROLE_BY_PLAN[plan]).catch(() => {});
}

/* ================= VIP MENU ================= */
function vipMenu() {
  const embed = new EmbedBuilder()
    .setTitle("📝 ĐĂNG KÝ THÀNH VIÊN KEMINVEST")
    .setDescription("Kính gửi quý thành viên mới và cũ.\n• Hệ thống tự động hỗ trợ thanh toán.\n• Chọn gói bên dưới để tiếp tục.")
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
  return { embed, row };
}

/* ================= READY ================= */
client.once(Events.ClientReady, () => console.log(`✅ Bot ready: ${client.user.tag}`));

/* ================= COMMAND ================= */
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;
  if (msg.content === "!vip") {
    const { embed, row } = vipMenu();
    return msg.channel.send({ embeds: [embed], components: [row] });
  }
});

/* ================= INTERACTIONS ================= */
client.on(Events.InteractionCreate, async i => {
  if (!i.isButton()) return;
  const id = i.user.id;
  if (!members[id]) members[id] = { expireAt: 0 };
  const guild = client.guilds.cache.get(process.env.GUILD_ID);

  // ===== Chọn gói =====
  if (['1m','6m','1y'].includes(i.customId)) {
    members[id].plan = i.customId; saveDB();
    const embed = new EmbedBuilder().setTitle("💰 Thanh toán").setDescription("Chọn phương thức thanh toán").setColor("#00C853");
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pay_vn').setLabel('🇻🇳 VNĐ').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('pay_jp').setLabel('🇯🇵 JPY').setStyle(ButtonStyle.Success)
    );
    return i.reply({ embeds: [embed], components: [row], ephemeral: true });
  }

  // ===== Pay VN =====
  if (i.customId === 'pay_vn') {
    await i.deferReply({ ephemeral: true });
    const amount = PRICE_VN[members[id].plan];
    members[id].currency = 'VN';
    members[id].transferNote = `DISCORD_${id}`;
    saveDB();

    let qrString, qrBuffer;
    try {
      qrString = createQR({
        accountName: PAYMENT_VN.accountName,
        accountNumber: PAYMENT_VN.accountNumber,
        bankCode: PAYMENT_VN.bankBin,
        amount: amount,
        addInfo: members[id].transferNote
      });
      qrBuffer = await QRCode.toBuffer(qrString, { type: 'png', width: 200 });
    } catch (err) {
      console.error("❌ Lỗi tạo QR code:", err);
      return i.editReply({ content: "❌ Lỗi tạo QR code, vui lòng thử lại sau." });
    }

    const embed = new EmbedBuilder()
      .setTitle("🇻🇳 Thanh toán VNĐ")
      .setDescription(
        `💰 Số tiền: ${amount.toLocaleString()} VND\n` +
        `👤 Chủ tài khoản: ${PAYMENT_VN.accountName}\n` +
        `🏦 Ngân hàng: ${PAYMENT_VN.bankName}\n` +
        `📝 Nội dung chuyển khoản: ${members[id].transferNote}`
      )
      .setColor("#FFD700")
      .setImage("attachment://qr.png")
      .setFooter({ text: "Quét QR để thanh toán nhanh, nếu QR lỗi vui lòng dùng thông tin text trên" });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('done_payment').setLabel('✅ Đã Thanh toán').setStyle(ButtonStyle.Success)
    );

    return i.editReply({ embeds: [embed], files: [{ attachment: qrBuffer, name: 'qr.png' }], components: [row] });
  }

  // ===== Pay JP =====
  if (i.customId === 'pay_jp') {
    await i.deferReply({ ephemeral: true });
    const amount = PRICE_JP[members[id].plan];
    members[id].currency = 'JP';
    saveDB();

    const embed = new EmbedBuilder()
      .setTitle("🇯🇵 Thanh toán JPY")
      .addFields(
        { name: "Số tiền", value: `${amount} JPY` },
        { name: "Ngân hàng", value: PAYMENT_JP.bankName },
        { name: "Chi nhánh", value: PAYMENT_JP.branch },
        { name: "STK", value: PAYMENT_JP.accountNumber },
        { name: "Chủ tài khoản", value: PAYMENT_JP.accountName }
      )
      .setColor("#4CAF50");

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('done_payment').setLabel('✅ Đã Thanh toán').setStyle(ButtonStyle.Success)
    );

    return i.editReply({ embeds: [embed], components: [row] });
  }

  // ===== Đã Thanh toán (multi-image ready) =====
  if (i.customId === 'done_payment') {
    await i.reply({ content: "✅ Vui lòng gửi ảnh bill để admin phê duyệt.", ephemeral: true });

    const filter = m => m.author.id === i.user.id && m.attachments.size > 0 &&
                       m.attachments.some(a => a.contentType?.startsWith('image/'));
    const collector = i.channel.createMessageCollector({ filter, time: 5*60*1000, max: 1 });

    collector.on('collect', async m => {
      const attachment = m.attachments.find(a => a.contentType?.startsWith('image/'));
      if (!attachment) return i.followUp({ content: "❌ Vui lòng gửi ảnh hợp lệ (PNG, JPG, JPEG, WEBP).", ephemeral: true });

      const adminChannel = guild.channels.cache.get(process.env.ADMIN_CHANNEL_ID);
      if (!adminChannel) return i.followUp({ content: "❌ Không tìm thấy channel phê duyệt.", ephemeral: true });

      const embed = new EmbedBuilder()
        .setTitle("💳 Xác nhận thanh toán")
        .setDescription(`Người dùng <@${i.user.id}> gửi bill.\nGói: **${members[i.user.id].plan}**`)
        .setColor("#FFA500")
        .setImage(attachment.url)
        .setFooter({ text: "Bấm nút APPROVE nếu đã nhận tiền" });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`approve_${i.user.id}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success)
      );

      await adminChannel.send({ embeds: [embed], components: [row] });
      i.followUp({ content: "🎉 Bill đã gửi admin phê duyệt.", ephemeral: true });
    });

    collector.on('end', collected => {
      if (collected.size === 0)
        i.followUp({ content: "❌ Bạn chưa gửi bill kịp thời.", ephemeral: true });
    });
  }

  // ===== Approve admin =====
  if (i.customId.startsWith('approve_')) {
    const userId = i.customId.split('_')[1];
    const plan = members[userId]?.plan;
    if (!plan) return i.reply({ content: "❌ Không tìm thấy thông tin user.", ephemeral: true });

    members[userId].expireAt = addMonths(Date.now(), planToMonth(plan));
    saveDB();
    await updateFinalRole(guild, userId, plan);

    await i.update({ content: `✅ Đã approve VIP cho <@${userId}>!`, embeds: [], components: [] });
    const user = await client.users.fetch(userId);
    user.send(`🎉 Gói VIP **${plan}** đã được kích hoạt.`);
  }

  // ===== Open VIP menu =====
  if (i.customId === 'open_vip_menu') {
    const { embed, row } = vipMenu();
    return i.reply({ embeds: [embed], components: [row], ephemeral: true });
  }
});

/* ================= CRON 23/25/27 13h VNT ================= */
const TIMEZONE = "Asia/Ho_Chi_Minh";

// Ngày 23: nhắc gia hạn sớm
cron.schedule(`0 15 13 23 * * *`, async () => {
  for (const userId of Object.keys(members)) {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) continue;
    const embed = new EmbedBuilder()
      .setTitle("⏰ Nhắc nhở gia hạn VIP")
      .setDescription("Gói VIP của bạn sắp hết hạn. Vui lòng gia hạn sớm để tiếp tục sử dụng.")
      .setColor("#FF9800");
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('open_vip_menu').setLabel("💳 Gia hạn ngay").setStyle(ButtonStyle.Primary)
    );
    await user.send({ embeds: [embed], components: [row] }).catch(() => {});
  }
}, { timezone: TIMEZONE });

// Ngày 25: hạn chót
cron.schedule(`0 15 13 25 * * *`, async () => {
  for (const userId of Object.keys(members)) {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) continue;
    const embed = new EmbedBuilder()
      .setTitle("⚠️ Hạn chót gia hạn VIP")
      .setDescription("Gói VIP của bạn sắp hết hạn. Đây là hạn chót, hãy gia hạn ngay để không bị mất quyền lợi.")
      .setColor("#FF5722");
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('open_vip_menu').setLabel("💳 Gia hạn ngay").setStyle(ButtonStyle.Primary)
    );
    await user.send({ embeds: [embed], components: [row] }).catch(() => {});
  }
}, { timezone: TIMEZONE });

// Ngày 27: hết hạn + xóa role
cron.schedule(`0 15 13 27 * * *`, async () => {
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  for (const userId of Object.keys(members)) {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) continue;
    const embed = new EmbedBuilder()
      .setTitle("❌ VIP hết hạn")
      .setDescription("Gói VIP của bạn đã hết hạn. Quyền lợi sẽ bị tạm ngưng. Vui lòng gia hạn nếu muốn tiếp tục.")
      .setColor("#F44336");
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('open_vip_menu').setLabel("💳 Gia hạn ngay").setStyle(ButtonStyle.Primary)
    );

    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) for (const r of Object.values(ROLE_BY_PLAN)) await member.roles.remove(r).catch(() => {});

    await user.send({ embeds: [embed], components: [row] }).catch(() => {});
  }
}, { timezone: TIMEZONE });

/* ================= START BOT ================= */
client.login(process.env.TOKEN);
process.on('unhandledRejection', err => console.error('❌ Unhandled Rejection:', err.stack || err));
process.on('uncaughtException', err => console.error('❌ Uncaught Exception:', err.stack || err));

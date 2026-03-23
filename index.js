require('dotenv').config();
const cron = require('node-cron');
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const QRCode = require('qrcode');
const { createQR } = require('vietqr');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
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
const ROLE_BY_PLAN = { '1m': process.env.ROLE_1T_ID, '6m': process.env.ROLE_6T_ID, '1y': process.env.ROLE_1Y_ID };
const PRICE_VN = { '1m': 2000000, '6m': 11000000, '1y': 22000000 };
const PRICE_JP = { '1m': 11000, '6m': 60500, '1y': 121000 };
const PAYMENT_VN = { bankName: "Techcombank", bankBin: '970407', accountNumber: '86196868888', accountName: 'NGUYEN DUY THINH' };
const PAYMENT_JP = { bankName: "三井住友銀行", branch: "目白支店　(メジロ) 677", accountNumber: "6970894", accountName: "グエンズイテイン" };
const VIP_ROLE_ID = process.env.VIP_ROLE_ID;

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
    .setDescription("Kính gửi quý thành viên.\n• Hệ thống tự động hỗ trợ thanh toán.\n• Chọn gói bên dưới để tiếp tục.")
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

/* ================= STARTUP CHECK ================= */
client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot ready: ${client.user.tag}`);
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  const now = Date.now();
  for (const [id, m] of Object.entries(members)) {
    if (m.expireAt && m.expireAt <= now) {
      const member = await guild.members.fetch(id).catch(() => null);
      if (member) for (const r of Object.values(ROLE_BY_PLAN)) await member.roles.remove(r).catch(() => {});
    }
  }
  console.log("✅ Checked expired VIP roles on startup");
});

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
  if (!members[id]) members[id] = { expireAt: 0, awaitingBill: false };
  const guild = client.guilds.cache.get(process.env.GUILD_ID);

  // Chọn gói
  if (['1m','6m','1y'].includes(i.customId)) {
    members[id].plan = i.customId; 
    members[id].awaitingBill = false;
    saveDB();
    const embed = new EmbedBuilder().setTitle("💰 Thanh toán").setDescription("Chọn phương thức thanh toán").setColor("#00C853");
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pay_vn').setLabel('🇻🇳 VNĐ').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('pay_jp').setLabel('🇯🇵 JPY').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('cancel_plan').setLabel('❌ Cancel / Thay đổi plan').setStyle(ButtonStyle.Secondary)
    );
    return i.reply({ embeds: [embed], components: [row], flags: 64 });
  }

  // Cancel plan
  if (i.customId === 'cancel_plan') {
    delete members[id].plan;
    members[id].awaitingBill = false;
    saveDB();
    return i.reply({ content: "✅ Bạn đã hủy lựa chọn gói. Vui lòng chọn lại gói VIP.", flags: 64 });
  }

  // Pay VN
  if (i.customId === 'pay_vn') {
    await i.deferReply({ flags: 64 });
    if (!members[id].plan) return i.editReply({ content: "❌ Vui lòng chọn gói trước.", embeds: [], components: [] });
    members[id].currency = 'VN';
    members[id].transferNote = `DISCORD_${id}`;
    saveDB();

    let qrBuffer = null;
    try {
      const qrString = createQR({
        accountName: PAYMENT_VN.accountName,
        accountNumber: PAYMENT_VN.accountNumber,
        bankCode: PAYMENT_VN.bankBin,
        amount: PRICE_VN[members[id].plan],
        addInfo: members[id].transferNote
      });
      qrBuffer = await QRCode.toBuffer(qrString, { type: 'png', width: 350 });
    } catch { qrBuffer = null; }

    const embed = new EmbedBuilder()
      .setTitle("🇻🇳 Thanh toán VNĐ")
      .setColor("#FFD700")
      .setDescription(
        `💰 Số tiền: ${PRICE_VN[members[id].plan].toLocaleString()} VND\n` +
        `👤 Chủ tài khoản: ${PAYMENT_VN.accountName}\n` +
        `🏦 Ngân hàng: ${PAYMENT_VN.bankName}\n` +
        `💳 STK: ${PAYMENT_VN.accountNumber}\n` +
        `📷 Quét QR để thanh toán nhanh hoặc sử dụng thông tin trên nếu QR lỗi.`
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('done_payment').setLabel('✅ Đã Thanh toán').setStyle(ButtonStyle.Success)
    );

    return i.editReply({ embeds: [embed], files: qrBuffer ? [{ attachment: qrBuffer, name: 'qr.png' }] : [], components: [row] });
  }

  // Pay JP
  if (i.customId === 'pay_jp') {
    await i.deferReply({ flags: 64 });
    if (!members[id].plan) return i.editReply({ content: "❌ Vui lòng chọn gói trước.", embeds: [], components: [] });
    members[id].currency = 'JP';
    saveDB();

    const embed = new EmbedBuilder()
      .setTitle("🇯🇵 Thanh toán JPY")
      .addFields(
        { name: "Số tiền", value: `${PRICE_JP[members[id].plan]} JPY` },
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

  // Done payment
  if (i.customId === 'done_payment') {
    if (!members[id].plan) return i.reply({ content: "❌ Vui lòng chọn gói trước.", flags: 64 });

    members[id].awaitingBill = true;
    saveDB();

    await i.reply({ content: "✅ Vui lòng gửi ảnh bill để admin phê duyệt.", flags: 64 });

    const dm = await i.user.createDM();
    const filter = m => m.author.id === id && m.attachments.size > 0 && m.attachments.some(a => a.contentType?.startsWith('image/'));
    const collector = dm.createMessageCollector({ filter, time: 5*60*1000, max: 1 });

    setTimeout(() => {
      if (!collector.ended) dm.send("⌛ Bạn còn 1 phút để gửi bill, nếu không sẽ hủy.").catch(() => {});
    }, 4*60*1000);

    collector.on('collect', async m => {
      const attachment = m.attachments.find(a => a.contentType?.startsWith('image/'));
      if (!attachment) return dm.send("❌ Vui lòng gửi ảnh hợp lệ.").catch(() => {});

      const adminChannel = guild.channels.cache.get(process.env.ADMIN_CHANNEL_ID);
      if (!adminChannel) return dm.send("❌ Không tìm thấy channel phê duyệt.").catch(() => {});

      const embed = new EmbedBuilder()
        .setTitle("💳 Xác nhận thanh toán")
        .setDescription(`Người dùng <@${id}> gửi bill.\nGói: **${members[id].plan}**`)
        .setColor("#FFA500")
        .setImage(attachment.url)
        .setFooter({ text: "Bấm nút APPROVE nếu đã nhận tiền" });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`approve_${id}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success)
      );

      await adminChannel.send({ embeds: [embed], components: [row] });
      dm.send("🎉 Bill đã gửi admin phê duyệt.").catch(() => {});
    });

    collector.on('end', collected => {
      members[id].awaitingBill = false;
      saveDB();
      if (collected.size === 0) dm.send("❌ Bạn chưa gửi bill kịp thời.").catch(() => {});
    });
  }

  // Approve admin (an toàn + disable button)
  if (i.customId.startsWith('approve_')) {
    const userId = String(i.customId.split('_')[1]);
    const memberData = members[userId];
    if (!memberData) return i.reply({ content: `❌ Không tìm thấy user ${userId} trong DB.`, flags: 64 });

    const plan = memberData.plan;
    if (!plan) return i.reply({ content: "❌ User chưa chọn gói VIP.", flags: 64 });

    memberData.expireAt = addMonths(Math.max(Date.now(), memberData.expireAt || 0), planToMonth(plan));
    memberData.awaitingBill = false;
    saveDB();

    const member = await guild.members.fetch(userId).catch(err => {
      console.warn(`[WARN] Không fetch được user ${userId}:`, err.message);
      return null;
    });
    if (member) await updateFinalRole(guild, userId, plan);

    // Disable button + update embed
    if (i.message.components.length > 0) {
      i.message.components.forEach(row => row.components.forEach(c => c.setDisabled(true)));
      const embed = EmbedBuilder.from(i.message.embeds[0])
        .setFooter({ text: `✅ Approved bởi ${i.user.tag}` })
        .setColor("#00C853");
      await i.update({ content: null, embeds: [embed], components: i.message.components });
    }

    // Gửi DM cho user nếu fetch được
    const user = await client.users.fetch(userId).catch(() => null);
    if (user) {
      user.send(`🎉 Gói VIP **${plan}** đã được kích hoạt.\n📅 Hết hạn: ${new Date(memberData.expireAt).toLocaleDateString('vi-VN')}`).catch(() => {});
    }

    const logLine = `[${new Date().toISOString()}] User ${userId} Plan ${plan} Approved by ${i.user.id}\n`;
    fs.appendFileSync('./approve.log', logLine);
  }

  // Open VIP menu
  if (i.customId === 'open_vip_menu') {
    const { embed, row } = vipMenu();
    return i.reply({ embeds: [embed], components: [row], flags: 64 });
  }
});

/* ================= CRON REMINDERS ================= */
async function sendDMInBatches(userIds, embed, row, batchSize = 10) {
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  const filteredIds = [];

  for (const id of userIds) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (!member) continue;
    if (VIP_ROLE_ID && member.roles.cache.has(VIP_ROLE_ID)) continue;
    if (members[id]?.awaitingBill) continue;
    filteredIds.push(id);
  }

  for (let i = 0; i < filteredIds.length; i += batchSize) {
    const batch = filteredIds.slice(i, i + batchSize);
    await Promise.all(batch.map(async id => {
      const user = await client.users.fetch(id).catch(() => null);
      if (user) await user.send({ embeds: [embed], components: [row] }).catch(() => {});
    }));
    await new Promise(res => setTimeout(res, 1000));
  }
}

// Ngày 23
cron.schedule(`0 0 11 23 * *`, async () => {
  const embed = new EmbedBuilder().setTitle("⏰ Nhắc nhở gia hạn VIP").setDescription("Gói VIP của bạn sắp hết hạn. Vui lòng gia hạn sớm để tiếp tục sử dụng.").setColor("#FF9800");
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_vip_menu').setLabel("💳 Gia hạn ngay").setStyle(ButtonStyle.Primary));
  await sendDMInBatches(Object.keys(members), embed, row);
}, { timezone: "Asia/Ho_Chi_Minh" });

// Ngày 25
cron.schedule(`0 0 11 25 * *`, async () => {
  const embed = new EmbedBuilder().setTitle("⚠️ Hạn chót gia hạn VIP").setDescription("Gói VIP của bạn sắp hết hạn. Đây là hạn chót, hãy gia hạn ngay để không bị mất quyền lợi.").setColor("#FF5722");
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_vip_menu').setLabel("💳 Gia hạn ngay").setStyle(ButtonStyle.Primary));
  await sendDMInBatches(Object.keys(members), embed, row);
}, { timezone: "Asia/Ho_Chi_Minh" });

// Ngày 27: hết hạn
cron.schedule(`0 0 11 27 * *`, async () => {
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  const embed = new EmbedBuilder().setTitle("❌ VIP hết hạn").setDescription("Gói VIP của bạn đã hết hạn. Quyền lợi sẽ bị tạm ngưng. Vui lòng gia hạn nếu muốn tiếp tục.").setColor("#F44336");
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_vip_menu').setLabel("💳 Gia hạn ngay").setStyle(ButtonStyle.Primary));
  for (const userId of Object.keys(members)) {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) continue;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) continue;
    if (VIP_ROLE_ID && member.roles.cache.has(VIP_ROLE_ID)) continue;
    if (members[userId]?.awaitingBill) continue;
    await user.send({ embeds: [embed], components: [row] }).catch(() => {});
  }
}, { timezone: "Asia/Ho_Chi_Minh" });


/* ================= START BOT ================= */
client.login(process.env.TOKEN);
process.on('unhandledRejection', e => console.error('UnhandledRejection:', e));
``

import { Telegraf, Markup } from "telegraf";
import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import cron from "node-cron";
import { connectDB, User, Appointment } from "./db.js";
import { systemPrompt } from "./prompt.js";

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const app = express();
const PORT = process.env.PORT || 3001;

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const SHOP_NAME = process.env.SHOP_NAME || "Վարսավիրանոց";
const SERVICE_DURATION = { Haircut: 60, Beard: 30 };
const userStates = {};

connectDB();

// ---------------------------------------------------------
// ՕԺԱՆԴԱԿ ՖՈՒՆԿՑԻԱՆԵՐ ԵՎ ՄԵՆՅՈՒ
// ---------------------------------------------------------
const mainKeyboard = Markup.keyboard([
    ["📅 Ամրագրել ժամ"],
    ["ℹ️ Ծառայություններ և գներ", "📞 Կապ"],
    ["⚙️ Իմ տվյալները"]
]).resize();

function formatDate(date) {
    return new Date(date).toLocaleDateString("hy-AM", { year: "numeric", month: "long", day: "numeric" });
}

function getArmeniaNow() {
    return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Yerevan" }));
}

async function getAvailableSlots(date) {
    const slots = [];
    const startHour = 9, endHour = 20;
    const nowInArmenia = getArmeniaNow();
    
    const dStart = new Date(date); dStart.setHours(0, 0, 0, 0);
    const dEnd = new Date(date); dEnd.setHours(23, 59, 59, 999);
    const appointments = await Appointment.find({ startTime: { $gte: dStart, $lte: dEnd } });

    for (let h = startHour; h < endHour; h++) {
        const sTime = new Date(date);
        sTime.setHours(h, 0, 0, 0);
        if (sTime.getTime() < nowInArmenia.getTime()) continue;
        const isBusy = appointments.some((a) => sTime.getTime() >= a.startTime.getTime() && sTime.getTime() < a.endTime.getTime());
        if (!isBusy) slots.push({ time: `${h.toString().padStart(2, "0")}:00`, date: sTime });
    }
    return slots;
}

// ---------------------------------------------------------
// ԳՈՐԾՈՂՈՒԹՅՈՒՆՆԵՐ (Actions)
// ---------------------------------------------------------

bot.action("cancel_booking", async (ctx) => {
    const userId = ctx.from.id;
    const apt = await Appointment.findOne({ telegramId: userId, startTime: { $gte: getArmeniaNow() } });
    if (apt) {
        const user = await User.findOne({ telegramId: userId });
        const timeStr = `${apt.startTime.getHours().toString().padStart(2, "0")}:00`;
        await Appointment.deleteOne({ _id: apt._id });
        await ctx.editMessageText(`❌ **Ամրագրումը չեղարկված է:**\n${formatDate(apt.startTime)}, ժամը ${timeStr}`, { parse_mode: "Markdown" });
        bot.telegram.sendMessage(ADMIN_CHAT_ID, `⚠️ **ՉԵՂԱՐԿՈՒՄ**\n👤 ${user?.name}\n📅 ${formatDate(apt.startTime)}\n⏰ ${timeStr}`);
    }
    await ctx.answerCbQuery();
});

bot.action("change_name", async (ctx) => {
    userStates[ctx.from.id] = { step: "waiting_for_name" };
    await ctx.reply("Մուտքագրեք Ձեր նոր անունը. ✍️");
    await ctx.answerCbQuery();
});

// ---------------------------------------------------------
// ՀԻՄՆԱԿԱՆ ՏԵՔՍՏԱՅԻՆ ՄՇԱԿՈՒՄ (AI + Անվան փոփոխություն)
// ---------------------------------------------------------

bot.on("text", async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text;

    // 1. Անվան փոփոխության տրամաբանություն
    if (userStates[userId]?.step === "waiting_for_name") {
        if (text.length < 2) return ctx.reply("Անունը շատ կարճ է:");
        await User.findOneAndUpdate({ telegramId: userId }, { name: text.trim() });
        await Appointment.updateMany({ telegramId: userId, startTime: { $gte: getArmeniaNow() } }, { userName: text.trim() });
        delete userStates[userId];
        return ctx.reply(`✅ Անունը թարմացվեց՝ **${text.trim()}**`, mainKeyboard);
    }

    // 2. Մենյուի կոճակների զտում
    const mainButtons = ["📅 Ամրագրել ժամ", "ℹ️ Ծառայություններ և գներ", "📞 Կապ", "⚙️ Իմ տվյալները"];
    if (mainButtons.includes(text)) return;

    // 3. AI Պատասխան (Retrieval-Augmented Generation)
    try {
        const todaySlots = await getAvailableSlots(getArmeniaNow());
        const slotsInfo = todaySlots.length > 0 
            ? `Այսօրվա ազատ ժամերն են՝ ${todaySlots.map(s => s.time).join(", ")}:` 
            : "Այսօրվա համար այլևս ազատ ժամ չկա:";

        const aiContext = `${systemPrompt}\n\nԿԱՐԵՎՈՐ: ${slotsInfo}\nԵթե հարցնեն մոտակա ժամերը, օգտագործիր այս ցուցակը:`;

        const response = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama-3.3-70b-versatile",
            messages: [{ role: "system", content: aiContext }, { role: "user", content: text }],
            temperature: 0.7,
        }, { headers: { Authorization: `Bearer ${process.env.GEMINI_API_KEY}`, "Content-Type": "application/json" } });
        
        await ctx.reply(response.data.choices[0].message.content, mainKeyboard);
    } catch (e) {
        await ctx.reply("Ներողություն, չհասկացա Ձեզ։ Օգտվեք կոճակներից։", mainKeyboard);
    }
});

// ---------------------------------------------------------
// ՄՆԱՑԱԾ ՀՐԱՄԱՆՆԵՐ
// ---------------------------------------------------------

bot.command("start", (ctx) => ctx.reply(`Բարի գալուստ ${SHOP_NAME}! 👋`, mainKeyboard));

bot.hears("📅 Ամրագրել ժամ", async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!user) return ctx.reply("Հաստատեք հեռախոսահամարը՝", Markup.keyboard([[Markup.button.contactRequest("📱 Կիսվել համարով")]]).resize().oneTime());
    ctx.reply("Ընտրեք ծառայությունը՝", Markup.inlineKeyboard([[Markup.button.callback("✂️ Կտրվածք", "service_Haircut")], [Markup.button.callback("🧔 Մորուք", "service_Beard")]]));
});

bot.action(/service_(.+)/, async (ctx) => {
    const service = ctx.match[1];
    userStates[ctx.from.id] = { service };
    const btns = [];
    for (let i = 0; i < 7; i++) {
        const d = getArmeniaNow(); d.setDate(d.getDate() + i);
        btns.push([Markup.button.callback(i === 0 ? "Այսօր" : formatDate(d).split(",")[0], `date_${d.toISOString().split("T")[0]}`)]);
    }
    ctx.editMessageText("Ընտրեք օրը՝", Markup.inlineKeyboard(btns));
});

bot.action(/date_(.+)/, async (ctx) => {
    const dateStr = ctx.match[1];
    userStates[ctx.from.id].date = dateStr;
    const slots = await getAvailableSlots(new Date(dateStr));
    const btns = slots.map((s) => [Markup.button.callback(s.time, `time_${s.time}`)]);
    ctx.editMessageText(`Ընտրեք ժամը (${dateStr}):`, Markup.inlineKeyboard(btns));
});

bot.action(/time_(.+)/, async (ctx) => {
    const time = ctx.match[1], userId = ctx.from.id, state = userStates[userId];
    const user = await User.findOne({ telegramId: userId });
    const start = new Date(state.date); start.setHours(parseInt(time.split(":")[0]), 0, 0, 0);
    const apt = new Appointment({ userId: user._id, telegramId: userId, userName: user.name, serviceType: state.service, startTime: start, endTime: new Date(start.getTime() + SERVICE_DURATION[state.service] * 60000) });
    await apt.save();
    await ctx.editMessageText(`✅ **Ամրագրված է!**\n👤 ${user.name}\n📅 ${formatDate(start)}\n⏰ ${time}`, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Չեղարկել", "cancel_booking")]]) });
    bot.telegram.sendMessage(ADMIN_CHAT_ID, `🔔 **Նոր ամրագրում**\n👤 ${user.name}\n📱 ${user.phoneNumber}\n⏰ ${time}`);
    delete userStates[userId];
});

bot.hears("⚙️ Իմ տվյալները", async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!user) return ctx.reply("Դուք գրանցված չեք։");
    const activeApt = await Appointment.findOne({ telegramId: ctx.from.id, startTime: { $gte: getArmeniaNow() } });
    let msg = `👤 **Անուն:** ${user.name}\n📱 **Համար:** ${user.phoneNumber}\n`;
    const btns = [[Markup.button.callback("🔄 Փոխել անունը", "change_name")]];
    if (activeApt) {
        msg += `\n✅ **Ամրագրում:** ${formatDate(activeApt.startTime)}, ժամը ${activeApt.startTime.getHours()}:00`;
        btns.push([Markup.button.callback("❌ Չեղարկել ամրագրումը", "cancel_booking")]);
    }
    await ctx.reply(msg, { parse_mode: "Markdown", ...Markup.inlineKeyboard(btns) });
});

bot.on("contact", async (ctx) => {
    const contact = ctx.message.contact;
    await User.findOneAndUpdate({ telegramId: ctx.from.id }, { name: contact.first_name, phoneNumber: contact.phone_number }, { upsert: true });
    await ctx.reply(`✅ Շնորհակալություն։`, mainKeyboard);
});

bot.hears("ℹ️ Ծառայություններ և գներ", (ctx) => ctx.reply(`📋 ✂️ Կտրվածք: ${process.env.HAIRCUT_PRICE}\n🧔 Մորուք: ${process.env.BEARD_PRICE}`, mainKeyboard));
bot.hears("📞 Կապ", (ctx) => ctx.reply(`📞 Կապ: ${process.env.CONTACT_INFO}`, mainKeyboard));

cron.schedule("0 3 * * *", async () => {
    const today = getArmeniaNow(); today.setHours(0, 0, 0, 0);
    await Appointment.deleteMany({ startTime: { $lt: today } });
}, { timezone: "Asia/Yerevan" });

app.get("/", (req, res) => res.send("🤖 Bot Active"));
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Port: ${PORT}`));
bot.launch();
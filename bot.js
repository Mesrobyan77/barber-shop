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
const HAIRCUT_PRICE = process.env.HAIRCUT_PRICE;
const BEARD_PRICE = process.env.BEARD_PRICE;
const CONTACT_INFO = process.env.CONTACT_INFO;

const SERVICE_DURATION = { Haircut: 60, Beard: 30 };
const userStates = {};

connectDB();

// ---------------------------------------------------------
// 1. ՕԺԱՆԴԱԿ ՖՈՒՆԿՑԻԱՆԵՐ (Timezone Fix)
// ---------------------------------------------------------
const mainKeyboard = Markup.keyboard([
    ["📅 Ամրագրել ժամ"],
    ["ℹ️ Ծառայություններ և գներ", "📞 Կապ"],
    ["⚙️ Իմ տվյալները"]
]).resize();

function formatDate(date) {
    return new Date(date).toLocaleDateString("hy-AM", { year: "numeric", month: "long", day: "numeric" });
}

// Ստանում ենք Հայաստանի ներկա ժամանակը անկախ սերվերի տեղից
function getArmeniaNow() {
    return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Yerevan" }));
}

async function getAvailableSlots(date) {
    const slots = [];
    const startHour = 9, endHour = 20;
    const nowInArmenia = getArmeniaNow();
    
    const dStart = new Date(date);
    dStart.setHours(0, 0, 0, 0);
    const dEnd = new Date(date);
    dEnd.setHours(23, 59, 59, 999);

    const appointments = await Appointment.find({ startTime: { $gte: dStart, $lte: dEnd } });

    for (let h = startHour; h < endHour; h++) {
        const sTime = new Date(date);
        sTime.setHours(h, 0, 0, 0);

        // Համեմատում ենք Հայաստանի իրական ժամանակի հետ
        if (sTime.getTime() < nowInArmenia.getTime()) continue;

        const isBusy = appointments.some((a) => 
            sTime.getTime() >= a.startTime.getTime() && sTime.getTime() < a.endTime.getTime()
        );

        if (!isBusy) {
            slots.push({ time: `${h.toString().padStart(2, "0")}:00`, date: sTime });
        }
    }
    return slots;
}

async function getNearestSlot() {
    for (let i = 0; i < 7; i++) {
        const d = getArmeniaNow();
        d.setDate(d.getDate() + i);
        const slots = await getAvailableSlots(d);
        if (slots.length > 0) {
            return { day: i === 0 ? "Այսօր" : formatDate(d), time: slots[0].time };
        }
    }
    return null;
}

// ---------------------------------------------------------
// 2. AI ՊԱՏԱՍԽԱՆ (Groq API)
// ---------------------------------------------------------
async function getAIResponse(userMessage) {
    try {
        const response = await axios.post(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                model: "llama-3.3-70b-versatile",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userMessage },
                ],
                temperature: 0,
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.GEMINI_API_KEY}`,
                    "Content-Type": "application/json",
                },
            }
        );
        return response.data.choices[0].message.content;
    } catch (error) {
        return `Ներողություն, տեխնիկական խնդիր: Խնդրում եմ օգտվել կոճակներից:`;
    }
}

// ---------------------------------------------------------
// 3. ACTIONS (Չեղարկում + Ադմինի Notify)
// ---------------------------------------------------------

bot.action("cancel_booking", async (ctx) => {
    const userId = ctx.from.id;
    const now = getArmeniaNow();
    
    // Գտնում ենք տվյալները նախքան ջնջելը
    const apt = await Appointment.findOne({ telegramId: userId, startTime: { $gte: now } });

    if (apt) {
        const user = await User.findOne({ telegramId: userId });
        const timeStr = `${apt.startTime.getHours().toString().padStart(2, "0")}:00`;
        const dateStr = formatDate(apt.startTime);

        await Appointment.deleteOne({ _id: apt._id });

        // Օգտատիրոջ հաղորդագրության թարմացում
        await ctx.editMessageText(`❌ **Ամրագրումը չեղարկված է:**\n\n${dateStr}, ժամը ${timeStr} նորից ազատ է:`, { parse_mode: "Markdown" });

        // Ադմինին նամակ ուղարկելը
        const adminMsg = `⚠️ **ՉԵՂԱՐԿՈՒՄ**\n\n👤 Հաճախորդ: ${user ? user.name : apt.userName}\n📱 Համար: ${user ? user.phoneNumber : 'Անհայտ'}\n📅 Օր: ${dateStr}\n⏰ Ժամ: ${timeStr}`;
        bot.telegram.sendMessage(ADMIN_CHAT_ID, adminMsg, { parse_mode: "Markdown" });
    } else {
        await ctx.answerCbQuery("Ակտիվ ամրագրում չգտնվեց:", { show_alert: true });
    }
    await ctx.answerCbQuery();
});

// ---------------------------------------------------------
// 4. ՄԵՆՅՈՒ ԵՎ ՀՐԱՄԱՆՆԵՐ
// ---------------------------------------------------------

bot.command("start", async (ctx) => {
    const keyboard = Markup.keyboard([
        ["📅 Ամրագրել ժամ"],
        ["ℹ️ Ծառայություններ և գներ", "📞 Կապ"],
        ["⚙️ Իմ տվյալները"]
    ]).resize();
    await ctx.reply(`Բարի գալուստ ${SHOP_NAME}! 👋`, keyboard);
});

bot.hears("📅 Ամրագրել ժամ", async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!user) {
        return ctx.reply("Ամրագրման համար հաստատեք հեռախոսահամարը՝", 
            Markup.keyboard([[Markup.button.contactRequest("📱 Կիսվել հեռախոսահամարով")], ["🔙 Չեղարկել"]]).resize().oneTime());
    }
    userStates[ctx.from.id] = { step: "select_service" };
    await ctx.reply("Ընտրեք ծառայությունը՝", Markup.inlineKeyboard([
        [Markup.button.callback("✂️ Կտրվածք", "service_Haircut")],
        [Markup.button.callback("🧔 Մորուք", "service_Beard")]
    ]));
});

bot.action(/service_(.+)/, async (ctx) => {
    const service = ctx.match[1];
    userStates[ctx.from.id] = { service };
    const btns = [];
    for (let i = 0; i < 7; i++) {
        const d = getArmeniaNow();
        d.setDate(d.getDate() + i);
        btns.push([Markup.button.callback(i === 0 ? "Այսօր" : formatDate(d).split(",")[0], `date_${d.toISOString().split("T")[0]}`)]);
    }
    await ctx.editMessageText("Ո՞ր օրն եք ցանկանում ամրագրել։", Markup.inlineKeyboard(btns));
});

bot.action(/date_(.+)/, async (ctx) => {
    const dateStr = ctx.match[1];
    userStates[ctx.from.id].date = dateStr;
    const slots = await getAvailableSlots(new Date(dateStr));

    if (slots.length === 0) {
        return ctx.editMessageText("Այս օրվա համար ազատ ժամեր չկան։ Ընտրեք այլ օր։");
    }

    const btns = slots.map((s) => [Markup.button.callback(s.time, `time_${s.time}`)]);
    await ctx.editMessageText(`Ընտրեք ժամը (${dateStr}):`, Markup.inlineKeyboard(btns));
});

bot.action(/time_(.+)/, async (ctx) => {
    const time = ctx.match[1], userId = ctx.from.id, state = userStates[userId];
    const user = await User.findOne({ telegramId: userId });

    const start = new Date(state.date);
    start.setHours(parseInt(time.split(":")[0]), 0, 0, 0);

    const apt = new Appointment({
        userId: user._id,
        telegramId: userId,
        userName: user.name,
        serviceType: state.service,
        startTime: start,
        endTime: new Date(start.getTime() + SERVICE_DURATION[state.service] * 60000)
    });
    await apt.save();

    await ctx.editMessageText(
        `✅ **Ամրագրված է!**\n\n👤 ${user.name}\n✂️ ${state.service}\n📅 ${formatDate(start)}\n⏰ ${time}`, 
        { 
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("❌ Չեղարկել այս ամրագրումը", "cancel_booking")]])
        }
    );

    bot.telegram.sendMessage(ADMIN_CHAT_ID, `🔔 **Նոր ամրագրում**\n👤 ${user.name}\n📱 ${user.phoneNumber}\n⏰ ${time} (${formatDate(start)})`, { parse_mode: "Markdown" });
    delete userStates[userId];
});

bot.hears("⚙️ Իմ տվյալները", async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!user) return ctx.reply("Դուք գրանցված չեք։");
    
    const activeApt = await Appointment.findOne({ telegramId: ctx.from.id, startTime: { $gte: getArmeniaNow() } });
    let msg = `👤 Անուն: ${user.name}\n📱 Համար: ${user.phoneNumber}\n`;
    const btns = [[Markup.button.callback("🔄 Փոխել հեռախոսահամարը", "change_phone")]];
    
    if (activeApt) {
        msg += `\n✅ Ակտիվ ամրագրում: ${formatDate(activeApt.startTime)}, ${activeApt.startTime.getHours()}:00`;
        btns.push([Markup.button.callback("❌ Չեղարկել ամրագրումը", "cancel_booking")]);
    } else {
        const nearest = await getNearestSlot();
        if (nearest) msg += `\n✨ Ամենամոտ ազատ ժամը: ${nearest.day}, ${nearest.time}`;
    }
    await ctx.reply(msg, Markup.inlineKeyboard(btns));
});

bot.on("text", async (ctx) => {
    const text = ctx.message.text;

    // 1. Եթե սեղմվել է հիմնական կոճակներից մեկը, AI-ն չպետք է խառնվի
    const mainButtons = ["📅 Ամրագրել ժամ", "ℹ️ Ծառայություններ և գներ", "📞 Կապ", "⚙️ Իմ տվյալները", "🔙 Չեղարկել"];
    if (mainButtons.includes(text)) return;

    // 2. Ուղարկում ենք հարցը AI-ին
    const aiRes = await getAIResponse(text);

    // 3. Պատասխանում ենք AI-ով և ՆՈՐԻՑ ՑՈՒՅՑ ՏԱԼԻՍ ԿՈՃԱԿՆԵՐԸ
    await ctx.reply(aiRes, mainKeyboard);
});

bot.hears("ℹ️ Ծառայություններ և գներ", (ctx) => ctx.reply(`📋 ✂️ Կտրվածք: ${HAIRCUT_PRICE}\n🧔 Մորուք: ${BEARD_PRICE}`));
bot.hears("📞 Կապ", (ctx) => ctx.reply(`📞 Կապ: ${CONTACT_INFO}`));

bot.on("text", async (ctx) => {
    const aiRes = await getAIResponse(ctx.message.text);
    await ctx.reply(aiRes);
});

// ---------------------------------------------------------
// 5. SERVER & CRON
// ---------------------------------------------------------

cron.schedule("0 3 * * *", async () => {
    const today = getArmeniaNow();
    today.setHours(0, 0, 0, 0);
    await Appointment.deleteMany({ startTime: { $lt: today } });
}, { timezone: "Asia/Yerevan" });

app.get("/", (req, res) => res.send("🤖 Bot Active"));
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on ${PORT}`));

bot.launch();
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
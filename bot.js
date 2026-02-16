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
// 1. ԱՎՏՈՄԱՏ ՄԱՔՐՈՒՄ (Ամեն օր 03:12)
// ---------------------------------------------------------
cron.schedule("12 3 * * *", async () => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const result = await Appointment.deleteMany({ startTime: { $lt: today } });
        const report = `🗑️ **Գիշերային մաքրում կատարված է**\n✅ Ջնջված հին ամրագրումներ: ${result.deletedCount}`;
        await bot.telegram.sendMessage(ADMIN_CHAT_ID, report, { parse_mode: "Markdown" });
    } catch (error) {
        console.error("Cron Error:", error);
    }
}, { timezone: "Asia/Yerevan" });

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
                // max_tokens: 200,
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
        console.log("*".repeat(20));
        console.log(error);
        console.log("*".repeat(20));
        return `Ներողություն, ես կարող եմ պատասխանել միայն վարսավիրանոցի ծառայություններին վերաբերող հարցերին։ 😊 Մեզ մոտ կտրվածքը ${HAIRCUT_PRICE} է, մորուքը՝ ${BEARD_PRICE}: 😊 Ամրագրելու համար սեղմեք համապատասխան կոճակը:`;
    }
}

// ---------------------------------------------------------
// 3. ՕԺԱՆԴԱԿ ՖՈՒՆԿՑԻԱՆԵՐ
// ---------------------------------------------------------
async function getAvailableSlots(date) {
    const slots = [];
    const startHour = 9, endHour = 20;
    const dStart = new Date(date).setHours(0, 0, 0, 0);
    const dEnd = new Date(date).setHours(23, 59, 59, 999);
    const appointments = await Appointment.find({ startTime: { $gte: dStart, $lte: dEnd } });

    for (let h = startHour; h < endHour; h++) {
        const sTime = new Date(date);
        sTime.setHours(h, 0, 0, 0);
        if (!appointments.some((a) => sTime >= a.startTime && sTime < a.endTime)) {
            slots.push({ time: `${h.toString().padStart(2, "0")}:00`, date: sTime });
        }
    }
    return slots;
}

function formatDate(date) {
    return new Date(date).toLocaleDateString("hy-AM", { year: "numeric", month: "long", day: "numeric" });
}

async function askPhoneNumber(ctx) {
    const userId = ctx.from.id;
    userStates[userId] = { step: "awaiting_phone" };
    await ctx.reply(
        "Ամրագրման համար անհրաժեշտ է հաստատել Ձեր հեռախոսահամարը։",
        Markup.keyboard([
            [Markup.button.contactRequest("📱 Կիսվել հեռախոսահամարով")],
            ["🔙 Չեղարկել"]
        ]).resize().oneTime()
    );
}

// ---------------------------------------------------------
// 4. BOT COMMANDS & MAIN MENU
// ---------------------------------------------------------
bot.command("start", async (ctx) => {
    const keyboard = Markup.keyboard([
        ["📅 Ամրագրել ժամ"],
        ["ℹ️ Ծառայություններ և գներ", "📞 Կապ"],
        ["⚙️ Իմ տվյալները"]
    ]).resize();
    await ctx.reply(`Բարի գալուստ ${SHOP_NAME}! 👋`, keyboard);
});

bot.hears("⚙️ Իմ տվյալները", async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!user) return ctx.reply("Դուք դեռ գրանցված չեք։");
    await ctx.reply(`👤 Անուն: ${user.name}\n📱 Համար: ${user.phoneNumber}`, 
        Markup.inlineKeyboard([[Markup.button.callback("🔄 Փոխել հեռախոսահամարը", "change_phone")]]));
});

bot.hears("📅 Ամրագրել ժամ", async (ctx) => {
    const userId = ctx.from.id;
    const user = await User.findOne({ telegramId: userId });

    if (!user) {
        return askPhoneNumber(ctx);
    }

    userStates[userId] = { step: "select_service" };
    await ctx.reply("Ընտրեք ծառայությունը՝", Markup.inlineKeyboard([
        [Markup.button.callback("✂️ Կտրվածք (60 րոպե)", "service_Haircut")],
        [Markup.button.callback("🧔 Մորուք (30 րոպե)", "service_Beard")],
    ]));
});

bot.hears("ℹ️ Ծառայություններ և գներ", (ctx) =>
    ctx.reply(`📋 Ծառայություններ՝\n✂️ Կտրվածք: ${HAIRCUT_PRICE}\n🧔 Մորուք: ${BEARD_PRICE}\n🕒 09:00 - 20:00`)
);

bot.hears("📞 Կապ", (ctx) => ctx.reply(`📞 Կապ՝ ${CONTACT_INFO}\n📍 ${SHOP_NAME}`));

bot.hears("🔙 Չեղարկել", (ctx) => {
    delete userStates[ctx.from.id];
    ctx.reply("Գործողությունը չեղարկվեց:", Markup.keyboard([
        ["📅 Ամրագրել ժամ"],
        ["ℹ️ Ծառայություններ և գներ", "📞 Կապ"]
    ]).resize());
});

// ---------------------------------------------------------
// 5. CONTACT & TEXT HANDLERS
// ---------------------------------------------------------
bot.on("contact", async (ctx) => {
    const userId = ctx.from.id;
    const contact = ctx.message.contact;

    if (contact.user_id !== userId) {
        return ctx.reply("⚠️ Խնդրում եմ կիսվել հենց Ձեր հեռախոսահամարով:");
    }

    const user = await User.findOneAndUpdate(
        { telegramId: userId },
        { 
            name: contact.first_name + (contact.last_name ? " " + contact.last_name : ""),
            phoneNumber: contact.phone_number 
        },
        { upsert: true, new: true }
    );

    userStates[userId] = { step: "select_service" };
    await ctx.reply(`✅ Շնորհակալություն, ${user.name}։ Համարը գրանցվեց։`, Markup.removeKeyboard());
    await ctx.reply("Հիմա ընտրեք ծառայությունը՝", Markup.inlineKeyboard([
        [Markup.button.callback("✂️ Կտրվածք", "service_Haircut")],
        [Markup.button.callback("🧔 Մորուք", "service_Beard")]
    ]));
});

bot.on("text", async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text;

    const confirmationWords = ["ayo", "այո", "ha", "հա", "uzum em", "ուզում եմ", "ok", "օք"];
  
  if (confirmationWords.includes(text)) {
    return ctx.reply(
      "Շատ բարի! 😊 Խնդրում եմ սեղմել ներքևի կոճակը՝ ազատ ժամերը տեսնելու և ամրագրելու համար:",
      Markup.keyboard([
        ["📅 Ամրագրել ժամ"],
        ["ℹ️ Ծառայություններ և գներ", "📞 Կապ"]
      ]).resize()
    );
  }

    // Բարևի զտում
    if (["բարև", "ողջույն", "hi", "barev"].some(b => text.toLowerCase().includes(b))) {
        return ctx.reply("Բարև ձեզ: Ինչո՞վ կարող եմ օգնել:");
    }

    // Համարի ձեռքով մուտքագրում (եթե կոճակը չի օգտագործել)
    if (userStates[userId]?.step === "awaiting_phone") {
        const phoneRegex = /^\+?[0-9]{8,15}$/;
        if (!phoneRegex.test(text)) {
            return ctx.reply("⚠️ Խնդրում եմ մուտքագրել ճիշտ հեռախոսահամար։");
        }

        const user = await User.findOneAndUpdate(
            { telegramId: userId },
            { 
                name: ctx.from.first_name + (ctx.from.last_name ? " " + ctx.from.last_name : ""), 
                phoneNumber: text 
            },
            { upsert: true, new: true }
        );

        userStates[userId] = { step: "select_service" };
        await ctx.reply(`✅ Շնորհակալություն: Համարը պահպանվեց:`, Markup.removeKeyboard());
        return ctx.reply("Հիմա ընտրեք ծառայությունը՝", Markup.inlineKeyboard([
            [Markup.button.callback("✂️ Կտրվածք", "service_Haircut")],
            [Markup.button.callback("🧔 Մորուք", "service_Beard")]
        ]));
    }

    const aiRes = await getAIResponse(text);
    await ctx.reply(aiRes);
});

// ---------------------------------------------------------
// 6. ACTIONS (Booking Process)
// ---------------------------------------------------------
bot.action("change_phone", async (ctx) => {
    await askPhoneNumber(ctx);
    await ctx.answerCbQuery();
});

bot.action(/service_(.+)/, async (ctx) => {
    const service = ctx.match[1];
    userStates[ctx.from.id] = { service, step: "select_date" };
    const btns = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date();
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
        return ctx.editMessageText("Այս օրվա համար ազատ ժամեր չկան։ Ընտրեք այլ օր։", 
            Markup.inlineKeyboard([[Markup.button.callback("« Վերադառնալ", "back_to_service")]]));
    }

    const btns = slots.map((s) => [Markup.button.callback(s.time, `time_${s.time}`)]);
    await ctx.editMessageText(`Ընտրեք ժամը (${dateStr}):`, Markup.inlineKeyboard(btns));
});

bot.action(/time_(.+)/, async (ctx) => {
    const time = ctx.match[1], userId = ctx.from.id, state = userStates[userId];
    const user = await User.findOne({ telegramId: userId });

    const start = new Date(state.date);
    start.setHours(parseInt(time.split(":")[0]), 0, 0, 0);
    const end = new Date(start.getTime() + SERVICE_DURATION[state.service] * 60000);

    const apt = new Appointment({
        userId: user._id,
        telegramId: userId,
        userName: user.name,
        serviceType: state.service,
        startTime: start,
        endTime: end,
    });
    await apt.save();

    await ctx.editMessageText(`✅ **Ամրագրված է!**\n\n👤 ${user.name}\n✂️ ${state.service}\n📅 ${formatDate(start)}\n⏰ ${time}`, { parse_mode: "Markdown" });

    bot.telegram.sendMessage(ADMIN_CHAT_ID, `🔔 **Նոր ամրագրում**\n\n👤 ${user.name}\n📱 ${user.phoneNumber}\n✂️ ${state.service}\n⏰ ${time} (${formatDate(start)})`, { parse_mode: "Markdown" });

    delete userStates[userId];
});

// ---------------------------------------------------------
// START SERVER
// ---------------------------------------------------------
app.get("/", (req, res) => res.send("🤖 Bot is active!"));
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));

bot.launch().then(() => console.log("🤖 Telegram bot started!"));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
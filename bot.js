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
// 1. ՕԺԱՆԴԱԿ ՖՈՒՆԿՑԻԱՆԵՐ
// ---------------------------------------------------------
const mainKeyboard = Markup.keyboard([
    ["📅 Ամրագրել ժամ"],
    ["ℹ️ Ծառայություններ և գներ", "📞 Կապ"],
    ["⚙️ Իմ տվյալները"]
]).resize();

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function formatDate(date) {
    return new Date(date).toLocaleDateString("hy-AM", { year: "numeric", month: "long", day: "numeric" });
}

function getArmeniaNow() {
    return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Yerevan" }));
}

async function getAIResponse(messages) {
    // Ավելացրինք Mixtral-ը որպես 3-րդ տարբերակ
    const models = [
        "llama-3.3-70b-versatile", 
        "llama-3.1-8b-instant", 
        "mixtral-8x7b-32768"
    ];
    const apiKey = process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY;

    for (const model of models) {
        try {
            const response = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
                model: model,
                messages: messages,
                temperature: 0.6,
            }, { 
                headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
                timeout: 5000 // Կրճատեցի timeout-ը, որ արագ փորձի բոլորը
            });
            
            return response.data.choices[0].message.content;
        } catch (e) {
            console.log(`⚠️ ${model} ձախողվեց: Status: ${e.response?.status}`);
            if (model === models[models.length - 1]) throw e;
        }
    }
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

async function getNearestSlot() {
    for (let i = 0; i < 7; i++) {
        const d = getArmeniaNow(); d.setDate(d.getDate() + i);
        const slots = await getAvailableSlots(d);
        if (slots.length > 0) return { day: i === 0 ? "Այսօր" : formatDate(d), time: slots[0].time };
    }
    return null;
}

// ---------------------------------------------------------
// 2. ACTIONS (Չեղարկում + Անուն փոխել)
// ---------------------------------------------------------

bot.action("cancel_booking", async (ctx) => {
    const userId = ctx.from.id;
    const apt = await Appointment.findOne({ telegramId: userId, startTime: { $gte: getArmeniaNow() } });
    if (apt) {
        const user = await User.findOne({ telegramId: userId });
        const timeStr = `${apt.startTime.getHours().toString().padStart(2, "0")}:00`;
        await Appointment.deleteOne({ _id: apt._id });
        await ctx.editMessageText(`❌ **Ամրագրումը չեղարկված է:**\n\n${formatDate(apt.startTime)}, ժամը ${timeStr} նորից ազատ է:`, { parse_mode: "Markdown" });
        bot.telegram.sendMessage(ADMIN_CHAT_ID, `⚠️ **ՉԵՂԱՐԿՈՒՄ**\n👤 ${user?.name || apt.userName}\n📅 ${formatDate(apt.startTime)}\n⏰ ${timeStr}`, { parse_mode: "Markdown" });
    }
    await ctx.answerCbQuery();
});

bot.action("change_name", async (ctx) => {
    userStates[ctx.from.id] = { step: "waiting_for_name" };
    await ctx.reply("Մուտքագրեք Ձեր նոր անունը. ✍️");
    await ctx.answerCbQuery();
});

bot.action("change_phone", async (ctx) => {
    userStates[ctx.from.id] = { step: "waiting_for_phone" };
    await ctx.reply("Մուտքագրեք Ձեր նոր հեռախոսահամարը (օրինակ՝ +37494123456) կամ կիսվեք կոնտակտով։ 📱", 
        Markup.keyboard([[Markup.button.contactRequest("📱 Կիսվել համարով"), "🔙 Չեղարկել"]]).resize().oneTime());
    await ctx.answerCbQuery();
});
// ---------------------------------------------------------
// 3. ՀԻՄՆԱԿԱՆ ՏԵՔՍՏԱՅԻՆ ՄՇԱԿՈՒՄ (AI + LOGIC)
// ---------------------------------------------------------


bot.on("text", async (ctx, next) => {
    const userId = ctx.from.id;
    const text = ctx.message.text;
    const lowerText = text.toLowerCase().trim();

    // 1. ՍՏՈՒԳՈՒՄ ԵՆՔ ԿՈՃԱԿՆԵՐԸ ՀԵՆՑ ՍԿԶԲԻՑ (Առանց Typing-ի)
    const mainButtons = ["📅 Ամրագրել ժամ", "ℹ️ Ծառայություններ և գներ", "📞 Կապ", "⚙️ Իմ տվյալները", "🔙 Չեղարկել"];
    if (mainButtons.includes(text)) {
        return next(); // Անմիջապես փոխանցում է bot.hears-ին
    }

    // 2. Անվան կամ համարի փոփոխության ստուգում
    if (userStates[userId]?.step === "waiting_for_name") {
        if (text.length < 2) return ctx.reply("Անունը շատ կարճ է:");
        await User.findOneAndUpdate({ telegramId: userId }, { name: text.trim() });
        delete userStates[userId];
        return ctx.reply(`✅ Անունը թարմացվեց՝ **${text.trim()}**`, mainKeyboard);
    }

    if (userStates[userId]?.step === "waiting_for_phone") {
        const phoneRegex = /^\+?[0-9]{9,15}$/;
        if (!phoneRegex.test(text.replace(/\s/g, ""))) {
            return ctx.reply("Խնդրում եմ մուտքագրել վավեր հեռախոսահամար:");
        }
        await User.findOneAndUpdate({ telegramId: userId }, { phoneNumber: text.trim() });
        delete userStates[userId];
        return ctx.reply(`✅ Հեռախոսահամարը թարմացվեց՝ **${text.trim()}**`, mainKeyboard);
    }

    // 3. Արագ արձագանքներ
    const confirmations = ["ayo", "ha", "ok", "այո", "հա", "լավ", "սկսենք", "uzum em"];
    if (confirmations.includes(lowerText)) {
        return ctx.reply("Շատ բարի: 😊 Խնդրում եմ սեղմել «📅 Ամրագրել ժամ» կոճակը:", mainKeyboard);
    }

    // 4. ԵԹԵ ՀԱՍԵԼ Է ԱՅՍՏԵՂ, ՈՒՐԵՄՆ ՍԱ AI-Ի ՀԱՐՑ Է
    try {
        // Typing-ը միացնում ենք ՄԻԱՅՆ այստեղ
        await ctx.sendChatAction("typing");

        const todaySlots = await getAvailableSlots(getArmeniaNow());
        const slotsInfo = todaySlots.length > 0 
            ? `Այսօրվա ազատ ժամերն են՝ ${todaySlots.map(s => s.time).join(", ")}` 
            : "Այսօրվա համար այլևս ազատ ժամ չկա:";

        const messages = [
            { role: "system", content: `${systemPrompt}\n\nԿԱՐԵՎՈՐ:\n${slotsInfo}` },
            { role: "user", content: text }
        ];

        const aiMessage = await getAIResponse(messages);

        // Delay-ն ավելացրու միայն եթե պատասխանը շատ արագ է գալիս
        await delay(1000); 
        await ctx.reply(aiMessage, mainKeyboard);

    } catch (e) {
        console.log("CRITICAL ERROR:", e.message);
        await ctx.reply("Կներեք, տեխնիկական խնդիր առաջացավ: Խնդրում եմ օգտվել կոճակներից:", mainKeyboard);
    }
});


// ---------------------------------------------------------
// 4. ՄԵՆՅՈՒԻ ՀՐԱՄԱՆՆԵՐ
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
    ctx.editMessageText("Ո՞ր օրն եք ցանկանում ամրագրել։", Markup.inlineKeyboard(btns));
});

bot.action(/date_(.+)/, async (ctx) => {
    const dateStr = ctx.match[1];
    userStates[ctx.from.id].date = dateStr;
    const slots = await getAvailableSlots(new Date(dateStr));
    if (slots.length === 0) return ctx.editMessageText("Այս օրվա համար ազատ ժամեր չկան։");
    const btns = slots.map((s) => [Markup.button.callback(s.time, `time_${s.time}`)]);
    ctx.editMessageText(`Ընտրեք ժամը (${dateStr}):`, Markup.inlineKeyboard(btns));
});

bot.action(/time_(.+)/, async (ctx) => {
    const time = ctx.match[1], userId = ctx.from.id, state = userStates[userId];
    const user = await User.findOne({ telegramId: userId });
    const start = new Date(state.date); start.setHours(parseInt(time.split(":")[0]), 0, 0, 0);

    const apt = new Appointment({
        userId: user._id, telegramId: userId, userName: user.name, serviceType: state.service,
        startTime: start, endTime: new Date(start.getTime() + SERVICE_DURATION[state.service] * 60000)
    });
    await apt.save();

    await ctx.editMessageText(`✅ **Ամրագրված է!**\n👤 ${user.name}\n📅 ${formatDate(start)}\n⏰ ${time}`, 
        { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Չեղարկել", "cancel_booking")]]) });

    bot.telegram.sendMessage(ADMIN_CHAT_ID, `🔔 **Նոր ամրագրում**\n👤 ${user.name}\n📱 ${user.phoneNumber}\n⏰ ${time} (${formatDate(start)})`);
    delete userStates[userId];
});

bot.hears("⚙️ Իմ տվյալները", async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!user) return ctx.reply("Դուք գրանցված չեք։");
    const activeApt = await Appointment.findOne({ telegramId: ctx.from.id, startTime: { $gte: getArmeniaNow() } });
    let msg = `👤 **Անուն:** ${user.name}\n📱 **Համար:** ${user.phoneNumber}\n`;
    const btns = [
        [
            Markup.button.callback("🔄 Փոխել անունը", "change_name"),
            Markup.button.callback("📱 Փոխել համարը", "change_phone")
        ]
    ];
    if (activeApt) {
        msg += `\n✅ **Ակտիվ ամրագրում:** ${formatDate(activeApt.startTime)}, ${activeApt.startTime.getHours().padStart(2, '0')}:00`;
        btns.push([Markup.button.callback("❌ Չեղարկել ամրագրումը", "cancel_booking")]);
    }else {
        const nearest = await getNearestSlot();
        if (nearest) msg += `\n✨ **Ամենամոտ ազատ ժամը:** ${nearest.day}, ${nearest.time}`;
    }
    await ctx.reply(msg, { parse_mode: "Markdown", ...Markup.inlineKeyboard(btns) });
});

bot.hears("ℹ️ Ծառայություններ և գներ", (ctx) => ctx.reply(`📋 ✂️ Կտրվածք: ${HAIRCUT_PRICE}\n🧔 Մորուք: ${BEARD_PRICE}`, mainKeyboard));
bot.hears("📞 Կապ", (ctx) => ctx.reply(`📞 Կապ: ${CONTACT_INFO}`, mainKeyboard));

bot.on("contact", async (ctx) => {
    const contact = ctx.message.contact;
    await User.findOneAndUpdate({ telegramId: ctx.from.id }, { name: contact.first_name, phoneNumber: contact.phone_number }, { upsert: true });
    await ctx.reply(`✅ Շնորհակալություն, ${contact.first_name}։ Այժմ կարող եք ամրագրել։`, mainKeyboard);
});

// ---------------------------------------------------------
// 5. SERVER & CRON
// ---------------------------------------------------------
cron.schedule("0 3 * * *", async () => {
    const today = getArmeniaNow(); today.setHours(0, 0, 0, 0);
    await Appointment.deleteMany({ startTime: { $lt: today } });
}, { timezone: "Asia/Yerevan" });

app.get("/", (req, res) => res.send("🤖 Bot Active"));
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server on ${PORT}`));

bot.launch();
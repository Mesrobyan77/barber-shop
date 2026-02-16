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

// bot.on("text", async (ctx, next) => {
//     const userId = ctx.from.id;
//     const text = ctx.message.text;
//     const lowerText = text.toLowerCase().trim();
//     await ctx.sendChatAction("typing");
//     // 1. Ստուգում ենք՝ արդյոք սա մենյուի հիմնական կոճակներից է
//     const mainButtons = ["📅 Ամրագրել ժամ", "ℹ️ Ծառայություններ և գներ", "📞 Կապ", "⚙️ Իմ տվյալները", "🔙 Չեղարկել"];
    
//     if (mainButtons.includes(text)) {
//         return next(); // Թույլ է տալիս, որ bot.hears-ը աշխատի
//     }

//     // 2. Անվան փոփոխության տրամաբանություն
//     if (userStates[userId]?.step === "waiting_for_name") {
//         if (text.length < 2) return ctx.reply("Անունը շատ կարճ է:");
//         await User.findOneAndUpdate({ telegramId: userId }, { name: text.trim() });
//         delete userStates[userId];
//         return ctx.reply(`✅ Անունը թարմացվեց՝ **${text.trim()}**`, mainKeyboard);
//     }
//     if (userStates[userId]?.step === "waiting_for_name") {
//         if (text.length < 2) return ctx.reply("Անունը շատ կարճ է:");
//         await User.findOneAndUpdate({ telegramId: userId }, { name: text.trim() });
//         delete userStates[userId];
//         return ctx.reply(`✅ Անունը թարմացվեց՝ **${text.trim()}**`, mainKeyboard);
//     }

//     // ՆՈՐ: Համարի փոփոխություն
//     if (userStates[userId]?.step === "waiting_for_phone") {
//         // Պարզ ստուգում համարի ձևաչափի համար
//         const phoneRegex = /^\+?[0-9]{9,15}$/;
//         if (!phoneRegex.test(text.replace(/\s/g, ""))) {
//             return ctx.reply("Խնդրում եմ մուտքագրել վավեր հեռախոսահամար:");
//         }
//         await User.findOneAndUpdate({ telegramId: userId }, { phoneNumber: text.trim() });
//         delete userStates[userId];
//         return ctx.reply(`✅ Հեռախոսահամարը թարմացվեց՝ **${text.trim()}**`, mainKeyboard);
//     }

//     // 3. Արագ արձագանքներ
//     const confirmations = ["ayo", "ha", "ok", "այո", "հա", "լավ", "սկսենք", "uzum em"];
//     if (confirmations.includes(lowerText)) {
//         return ctx.reply("Շատ բարի: 😊 Խնդրում եմ սեղմել «📅 Ամրագրել ժամ» կոճակը:", mainKeyboard);
//     }

//     // 4. Եթե վերևի կետերից ոչ մեկը չէ, նոր ուղարկում ենք AI-ին
//     try {
//         const todaySlots = await getAvailableSlots(getArmeniaNow());
//         const slotsInfo = todaySlots.length > 0 
//             ? `Այսօրվա ազատ ժամերն են՝ ${todaySlots.map(s => s.time).join(", ")}` 
//             : "Այսօրվա համար այլևս ազատ ժամ չկա:";

//         const aiContext = `${systemPrompt}\n\nԿԱՐԵՎՈՐ:\n${slotsInfo}\nԵթե հաճախորդը ուզում է ամրագրել, ուղարկիր նրան սեղմելու "📅 Ամրագրել ժամ" կոճակը:`;

//         const response = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
//             model: "llama-3.3-70b-versatile",
//             messages: [{ role: "system", content: aiContext }, { role: "user", content: text }],
//             temperature: 0.5,
//         }, { 
//             headers: { 
//                 "Authorization": `Bearer ${process.env.GEMINI_API_KEY}`, // Ստուգիր այս key-ի անունը (.env-ում)
//                 "Content-Type": "application/json" 
//             } 
//         });
        
//         await delay(2000);


//         await ctx.reply(response.data.choices[0].message.content, mainKeyboard);
//     } catch (e) {
//         console.error("AI Error:", e);
//         await ctx.reply("Ներողություն, չհասկացա Ձեզ: Խնդրում եմ օգտվել կոճակներից:", mainKeyboard);
//     }
// });

bot.on("text", async (ctx, next) => {
    const userId = ctx.from.id;
    const text = ctx.message.text;
    const lowerText = text.toLowerCase().trim();

    // 1. Ստուգում ենք հիմնական կոճակները (որպեսզի AI-ին չուղարկի)
    const mainButtons = ["📅 Ամրագրել ժամ", "ℹ️ Ծառայություններ և գներ", "📞 Կապ", "⚙️ Իմ տվյալները", "🔙 Չեղարկել"];
    if (mainButtons.includes(text)) {
        return next(); 
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

    // 4. Եթե հասել է այստեղ, նոր ուղարկում ենք AI-ին
    try {
        await ctx.sendChatAction("typing"); // Միացնում ենք Typing-ը միայն այստեղ

        const todaySlots = await getAvailableSlots(getArmeniaNow());
        const slotsInfo = todaySlots.length > 0 
            ? `Այսօրվա ազատ ժամերն են՝ ${todaySlots.map(s => s.time).join(", ")}` 
            : "Այսօրվա համար այլևս ազատ ժամ չկա:";

        const aiContext = `${systemPrompt}\n\nԿԱՐԵՎՈՐ:\n${slotsInfo}`;

        // ՈՒՇԱԴՐՈՒԹՅՈՒՆ: Ստուգիր API KEY-ի անունը քո .env ֆայլում (GROQ_API_KEY թե GEMINI_API_KEY)
        const apiKey = process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY;

        const response = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama-3.3-70b-versatile",
            messages: [{ role: "system", content: aiContext }, { role: "user", content: text }],
            temperature: 0.6,
        }, { 
            headers: { 
                "Authorization": `Bearer ${apiKey}`, 
                "Content-Type": "application/json" 
            },
            timeout: 10000 // 10 վայրկյան սպասելուց հետո կդադարեցնի, որ bot-ը չկախի
        });
        
        await delay(2000); // 2 վայրկյան typing էֆեկտ
        
        const aiMessage = response.data.choices[0].message.content;
        await ctx.reply(aiMessage, mainKeyboard);

    } catch (e) {
        console.error("AI ERROR DETAIL:", e.response?.data || e.message); // Սա կօգնի տեսնել իրական սխալը terminal-ում
        await ctx.reply("Կներեք, կապի հետ կապված խնդիր կա: Խնդրում եմ օգտվել կոճակներից:", mainKeyboard);
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
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
// 1. ՕԺԱՆԴԱԿ ՖՈՒՆԿՑԻԱՆԵՐ (Տրամաբանություն)
// ---------------------------------------------------------

function formatDate(date) {
    return new Date(date).toLocaleDateString("hy-AM", { year: "numeric", month: "long", day: "numeric" });
}

async function getAvailableSlots(date) {
    const slots = [];
    const startHour = 9, endHour = 20;
    const now = new Date();
    
    const dStart = new Date(date).setHours(0, 0, 0, 0);
    const dEnd = new Date(date).setHours(23, 59, 59, 999);
    const appointments = await Appointment.find({ startTime: { $gte: dStart, $lte: dEnd } });

    for (let h = startHour; h < endHour; h++) {
        const sTime = new Date(date);
        sTime.setHours(h, 0, 0, 0);

        // Ֆիլտրում. Եթե այսօրվա ժամն արդեն անցել է, այն չենք ցուցադրում
        if (sTime < now) continue;

        // Ստուգում ենք բազայում՝ արդյոք զբաղված է
        if (!appointments.some((a) => sTime >= a.startTime && sTime < a.endTime)) {
            slots.push({ time: `${h.toString().padStart(2, "0")}:00`, date: sTime });
        }
    }
    return slots;
}

async function getNearestSlot() {
    for (let i = 0; i < 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        const slots = await getAvailableSlots(d);
        if (slots.length > 0) {
            return { day: i === 0 ? "Այսօր" : formatDate(d), time: slots[0].time };
        }
    }
    return null;
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
        return `Ներողություն, ես կարող եմ պատասխանել միայն վարսավիրանոցին վերաբերող հարցերին։ 😊 Ամրագրելու համար սեղմեք համապատասխան կոճակը:`;
    }
}

// ---------------------------------------------------------
// 3. BOT COMMANDS & MAIN MENU
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
    const userId = ctx.from.id;
    const user = await User.findOne({ telegramId: userId });
    if (!user) return ctx.reply("Դուք դեռ գրանցված չեք։");

    const activeApt = await Appointment.findOne({ telegramId: userId, startTime: { $gte: new Date() } });

    let msg = `👤 Անուն: ${user.name}\n📱 Համար: ${user.phoneNumber}\n`;
    const buttons = [[Markup.button.callback("🔄 Փոխել հեռախոսահամարը", "change_phone")]];

    if (activeApt) {
        msg += `\n✅ Ակտիվ ամրագրում. ${formatDate(activeApt.startTime)}, ժամը ${activeApt.startTime.getHours()}:00`;
        buttons.push([Markup.button.callback("❌ Չեղարկել ամրագրումը", "cancel_booking")]);
    } else {
        const nearest = await getNearestSlot();
        if (nearest) msg += `\n✨ Ամենամոտ ազատ ժամը. ${nearest.day}, ${nearest.time}`;
    }

    await ctx.reply(msg, Markup.inlineKeyboard(buttons));
});

bot.action("cancel_booking", async (ctx) => {
    const userId = ctx.from.id;
    const apt = await Appointment.findOne({ telegramId: userId, startTime: { $gte: new Date() } });

    if (apt) {
        await Appointment.deleteOne({ _id: apt._id });
        await ctx.reply("✅ Ձեր ամրագրումը հաջողությամբ չեղարկվեց։ Այդ ժամը նորից ազատ է։");
    } else {
        await ctx.answerCbQuery("Ակտիվ ամրագրում չգտնվեց։", { show_alert: true });
    }
    await ctx.answerCbQuery();
});

bot.hears("📅 Ամրագրել ժամ", async (ctx) => {
    const userId = ctx.from.id;
    const user = await User.findOne({ telegramId: userId });

    if (!user) return askPhoneNumber(ctx);

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
// 4. FLOW HANDLERS (Booking & Contact)
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
            Markup.inlineKeyboard([[Markup.button.callback("« Վերադառնալ", "service_Haircut")]]));
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
    bot.telegram.sendMessage(ADMIN_CHAT_ID, `🔔 **Նոր ամրագրում**\n\n👤 ${user.name}\n📱 ${user.phoneNumber}\n✂️ ${state.service}\n⏰ ${time}`, { parse_mode: "Markdown" });
    delete userStates[userId];
});

bot.on("text", async (ctx) => {
    const text = ctx.message.text;
    const confirmationWords = ["ayo", "այո", "ha", "հա", "uzum em", "ուզում եմ", "ok", "օք"];
  
    if (confirmationWords.includes(text.toLowerCase())) {
        return ctx.reply("Շատ բարի! 😊 Սեղմեք կոճակը ամրագրելու համար:", Markup.keyboard([["📅 Ամրագրել ժամ"]]).resize());
    }

    const aiRes = await getAIResponse(text);
    await ctx.reply(aiRes);
});

// ---------------------------------------------------------
// 5. ԱՎՏՈՄԱՏ ՄԱՔՐՈՒՄ (Ամեն օր 03:12)
// ---------------------------------------------------------
cron.schedule("* * * * *", async () => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        await Appointment.deleteMany({ startTime: { $lt: today } });
    } catch (error) {
        console.error("Cron Error:", error);
    }
}, { timezone: "Asia/Yerevan" });

// ---------------------------------------------------------
// 6. SERVER START
// ---------------------------------------------------------

app.get("/", (req, res) => res.send("🤖 Bot is active!"));
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server on port ${PORT}`));

bot.launch().then(() => console.log("🤖 Telegram bot started!"));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
# Telegram Bot Usage Guide

## 🚀 Quick Start

Your Armenian Barber Shop bot is now live and running!

### Bot Information
- **Bot Username**: @ai_agent_gugushik_bot
- **Bot Link**: https://t.me/ai_agent_gugushik_bot
- **Status**: ✅ Active and running on port 3001

## 📱 How to Use the Bot

### 1. Start the Bot
Open Telegram and search for `@ai_agent_gugushik_bot` or use the link above, then type:
```
/start
```

### 2. Main Menu Options
After starting, you'll see 4 main buttons:

📅 **Ամրագրել ժամ** (Book Appointment)
- First-time users will be asked to share their phone number
- Select service: Haircut (60 min) or Beard (30 min)
- Choose date from next 7 days
- Pick available time slot
- Get confirmation and admin receives notification

ℹ️ **Ծառայություններ և գներ** (Services & Prices)
- View service list
- See prices (Haircut: 5000 AMD, Beard: 3000 AMD)
- Check working hours (Mon-Sat 9:00-20:00)

📞 **Կապ** (Contact)
- Get shop phone number
- View shop address
- Shop name and location details

💬 **Հարցնել AI-ից** (Ask AI)
- Chat with Armenian AI assistant
- Ask about services, prices, hours
- Get professional barber shop advice
- AI responds ONLY in Armenian

## 🔧 Admin Features

As an admin (ADMIN_CHAT_ID: 949468725), you'll receive:
- 🔔 Instant notifications for new bookings
- Customer name and phone number
- Service type and duration
- Appointment date and time

**Notification Format:**
```
🔔 Նոր ամրագրում

👤 [Customer Name]
📱 [Phone Number]
✂️ [Service Type]
📅 [Date]
🕐 [Start Time] - [End Time]
```

## 🗄️ Database Structure

### Users Collection
```javascript
{
  telegramId: Number (unique),
  name: String,
  phoneNumber: String,
  createdAt: Date,
  updatedAt: Date
}
```

### Appointments Collection
```javascript
{
  userId: ObjectId (ref: User),
  telegramId: Number,
  userName: String,
  serviceType: "Haircut" | "Beard",
  startTime: Date,
  endTime: Date,
  createdAt: Date,
  updatedAt: Date
}
```

## ⚡ Service Durations
- **Haircut (Կտրվածք)**: 60 minutes
- **Beard (Մորուք)**: 30 minutes

## 🛡️ Conflict Prevention

The bot automatically prevents double-booking using MongoDB overlap detection:
- Checks if requested time conflicts with existing appointments
- Shows only available time slots
- Real-time availability updates

## 🤖 AI Assistant Details

**Powered by**: Google Gemini 3 Flash Preview
**Language**: Armenian only (հայերեն)
**Purpose**: Answer barber shop questions
**Restrictions**: 
- Only responds to shop-related questions
- Politely redirects off-topic questions
- Encourages appointment booking

## 📊 Monitoring

### Health Check
```bash
curl http://localhost:3001/health
```

Response:
```json
{
  "status": "ok",
  "uptime": 123.45
}
```

### View Appointments
```bash
mongosh
use barbershop_db
db.appointments.find().pretty()
```

### View Users
```bash
db.users.find().pretty()
```

## 🔄 Bot Management

### Check if Bot is Running
```bash
ps aux | grep "node bot.js"
```

### View Bot Logs
```bash
# If using PM2 or similar
pm2 logs

# Or check process output
tail -f /path/to/bot.log
```

### Restart Bot
```bash
cd /app/backend/telegram-bot
# Kill current process
pkill -f "node bot.js"

# Start fresh
node bot.js &
```

### Development Mode (Auto-reload)
```bash
yarn dev
```

## 🌐 Shop Information

**Name**: Gentle Cut BarberShop
**Services**:
- Haircut: 5000 AMD
- Beard Trim: 3000 AMD

**Contact**: +374 77 777 777
**Address**: Yerevan, Abovyan St. 10
**Hours**: Monday-Saturday, 9:00-20:00

## 🚨 Troubleshooting

### Bot Not Responding
1. Check if process is running: `ps aux | grep bot.js`
2. Verify MongoDB is running: `mongosh --eval "db.runCommand({ping:1})"`
3. Check environment variables in `.env`
4. Review bot token validity

### Database Connection Issues
```bash
# Check MongoDB status
sudo systemctl status mongod

# Test connection
mongosh --eval "use barbershop_db; db.stats()"
```

### Gemini API Errors
- Verify API key in `.env`
- Check API quota and limits
- Review error logs in console

## 📝 Notes

- Bot supports Armenian language exclusively for user-facing messages
- Time slots are from 9:00 to 20:00
- Shows next 7 days for booking
- Maximum 8 time slots displayed per date
- Admin notifications sent immediately upon booking
- User data stored securely in MongoDB

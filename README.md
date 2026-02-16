# Armenian Barber Shop Telegram Bot

A professional Telegram bot for managing barber shop appointments with AI assistant support.

## Features

- 🤖 Armenian language AI assistant (powered by Gemini)
- 📅 Appointment booking system with time conflict detection
- ⏰ Automatic duration calculation (Haircut: 60 min, Beard: 30 min)
- 📱 Phone number collection via Telegram
- 🔔 Admin notifications for new bookings
- 🗄️ MongoDB database for persistent storage
- ⚡ Express server to keep bot alive

## Setup

1. Install dependencies:
```bash
cd /app/backend/telegram-bot
yarn install
```

2. Configure environment variables in `.env`:
- TELEGRAM_BOT_TOKEN: Get from @BotFather
- ADMIN_CHAT_ID: Your Telegram user ID
- GEMINI_API_KEY: Gemini API key
- Shop details (name, prices, contact)

3. Start the bot:
```bash
# Development mode with auto-reload
yarn dev

# Production mode
yarn start
```

## MongoDB Collections

### User Collection
- telegramId: Unique Telegram user ID
- name: User's full name
- phoneNumber: Contact number

### Appointment Collection
- userId: Reference to User
- telegramId: Telegram user ID
- userName: User's name
- serviceType: "Haircut" or "Beard"
- startTime: Appointment start time
- endTime: Calculated end time based on service duration

## Time Conflict Check

The bot prevents double-booking using MongoDB overlap query:
```javascript
const conflict = await Appointment.findOne({
  $and: [
    { startTime: { $lt: requestedEndTime } },
    { endTime: { $gt: requestedStartTime } }
  ]
});
```

## Bot Commands

- `/start` - Initialize bot and show main menu
- Main menu buttons:
  - 📅 Ամրագրել ժամ - Book appointment
  - ℹ️ Ծառայություններ և գներ - Services and prices
  - 📞 Կապ - Contact information
  - 💬 Հարցնել AI-ից - Chat with AI assistant

## Architecture

- **Telegraf**: Modern Telegram Bot framework
- **Mongoose**: MongoDB ODM with schema validation
- **Express**: HTTP server for health checks
- **Gemini AI**: Armenian language assistant
- **Nodemon**: Development auto-reload

## Booking Flow

1. User sends contact (first-time users)
2. User selects service (Haircut/Beard)
3. User selects date (next 7 days)
4. System shows available time slots
5. User confirms booking
6. Admin receives notification
7. Confirmation sent to user

## AI Assistant

The AI assistant is strictly configured to:
- Respond ONLY in Armenian language
- Answer questions about shop services, prices, hours
- Politely redirect off-topic questions to booking
- Maintain professional barber shop tone

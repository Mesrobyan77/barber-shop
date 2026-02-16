import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
// const DB_NAME = process.env.DB_NAME || 'barbershop_db';

const connectDB = async () => {
  try {
    await mongoose.connect(`${MONGO_URL}`);
    console.log('✅ MongoDB connected successfully');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// User Schema
const userSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true },
  name: { type: String, required: true },
  phoneNumber: { type: String, required: true }
}, { timestamps: true });

// Appointment Schema
const appointmentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  telegramId: { type: Number, required: true },
  userName: { type: String, required: true },
  serviceType: { type: String, enum: ['Haircut', 'Beard'], required: true },
  startTime: { type: Date, required: true },
  endTime: { type: Date, required: true }
}, { timestamps: true });

// Create indexes for efficient queries
appointmentSchema.index({ startTime: 1, endTime: 1 });

const User = mongoose.model('User', userSchema);
const Appointment = mongoose.model('Appointment', appointmentSchema);

export { connectDB, User, Appointment };

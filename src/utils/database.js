const mongoose = require("mongoose");
const config = require("../../config");

const connectDB = async () => {
  try {
    const options = {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      bufferCommands: false,
    };

    await mongoose.connect(config.MONGODB_URI, options);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("MongoDB connection timeout"));
      }, 10000); // 10 second timeout

      if (mongoose.connection.readyState === 1) {
        clearTimeout(timeout);
        resolve();
      } else {
        mongoose.connection.once("open", () => {
          clearTimeout(timeout);
          resolve();
        });
        mongoose.connection.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      }
    });

    console.log("MongoDB connected successfully");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
};

module.exports = connectDB;

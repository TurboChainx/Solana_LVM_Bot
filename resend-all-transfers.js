const sqlite3 = require("sqlite3").verbose();
const { sendTelegramNotification } = require("./index"); // Make sure it's exported
const config = require("./config");

const db = new sqlite3.Database("./transfers.db");

async function resendOldNotifications() {
  db.all("SELECT * FROM transfers", async (err, rows) => {
    if (err) {
      console.error("❌ Error reading database:", err.message);
      return;
    }

    for (const row of rows) {
      console.log(`📤 Resending notification for ${row.signature}...`);
      await sendTelegramNotification(
        row.signature,
        row.fromAddress,
        row.toAddress,
        row.amount,
        row.walletBalanceAtTime, // (Optional: you could query new balance if you want)
        row.solPrice,
        row.tokenPrice,
        row.timestamp
      );
      await new Promise(resolve => setTimeout(resolve, 500)); // small delay to avoid spamming Telegram
    }

    console.log("✅ All old notifications sent!");
    db.close();
  });
}

resendOldNotifications();

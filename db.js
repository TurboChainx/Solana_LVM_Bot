const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./transfers.db");

db.run(`CREATE TABLE IF NOT EXISTS transfers (
  signature TEXT PRIMARY KEY,
  fromAddress TEXT,
  toAddress TEXT,
  amount REAL,
  timestamp INTEGER,
  walletBalanceAtTime REAL,
  solPrice REAL,
  tokenPrice REAL
)`);

function saveTransfer({ signature, from, to, amount, timestamp, walletBalanceAtTime, solPrice, tokenPrice }){
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR IGNORE INTO transfers (signature, fromAddress, toAddress, amount, timestamp, walletBalanceAtTime, solPrice, tokenPrice) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      // Assuming solPrice and tokenPrice are constants or fetched from somewhere
      [signature, from, to, amount, timestamp, walletBalanceAtTime, solPrice, tokenPrice],
      function (err) {
        if (err) return reject(err);
        resolve(this.changes > 0);
      }
    );    
  });
}

module.exports = { saveTransfer, db };
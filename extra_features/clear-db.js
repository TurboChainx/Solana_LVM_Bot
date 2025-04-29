const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("../transfers.db");

db.run("DELETE FROM transfers", function(err) {
  if (err) {
    console.error("❌ Error clearing database:", err.message);
  } else {
    console.log("✅ All data deleted from transfers table!");
  }
  db.close();
});

const { Connection, PublicKey } = require("@solana/web3.js");
const { getAccount } = require("@solana/spl-token");
const { PythConnection } = require('@pythnetwork/client');

const fs = require('fs');
const FormData = require('form-data');

const cron = require('node-cron');
const axios = require("axios");

const { saveTransfer, db } = require("./db");
const config = require("./config");

const connection = new Connection(config.RPC_URL);
// const connection = new Connection(config.RPC_URL, "confirmed");
const pyth = new PythConnection(connection);

// Vault token accounts (real WSOL + LVM SPL token accounts)
const WSOL_VAULT = new PublicKey("3xsB6fj8zmSjs9vHNXVVneBp3Hoz8w87jcEpBC4iwMrr"); // <--- CONFIRMED WSOL VAULT
const LVM_VAULT  = new PublicKey("5KejAFhQZ8v4v4R4YxfUmL683Pu3eAPTqzPibknERYok"); // <--- CONFIRMED LVM VAULT

// const solPriceCache = {}; // memory cache to avoid too many API calls for same date
const maxRetries = 5; // max number of retries for failed requests

let isfirstRun = true; // flag to check if it's the first run
let limit = 100; // max number of transactions to fetch
let current_sol_price = 0; // max number of transactions to fetch

// Function to sleep for a specified number of milliseconds
// This is used to avoid hitting the API too hard
// and to give time for the database operations to complete
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Function to get the LVM price using Solana RPC
// This function fetches the WSOL and LVM token accounts
// and calculates the price of LVM in USD
async function getLVMPrice() {
  try {
    const WSOL_USD = current_sol_price;

    const wsolAcc = await getAccount(connection, WSOL_VAULT);
    const lvmAcc  = await getAccount(connection, LVM_VAULT);

    const wsol = Number(wsolAcc.amount) / 1e9;
    const lvm  = Number(lvmAcc.amount)  / 1e9;

    if (wsol === 0 || lvm === 0) {
      console.log("⚠️ Vaults exist, but no reserves found.");
      return;
    }

    const priceInWSOL = wsol / lvm;
    const priceInUSD = priceInWSOL * WSOL_USD;

    console.log(`✅ LVM Price: $${priceInUSD.toFixed(8)} USD`);
    console.log(`💧 Pool: ${lvm.toLocaleString()} LVM | ${wsol.toFixed(4)} WSOL`);

    return priceInUSD;
  } catch (err) {
    console.error("❌ Error:", err.message);
    return 0.000036;
  }
}

//Function to get the account details using Solana RPC
async function getSOLPrice() {
  try {
    const response = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    console.log("SOL price fetched:", response.data.solana.usd);
    current_sol_price = response.data.solana.usd; // update current sol price
    return current_sol_price; // return current sol price
  } catch (err) {
    console.error("❌ Error fetching SOL price:", err.message);
    return 150; // fallback manual SOL price
  }
}

async function getSOLPriceAtMinute(timestamp) {
  try {
    const apiKey = 'a6896b25c77d8b2bd7591708320193017506dc5bbb45af61f1a9d3f10b7e9711';
    const url = `https://min-api.cryptocompare.com/data/v2/histominute`;

    const response = await axios.get(url, {
      params: {
        fsym: 'SOL',  // Solana
        tsym: 'USD',  // Price in USD
        limit: 1,      // Get one data point for the specific minute
        toTs: timestamp,  // Timestamp for the specific minute
      },
      headers: {
        'Authorization': `Apikey ${apiKey}`,
      },
    });
    current_sol_price = response.data.Data.Data[0].close; // Get the closing price
    console.log('SOL Price at the given timestamp:', current_sol_price);
    return current_sol_price; // return current sol price
  } catch (error) {
    console.error('Error fetching SOL price:', error.message);
    return 150; // fallback manual SOL price
  }
}

// Function to get the historical SOL price using CoinGecko API
// async function getSOLPriceAtDate(dateString) {
//   if (solPriceCache[dateString]) {
//     console.log(`✅ Using cached SOL price for ${dateString}: $${solPriceCache[dateString]}`);
//     return solPriceCache[dateString]; // ✅ Use cached price if already fetched
//   }

//   try {
//     const url = `https://api.coingecko.com/api/v3/coins/solana/history?date=${dateString}`;
//     const response = await axios.get(url);
//     const price = response.data.market_data.current_price.usd;
//     solPriceCache[dateString] = price; // ✅ Save in cache
//     console.log(`SOL price on ${dateString}: $${price}`);
//     return price;
//   } catch (err) {
//     console.error(`❌ Error fetching historical SOL price for ${dateString}:`, err.message);
//     return 150; // fallback default
//   }
// }

// Function to format the date from timestamp
// This function takes a timestamp and formats it to DD-MM-YYYY
// It uses the Date object to create a new date and formats the day, month, and year
function formatDate(timestamp) {
  const date = new Date(timestamp * 1000);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}-${month}-${year}`; // format DD-MM-YYYY
}

// Function to scan new transactions using Helius API
// This function fetches the last 100 transactions for the client wallet and checks for token transfers
// If a transfer is found, it saves the transfer details to the database
// It also checks if the transfer is either from or to the client wallet
// and if the token mint matches the specified token mint
// If a transfer is found, it fetches the wallet balance at the time of the transaction
// and saves the transfer details to the database
// It also sleeps for 2 seconds after each call to avoid hitting the API too hard
async function scanTransferLVMTransactions() {
  console.log("🔍 Scanning transactions with Helius...");
  try {
    const url = `https://api.helius.xyz/v0/addresses/${config.CLIENT_WALLET}/transactions?api-key=${config.HELIUS_API_KEY}&limit=${limit}&type=TRANSFER`;
    const response = await axios.get(url);
    const txs = response.data;
    if (txs.length === 0) {
      console.log("❌ No transfer transactions found.");
      return;
    }
    console.log(`Found ${txs.length} transactions.`);
    for (const tx of txs) {

      const signature = tx.signature;
      const alreadySaved = await isSignatureSaved(signature);
      if (alreadySaved) {
        console.log(`⚡ Skipping already saved tx: ${signature}`);
        continue;
      }

      const instructions = tx.tokenTransfers || [];

      for (const transfer of instructions) {

        console.log('Token Transfers:', transfer); // Debugging

        if (transfer.mint !== config.TOKEN_MINT) continue;
        const from = transfer.fromUserAccount;
        const to = transfer.toUserAccount;
        const amount = transfer.tokenAmount;
        const signature = tx.signature;
        const timestamp = Math.floor(new Date(tx.timestamp * 1000) / 1000);
        // const dateString = formatDate(timestamp);
    
        if (from === config.CLIENT_WALLET || to === config.CLIENT_WALLET) {

          let solPrice = 0;

          if (isfirstRun) {
            console.log("⚠️ First run, skipping SOL price check.");
            // solPrice = await getSOLPriceAtDate(dateString);
            solPrice = await getSOLPriceAtMinute(timestamp);
            await sleep(2000); // sleep for 2 seconds
            
          } else {
            console.log("✅ Not first run, checking SOL price...");
            solPrice = await getSOLPrice();
            await sleep(1000); // sleep for 2 seconds
          }

          const tokenPrice = await getLVMPrice();

          const walletBalanceAtTime = await getWalletBalance(config.CLIENT_WALLET);

          const saved = await saveTransfer({
            signature,
            from,
            to,
            amount,
            timestamp,
            walletBalanceAtTime,
            solPrice, 
            tokenPrice
          });
          if (saved) {
            console.log(`💾 [New] Saved new LVM transfer: ${amount} LVM`);
            await sendTelegramNotification(signature, from, to, amount, walletBalanceAtTime, solPrice, tokenPrice, timestamp);
          }
        }
        await sleep(500); // still sleep a little after normal call
      }
    }
    limit = maxRetries; // reset limit for next scan
    isfirstRun = false;
    console.log("✅ Token Transfer transaction scan complete.");
  } catch (error) {
    console.error("❌ Error during new scan:", error.response?.data || error.message);
  }
}

// Function to get the wallet balance using Helius API
// This function fetches the token accounts for the client wallet
// and checks for the specified token mint
// If the token mint matches, it returns the balance
// If no matching token mint is found, it returns 0
async function getWalletBalance(walletAddress) {
  try {
    const response = await axios.post(`https://rpc.helius.xyz/?api-key=${config.HELIUS_API_KEY}`, {
      jsonrpc: "2.0",
      id: "1",
      method: "getTokenAccountsByOwner",
      params: [
        walletAddress,
        {
          programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          encoding: "jsonParsed"
        }
      ]
    });

    const accounts = response.data.result.value;
    for (const account of accounts) {
      const parsed = account.account.data.parsed.info;
      if (parsed.mint === config.TOKEN_MINT) {
        return parsed.tokenAmount.uiAmount;
      }
    }
    return 0;
  } catch (err) {
    console.error("❌ Error getting balance from Helius RPC:", err.message);
    return 0;
  }
}

// Function to check if the signature is already saved in the database
async function isSignatureSaved(signature) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT 1 FROM transfers WHERE signature = ?`, [signature], (err, row) => {
      if (err) {
        console.error("❌ DB Error checking signature:", err.message);
        return resolve(false);
      }
      resolve(!!row);
    });
  });
}

// Function to send a Telegram notification
// This function sends a message to the specified Telegram chat
// with the details of the transfer
// It includes the token name, amount, USD value, from and to addresses,
// SOL price, token price, and a link to view the transaction
async function sendTelegramNotification(signature, from, to, amount, walletBalanceAtTime, solPrice, tokenPrice, timestamp) {
  const usdValue = (amount * tokenPrice).toFixed(4);
  const date = new Date(timestamp * 1000);
  const isSell = from === config.CLIENT_WALLET;

  const message = `
<b>🚨🚨🚨 ${isSell ? "Sell" : "Buy"} DETECTED! 🚨🚨🚨</b>

<b>❤️ Token: ${config.TOKEN_NAME} (${config.TOKEN_SYMBOL}) </b>
<b>🚀 Amount:</b> <code>${Number(amount).toLocaleString()} <b>${config.TOKEN_SYMBOL}</b></code>
<b>💰 USD Value:</b> <code>$${usdValue}</code>
<b>🔒 From: <a href="https://solscan.io/account/${from}">${from}</a> </b>
<b>🔒 To: <a href="https://solscan.io/account/${to}">${to}</a> </b>
<b>💥 SOL Price: 1 SOL / </b><code>$${solPrice}</code>
<b>❤️ ${config.TOKEN_NAME} Price: 1 ${config.TOKEN_SYMBOL} / </b><code>$${tokenPrice}</code>
<b>💹 Client Wallet Balance:</b> <code>${Number(walletBalanceAtTime).toLocaleString()} ${config.TOKEN_SYMBOL} </code>
<b>📅 Date: </b><code>${date.toUTCString()}</code>

<a href="https://solscan.io/tx/${signature}">🔍 <b>View Transaction</b></a>
`.trim();

  try {
    if (config.BANNER_IMAGE_PATH) {
      // ✅ Send photo (banner) + caption
      const form = new FormData();
      form.append('chat_id', config.TELEGRAM_CHAT_ID);
      form.append('photo', fs.createReadStream(config.BANNER_IMAGE_PATH)); // e.g., "./banner.png"
      form.append('caption', message);
      form.append('parse_mode', 'HTML');

      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendPhoto`, form, {
        headers: form.getHeaders(),
      });
    } else {
      // ✅ Send normal text message
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: config.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      });
    }

    console.log("📩 Telegram notification sent.");
  } catch (error) {
    console.error("❌ Telegram error:", error.message);
  }
}

// Schedule the scanning function to run every minute
cron.schedule('* * * * *', async () => {
  console.log("🔍 Starting scan for past transactions and real-time monitoring...");
  await scanTransferLVMTransactions();
  // await getSOLPrice();
});

module.exports = {
  sendTelegramNotification
};
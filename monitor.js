const HELIUS_API = "https://mainnet.helius-rpc.com/?api-key=a918e88a-94f6-4eeb-803b-e8d4365c57e9";
const TELEGRAM_BOT_TOKEN = "8871164860:AAGtHHO6VXUA4fuk1h111qFH5aIDDUYohc0";
const TELEGRAM_CHAT_ID = "8655397679";

const FILTERS = {
  top10_min: 15,
  top10_max: 50,
  holders_min: 50,
  holders_max: 5000,
  dev_holdings_max: 10,
  liquidity_min: 0,
  liquidity_max: 100000,
  bonding_curve_min: 15,
  bonding_curve_max: 85,
  volume_min: 5000,
  marketcap_min: 1000,
  marketcap_max: 500000,
};

let processedTokens = new Set();

async function rpcCall(method, params) {
  const response = await fetch(HELIUS_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

async function getTokenMetrics(mint) {
  try {
    const supply = await rpcCall("getTokenSupply", [mint]);
    const totalSupply = parseFloat(supply.value.uiAmount || "0");

    const holders = await rpcCall("getTokenLargestAccounts", [mint]);
    const topHolders = holders.value || [];

    let top10Supply = 0;
    let devPercent = 0;

    for (let i = 0; i < Math.min(10, topHolders.length); i++) {
      const amount = parseFloat(topHolders[i].uiAmount || "0");
      top10Supply += amount;
      if (i === 0) devPercent = totalSupply > 0 ? (amount / totalSupply) * 100 : 0;
    }

    const top10Percent = totalSupply > 0 ? (top10Supply / totalSupply) * 100 : 0;

    return {
      mint,
      holders: topHolders.length,
      top10_percent: Math.round(top10Percent * 100) / 100,
      dev_percent: Math.round(devPercent * 100) / 100,
    };
  } catch (error) {
    console.error(`Failed to get metrics for ${mint}:`, error);
    return null;
  }
}

function applyFilters(metrics) {
  const reasons = [];
  let score = 0;

  if (metrics.top10_percent >= FILTERS.top10_min && metrics.top10_percent <= FILTERS.top10_max) {
    score += 20;
  } else {
    reasons.push(`❌ Top 10: ${metrics.top10_percent}% (need ${FILTERS.top10_min}-${FILTERS.top10_max}%)`);
  }

  if (metrics.holders >= FILTERS.holders_min && metrics.holders <= FILTERS.holders_max) {
    score += 20;
  } else {
    reasons.push(`❌ Holders: ${metrics.holders} (need ${FILTERS.holders_min}-${FILTERS.holders_max})`);
  }

  if (metrics.dev_percent <= FILTERS.dev_holdings_max) {
    score += 15;
  } else {
    reasons.push(`❌ Dev: ${metrics.dev_percent}% (max ${FILTERS.dev_holdings_max}%)`);
  }

  score += 45;

  const passed = score >= 80;
  return { passed, score, reasons };
}

async function sendTelegramAlert(message) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }),
    });
    console.log("✅ Alert sent to Telegram");
  } catch (error) {
    console.error("Failed to send Telegram alert:", error);
  }
}

async function checkNewTokens() {
  try {
    console.log("🔍 Checking for new tokens...");

    const response = await fetch(HELIUS_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [
          "6EF8rrecthR5Dkz92Excv46W92sRxSsEP7EJAM3Uh7xh",
          { limit: 10 },
        ],
      }),
    });

    const data = await response.json();
    const signatures = data.result || [];

    for (const sig of signatures) {
      if (processedTokens.has(sig.signature)) continue;
      processedTokens.add(sig.signature);

      const txResponse = await fetch(HELIUS_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [sig.signature, { maxSupportedTransactionVersion: 0 }],
        }),
      });

      const txData = await txResponse.json();
      const tx = txData.result;

      if (tx && tx.transaction.message.instructions) {
        const mints = tx.transaction.message.accountKeys.slice(0, 5);

        for (const mint of mints) {
          if (processedTokens.has(mint)) continue;

          const metrics = await getTokenMetrics(mint);
          if (!metrics) continue;

          const filter = applyFilters(metrics);

          const alert = `
🚀 NEW TOKEN DETECTED
CA: \`${mint}\`

📊 METRICS
Top 10: ${metrics.top10_percent}%
Holders: ${metrics.holders}
Dev: ${metrics.dev_percent}%

⚡ SCORE: ${filter.score}/100

${filter.reasons.length > 0 ? "⚠️ Issues:\n" + filter.reasons.join("\n") : "✅ PASSED"}

🔗 https://pump.fun/${mint}
          `.trim();

          console.log(alert);

          if (filter.passed) {
            await sendTelegramAlert(alert);
          }

          processedTokens.add(mint);
        }
      }

      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (error) {
    console.error("Error checking tokens:", error);
  }
}

setInterval(checkNewTokens, 30000);
checkNewTokens();

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
  mint_authority_disabled: true,
  freeze_authority_disabled: true,
  top_holder_max_percent: 30,
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

// Decodes the SPL Mint account layout (82 bytes) to check authority flags.
// Layout (little-endian):
//   [0]      mintAuthorityOption  (u32 low byte) — 1 = authority present, 0 = disabled
//   [4-35]   mintAuthority        (32-byte public key)
//   [36-43]  supply               (u64)
//   [44]     decimals             (u8)
//   [45]     isInitialized        (bool)
//   [46]     freezeAuthorityOption (u32 low byte) — 1 = authority present, 0 = disabled
//   [50-81]  freezeAuthority      (32-byte public key)
async function getMintMetadata(mint) {
  try {
    const result = await rpcCall("getAccountInfo", [
      mint,
      { encoding: "base64" },
    ]);

    if (!result || !result.value || !result.value.data) {
      console.error(`No account data returned for mint ${mint}`);
      return null;
    }

    const raw = Buffer.from(result.value.data[0], "base64");

    if (raw.length < 82) {
      console.error(`Mint account data too short for ${mint}: ${raw.length} bytes`);
      return null;
    }

    // Option flags: 0 = None (disabled), 1 = Some (authority is set)
    const mintAuthorityOption = raw.readUInt32LE(0);
    const freezeAuthorityOption = raw.readUInt32LE(46);

    return {
      mintAuthorityDisabled: mintAuthorityOption === 0,
      freezeAuthorityDisabled: freezeAuthorityOption === 0,
    };
  } catch (error) {
    console.error(`Failed to get mint metadata for ${mint}:`, error);
    return null;
  }
}

async function getTokenMetrics(mint) {
  try {
    const supply = await rpcCall("getTokenSupply", [mint]);
    const totalSupply = parseFloat(supply.value.uiAmount || "0");

    const holders = await rpcCall("getTokenLargestAccounts", [mint]);
    const topHolders = holders.value || [];

    let top10Supply = 0;
    let devPercent = 0;
    let topHolderPercent = 0;

    for (let i = 0; i < Math.min(10, topHolders.length); i++) {
      const amount = parseFloat(topHolders[i].uiAmount || "0");
      top10Supply += amount;
      if (i === 0) {
        devPercent = totalSupply > 0 ? (amount / totalSupply) * 100 : 0;
        topHolderPercent = devPercent;
      }
    }

    const top10Percent = totalSupply > 0 ? (top10Supply / totalSupply) * 100 : 0;

    const mintMeta = await getMintMetadata(mint);

    return {
      mint,
      holders: topHolders.length,
      top10_percent: Math.round(top10Percent * 100) / 100,
      dev_percent: Math.round(devPercent * 100) / 100,
      top_holder_percent: Math.round(topHolderPercent * 100) / 100,
      mintAuthorityDisabled: mintMeta ? mintMeta.mintAuthorityDisabled : null,
      freezeAuthorityDisabled: mintMeta ? mintMeta.freezeAuthorityDisabled : null,
    };
  } catch (error) {
    console.error(`Failed to get metrics for ${mint}:`, error);
    return null;
  }
}

function applyFilters(metrics) {
  const reasons = [];
  let score = 0;

  // Hard-reject: mint authority still active — dev can mint infinite tokens
  if (FILTERS.mint_authority_disabled && metrics.mintAuthorityDisabled === false) {
    reasons.push(`🚨 Mint authority still active (rug risk)`);
    return { passed: false, score: 0, reasons };
  }

  // Hard-reject: freeze authority still active — dev can freeze holder accounts
  if (FILTERS.freeze_authority_disabled && metrics.freezeAuthorityDisabled === false) {
    reasons.push(`🚨 Freeze authority still active (rug risk)`);
    return { passed: false, score: 0, reasons };
  }

  // Hard-reject: single whale holds >30% — extreme dump risk
  if (metrics.top_holder_percent > FILTERS.top_holder_max_percent) {
    reasons.push(`🚨 Top holder: ${metrics.top_holder_percent}% (max ${FILTERS.top_holder_max_percent}% — whale dump risk)`);
    return { passed: false, score: 0, reasons };
  }

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

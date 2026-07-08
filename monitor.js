const HELIUS_API = "https://mainnet.helius-rpc.com/?api-key=a918e88a-94f6-4eeb-803b-e8d4365c57e9";
const TELEGRAM_BOT_TOKEN = "8871164860:AAGtHHO6VXUA4fuk1h111qFH5aIDDUYohc0";
const TELEGRAM_CHAT_ID = "8655397679";
const GMGN_API_KEY = process.env.GMGN_API_KEY || null;

if (!GMGN_API_KEY) {
  console.warn("⚠️  GMGN_API_KEY not set — running with basic Helius metrics only.");
  console.warn("   Set GMGN_API_KEY to https://gmgn.ai/ai for deep metrics (volume, liquidity, rug probability, holder distribution, authorities).");
}

const FILTERS = {
  top10_min: 15,
  top10_max: 50,
  holders_min: 50,
  holders_max: 5000,
  dev_holdings_max: 10,
  top_holder_max_percent: 75,
  liquidity_min: 0,
  liquidity_max: 100000,
  bonding_curve_min: 0,
  bonding_curve_max: 85,
  volume_min: 1000,
  marketcap_min: 100,
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

async function getGMGNMetrics(ca) {
  if (!GMGN_API_KEY) {
    return null;
  }

  try {
    // Token security / authority info
    const securityRes = await fetch(
      `https://gmgn.ai/api/v1/token_security/sol/${ca}`,
      { headers: { "Authorization": `Bearer ${GMGN_API_KEY}`, "Content-Type": "application/json" } }
    );
    const securityData = await securityRes.json();
    const security = securityData?.data || {};

    // Token market / price info (volume, liquidity, bonding curve, market cap)
    const infoRes = await fetch(
      `https://gmgn.ai/api/v1/token_info/sol/${ca}`,
      { headers: { "Authorization": `Bearer ${GMGN_API_KEY}`, "Content-Type": "application/json" } }
    );
    const infoData = await infoRes.json();
    const info = infoData?.data || {};

    // Rug check / risk score
    const rugRes = await fetch(
      `https://gmgn.ai/api/v1/token_rug_check/sol/${ca}`,
      { headers: { "Authorization": `Bearer ${GMGN_API_KEY}`, "Content-Type": "application/json" } }
    );
    const rugData = await rugRes.json();
    const rug = rugData?.data || {};

    // Holder distribution
    const holderRes = await fetch(
      `https://gmgn.ai/api/v1/token_holder_stat/sol/${ca}`,
      { headers: { "Authorization": `Bearer ${GMGN_API_KEY}`, "Content-Type": "application/json" } }
    );
    const holderData = await holderRes.json();
    const holders = holderData?.data || {};

    const metrics = {
      // Volume & liquidity
      volume_24h:        info.volume_24h        ?? null,
      liquidity:         info.liquidity         ?? null,
      market_cap:        info.market_cap        ?? null,
      bonding_curve_pct: info.bonding_curve_pct ?? null,

      // Rug probability & risk
      rug_probability:   rug.rug_probability    ?? null,
      risk_score:        rug.risk_score         ?? null,
      risk_level:        rug.risk_level         ?? null,

      // Holder distribution
      holder_count:      holders.holder_count   ?? null,
      top10_pct:         holders.top10_pct      ?? null,
      dev_wallet_pct:    holders.dev_wallet_pct ?? null,
      dev_wallet_balance:holders.dev_wallet_balance ?? null,

      // Mint / freeze authority
      mint_authority:    security.mint_authority    ?? null,
      freeze_authority:  security.freeze_authority  ?? null,
      is_mintable:       security.is_mintable       ?? null,
      is_freezable:      security.is_freezable      ?? null,

      // Solana network fees (estimated from GMGN fee data)
      sol_fees_estimate: info.sol_fees_estimate ?? null,
    };

    console.log(`📡 GMGN metrics for ${ca}:`, JSON.stringify(metrics, null, 2));
    return metrics;
  } catch (error) {
    console.error(`⚠️  GMGN fetch failed for ${ca}:`, error.message);
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

    for (let i = 0; i < Math.min(10, topHolders.length); i++) {
      const amount = parseFloat(topHolders[i].uiAmount || "0");
      top10Supply += amount;
      if (i === 0) devPercent = totalSupply > 0 ? (amount / totalSupply) * 100 : 0;
    }

    const top10Percent = totalSupply > 0 ? (top10Supply / totalSupply) * 100 : 0;

    const heliusMetrics = {
      mint,
      holders: topHolders.length,
      top10_percent: Math.round(top10Percent * 100) / 100,
      dev_percent: Math.round(devPercent * 100) / 100,
    };

    // Fetch deep GMGN metrics and merge with Helius data
    const gmgn = await getGMGNMetrics(mint);
    const merged = {
      ...heliusMetrics,
      // Prefer GMGN holder count when available, fall back to Helius top-accounts length
      holders: gmgn?.holder_count ?? heliusMetrics.holders,
      top10_percent: gmgn?.top10_pct ?? heliusMetrics.top10_percent,
      dev_percent: gmgn?.dev_wallet_pct ?? heliusMetrics.dev_percent,
      // GMGN-only fields (null when API key not set)
      volume_24h:         gmgn?.volume_24h         ?? null,
      liquidity:          gmgn?.liquidity          ?? null,
      market_cap:         gmgn?.market_cap         ?? null,
      bonding_curve_pct:  gmgn?.bonding_curve_pct  ?? null,
      rug_probability:    gmgn?.rug_probability     ?? null,
      risk_score:         gmgn?.risk_score          ?? null,
      risk_level:         gmgn?.risk_level          ?? null,
      dev_wallet_balance: gmgn?.dev_wallet_balance  ?? null,
      mint_authority:     gmgn?.mint_authority      ?? null,
      freeze_authority:   gmgn?.freeze_authority    ?? null,
      is_mintable:        gmgn?.is_mintable         ?? null,
      is_freezable:       gmgn?.is_freezable        ?? null,
      sol_fees_estimate:  gmgn?.sol_fees_estimate   ?? null,
    };

    console.log(`📊 Full metrics for ${mint}:`, JSON.stringify(merged, null, 2));
    return merged;
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

  if (metrics.dev_percent > FILTERS.top_holder_max_percent) {
    reasons.push(`❌ Top holder: ${metrics.dev_percent}% (max ${FILTERS.top_holder_max_percent}% — extreme whale concentration)`);
    return { passed: false, score: 0, reasons };
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

          const gmgnLines = metrics.volume_24h !== null ? `
💧 Liquidity:    ${metrics.liquidity ?? "n/a"}
📈 Volume 24h:   ${metrics.volume_24h ?? "n/a"}
💰 Market Cap:   ${metrics.market_cap ?? "n/a"}
🎯 Bonding Curve:${metrics.bonding_curve_pct !== null ? ` ${metrics.bonding_curve_pct}%` : " n/a"}
☠️  Rug Prob:     ${metrics.rug_probability !== null ? `${metrics.rug_probability}%` : "n/a"} (risk: ${metrics.risk_level ?? "n/a"})
🏦 Dev Balance:  ${metrics.dev_wallet_balance !== null ? `${metrics.dev_wallet_balance} SOL` : "n/a"}
🔑 Mint Auth:    ${metrics.mint_authority ?? "n/a"} | Freeze: ${metrics.freeze_authority ?? "n/a"}
⛽ SOL Fees Est: ${metrics.sol_fees_estimate !== null ? `${metrics.sol_fees_estimate} SOL` : "n/a"}` : "\n⚠️  GMGN data unavailable — set GMGN_API_KEY for deep metrics";

          const alert = `
🚀 NEW TOKEN DETECTED
CA: \`${mint}\`

📊 HELIUS METRICS
Top 10: ${metrics.top10_percent}%
Holders: ${metrics.holders}
Dev: ${metrics.dev_percent}%
${gmgnLines}

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

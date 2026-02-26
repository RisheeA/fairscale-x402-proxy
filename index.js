import express from 'express';
import cors from 'cors';
import { Connection } from '@solana/web3.js';
import 'dotenv/config';

const app = express();
app.use(cors());
app.use(express.json());

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  FAIRSCALE_API_KEY: process.env.FAIRSCALE_API_KEY,
  TREASURY_WALLET: process.env.TREASURY_WALLET || 'fairAUEuR1SCcHL254Vb3F3XpUWLruJ2a11f6QfANEN',
  
  // Tiers
  TIERS: {
    free: {
      daily_limit: 100,
      features: ['basic_score'],
      rate_limit_per_minute: 10,
    },
    pro: {
      daily_limit: 10000,
      features: ['basic_score', 'full_data', 'custom_rules', 'batch'],
      rate_limit_per_minute: 100,
      price_usd_monthly: 50,
    },
    enterprise: {
      daily_limit: Infinity,
      features: ['basic_score', 'full_data', 'custom_rules', 'batch', 'webhooks', 'sla'],
      rate_limit_per_minute: 1000,
      price_usd_monthly: 500,
    },
  },
  
  // x402 upgrade pricing
  PRICES: {
    score: 50000,       // $0.05 USDC per wallet check (for upgrade)
    batch: 400000,      // $0.40 USDC per batch
    pro_monthly: 50000000, // $50 USDC
  },
  
  // Vouching (unchanged)
  VOUCH: {
    MIN_STAKE: 1000,
    MAX_VOUCHES_PER_WALLET: 5,
    SLASH_THRESHOLD: 0.25,
    MAX_BOOST: 5,
  },
  
  USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  FAIR_MINT: process.env.FAIR_MINT || 'Fairr196TRbroavk2QhRb3RRDH1ZpdWC3yJDTDDestar',
  SOLANA_RPC: process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
  PORT: process.env.PORT || 3402,
  PAYMENT_CACHE_TTL: 24 * 60 * 60 * 1000,
};

const solana = new Connection(CONFIG.SOLANA_RPC, {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 30000,
});

// =============================================================================
// IN-MEMORY STORAGE
// =============================================================================

const processedPayments = new Map();
const vouches = new Map();
const vouchIndex = {
  byVoucher: new Map(),
  byRecipient: new Map(),
};

// Rate limiting: IP/fingerprint -> { calls: [], tier }
const rateLimits = new Map();

// API keys: key -> { tier, wallet, created_at, daily_calls }
const apiKeys = new Map();

// Daily usage reset
const dailyUsage = new Map(); // key/IP -> { date, count }

// Cleanup old data
setInterval(() => {
  const now = Date.now();
  for (const [sig, timestamp] of processedPayments.entries()) {
    if (now - timestamp > CONFIG.PAYMENT_CACHE_TTL) {
      processedPayments.delete(sig);
    }
  }
  
  // Reset daily usage at midnight
  const today = new Date().toDateString();
  for (const [key, usage] of dailyUsage.entries()) {
    if (usage.date !== today) {
      dailyUsage.delete(key);
    }
  }
}, 60 * 60 * 1000);

// =============================================================================
// HELPERS
// =============================================================================

function isValidSolanaAddress(address) {
  if (!address || typeof address !== 'string') return false;
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return base58Regex.test(address);
}

function generateVouchId() {
  return 'v_' + Math.random().toString(36).substring(2, 15);
}

function generateApiKey() {
  return 'fs_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function getClientIdentifier(req) {
  // Use API key if provided, otherwise use IP
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKeys.has(apiKey)) {
    return { type: 'api_key', id: apiKey, tier: apiKeys.get(apiKey).tier };
  }
  
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown';
  return { type: 'ip', id: ip, tier: 'free' };
}

function checkRateLimit(client) {
  const tier = CONFIG.TIERS[client.tier];
  const now = Date.now();
  const oneMinuteAgo = now - 60000;
  const today = new Date().toDateString();
  
  // Get or create rate limit entry
  let limits = rateLimits.get(client.id);
  if (!limits) {
    limits = { calls: [] };
    rateLimits.set(client.id, limits);
  }
  
  // Clean old calls
  limits.calls = limits.calls.filter(t => t > oneMinuteAgo);
  
  // Check per-minute rate limit
  if (limits.calls.length >= tier.rate_limit_per_minute) {
    return { 
      allowed: false, 
      error: 'Rate limit exceeded',
      limit: tier.rate_limit_per_minute,
      reset_in_seconds: Math.ceil((limits.calls[0] + 60000 - now) / 1000),
    };
  }
  
  // Check daily limit
  let usage = dailyUsage.get(client.id);
  if (!usage || usage.date !== today) {
    usage = { date: today, count: 0 };
    dailyUsage.set(client.id, usage);
  }
  
  if (usage.count >= tier.daily_limit) {
    return {
      allowed: false,
      error: 'Daily limit exceeded',
      limit: tier.daily_limit,
      tier: client.tier,
      upgrade: client.tier === 'free' ? 'Upgrade to Pro for 10,000 calls/day' : null,
    };
  }
  
  // Record call
  limits.calls.push(now);
  usage.count++;
  
  return { 
    allowed: true, 
    remaining_today: tier.daily_limit - usage.count,
    tier: client.tier,
  };
}

// =============================================================================
// CORE API CALLS
// =============================================================================

async function getWalletScore(wallet) {
  try {
    const response = await fetch(
      `https://api.fairscale.xyz/score?wallet=${encodeURIComponent(wallet)}`,
      {
        headers: {
          'accept': 'application/json',
          'fairkey': CONFIG.FAIRSCALE_API_KEY,
        },
      }
    );
    
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    console.error('FairScale API error:', e);
    return null;
  }
}

async function getWalletDetails(wallet) {
  try {
    const response = await fetch(
      `https://api.fairscale.xyz/details?wallet=${encodeURIComponent(wallet)}`,
      {
        headers: {
          'accept': 'application/json',
          'fairkey': CONFIG.FAIRSCALE_API_KEY,
        },
      }
    );
    
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    return null;
  }
}

// =============================================================================
// VOUCH HELPERS
// =============================================================================

function getVouchesByVoucher(wallet) {
  const ids = vouchIndex.byVoucher.get(wallet) || new Set();
  return Array.from(ids).map(id => vouches.get(id)).filter(v => v && v.status === 'active');
}

function getVouchesByRecipient(wallet) {
  const ids = vouchIndex.byRecipient.get(wallet) || new Set();
  return Array.from(ids).map(id => vouches.get(id)).filter(v => v && v.status === 'active');
}

function calculateVouchBoost(wallet) {
  const received = getVouchesByRecipient(wallet);
  let totalBoost = 0;
  
  for (const vouch of received) {
    const boost = (vouch.voucher_score / 100) * (vouch.stake_amount / 1000) * 0.1;
    totalBoost += boost;
  }
  
  return Math.min(totalBoost, CONFIG.VOUCH.MAX_BOOST);
}

// =============================================================================
// PAYMENT VERIFICATION (for upgrades)
// =============================================================================

async function verifyPayment(signature, expectedAmount, tokenMint = CONFIG.USDC_MINT) {
  try {
    if (!signature || typeof signature !== 'string' || signature.length < 80) {
      return { valid: false, error: 'Invalid signature format' };
    }
    
    if (processedPayments.has(signature)) {
      return { valid: false, error: 'Payment already used' };
    }
    
    let tx = null;
    let retries = 3;
    
    while (retries > 0 && !tx) {
      try {
        tx = await solana.getTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
      } catch (e) {
        retries--;
        if (retries > 0) await new Promise(r => setTimeout(r, 1000));
      }
    }
    
    if (!tx) return { valid: false, error: 'Transaction not found' };
    if (tx.meta?.err) return { valid: false, error: 'Transaction failed' };
    
    const meta = tx.meta;
    const postBalances = meta.postTokenBalances || [];
    const preBalances = meta.preTokenBalances || [];
    
    for (const post of postBalances) {
      if (post.mint === tokenMint && post.owner === CONFIG.TREASURY_WALLET) {
        const pre = preBalances.find(p => p.accountIndex === post.accountIndex && p.mint === tokenMint);
        const preAmount = pre?.uiTokenAmount?.amount ? parseInt(pre.uiTokenAmount.amount) : 0;
        const postAmount = post.uiTokenAmount?.amount ? parseInt(post.uiTokenAmount.amount) : 0;
        const received = postAmount - preAmount;
        
        if (received >= expectedAmount) {
          processedPayments.set(signature, Date.now());
          return { valid: true, amount: received };
        }
      }
    }
    
    return { valid: false, error: 'Payment insufficient or wrong recipient' };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

// =============================================================================
// ROUTES: Health Check
// =============================================================================

app.get('/', (req, res) => {
  res.json({
    service: 'FairScale API',
    version: '3.0.0',
    status: 'ok',
    tiers: {
      free: {
        daily_limit: 100,
        features: ['Basic score lookup'],
        price: 'Free',
      },
      pro: {
        daily_limit: 10000,
        features: ['Full data', 'Custom rules', 'Batch queries'],
        price: '$50/month or x402',
      },
      enterprise: {
        daily_limit: 'Unlimited',
        features: ['Everything + SLA + Webhooks'],
        price: '$500/month',
      },
    },
    endpoints: {
      'GET /score': 'Get wallet score (free tier: 100/day)',
      'POST /score/custom': 'Custom scoring rules (Pro+)',
      'POST /batch': 'Batch scoring (Pro+)',
      'POST /register': 'Get API key',
      'POST /upgrade': 'Upgrade tier with x402',
    },
  });
});

// =============================================================================
// ROUTES: Register for API Key
// =============================================================================

app.post('/register', (req, res) => {
  const { wallet } = req.body;
  
  if (!wallet || !isValidSolanaAddress(wallet)) {
    return res.status(400).json({ error: 'Valid Solana wallet required' });
  }
  
  // Check if wallet already has a key
  for (const [key, data] of apiKeys.entries()) {
    if (data.wallet === wallet) {
      return res.json({
        message: 'API key already exists for this wallet',
        api_key: key,
        tier: data.tier,
      });
    }
  }
  
  const apiKey = generateApiKey();
  
  apiKeys.set(apiKey, {
    wallet,
    tier: 'free',
    created_at: new Date().toISOString(),
  });
  
  return res.status(201).json({
    message: 'API key created',
    api_key: apiKey,
    tier: 'free',
    limits: CONFIG.TIERS.free,
    usage: 'Include header: x-api-key: ' + apiKey,
  });
});

// =============================================================================
// ROUTES: Score (Free Tier Available)
// =============================================================================

app.get('/score', async (req, res) => {
  const wallet = req.query.wallet;
  
  if (!wallet) {
    return res.status(400).json({
      error: 'Missing wallet parameter',
      example: '/score?wallet=YOUR_SOLANA_WALLET',
    });
  }
  
  if (!isValidSolanaAddress(wallet)) {
    return res.status(400).json({ error: 'Invalid Solana wallet address' });
  }
  
  // Identify client and check rate limit
  const client = getClientIdentifier(req);
  const rateCheck = checkRateLimit(client);
  
  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: rateCheck.error,
      limit: rateCheck.limit,
      tier: rateCheck.tier,
      upgrade: rateCheck.upgrade,
      reset_in_seconds: rateCheck.reset_in_seconds,
    });
  }
  
  // Fetch score
  const data = await getWalletScore(wallet);
  
  if (!data) {
    return res.status(500).json({ error: 'Failed to fetch wallet score' });
  }
  
  // Add vouch boost
  const vouchBoost = calculateVouchBoost(wallet);
  
  // Free tier: basic response
  if (client.tier === 'free') {
    return res.json({
      wallet,
      fairscore: Math.min((data.fairscore || 0) + vouchBoost, 100),
      tier: data.tier,
      vouch_boost: vouchBoost,
      _meta: {
        tier: 'free',
        remaining_today: rateCheck.remaining_today,
        upgrade_for: 'Full data, custom rules, batch queries',
      },
    });
  }
  
  // Pro/Enterprise: full response
  return res.json({
    ...data,
    fairscore: Math.min((data.fairscore || 0) + vouchBoost, 100),
    vouch_boost: vouchBoost,
    vouches_received: getVouchesByRecipient(wallet).length,
    _meta: {
      tier: client.tier,
      remaining_today: rateCheck.remaining_today,
    },
  });
});

// =============================================================================
// ROUTES: Custom Scoring (Pro+)
// =============================================================================

app.post('/score/custom', async (req, res) => {
  const { wallet, rules } = req.body;
  
  if (!wallet || !isValidSolanaAddress(wallet)) {
    return res.status(400).json({ error: 'Valid wallet required' });
  }
  
  if (!rules || typeof rules !== 'object') {
    return res.status(400).json({
      error: 'Rules object required',
      example: {
        wallet: 'ABC...',
        rules: {
          min_score: 60,
          min_age_days: 180,
          no_rug_history: true,
          min_transaction_count: 100,
          min_volume_usd: 10000,
          max_burst_ratio: 0.5,
        },
      },
    });
  }
  
  // Check tier
  const client = getClientIdentifier(req);
  
  if (client.tier === 'free') {
    return res.status(403).json({
      error: 'Custom scoring requires Pro tier',
      upgrade: 'POST /upgrade with x402 payment or contact for Enterprise',
    });
  }
  
  const rateCheck = checkRateLimit(client);
  if (!rateCheck.allowed) {
    return res.status(429).json(rateCheck);
  }
  
  // Fetch full wallet data
  const data = await getWalletScore(wallet);
  
  if (!data) {
    return res.status(500).json({ error: 'Failed to fetch wallet data' });
  }
  
  // Evaluate rules
  const ruleResults = {};
  let allPass = true;
  
  // min_score
  if (rules.min_score !== undefined) {
    const pass = (data.fairscore || 0) >= rules.min_score;
    ruleResults.min_score = { pass, required: rules.min_score, actual: data.fairscore };
    if (!pass) allPass = false;
  }
  
  // min_age_days
  if (rules.min_age_days !== undefined) {
    const ageDays = data.wallet_age_days || data.age_days || 0;
    const pass = ageDays >= rules.min_age_days;
    ruleResults.min_age_days = { pass, required: rules.min_age_days, actual: ageDays };
    if (!pass) allPass = false;
  }
  
  // no_rug_history
  if (rules.no_rug_history === true) {
    const hasRug = data.rug_history || data.has_rugged || false;
    const pass = !hasRug;
    ruleResults.no_rug_history = { pass, actual: hasRug };
    if (!pass) allPass = false;
  }
  
  // min_transaction_count
  if (rules.min_transaction_count !== undefined) {
    const txCount = data.transaction_count || data.tx_count || 0;
    const pass = txCount >= rules.min_transaction_count;
    ruleResults.min_transaction_count = { pass, required: rules.min_transaction_count, actual: txCount };
    if (!pass) allPass = false;
  }
  
  // min_volume_usd
  if (rules.min_volume_usd !== undefined) {
    const volume = data.total_volume_usd || data.volume_usd || 0;
    const pass = volume >= rules.min_volume_usd;
    ruleResults.min_volume_usd = { pass, required: rules.min_volume_usd, actual: volume };
    if (!pass) allPass = false;
  }
  
  // max_burst_ratio
  if (rules.max_burst_ratio !== undefined) {
    const burst = data.burst_ratio || data.burst || 0;
    const pass = burst <= rules.max_burst_ratio;
    ruleResults.max_burst_ratio = { pass, required: rules.max_burst_ratio, actual: burst };
    if (!pass) allPass = false;
  }
  
  // min_tier
  if (rules.min_tier !== undefined) {
    const tierOrder = { bronze: 1, silver: 2, gold: 3, platinum: 4 };
    const actualTier = (data.tier || 'bronze').toLowerCase();
    const requiredTier = rules.min_tier.toLowerCase();
    const pass = (tierOrder[actualTier] || 0) >= (tierOrder[requiredTier] || 0);
    ruleResults.min_tier = { pass, required: rules.min_tier, actual: data.tier };
    if (!pass) allPass = false;
  }
  
  // Add vouch boost
  const vouchBoost = calculateVouchBoost(wallet);
  
  return res.json({
    wallet,
    passes: allPass,
    fairscore: Math.min((data.fairscore || 0) + vouchBoost, 100),
    vouch_boost: vouchBoost,
    rule_results: ruleResults,
    rules_evaluated: Object.keys(ruleResults).length,
    recommendation: allPass ? 'proceed' : 'reject',
    _meta: {
      tier: client.tier,
      remaining_today: rateCheck.remaining_today,
    },
  });
});

// =============================================================================
// ROUTES: Batch (Pro+)
// =============================================================================

app.post('/batch', async (req, res) => {
  const { wallets } = req.body;
  
  if (!wallets || !Array.isArray(wallets) || wallets.length === 0) {
    return res.status(400).json({
      error: 'Wallets array required',
      example: { wallets: ['address1', 'address2'] },
    });
  }
  
  if (wallets.length > 100) {
    return res.status(400).json({ error: 'Maximum 100 wallets per batch' });
  }
  
  // Check tier
  const client = getClientIdentifier(req);
  
  if (client.tier === 'free') {
    return res.status(403).json({
      error: 'Batch scoring requires Pro tier',
      upgrade: 'POST /upgrade with x402 payment',
    });
  }
  
  // Each wallet in batch counts as one call
  for (let i = 0; i < wallets.length; i++) {
    const rateCheck = checkRateLimit(client);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded during batch',
        processed: i,
        total: wallets.length,
        ...rateCheck,
      });
    }
  }
  
  const invalidWallets = wallets.filter(w => !isValidSolanaAddress(w));
  if (invalidWallets.length > 0) {
    return res.status(400).json({ error: 'Invalid wallets', invalid: invalidWallets });
  }
  
  // Fetch all scores
  const results = await Promise.all(
    wallets.map(async (wallet) => {
      try {
        const data = await getWalletScore(wallet);
        if (!data) return { wallet, error: 'Failed to fetch' };
        
        const vouchBoost = calculateVouchBoost(wallet);
        return {
          wallet,
          fairscore: Math.min((data.fairscore || 0) + vouchBoost, 100),
          tier: data.tier,
          vouch_boost: vouchBoost,
        };
      } catch (e) {
        return { wallet, error: e.message };
      }
    })
  );
  
  return res.json({
    count: results.length,
    results,
    _meta: { tier: client.tier },
  });
});

// =============================================================================
// ROUTES: Pre-Transaction Check (Free)
// =============================================================================

app.get('/check', async (req, res) => {
  const { wallet, amount } = req.query;
  
  if (!wallet || !isValidSolanaAddress(wallet)) {
    return res.status(400).json({ error: 'Valid wallet required' });
  }
  
  const client = getClientIdentifier(req);
  const rateCheck = checkRateLimit(client);
  
  if (!rateCheck.allowed) {
    return res.status(429).json(rateCheck);
  }
  
  const data = await getWalletScore(wallet);
  if (!data) {
    return res.status(500).json({ error: 'Failed to fetch wallet data' });
  }
  
  const vouchBoost = calculateVouchBoost(wallet);
  const finalScore = Math.min((data.fairscore || 0) + vouchBoost, 100);
  
  // Determine risk level based on score
  let risk, recommendation, maxSuggestedAmount;
  
  if (finalScore >= 80) {
    risk = 'low';
    recommendation = 'proceed';
    maxSuggestedAmount = 10000;
  } else if (finalScore >= 60) {
    risk = 'medium';
    recommendation = 'proceed_with_caution';
    maxSuggestedAmount = 1000;
  } else if (finalScore >= 40) {
    risk = 'high';
    recommendation = 'small_amounts_only';
    maxSuggestedAmount = 100;
  } else {
    risk = 'very_high';
    recommendation = 'avoid';
    maxSuggestedAmount = 0;
  }
  
  // If amount specified, check against suggested max
  let amountCheck = null;
  if (amount) {
    const amountNum = parseFloat(amount);
    amountCheck = {
      requested: amountNum,
      max_suggested: maxSuggestedAmount,
      proceed: amountNum <= maxSuggestedAmount,
    };
  }
  
  return res.json({
    wallet,
    fairscore: finalScore,
    risk_level: risk,
    recommendation,
    max_suggested_amount_usd: maxSuggestedAmount,
    amount_check: amountCheck,
    _meta: {
      tier: client.tier,
      remaining_today: rateCheck.remaining_today,
    },
  });
});

// =============================================================================
// ROUTES: Upgrade Tier (x402)
// =============================================================================

app.post('/upgrade', async (req, res) => {
  const { api_key, tier, signature } = req.body;
  
  if (!api_key || !apiKeys.has(api_key)) {
    return res.status(400).json({ error: 'Valid API key required' });
  }
  
  if (tier !== 'pro') {
    return res.status(400).json({
      error: 'Invalid tier',
      available: ['pro'],
      note: 'For Enterprise, contact sales@fairscale.xyz',
    });
  }
  
  if (!signature) {
    return res.status(402).json({
      status: 402,
      message: 'Payment required for upgrade',
      x402: {
        price: {
          amount: String(CONFIG.PRICES.pro_monthly),
          currency: 'USDC',
          readable: '$50',
        },
        recipient: CONFIG.TREASURY_WALLET,
        description: 'FairScale Pro - 1 month',
      },
      instructions: [
        `Send $50 USDC to ${CONFIG.TREASURY_WALLET}`,
        'Retry with signature in request body',
      ],
    });
  }
  
  const verification = await verifyPayment(signature, CONFIG.PRICES.pro_monthly);
  
  if (!verification.valid) {
    return res.status(402).json({
      error: 'Payment verification failed',
      reason: verification.error,
    });
  }
  
  // Upgrade the key
  const keyData = apiKeys.get(api_key);
  keyData.tier = 'pro';
  keyData.upgraded_at = new Date().toISOString();
  keyData.expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  
  return res.json({
    success: true,
    message: 'Upgraded to Pro tier',
    api_key,
    tier: 'pro',
    limits: CONFIG.TIERS.pro,
    expires_at: keyData.expires_at,
  });
});

// =============================================================================
// ROUTES: Usage Stats
// =============================================================================

app.get('/usage', (req, res) => {
  const client = getClientIdentifier(req);
  const today = new Date().toDateString();
  const usage = dailyUsage.get(client.id) || { date: today, count: 0 };
  const tier = CONFIG.TIERS[client.tier];
  
  return res.json({
    tier: client.tier,
    today: {
      calls: usage.count,
      limit: tier.daily_limit,
      remaining: tier.daily_limit - usage.count,
    },
    features: tier.features,
    rate_limit_per_minute: tier.rate_limit_per_minute,
  });
});

// =============================================================================
// ROUTES: Vouching (unchanged from v2)
// =============================================================================

app.post('/vouch', async (req, res) => {
  const { voucher, recipient, stake_amount, signature } = req.body;
  
  if (!voucher || !recipient || !stake_amount || !signature) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['voucher', 'recipient', 'stake_amount', 'signature'],
    });
  }
  
  if (!isValidSolanaAddress(voucher) || !isValidSolanaAddress(recipient)) {
    return res.status(400).json({ error: 'Invalid wallet addresses' });
  }
  
  if (voucher === recipient) {
    return res.status(400).json({ error: 'Cannot vouch for yourself' });
  }
  
  if (stake_amount < CONFIG.VOUCH.MIN_STAKE) {
    return res.status(400).json({
      error: `Minimum stake is ${CONFIG.VOUCH.MIN_STAKE} $FAIR`,
    });
  }
  
  const existingVouches = getVouchesByVoucher(voucher);
  if (existingVouches.length >= CONFIG.VOUCH.MAX_VOUCHES_PER_WALLET) {
    return res.status(400).json({
      error: `Maximum ${CONFIG.VOUCH.MAX_VOUCHES_PER_WALLET} active vouches per wallet`,
    });
  }
  
  // Verify $FAIR payment
  const verification = await verifyPayment(signature, stake_amount * 1000000, CONFIG.FAIR_MINT);
  if (!verification.valid) {
    return res.status(402).json({
      error: 'Stake payment verification failed',
      reason: verification.error,
    });
  }
  
  // Get scores
  const voucherScore = await getWalletScore(voucher).then(d => d?.fairscore || 0);
  const recipientData = await getWalletScore(recipient);
  const recipientScore = recipientData?.fairscore || 0;
  
  // Create vouch
  const vouchId = generateVouchId();
  const vouch = {
    vouch_id: vouchId,
    voucher,
    recipient,
    stake_amount,
    voucher_score: voucherScore,
    recipient_score_at_vouch: recipientScore,
    slash_threshold: recipientScore * (1 - CONFIG.VOUCH.SLASH_THRESHOLD),
    stake_tx: signature,
    status: 'active',
    created_at: new Date().toISOString(),
  };
  
  vouches.set(vouchId, vouch);
  
  if (!vouchIndex.byVoucher.has(voucher)) vouchIndex.byVoucher.set(voucher, new Set());
  vouchIndex.byVoucher.get(voucher).add(vouchId);
  
  if (!vouchIndex.byRecipient.has(recipient)) vouchIndex.byRecipient.set(recipient, new Set());
  vouchIndex.byRecipient.get(recipient).add(vouchId);
  
  const boost = (voucherScore / 100) * (stake_amount / 1000) * 0.1;
  
  return res.status(201).json({
    success: true,
    vouch: { ...vouch, boost_provided: boost.toFixed(2) },
  });
});

app.get('/vouches', async (req, res) => {
  const wallet = req.query.wallet;
  
  if (!wallet || !isValidSolanaAddress(wallet)) {
    return res.status(400).json({ error: 'Valid wallet required' });
  }
  
  const given = getVouchesByVoucher(wallet);
  const received = getVouchesByRecipient(wallet);
  const totalBoost = calculateVouchBoost(wallet);
  
  return res.json({
    wallet,
    vouches_given: given.map(v => ({
      vouch_id: v.vouch_id,
      recipient: v.recipient,
      stake_amount: v.stake_amount,
      status: v.status,
      created_at: v.created_at,
    })),
    vouches_received: received.map(v => ({
      vouch_id: v.vouch_id,
      voucher: v.voucher,
      voucher_score: v.voucher_score,
      stake_amount: v.stake_amount,
      boost: ((v.voucher_score / 100) * (v.stake_amount / 1000) * 0.1).toFixed(2),
    })),
    total_vouch_boost: totalBoost.toFixed(2),
  });
});

// =============================================================================
// ERROR HANDLING
// =============================================================================

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    endpoints: {
      'GET /': 'API info',
      'GET /score': 'Get wallet score (free: 100/day)',
      'GET /check': 'Pre-transaction risk check (free)',
      'POST /score/custom': 'Custom rules (Pro+)',
      'POST /batch': 'Batch scoring (Pro+)',
      'POST /register': 'Get API key',
      'POST /upgrade': 'Upgrade tier',
      'GET /usage': 'Check your usage',
      'POST /vouch': 'Create vouch',
      'GET /vouches': 'View vouches',
    },
  });
});

// =============================================================================
// START SERVER
// =============================================================================

const server = app.listen(CONFIG.PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════════╗
║                   FairScale API v3.0                               ║
╠════════════════════════════════════════════════════════════════════╣
║  Port: ${String(CONFIG.PORT).padEnd(60)}║
║                                                                    ║
║  Tiers:                                                            ║
║    Free       100 calls/day    Basic score                         ║
║    Pro        10,000/day       Full data + Custom rules            ║
║    Enterprise Unlimited        Everything + SLA                    ║
║                                                                    ║
║  Endpoints:                                                        ║
║    GET  /score         Wallet score (free tier available)          ║
║    GET  /check         Pre-transaction risk check                  ║
║    POST /score/custom  Custom scoring rules (Pro+)                 ║
║    POST /batch         Batch scoring (Pro+)                        ║
║    POST /register      Get API key                                 ║
║    POST /upgrade       Upgrade with x402                           ║
╚════════════════════════════════════════════════════════════════════╝
  `);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

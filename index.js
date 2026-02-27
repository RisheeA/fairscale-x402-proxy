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
      features: ['basic_score', 'check'],
      rate_limit_per_minute: 10,
    },
    credits: {
      daily_limit: Infinity,
      features: ['basic_score', 'check', 'full_data', 'custom_rules', 'batch'],
      rate_limit_per_minute: 100,
    },
    pro: {
      daily_limit: 10000,
      features: ['basic_score', 'check', 'full_data', 'custom_rules', 'batch'],
      rate_limit_per_minute: 100,
      price_usd_monthly: 50,
    },
    enterprise: {
      daily_limit: Infinity,
      features: ['basic_score', 'check', 'full_data', 'custom_rules', 'batch', 'webhooks', 'sla'],
      rate_limit_per_minute: 1000,
      price_usd_monthly: 500,
    },
  },
  
  // Pricing (USDC has 6 decimals)
  PRICES: {
    per_call: 10000,          // $0.01 USDC per call
    batch_per_wallet: 10000,  // $0.01 USDC per wallet in batch
    pro_monthly: 50000000,    // $50 USDC
  },
  
  // Vouching
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

// Rate limiting
const rateLimits = new Map();

// API keys: key -> { tier, wallet, created_at }
const apiKeys = new Map();

// Daily usage
const dailyUsage = new Map();

// Prepaid credits: session_token -> { wallet, balance_usd, created_at }
const credits = new Map();
const walletToSession = new Map();

// Cleanup
setInterval(() => {
  const now = Date.now();
  for (const [sig, timestamp] of processedPayments.entries()) {
    if (now - timestamp > CONFIG.PAYMENT_CACHE_TTL) {
      processedPayments.delete(sig);
    }
  }
  
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

function generateSessionToken() {
  return 'fsc_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// =============================================================================
// CLIENT IDENTIFICATION & RATE LIMITING
// =============================================================================

function getClientIdentifier(req) {
  // Check for session token (prepaid credits)
  const sessionToken = req.headers['x-session-token'];
  if (sessionToken && credits.has(sessionToken)) {
    return { type: 'credits', id: sessionToken, tier: 'credits', session: credits.get(sessionToken) };
  }
  
  // Check for API key
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKeys.has(apiKey)) {
    return { type: 'api_key', id: apiKey, tier: apiKeys.get(apiKey).tier };
  }
  
  // Fall back to IP (free tier)
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown';
  return { type: 'ip', id: ip, tier: 'free' };
}

function checkRateLimit(client) {
  const tier = CONFIG.TIERS[client.tier];
  const now = Date.now();
  const oneMinuteAgo = now - 60000;
  const today = new Date().toDateString();
  
  let limits = rateLimits.get(client.id);
  if (!limits) {
    limits = { calls: [] };
    rateLimits.set(client.id, limits);
  }
  
  limits.calls = limits.calls.filter(t => t > oneMinuteAgo);
  
  if (limits.calls.length >= tier.rate_limit_per_minute) {
    return { 
      allowed: false, 
      error: 'Rate limit exceeded',
      limit: tier.rate_limit_per_minute,
      reset_in_seconds: Math.ceil((limits.calls[0] + 60000 - now) / 1000),
    };
  }
  
  // Skip daily limit for credits tier
  if (client.tier !== 'credits') {
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
        upgrade: 'Deposit credits for unlimited calls: POST /credits/deposit',
      };
    }
    
    usage.count++;
  }
  
  limits.calls.push(now);
  
  return { 
    allowed: true, 
    remaining_today: client.tier === 'credits' ? 'unlimited' : (tier.daily_limit - (dailyUsage.get(client.id)?.count || 0)),
    tier: client.tier,
  };
}

// =============================================================================
// CREDITS SYSTEM
// =============================================================================

function deductCredits(sessionToken, amountUsd) {
  const session = credits.get(sessionToken);
  if (!session) return { success: false, error: 'Invalid session' };
  
  if (session.balance_usd < amountUsd) {
    return { 
      success: false, 
      error: 'Insufficient credits',
      balance: session.balance_usd,
      required: amountUsd,
    };
  }
  
  session.balance_usd -= amountUsd;
  session.last_used = new Date().toISOString();
  session.total_calls = (session.total_calls || 0) + 1;
  
  return { 
    success: true, 
    deducted: amountUsd,
    remaining: session.balance_usd,
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
// PAYMENT VERIFICATION
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
    version: '3.1.0',
    status: 'ok',
    pricing: {
      free: {
        limit: '100 calls/day',
        features: ['Basic score', 'Risk check'],
        price: '$0',
      },
      prepaid_credits: {
        limit: 'Unlimited',
        features: ['All features', 'Custom rules', 'Batch'],
        price: '$0.01 per call',
        how: 'POST /credits/deposit',
      },
      pro: {
        limit: '10,000 calls/day',
        features: ['All features'],
        price: '$50/month',
      },
    },
    endpoints: {
      'GET /score': 'Wallet score',
      'GET /check': 'Pre-transaction risk check',
      'POST /score/custom': 'Custom scoring rules',
      'POST /batch': 'Batch scoring',
      'POST /credits/deposit': 'Deposit USDC for credits',
      'GET /credits/balance': 'Check credit balance',
      'POST /register': 'Get API key',
    },
    treasury: CONFIG.TREASURY_WALLET,
  });
});

// =============================================================================
// ROUTES: Credits
// =============================================================================

app.get('/credits', (req, res) => {
  res.json({
    description: 'Prepaid credits for unlimited API access',
    pricing: '$0.01 per call',
    how_it_works: [
      '1. Send USDC to treasury wallet',
      '2. POST /credits/deposit with your wallet + tx signature',
      '3. Get a session token',
      '4. Include x-session-token header on all requests',
      '5. Credits deduct automatically per call',
    ],
    treasury: CONFIG.TREASURY_WALLET,
    minimum_deposit: '$1 USDC (100 calls)',
    example_deposits: {
      '$1': '100 calls',
      '$10': '1,000 calls',
      '$100': '10,000 calls',
    },
  });
});

app.post('/credits/deposit', async (req, res) => {
  const { wallet, signature } = req.body;
  
  if (!wallet || !isValidSolanaAddress(wallet)) {
    return res.status(400).json({ error: 'Valid wallet required' });
  }
  
  if (!signature) {
    return res.status(400).json({
      error: 'Payment signature required',
      instructions: [
        `1. Send USDC to ${CONFIG.TREASURY_WALLET}`,
        '2. Copy the transaction signature',
        '3. POST here with { wallet, signature }',
      ],
      treasury: CONFIG.TREASURY_WALLET,
      minimum: '$1 USDC',
    });
  }
  
  // Verify payment (minimum $1 = 1000000 units)
  const verification = await verifyPayment(signature, 1000000);
  
  if (!verification.valid) {
    return res.status(402).json({
      error: 'Payment verification failed',
      reason: verification.error,
    });
  }
  
  // Calculate credits ($1 = 100 calls at $0.01 each)
  const depositedUsd = verification.amount / 1000000;
  
  // Check if wallet already has a session
  let sessionToken = walletToSession.get(wallet);
  
  if (sessionToken && credits.has(sessionToken)) {
    // Add to existing balance
    const session = credits.get(sessionToken);
    session.balance_usd += depositedUsd;
    session.deposits.push({
      amount_usd: depositedUsd,
      signature,
      timestamp: new Date().toISOString(),
    });
    
    return res.json({
      success: true,
      message: 'Credits added to existing session',
      session_token: sessionToken,
      deposited_usd: depositedUsd,
      total_balance_usd: session.balance_usd,
      calls_available: Math.floor(session.balance_usd / 0.01),
    });
  }
  
  // Create new session
  sessionToken = generateSessionToken();
  
  credits.set(sessionToken, {
    wallet,
    balance_usd: depositedUsd,
    created_at: new Date().toISOString(),
    deposits: [{
      amount_usd: depositedUsd,
      signature,
      timestamp: new Date().toISOString(),
    }],
    total_calls: 0,
  });
  
  walletToSession.set(wallet, sessionToken);
  
  return res.status(201).json({
    success: true,
    message: 'Credits deposited',
    session_token: sessionToken,
    balance_usd: depositedUsd,
    calls_available: Math.floor(depositedUsd / 0.01),
    usage: 'Include header: x-session-token: ' + sessionToken,
  });
});

app.get('/credits/balance', (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  
  if (!sessionToken) {
    return res.status(400).json({ error: 'x-session-token header required' });
  }
  
  const session = credits.get(sessionToken);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  return res.json({
    wallet: session.wallet,
    balance_usd: session.balance_usd,
    calls_available: Math.floor(session.balance_usd / 0.01),
    total_calls_made: session.total_calls || 0,
    created_at: session.created_at,
    last_used: session.last_used,
  });
});

// =============================================================================
// ROUTES: Register API Key
// =============================================================================

app.post('/register', (req, res) => {
  const { wallet } = req.body;
  
  if (!wallet || !isValidSolanaAddress(wallet)) {
    return res.status(400).json({ error: 'Valid Solana wallet required' });
  }
  
  for (const [key, data] of apiKeys.entries()) {
    if (data.wallet === wallet) {
      return res.json({
        message: 'API key already exists',
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
    note: 'For unlimited calls, use prepaid credits instead: POST /credits/deposit',
  });
});

// =============================================================================
// ROUTES: Score
// =============================================================================

app.get('/score', async (req, res) => {
  const wallet = req.query.wallet;
  
  if (!wallet) {
    return res.status(400).json({ error: 'Missing wallet parameter' });
  }
  
  if (!isValidSolanaAddress(wallet)) {
    return res.status(400).json({ error: 'Invalid Solana wallet address' });
  }
  
  const client = getClientIdentifier(req);
  
  // Deduct credits if using credits
  if (client.tier === 'credits') {
    const deduction = deductCredits(client.id, 0.01);
    if (!deduction.success) {
      return res.status(402).json({
        error: deduction.error,
        balance_usd: deduction.balance,
        required_usd: deduction.required,
        top_up: 'POST /credits/deposit',
      });
    }
  }
  
  const rateCheck = checkRateLimit(client);
  if (!rateCheck.allowed) {
    return res.status(429).json(rateCheck);
  }
  
  const data = await getWalletScore(wallet);
  if (!data) {
    return res.status(500).json({ error: 'Failed to fetch wallet score' });
  }
  
  const vouchBoost = calculateVouchBoost(wallet);
  
  const response = {
    wallet,
    fairscore: Math.min((data.fairscore || 0) + vouchBoost, 100),
    tier: data.tier,
    vouch_boost: vouchBoost,
  };
  
  // Add metadata based on tier
  if (client.tier === 'credits') {
    const session = credits.get(client.id);
    response._meta = {
      payment: 'credits',
      charged: '$0.01',
      remaining_usd: session.balance_usd,
      calls_remaining: Math.floor(session.balance_usd / 0.01),
    };
  } else {
    response._meta = {
      tier: client.tier,
      remaining_today: rateCheck.remaining_today,
    };
  }
  
  return res.json(response);
});

// =============================================================================
// ROUTES: Check (Pre-Transaction)
// =============================================================================

app.get('/check', async (req, res) => {
  const { wallet, amount } = req.query;
  
  if (!wallet || !isValidSolanaAddress(wallet)) {
    return res.status(400).json({ error: 'Valid wallet required' });
  }
  
  const client = getClientIdentifier(req);
  
  if (client.tier === 'credits') {
    const deduction = deductCredits(client.id, 0.01);
    if (!deduction.success) {
      return res.status(402).json({
        error: deduction.error,
        balance_usd: deduction.balance,
        top_up: 'POST /credits/deposit',
      });
    }
  }
  
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
  
  let amountCheck = null;
  if (amount) {
    const amountNum = parseFloat(amount);
    amountCheck = {
      requested: amountNum,
      max_suggested: maxSuggestedAmount,
      proceed: amountNum <= maxSuggestedAmount,
    };
  }
  
  const response = {
    wallet,
    fairscore: finalScore,
    risk_level: risk,
    recommendation,
    max_suggested_amount_usd: maxSuggestedAmount,
    amount_check: amountCheck,
  };
  
  if (client.tier === 'credits') {
    const session = credits.get(client.id);
    response._meta = {
      payment: 'credits',
      charged: '$0.01',
      remaining_usd: session.balance_usd,
    };
  } else {
    response._meta = {
      tier: client.tier,
      remaining_today: rateCheck.remaining_today,
    };
  }
  
  return res.json(response);
});

// =============================================================================
// ROUTES: Custom Scoring
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
        },
      },
    });
  }
  
  const client = getClientIdentifier(req);
  
  // Custom scoring requires credits or pro tier
  if (client.tier === 'free') {
    return res.status(403).json({
      error: 'Custom scoring requires credits or Pro tier',
      options: {
        credits: 'POST /credits/deposit - $0.01 per call',
        pro: '$50/month for 10,000 calls/day',
      },
    });
  }
  
  if (client.tier === 'credits') {
    const deduction = deductCredits(client.id, 0.01);
    if (!deduction.success) {
      return res.status(402).json({
        error: deduction.error,
        balance_usd: deduction.balance,
        top_up: 'POST /credits/deposit',
      });
    }
  }
  
  const rateCheck = checkRateLimit(client);
  if (!rateCheck.allowed) {
    return res.status(429).json(rateCheck);
  }
  
  const data = await getWalletScore(wallet);
  if (!data) {
    return res.status(500).json({ error: 'Failed to fetch wallet data' });
  }
  
  const ruleResults = {};
  let allPass = true;
  
  if (rules.min_score !== undefined) {
    const pass = (data.fairscore || 0) >= rules.min_score;
    ruleResults.min_score = { pass, required: rules.min_score, actual: data.fairscore };
    if (!pass) allPass = false;
  }
  
  if (rules.min_age_days !== undefined) {
    const ageDays = data.wallet_age_days || data.age_days || 0;
    const pass = ageDays >= rules.min_age_days;
    ruleResults.min_age_days = { pass, required: rules.min_age_days, actual: ageDays };
    if (!pass) allPass = false;
  }
  
  if (rules.no_rug_history === true) {
    const hasRug = data.rug_history || data.has_rugged || false;
    const pass = !hasRug;
    ruleResults.no_rug_history = { pass, actual: hasRug };
    if (!pass) allPass = false;
  }
  
  if (rules.min_transaction_count !== undefined) {
    const txCount = data.transaction_count || data.tx_count || 0;
    const pass = txCount >= rules.min_transaction_count;
    ruleResults.min_transaction_count = { pass, required: rules.min_transaction_count, actual: txCount };
    if (!pass) allPass = false;
  }
  
  if (rules.min_volume_usd !== undefined) {
    const volume = data.total_volume_usd || data.volume_usd || 0;
    const pass = volume >= rules.min_volume_usd;
    ruleResults.min_volume_usd = { pass, required: rules.min_volume_usd, actual: volume };
    if (!pass) allPass = false;
  }
  
  if (rules.max_burst_ratio !== undefined) {
    const burst = data.burst_ratio || data.burst || 0;
    const pass = burst <= rules.max_burst_ratio;
    ruleResults.max_burst_ratio = { pass, required: rules.max_burst_ratio, actual: burst };
    if (!pass) allPass = false;
  }
  
  if (rules.min_tier !== undefined) {
    const tierOrder = { bronze: 1, silver: 2, gold: 3, platinum: 4 };
    const actualTier = (data.tier || 'bronze').toLowerCase();
    const requiredTier = rules.min_tier.toLowerCase();
    const pass = (tierOrder[actualTier] || 0) >= (tierOrder[requiredTier] || 0);
    ruleResults.min_tier = { pass, required: rules.min_tier, actual: data.tier };
    if (!pass) allPass = false;
  }
  
  const vouchBoost = calculateVouchBoost(wallet);
  
  const response = {
    wallet,
    passes: allPass,
    fairscore: Math.min((data.fairscore || 0) + vouchBoost, 100),
    vouch_boost: vouchBoost,
    rule_results: ruleResults,
    rules_evaluated: Object.keys(ruleResults).length,
    recommendation: allPass ? 'proceed' : 'reject',
  };
  
  if (client.tier === 'credits') {
    const session = credits.get(client.id);
    response._meta = {
      payment: 'credits',
      charged: '$0.01',
      remaining_usd: session.balance_usd,
    };
  } else {
    response._meta = { tier: client.tier };
  }
  
  return res.json(response);
});

// =============================================================================
// ROUTES: Batch
// =============================================================================

app.post('/batch', async (req, res) => {
  const { wallets } = req.body;
  
  if (!wallets || !Array.isArray(wallets) || wallets.length === 0) {
    return res.status(400).json({ error: 'Wallets array required' });
  }
  
  if (wallets.length > 100) {
    return res.status(400).json({ error: 'Maximum 100 wallets per batch' });
  }
  
  const client = getClientIdentifier(req);
  
  if (client.tier === 'free') {
    return res.status(403).json({
      error: 'Batch scoring requires credits or Pro tier',
      options: {
        credits: 'POST /credits/deposit - $0.01 per wallet',
        pro: '$50/month',
      },
    });
  }
  
  const totalCost = wallets.length * 0.01;
  
  if (client.tier === 'credits') {
    const session = credits.get(client.id);
    if (session.balance_usd < totalCost) {
      return res.status(402).json({
        error: 'Insufficient credits for batch',
        wallets_requested: wallets.length,
        cost_usd: totalCost,
        balance_usd: session.balance_usd,
        top_up: 'POST /credits/deposit',
      });
    }
    
    // Deduct full amount
    session.balance_usd -= totalCost;
    session.total_calls = (session.total_calls || 0) + wallets.length;
  }
  
  const invalidWallets = wallets.filter(w => !isValidSolanaAddress(w));
  if (invalidWallets.length > 0) {
    return res.status(400).json({ error: 'Invalid wallets', invalid: invalidWallets });
  }
  
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
  
  const response = {
    count: results.length,
    results,
  };
  
  if (client.tier === 'credits') {
    const session = credits.get(client.id);
    response._meta = {
      payment: 'credits',
      charged_usd: totalCost,
      remaining_usd: session.balance_usd,
    };
  } else {
    response._meta = { tier: client.tier };
  }
  
  return res.json(response);
});

// =============================================================================
// ROUTES: Usage
// =============================================================================

app.get('/usage', (req, res) => {
  const client = getClientIdentifier(req);
  
  if (client.tier === 'credits') {
    const session = credits.get(client.id);
    return res.json({
      type: 'prepaid_credits',
      balance_usd: session.balance_usd,
      calls_available: Math.floor(session.balance_usd / 0.01),
      total_calls_made: session.total_calls || 0,
      price_per_call: '$0.01',
    });
  }
  
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
    upgrade: client.tier === 'free' ? 'POST /credits/deposit for unlimited' : null,
  });
});

// =============================================================================
// ROUTES: Vouching
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
      error: `Maximum ${CONFIG.VOUCH.MAX_VOUCHES_PER_WALLET} active vouches`,
    });
  }
  
  const verification = await verifyPayment(signature, stake_amount * 1000000, CONFIG.FAIR_MINT);
  if (!verification.valid) {
    return res.status(402).json({
      error: 'Stake payment verification failed',
      reason: verification.error,
    });
  }
  
  const voucherData = await getWalletScore(voucher);
  const voucherScore = voucherData?.fairscore || 0;
  const recipientData = await getWalletScore(recipient);
  const recipientScore = recipientData?.fairscore || 0;
  
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
      'GET /score': 'Wallet score',
      'GET /check': 'Risk check',
      'POST /score/custom': 'Custom rules',
      'POST /batch': 'Batch scoring',
      'GET /credits': 'Credits info',
      'POST /credits/deposit': 'Deposit credits',
      'GET /credits/balance': 'Check balance',
      'POST /register': 'Get API key',
      'GET /usage': 'Check usage',
    },
  });
});

// =============================================================================
// START SERVER
// =============================================================================

const server = app.listen(CONFIG.PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════════╗
║                   FairScale API v3.1                               ║
╠════════════════════════════════════════════════════════════════════╣
║  Port: ${String(CONFIG.PORT).padEnd(60)}║
║  Treasury: ${CONFIG.TREASURY_WALLET.padEnd(55)}║
║                                                                    ║
║  Pricing:                                                          ║
║    Free        100 calls/day                                       ║
║    Credits     $0.01 per call (unlimited)                          ║
║    Pro         $50/month (10,000/day)                              ║
║                                                                    ║
║  Endpoints:                                                        ║
║    GET  /score           Wallet score                              ║
║    GET  /check           Pre-transaction risk check                ║
║    POST /score/custom    Custom scoring rules                      ║
║    POST /batch           Batch scoring                             ║
║    POST /credits/deposit Deposit USDC for credits                  ║
║    GET  /credits/balance Check credit balance                      ║
╚════════════════════════════════════════════════════════════════════╝
  `);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

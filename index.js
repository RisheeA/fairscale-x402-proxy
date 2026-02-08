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
  // Your FairScale enterprise API key
  FAIRSCALE_API_KEY: process.env.FAIRSCALE_API_KEY || 'zpka_128387537802403a8867d36db412162e_30fa9a36',
  
  // Your Solana wallet address to receive payments
  TREASURY_WALLET: process.env.TREASURY_WALLET || 'fairAUEuR1SCcHL254Vb3F3XpUWLruJ2a11f6QfANEN',
  
  // Pricing in USDC (6 decimals, so 50000 = $0.05)
  PRICES: {
    score: 50000,       // $0.05 per wallet check
    batch: 400000,      // $0.40 per batch (up to 10 wallets)
  },
  
  // USDC token mint on Solana mainnet
  USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  
  // Solana RPC (use a reliable one for production)
  SOLANA_RPC: process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
  
  // Port
  PORT: process.env.PORT || 3402,
  
  // Payment cache TTL (24 hours in ms) - prevents replay attacks
  PAYMENT_CACHE_TTL: 24 * 60 * 60 * 1000,
};

// Initialize Solana connection with timeout
const solana = new Connection(CONFIG.SOLANA_RPC, {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 30000,
});

// =============================================================================
// PAYMENT TRACKING - In-memory with TTL cleanup
// =============================================================================

const processedPayments = new Map(); // signature -> timestamp

// Cleanup old payments every hour
setInterval(() => {
  const now = Date.now();
  for (const [sig, timestamp] of processedPayments.entries()) {
    if (now - timestamp > CONFIG.PAYMENT_CACHE_TTL) {
      processedPayments.delete(sig);
    }
  }
}, 60 * 60 * 1000);

// =============================================================================
// HELPER: Validate Solana wallet address
// =============================================================================

function isValidSolanaAddress(address) {
  if (!address || typeof address !== 'string') return false;
  // Solana addresses are base58 encoded, 32-44 characters
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return base58Regex.test(address);
}

// =============================================================================
// HELPER: Verify Solana USDC payment
// =============================================================================

async function verifyPayment(signature, expectedAmount) {
  try {
    // Validate signature format
    if (!signature || typeof signature !== 'string' || signature.length < 80) {
      return { valid: false, error: 'Invalid signature format' };
    }
    
    // Check if already processed (replay protection)
    if (processedPayments.has(signature)) {
      return { valid: false, error: 'Payment already used' };
    }
    
    // Get transaction with retries
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
        if (retries > 0) {
          await new Promise(r => setTimeout(r, 1000)); // Wait 1s before retry
        }
      }
    }
    
    if (!tx) {
      return { valid: false, error: 'Transaction not found. It may still be processing - try again in a few seconds.' };
    }
    
    // Check transaction was successful
    if (tx.meta?.err) {
      return { valid: false, error: 'Transaction failed on-chain' };
    }
    
    // Check transaction age (must be within last 24 hours)
    const txTime = tx.blockTime ? tx.blockTime * 1000 : 0;
    if (txTime && Date.now() - txTime > CONFIG.PAYMENT_CACHE_TTL) {
      return { valid: false, error: 'Transaction too old. Must be within 24 hours.' };
    }
    
    // Look for USDC transfer to our treasury
    const meta = tx.meta;
    if (!meta) {
      return { valid: false, error: 'No transaction metadata' };
    }
    
    const postBalances = meta.postTokenBalances || [];
    const preBalances = meta.preTokenBalances || [];
    
    for (const post of postBalances) {
      // Check it's USDC going to our wallet
      if (post.mint === CONFIG.USDC_MINT && 
          post.owner === CONFIG.TREASURY_WALLET) {
        
        // Find matching pre-balance
        const pre = preBalances.find(p => 
          p.accountIndex === post.accountIndex && 
          p.mint === CONFIG.USDC_MINT
        );
        
        const preAmount = pre?.uiTokenAmount?.amount ? parseInt(pre.uiTokenAmount.amount) : 0;
        const postAmount = post.uiTokenAmount?.amount ? parseInt(post.uiTokenAmount.amount) : 0;
        const received = postAmount - preAmount;
        
        if (received >= expectedAmount) {
          // Mark as processed
          processedPayments.set(signature, Date.now());
          return { valid: true, amount: received };
        }
      }
    }
    
    return { valid: false, error: `Payment insufficient or wrong recipient. Expected ${expectedAmount / 1000000} USDC to ${CONFIG.TREASURY_WALLET}` };
    
  } catch (error) {
    console.error('Payment verification error:', error);
    return { valid: false, error: 'Verification failed: ' + error.message };
  }
}

// =============================================================================
// ROUTES
// =============================================================================

// Health check
app.get('/', (req, res) => {
  res.json({ 
    service: 'FairScale x402 Proxy',
    version: '1.0.0',
    status: 'ok',
    pricing: {
      score: '$0.05 USDC per wallet',
      batch: '$0.40 USDC per 10 wallets',
    },
    treasury: CONFIG.TREASURY_WALLET,
    network: 'solana-mainnet',
    currency: 'USDC',
    docs: 'https://docs.fairscale.xyz',
  });
});

// =============================================================================
// MAIN ENDPOINT: /score
// =============================================================================

app.get('/score', async (req, res) => {
  const wallet = req.query.wallet;
  const paymentSignature = req.headers['x-payment-signature'];
  
  // Validate wallet parameter
  if (!wallet) {
    return res.status(400).json({ 
      error: 'Missing wallet parameter',
      example: '/score?wallet=YOUR_SOLANA_WALLET_ADDRESS'
    });
  }
  
  if (!isValidSolanaAddress(wallet)) {
    return res.status(400).json({ 
      error: 'Invalid Solana wallet address',
      received: wallet
    });
  }
  
  // If no payment, return 402 with payment requirements
  if (!paymentSignature) {
    return res.status(402).json({
      status: 402,
      message: 'Payment Required',
      x402: {
        version: 1,
        scheme: 'exact',
        network: 'solana-mainnet',
        price: {
          amount: String(CONFIG.PRICES.score),
          currency: 'USDC',
          decimals: 6,
          readable: '$0.05',
        },
        recipient: CONFIG.TREASURY_WALLET,
        description: 'FairScale wallet reputation check',
        resource: `/score?wallet=${wallet}`,
        mimeType: 'application/json',
      },
      instructions: {
        step1: `Send exactly 0.05 USDC to ${CONFIG.TREASURY_WALLET}`,
        step2: 'Wait for transaction to confirm',
        step3: 'Retry this request with header: x-payment-signature: YOUR_TX_SIGNATURE',
      },
    });
  }
  
  // Verify payment
  const verification = await verifyPayment(paymentSignature, CONFIG.PRICES.score);
  
  if (!verification.valid) {
    return res.status(402).json({
      status: 402,
      error: 'Payment verification failed',
      reason: verification.error,
      retry: 'Check your transaction and try again',
    });
  }
  
  // Payment verified - call FairScale API
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
    
    const response = await fetch(
      `https://api.fairscale.xyz/score?wallet=${encodeURIComponent(wallet)}`,
      {
        headers: {
          'accept': 'application/json',
          'fairkey': CONFIG.FAIRSCALE_API_KEY,
        },
        signal: controller.signal,
      }
    );
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      throw new Error(`FairScale API returned ${response.status}`);
    }
    
    const data = await response.json();
    
    // Return data with payment receipt
    return res.json({
      ...data,
      _payment: {
        verified: true,
        signature: paymentSignature,
        amount: verification.amount / 1000000, // Convert to USDC
        currency: 'USDC',
      },
    });
    
  } catch (error) {
    console.error('FairScale API error:', error);
    
    // Refund note - payment was valid but we couldn't deliver
    return res.status(500).json({ 
      error: 'Failed to fetch wallet data from FairScale',
      message: error.message,
      payment: {
        signature: paymentSignature,
        note: 'Your payment was received. Please contact support if issue persists.',
      }
    });
  }
});

// =============================================================================
// BATCH ENDPOINT: /batch
// =============================================================================

app.post('/batch', async (req, res) => {
  const { wallets } = req.body;
  const paymentSignature = req.headers['x-payment-signature'];
  
  // Validate wallets
  if (!wallets || !Array.isArray(wallets) || wallets.length === 0) {
    return res.status(400).json({ 
      error: 'Missing or invalid wallets array',
      example: { wallets: ['address1', 'address2'] }
    });
  }
  
  if (wallets.length > 10) {
    return res.status(400).json({ 
      error: 'Maximum 10 wallets per batch',
      received: wallets.length
    });
  }
  
  // Validate each wallet address
  const invalidWallets = wallets.filter(w => !isValidSolanaAddress(w));
  if (invalidWallets.length > 0) {
    return res.status(400).json({
      error: 'Invalid wallet addresses detected',
      invalid: invalidWallets,
    });
  }
  
  // If no payment, return 402
  if (!paymentSignature) {
    return res.status(402).json({
      status: 402,
      message: 'Payment Required',
      x402: {
        version: 1,
        scheme: 'exact',
        network: 'solana-mainnet',
        price: {
          amount: String(CONFIG.PRICES.batch),
          currency: 'USDC',
          decimals: 6,
          readable: '$0.40',
        },
        recipient: CONFIG.TREASURY_WALLET,
        description: `FairScale batch check (${wallets.length} wallets)`,
        resource: '/batch',
        mimeType: 'application/json',
      },
      instructions: {
        step1: `Send exactly 0.40 USDC to ${CONFIG.TREASURY_WALLET}`,
        step2: 'Wait for transaction to confirm',
        step3: 'Retry this request with header: x-payment-signature: YOUR_TX_SIGNATURE',
      },
    });
  }
  
  // Verify payment
  const verification = await verifyPayment(paymentSignature, CONFIG.PRICES.batch);
  
  if (!verification.valid) {
    return res.status(402).json({
      status: 402,
      error: 'Payment verification failed',
      reason: verification.error,
    });
  }
  
  // Fetch all wallets with error handling per wallet
  try {
    const results = await Promise.all(
      wallets.map(async (wallet) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          
          const response = await fetch(
            `https://api.fairscale.xyz/score?wallet=${encodeURIComponent(wallet)}`,
            {
              headers: {
                'accept': 'application/json',
                'fairkey': CONFIG.FAIRSCALE_API_KEY,
              },
              signal: controller.signal,
            }
          );
          
          clearTimeout(timeout);
          
          if (!response.ok) {
            return { wallet, error: `API returned ${response.status}` };
          }
          
          return await response.json();
        } catch (e) {
          return { wallet, error: e.message };
        }
      })
    );
    
    return res.json({
      count: results.length,
      results,
      _payment: {
        verified: true,
        signature: paymentSignature,
        amount: verification.amount / 1000000,
        currency: 'USDC',
      },
    });
    
  } catch (error) {
    console.error('Batch API error:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch wallet data',
      message: error.message,
    });
  }
});

// =============================================================================
// ERROR HANDLING
// =============================================================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    endpoints: {
      'GET /': 'Health check and pricing info',
      'GET /score?wallet=ADDRESS': 'Check single wallet reputation',
      'POST /batch': 'Check multiple wallets (body: {wallets: [...]})',
    }
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// =============================================================================
// START SERVER
// =============================================================================

const server = app.listen(CONFIG.PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║           FairScale x402 Proxy - Production Ready             ║
╠═══════════════════════════════════════════════════════════════╣
║  Status:    ✅ Running                                        ║
║  Port:      ${String(CONFIG.PORT).padEnd(49)}║
║  Treasury:  ${CONFIG.TREASURY_WALLET.slice(0, 44)}  ║
║                                                               ║
║  Endpoints:                                                   ║
║    GET  /           Health check                              ║
║    GET  /score      $0.05 USDC per wallet                     ║
║    POST /batch      $0.40 USDC per 10 wallets                 ║
║                                                               ║
║  x402 Flow:                                                   ║
║    1. Agent calls endpoint                                    ║
║    2. Gets 402 + payment instructions                         ║
║    3. Sends USDC to treasury                                  ║
║    4. Retries with x-payment-signature header                 ║
║    5. Gets wallet data                                        ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

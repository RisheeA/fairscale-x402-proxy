# FairScale x402 Proxy

Accept USDC micropayments from AI agents for wallet reputation checks. No API keys needed for agents — they pay per request.

## How it works

```
Agent → Your Proxy → Returns 402 "Pay $0.05 USDC"
Agent → Sends USDC to your wallet
Agent → Retries with payment signature
Proxy → Verifies payment on Solana
Proxy → Calls FairScale API
Proxy → Returns wallet data
```

## Pricing

| Endpoint | Price | Description |
|----------|-------|-------------|
| `GET /score` | $0.05 USDC | Single wallet check |
| `POST /batch` | $0.40 USDC | Up to 10 wallets |

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/fairscale-x402-proxy
cd fairscale-x402-proxy
npm install
```

### 2. Configure (optional)

The default config uses FairScale's enterprise key and treasury. To use your own:

```bash
cp .env.example .env
# Edit .env with your values
```

### 3. Run

```bash
npm start
```

### 4. Test

```bash
# Health check
curl http://localhost:3402/

# Try to get a score (will return 402)
curl http://localhost:3402/score?wallet=GFTVQdZumAnBRbmaRgN9n3Z5qH5nXvjMZXJ3EyqP32Tn
```

## API Reference

### GET /

Health check and pricing info.

**Response:**
```json
{
  "service": "FairScale x402 Proxy",
  "status": "ok",
  "pricing": {
    "score": "$0.05 USDC per wallet",
    "batch": "$0.40 USDC per 10 wallets"
  },
  "treasury": "fairAUEuR1SCcHL254Vb3F3XpUWLruJ2a11f6QfANEN"
}
```

### GET /score?wallet=ADDRESS

Check a single wallet's reputation.

**Without payment:**
```bash
curl http://localhost:3402/score?wallet=ADDRESS
```

**Response (402):**
```json
{
  "status": 402,
  "message": "Payment Required",
  "x402": {
    "version": 1,
    "scheme": "exact",
    "network": "solana-mainnet",
    "price": {
      "amount": "50000",
      "currency": "USDC",
      "decimals": 6,
      "readable": "$0.05"
    },
    "recipient": "fairAUEuR1SCcHL254Vb3F3XpUWLruJ2a11f6QfANEN"
  },
  "instructions": {
    "step1": "Send exactly 0.05 USDC to fairAUEuR1SCcHL254Vb3F3XpUWLruJ2a11f6QfANEN",
    "step2": "Wait for transaction to confirm",
    "step3": "Retry this request with header: x-payment-signature: YOUR_TX_SIGNATURE"
  }
}
```

**With payment:**
```bash
curl http://localhost:3402/score?wallet=ADDRESS \
  -H "x-payment-signature: YOUR_SOLANA_TX_SIGNATURE"
```

**Response (200):**
```json
{
  "wallet": "...",
  "fairscore": 90.0,
  "tier": "platinum",
  "badges": [...],
  "features": {...},
  "_payment": {
    "verified": true,
    "signature": "...",
    "amount": 0.05,
    "currency": "USDC"
  }
}
```

### POST /batch

Check up to 10 wallets at once.

**Request:**
```bash
curl -X POST http://localhost:3402/batch \
  -H "Content-Type: application/json" \
  -H "x-payment-signature: YOUR_TX_SIGNATURE" \
  -d '{"wallets": ["addr1", "addr2", "addr3"]}'
```

**Response:**
```json
{
  "count": 3,
  "results": [
    {"wallet": "addr1", "fairscore": 90, ...},
    {"wallet": "addr2", "fairscore": 45, ...},
    {"wallet": "addr3", "fairscore": 72, ...}
  ],
  "_payment": {
    "verified": true,
    "signature": "...",
    "amount": 0.40,
    "currency": "USDC"
  }
}
```

## For x402-Compatible Agents

Agents that support the x402 protocol will automatically:
1. Detect the 402 response
2. Parse payment requirements
3. Send USDC payment
4. Retry with the payment signature
5. Receive the data

No manual configuration needed.

## Deployment

### Railway (Recommended)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app)
3. New Project → Deploy from GitHub
4. Select this repo
5. Add environment variables (optional - defaults are set)
6. Deploy

### Vercel

```bash
npm i -g vercel
vercel
```

### Docker

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3402
CMD ["npm", "start"]
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FAIRSCALE_API_KEY` | (set) | Your FairScale API key |
| `TREASURY_WALLET` | (set) | Solana wallet for USDC payments |
| `SOLANA_RPC` | mainnet-beta | Solana RPC endpoint |
| `PORT` | 3402 | Server port |

## Security Features

- **Replay protection**: Each payment signature can only be used once
- **Transaction age check**: Payments must be within 24 hours
- **Input validation**: All wallet addresses are validated
- **Timeout handling**: API calls timeout after 10 seconds
- **Graceful shutdown**: Handles SIGTERM properly

## Revenue

At $0.05 per call:
- 1,000 calls/day = $50/day = **$1,500/month**
- 10,000 calls/day = $500/day = **$15,000/month**

## Support

- Docs: https://docs.fairscale.xyz
- API Keys: https://sales.fairscale.xyz
- Twitter: [@FairScaleXYZ](https://twitter.com/FairScaleXYZ)

## License

MIT

# ZeroDrift bot — go-live runbook (owner)

The engine already runs BY ITSELF, 24/7, as docker container `zd-hedger` on the VPS —
currently in **paper mode** (simulated fills on live mainnet data; feeds the site's
terminal). To make it trade REAL funds autonomously, the owner does this once:

## 0. What the bot does when live

Hold spot MON + short MON-perp on Perpl at equal size. Every 15 min it churns 25% of the
short with PostOnly maker orders (~1.8bps/round-trip) to farm 2×-boosted mPoints volume.
It rebalances delta (maker first, taker beyond 3%), pauses churn when funding costs >10%
APR, unwinds itself on margin pressure, records epochs in the HedgeRegistry, and reports
to Telegram. Kill it any time: `docker stop zd-hedger` (or set HEDGER_UNWIND=true and
restart to exit the position cleanly first).

## 1. Prepare a fresh wallet (once)

- Fund with: **AUSD** (Perpl collateral — min $10, suggested $50–200; buy via
  nullterminal.xyz), **USDC** for the spot leg (same notional), and ~1 MON gas.
- Connect this wallet ONCE at https://app.perpl.xyz (creates your Perpl profile —
  without it the API returns 404 "target profile not found").

## 2. Enroll the API key + exchange account (once, ~2 min)

On any machine with the repo + bun:

```bash
cd zerodrift/bot && bun install
# EIP-712 enroll — prints PERPL_API_KEY + PERPL_ED25519_PRIVKEY, never writes them to disk
ENROLL_PRIVATE_KEY=0x<wallet-key> bun run hedger:enroll
# on-chain account: approve AUSD → createAccount → prints PERPL_ACCOUNT_ID
HEDGER_PRIVATE_KEY=0x<wallet-key> MONAD_RPC_URL=https://rpc.monad.xyz bun run hedger:bootstrap --deposit 50
```

(Alternative to the first script: create the key in the Perpl UI at /apikeys and copy
the token + private key.)

## 3. Flip the container to live

On the VPS, create `/opt/zerodrift/bot/.env.live` is NOT used — pass env directly:

```bash
docker rm -f zd-hedger
docker run -d --name zd-hedger --restart unless-stopped --network host \
  -v /opt/zerodrift:/opt/zerodrift -w /opt/zerodrift/bot \
  -e HEDGER_STATUS_FILE=/opt/zerodrift/status/status.json \
  -e NT_API_BASE=http://localhost:8421 \
  -e MONAD_RPC_URL=https://rpc.monad.xyz \
  -e HEDGER_LIVE=true \
  -e HEDGER_PRIVATE_KEY=0x… \
  -e PERPL_API_KEY=… \
  -e PERPL_ED25519_PRIVKEY=0x… \
  -e PERPL_ACCOUNT_ID=… \
  -e HEDGER_NOTIONAL_USD=50 \
  -e HEDGER_REGISTRY_ADDRESS=0x24BD952B9BaD090Eab24A1a91948fA130c8D3A48 \
  -e TG_BOT_TOKEN=… -e TG_CHAT_ID=… \
  oven/bun:1-alpine bun run hedger
docker logs -f zd-hedger   # expect: mode=LIVE, spot buy tx, maker short fills
```

Safety rails already in the code: live requires ALL four env vars; hard caps
(HEDGER_MAX_DAILY_TAKER_USD default $25, notional fixed); Perpl API keys can never
withdraw; every live tx alerts to Telegram. Start with $50 notional, watch one full
churn cycle, then size up.

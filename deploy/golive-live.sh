#!/usr/bin/env bash
# ZeroDrift — OWNER-run go-live for the REAL-MONEY bot (zd-live).
#
# Run this YOURSELF on the VPS:   bash /opt/zerodrift/deploy/golive-live.sh [notional] [strategy]
# Keys are prompted silently (never echoed, not in shell history). They DO live in
# the container's env (visible to root via `docker inspect zd-live` — it is your
# box). The two paper demo bots (zd-hedger, zd-hedger-as) keep running.
#
# Assumes HEDGER_SPOT_MANAGED=false: YOU already hold the spot MON in your own
# wallet — this bot only manages the perp short on Perpl. Your wallet key is NOT
# required (Perpl API keys cannot withdraw funds, by protocol design).
set -euo pipefail

NOTIONAL="${1:-100}"
STRATEGY="${2:-avellaneda}"

echo "════════════════════════════════════════════════════════════"
echo " ZeroDrift LIVE go-live · notional \$$NOTIONAL · strategy $STRATEGY"
echo " Spot leg: owner-held (bot never touches your MON)"
echo "════════════════════════════════════════════════════════════"
echo
echo "Prereqs:"
echo "  1. You hold ≥ \$$NOTIONAL of MON in your wallet (the spot leg)."
echo "  2. Perpl account funded with AUSD collateral (≥ \$$NOTIONAL recommended for a 1:1 pump buffer at 2x)."
echo "  3. Perpl API key created (app.perpl.xyz/apikeys or 'bun run hedger:enroll')."
echo "  4. Browser auto-farm for this account is OFF (two quoters would fight over the same short)."
echo
read -rp  "PERPL_ACCOUNT_ID (number): " ACC
read -rsp "PERPL_API_KEY: " APIKEY; echo
read -rsp "PERPL_ED25519_PRIVKEY (0x…): " EDKEY; echo
read -rsp "Burner wallet key for on-chain epoch receipts (OPTIONAL — Enter to skip): " WKEY; echo
read -rp  "TG_BOT_TOKEN (optional, Enter to skip): " TGTOK
TGCHAT=""
[[ -n "$TGTOK" ]] && read -rp "TG_CHAT_ID: " TGCHAT

if [[ -z "$ACC" || -z "$APIKEY" || -z "$EDKEY" ]]; then
  echo "✗ PERPL_ACCOUNT_ID, PERPL_API_KEY and PERPL_ED25519_PRIVKEY are all required."
  exit 1
fi
case "$ACC" in *[!0-9]*) echo "✗ PERPL_ACCOUNT_ID must be a number"; exit 1;; esac

echo
echo "About to launch container zd-live: \$$NOTIONAL $STRATEGY on account #$ACC (REAL orders on Perpl)."
read -rp "Type GO to launch: " OK
[[ "$OK" == "GO" ]] || { echo "aborted"; exit 1; }

mkdir -p /opt/zerodrift/bot/data-live /opt/zerodrift/status
docker rm -f zd-live >/dev/null 2>&1 || true
docker run -d --name zd-live --network host --restart on-failure \
  -v /opt/zerodrift:/opt/zerodrift -w /opt/zerodrift/bot \
  -e HEDGER_LIVE=true \
  -e HEDGER_STRATEGY="$STRATEGY" \
  -e HEDGER_SPOT_MANAGED=false \
  -e HEDGER_UNWIND="${HEDGER_UNWIND:-false}" \
  -e HEDGER_NOTIONAL_USD="$NOTIONAL" \
  -e PERPL_ACCOUNT_ID="$ACC" \
  -e PERPL_API_KEY="$APIKEY" \
  -e PERPL_ED25519_PRIVKEY="$EDKEY" \
  ${WKEY:+-e HEDGER_PRIVATE_KEY="$WKEY"} \
  ${WKEY:+-e HEDGER_REGISTRY_ADDRESS=0x24BD952B9BaD090Eab24A1a91948fA130c8D3A48} \
  ${TGTOK:+-e TG_BOT_TOKEN="$TGTOK"} \
  ${TGCHAT:+-e TG_CHAT_ID="$TGCHAT"} \
  -e HEDGER_STATUS_FILE=/opt/zerodrift/status/status-live.json \
  -e HEDGER_DATA_DIR=/opt/zerodrift/bot/data-live \
  -e NT_API_BASE=http://localhost:8421 \
  -e MONAD_RPC_URL=https://rpc.monad.xyz \
  oven/bun:1-alpine bun run hedger

echo
echo "✓ launched. Expect in the logs: mode=LIVE → session ready → maker short fills → HEDGED → quoting."
echo "  follow : docker logs -f zd-live"
echo "  status : https://hedge.nullterminal.xyz/status-live.json"
echo "  KILL   : docker stop zd-live        (position stays on Perpl, close it in the app)"
echo "  UNWIND : docker rm -f zd-live && HEDGER_UNWIND=true bash /opt/zerodrift/deploy/golive-live.sh $NOTIONAL $STRATEGY"

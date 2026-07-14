#!/usr/bin/env bash
# Deploy HedgeRegistry to Monad mainnet (chain 143).
# Usage: MONAD_RPC_URL=... DEPLOYER_PRIVATE_KEY=0x... bash script/deploy-hedge-registry.sh
# Monad needs --legacy; forge script broadcast is flaky on 143 → forge create + cast smoke test.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${MONAD_RPC_URL:?set MONAD_RPC_URL}"
: "${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY}"

forge build

echo "== deploying HedgeRegistry =="
forge create src/HedgeRegistry.sol:HedgeRegistry \
  --rpc-url "$MONAD_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --legacy --broadcast | tee /tmp/hedge-registry-deploy.log

REGISTRY=$(grep "Deployed to:" /tmp/hedge-registry-deploy.log | awk '{print $3}')
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
echo "REGISTRY=$REGISTRY"

echo "== smoke test: openEpoch + epochCount =="
cast send "$REGISTRY" --legacy --gas-limit 300000 \
  --rpc-url "$MONAD_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" \
  "openEpoch(uint32,uint128,bytes32,bytes32)" 10 1000000 \
  0x0000000000000000000000000000000000000000000000000000000000000001 \
  0x0000000000000000000000000000000000000000000000000000000000000002 >/dev/null

COUNT=$(cast call "$REGISTRY" "epochCount(address)(uint256)" "$DEPLOYER" --rpc-url "$MONAD_RPC_URL")
echo "epochCount($DEPLOYER) = $COUNT (expect 1)"

echo ""
echo "Add to .env:"
echo "  HEDGER_REGISTRY_ADDRESS=$REGISTRY"
echo "  VITE_HEDGE_REGISTRY_ADDRESS=$REGISTRY"

# zd-cloud — run YOUR bot 24/7 on the ZeroDrift server

The web console's **Cloud runner** card lets any user hand their strategy to the
ZeroDrift VPS instead of babysitting a browser tab. One wallet signature to start,
one to stop.

## User flow (all in the browser)

1. Connect wallet + paste Perpl trade keys in the Hedge console (as usual).
2. In **Cloud runner · 24/7**: pick notional ($10–$200), tick *real orders (LIVE)*
   or leave paper, hit **Run on server** → sign one `personal_sign` message.
3. Done — close the tab. The instance card shows 🟢 running + a personal status
   feed (`/status-u-<id>.json`). **Stop** or **Stop + unwind** anytime (signed).

## Security model (honest version)

- **Auth**: every start/stop is gated by an EIP-191 signature over
  `zerodrift-cloud:<action>:<address>:<ts>` (±5 min window, EOA only). Nobody can
  start/stop/replace your instance without your wallet.
- **Key custody**: Perpl API keys travel once over same-origin HTTPS and are stored
  **AES-256-GCM encrypted** (`/opt/zerodrift/cloud/secret.key`, 0600, generated on
  the box). They are decrypted only into *your* container's env at spawn and are
  never logged. Root on the box can read them (`docker inspect`) — same trust model
  as `golive-live.sh`, stated plainly.
- **Blast radius**: Perpl API keys **cannot withdraw funds** (protocol guarantee).
  Spot stays in the user's wallet — the server only ever runs the perp side
  (`HEDGER_SPOT_MANAGED=false`, never a wallet key).
- **Caps**: max 8 instances, $10–$200 notional, per-container `--cpus 0.5
  --memory 384m`, per-IP rate limiting.

## Ops

```bash
# deploy/update the API (build + restart, ~10s)
bash /opt/zerodrift/deploy/zd-cloud.sh

# health / inventory
curl -s localhost:8796/api/cloud/health
docker ps --filter label=zerodrift.cloud=user

# kill one user instance manually
docker rm -f zd-u-<id>   # config+keys stay encrypted in cloud/instances/
```

Caddy routes `/api/cloud/*` → `localhost:8796`; per-user feeds ride the existing
`/status*.json` file server. Instance state lives in
`/opt/zerodrift/cloud/instances/<address>.json` (encrypted keys + config).

Verified by `bot/test/unit/cloud.test.ts` (crypto round-trip, signature gate,
validation caps, spawn-args hygiene) and an end-to-end burner-wallet run on prod:
start → feed live → wrong-wallet stop rejected (401) → stop+forget clean.

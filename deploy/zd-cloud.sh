#!/usr/bin/env bash
# Build + (re)start the zd-cloud user-instance API on the VPS.
# Run on the box: bash /opt/zerodrift/deploy/zd-cloud.sh
set -euo pipefail

cd /opt/zerodrift
mkdir -p cloud/instances cloud/data status

docker build -q -t zd-cloud -f deploy/cloud.Dockerfile deploy/
docker rm -f zd-cloud >/dev/null 2>&1 || true
docker run -d --name zd-cloud --restart unless-stopped --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/zerodrift:/opt/zerodrift \
  -e CLOUD_PORT=8796 \
  -e CLOUD_DIR=/opt/zerodrift/cloud \
  -e CLOUD_MAX_INSTANCES=25 \
  -e CLOUD_MAX_NOTIONAL_USD=500 \
  zd-cloud

sleep 2
curl -sf http://localhost:8796/api/cloud/health && echo && echo "zd-cloud OK"

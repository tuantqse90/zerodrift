# zd-cloud — the 24/7 user-instance runner API. Needs the docker CLI to spawn
# sibling bot containers through the host socket (mounted at run time).
FROM oven/bun:1-alpine
RUN apk add --no-cache docker-cli
WORKDIR /opt/zerodrift/bot
CMD ["bun", "run", "src/cloud/server.ts"]

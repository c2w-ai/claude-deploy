FROM node:20-bookworm-slim

# System deps: Railway CLI needs a few things, and we use `tar` for extraction.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tar gzip \
 && rm -rf /var/lib/apt/lists/*

# Install a pinned Railway CLI version. We rely on this CLI for `railway up`
# (the tarball upload + build trigger). Bumping this version is a deliberate
# act — unpinning risks silent contract breakage on every image rebuild.
ARG RAILWAY_CLI_VERSION=4.36.1
RUN npm install -g "@railway/cli@${RAILWAY_CLI_VERSION}" \
 && railway --version

WORKDIR /app

COPY package.json ./
# No runtime dependencies currently. Node's built-in fetch + child_process
# cover everything the server needs.
COPY server.js ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "server.js"]

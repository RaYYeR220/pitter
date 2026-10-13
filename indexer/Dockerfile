FROM node:24-bookworm-slim

# The RPC client verifies TLS against the system certificates, which the slim image leaves out.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.32.0

WORKDIR /indexer

COPY package.json ./
RUN pnpm install --no-lockfile

COPY . .
RUN pnpm envio codegen

CMD ["pnpm", "envio", "start"]

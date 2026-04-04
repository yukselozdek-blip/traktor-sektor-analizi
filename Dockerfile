FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl dumb-init ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl --fail --silent http://localhost:${PORT:-3000}/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]

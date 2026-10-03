# ---- build stage: all deps + minified assets ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && rm -rf node_modules

# ---- runtime stage ----
FROM node:22-bookworm-slim
WORKDIR /app
# Serve public/dist minified assets without altering other NODE_ENV-dependent behaviour
ENV SERVE_MINIFIED=1

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/ ./
RUN chown -R node:node /app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/health').then(res => { if (!res.ok) process.exit(1); }).catch(() => process.exit(1))"

USER node

CMD ["npm", "start"]

FROM node:22-bookworm-slim

WORKDIR /app

COPY . .

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/health').then(res => { if (!res.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["npm", "start"]

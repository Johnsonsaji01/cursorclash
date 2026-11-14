FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

# admin portal data (password, bans, settings, 24 h log) — mount a persistent volume here in Coolify
RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]

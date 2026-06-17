# Multi-stage Dockerfile for FMSS Contracts (contracts.fmss.ae)
# Stage 1: Dependencies
FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Stage 2: Runtime
FROM node:24-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# SQLite lives on a persistent volume mounted at /data (set FMSS_DB_PATH=/data/fmss.db)
RUN mkdir -p /data
ENV PORT=3002

# Health check hits the app's /api/health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3002) + '/api/health', (r) => { if (r.statusCode !== 200) throw new Error('unhealthy'); })"

EXPOSE 3002
CMD ["node", "server/index.js"]

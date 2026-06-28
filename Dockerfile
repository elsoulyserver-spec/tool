# ── Easy Track — Dockerfile for Google Cloud Run / Railway / any VPS ──────
FROM node:20-slim

WORKDIR /app

# Skip Puppeteer's Chromium download — the scan feature uses a graceful
# fallback when Puppeteer is unavailable. This keeps the image small and
# prevents Railway build timeouts caused by the ~300 MB Chrome download.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_ENV=production

# Copy package files and install deps
COPY package*.json ./
RUN npm install --omit=dev

# Copy app source
COPY . .

# Cloud Run / Railway set PORT dynamically; server.js reads process.env.PORT || 3000
EXPOSE 3000

CMD ["node", "server.js"]

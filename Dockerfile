FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY public ./public
COPY src ./src
COPY server.js ./server.js
RUN mkdir -p /app/data /app/storage \
  && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server.js"]

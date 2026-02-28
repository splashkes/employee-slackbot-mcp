FROM node:20-alpine AS deps

WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./

# Copy shared package
COPY packages/shared/ ./packages/shared/

# Copy ALL service package.json files so npm can resolve the full workspace
COPY services/slackbot/package.json ./services/slackbot/
COPY services/mcp-gateway/package.json ./services/mcp-gateway/

# Install all production dependencies
RUN npm ci --omit=dev

# ---

FROM node:20-alpine

WORKDIR /app

# Copy hoisted root modules + service-level modules (npm may split across both)
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/services/slackbot/node_modules ./services/slackbot/node_modules

# Copy service source and config
COPY services/slackbot/package.json ./services/slackbot/
COPY services/slackbot/src ./services/slackbot/src
COPY config ./config

WORKDIR /app/services/slackbot

EXPOSE 3000

CMD ["node", "src/index.js"]

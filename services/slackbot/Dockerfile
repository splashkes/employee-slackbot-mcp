FROM node:20-alpine AS deps

WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./

# Copy shared package
COPY packages/shared/ ./packages/shared/

# Copy service package.json
COPY services/slackbot/package.json ./services/slackbot/

# Install production dependencies for the slackbot workspace
RUN npm ci --omit=dev --workspace=services/slackbot

# ---

FROM node:20-alpine

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/services/slackbot/node_modules ./services/slackbot/node_modules 2>/dev/null || true

# Copy service source and config
COPY services/slackbot/package.json ./services/slackbot/
COPY services/slackbot/src ./services/slackbot/src
COPY config ./config

WORKDIR /app/services/slackbot

EXPOSE 3000

CMD ["node", "src/index.js"]

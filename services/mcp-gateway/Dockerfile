FROM node:20-alpine AS deps

WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./

# Copy shared package
COPY packages/shared/ ./packages/shared/

# Copy service package.json
COPY services/mcp-gateway/package.json ./services/mcp-gateway/

# Install production dependencies for the mcp-gateway workspace
RUN npm ci --omit=dev --workspace=services/mcp-gateway

# ---

FROM node:20-alpine

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/services/mcp-gateway/node_modules ./services/mcp-gateway/node_modules 2>/dev/null || true

# Copy service source and config
COPY services/mcp-gateway/package.json ./services/mcp-gateway/
COPY services/mcp-gateway/src ./services/mcp-gateway/src
COPY config ./config

WORKDIR /app/services/mcp-gateway

EXPOSE 8081

CMD ["node", "src/index.js"]

FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
# --legacy-peer-deps: npm 10's peer-set resolution crashes on this tree
# ("Cannot read properties of null (reading 'edgesOut')"). No runtime
# package here relies on npm auto-installing peers.
RUN npm install --legacy-peer-deps

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3200

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --legacy-peer-deps
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/*.sql ./dist/

EXPOSE 3200

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3200/health || exit 1

CMD ["sh", "-c", "node dist/migrate-run.js && node dist/index.js"]

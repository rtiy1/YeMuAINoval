# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14 AS build

WORKDIR /app

COPY . .

RUN --mount=type=cache,target=/root/.bun/install/cache \
	bun install --frozen-lockfile
RUN bun run check
RUN bun run build

FROM oven/bun:1.3.14 AS production-dependencies

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
COPY packages ./packages

RUN --mount=type=cache,target=/root/.bun/install/cache \
	bun install --production --filter './' --frozen-lockfile

FROM oven/bun:1.3.14 AS runtime

WORKDIR /app

ENV NODE_ENV=production \
	HOST=0.0.0.0 \
	PORT=8787 \
	STORY_DATA_FILE=/app/data/db.json \
	STORY_SKILL_MARKET_DIR=/app/data/skill-market

COPY --from=build --chown=bun:bun /app/package.json /app/bun.lock /app/bunfig.toml ./
COPY --from=production-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/packages ./packages
COPY --from=build --chown=bun:bun /app/server ./server
COPY --from=build --chown=bun:bun /app/src ./src
COPY --from=build --chown=bun:bun /app/skills ./skills
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/LICENSE ./

RUN mkdir -p /app/data && chown bun:bun /app/data

USER bun

EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
	CMD ["bun", "-e", "fetch('http://127.0.0.1:8787/api/health').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["bun", "server/index.mjs"]

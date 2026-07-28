FROM node:22-bookworm-slim AS build

ARG VITE_SOURCE_REPOSITORY_URL=https://github.com/rtiy1/YeMuAINoval
ENV VITE_SOURCE_REPOSITORY_URL=${VITE_SOURCE_REPOSITORY_URL}
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim

ARG VITE_SOURCE_REPOSITORY_URL=https://github.com/rtiy1/YeMuAINoval
LABEL org.opencontainers.image.source="${VITE_SOURCE_REPOSITORY_URL}"

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/LICENSE ./LICENSE
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/skills ./skills
COPY --from=build /app/src/sse.mjs ./src/sse.mjs

EXPOSE 8787
CMD ["node", "server/index.mjs"]

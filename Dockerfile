FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
ARG API_INTERNAL_URL=http://api:4000
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_SOCKET_URL=http://localhost:4000
ARG NEXT_PUBLIC_APP_ENV=production
ENV API_INTERNAL_URL=$API_INTERNAL_URL \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_SOCKET_URL=$NEXT_PUBLIC_SOCKET_URL \
    NEXT_PUBLIC_APP_ENV=$NEXT_PUBLIC_APP_ENV \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:24-bookworm-slim AS api
WORKDIR /workspace
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Smart Printer Queue API" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$REVISION
RUN corepack enable
COPY --from=build /workspace /workspace
ENV NODE_ENV=production
EXPOSE 4000
CMD ["sh", "-c", "pnpm --filter @printer/api db:migrate && pnpm --filter @printer/api start"]

FROM node:24-bookworm-slim AS web
WORKDIR /workspace
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Smart Printer Queue Web" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$REVISION
RUN corepack enable
COPY --from=build /workspace /workspace
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
CMD ["pnpm", "--filter", "@printer/web", "start"]

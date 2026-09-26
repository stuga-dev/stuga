# check=skip=SecretsUsedInArgOrEnv
# The Stuga node: everything but Postgres. Build from the repository root:
#   docker build -f packaging/docker/node.Dockerfile --build-arg STUGA_VERSION=1.2.3 .
# The defaults below are packaging/versions.env; packaging/check-pins.sh keeps them equal.
ARG NODE_VERSION=26.10.0
ARG DEBIAN_SUITE=bookworm

FROM node:${NODE_VERSION}-${DEBIAN_SUITE}-slim AS build
ARG PNPM_VERSION=12.6.0
RUN npm install -g "pnpm@${PNPM_VERSION}"
ENV npm_config_update_notifier=false
WORKDIR /src
COPY . .
# Unset, the image carries no VERSION and reports itself as a source build.
ARG STUGA_VERSION
# The store lives in a cache mount outside /app, so it never reaches the runtime stage.
RUN --mount=type=cache,id=stuga-pnpm-store,target=/pnpm/store \
    npm_config_store_dir=/pnpm/store \
    bash packaging/shared/build-app.sh /app ${STUGA_VERSION:+--version "$STUGA_VERSION"}

FROM node:${NODE_VERSION}-${DEBIAN_SUITE}-slim AS runtime
ARG DEBIAN_SUITE
ARG PG_MAJOR=18
ARG PGDG_KEY_SHA256=0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76

# pg_dump refuses a server newer than itself and Debian's own client is older, so the client
# comes from the PostgreSQL project's repository, whose key is pinned by checksum.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    install -d /usr/share/postgresql-common/pgdg; \
    curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc; \
    echo "${PGDG_KEY_SHA256}  /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc" | sha256sum -c -; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${DEBIAN_SUITE}-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}"; \
    apt-get purge -y curl; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

ARG STUGA_VERSION
LABEL org.opencontainers.image.title="Stuga node" \
      org.opencontainers.image.description="The Stuga node: everything but Postgres." \
      org.opencontainers.image.version="${STUGA_VERSION:-0.0.0-dev}" \
      org.opencontainers.image.source="https://github.com/stuga-dev/stuga" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

COPY --from=build /app /app
COPY packaging/docker/healthcheck.mjs /usr/local/lib/stuga/healthcheck.mjs

ENV NODE_ENV=production \
    PG_BIN=/usr/lib/postgresql/${PG_MAJOR}/bin \
    DATA_DIR=/data \
    BIND=0.0.0.0 \
    PORT=8787 \
    STUGA_STDIO_ENTRY="" \
    STUGA_RESTART_HINT="Run docker compose up -d in your Stuga directory to apply it." \
    STUGA_UPGRADE_HINT="Run ./stuga upgrade in your Stuga directory: it downloads the release and installs it." \
    AI_OLLAMA_DEFAULT_URL=http://host.docker.internal:11434
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --start-interval=2s --retries=3 \
  CMD ["node", "/usr/local/lib/stuga/healthcheck.mjs"]

WORKDIR /app/services/node
CMD ["node", "bin/stuga-node.js", "serve"]

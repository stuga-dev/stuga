# Stuga's Postgres: pgvector for semantic search, pg_search (ParadeDB) for BM25 keyword search.
# The defaults below are packaging/versions.env; packaging/check-pins.sh keeps them equal.
ARG PGVECTOR_VERSION=0.8.6
ARG PG_MAJOR=18
ARG DEBIAN_SUITE=bookworm
FROM pgvector/pgvector:${PGVECTOR_VERSION}-pg${PG_MAJOR}-${DEBIAN_SUITE}

# PG_MAJOR comes from the base image's environment.
ARG DEBIAN_SUITE
ARG PG_SEARCH_VERSION=0.25.9
ARG PG_SEARCH_DEB_AMD64_SHA256=8f70e992f03493dafe9f93d84781779625a23450c5eb85b6791501032d190bcb
ARG PG_SEARCH_DEB_ARM64_SHA256=5e0fcdf88b3b156d39679217f53de5c016de48e8a42faed57a9271e3160361bf
ARG TARGETARCH

# A GitHub release asset can be replaced in place, and installing a local .deb checks no signature:
# the checksum is the pin.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl ca-certificates; \
    case "${TARGETARCH:-amd64}" in \
      amd64) sha="${PG_SEARCH_DEB_AMD64_SHA256}" ;; \
      arm64) sha="${PG_SEARCH_DEB_ARM64_SHA256}" ;; \
      *) echo "unsupported architecture ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/pg_search.deb \
      "https://github.com/paradedb/paradedb/releases/download/v${PG_SEARCH_VERSION}/postgresql-${PG_MAJOR}-pg-search_${PG_SEARCH_VERSION}-1PARADEDB-${DEBIAN_SUITE}_${TARGETARCH:-amd64}.deb"; \
    echo "${sha}  /tmp/pg_search.deb" | sha256sum -c -; \
    apt-get install -y --no-install-recommends /tmp/pg_search.deb; \
    rm -f /tmp/pg_search.deb; \
    apt-get purge -y curl; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

# pg_search is AGPL-3.0 and redistributed here as a binary, so its notice travels inside the image.
LABEL org.opencontainers.image.licenses="PostgreSQL AND AGPL-3.0-only"
RUN set -eux; \
    mkdir -p /usr/share/doc/stuga; \
    { \
      echo "This image redistributes third-party components:"; \
      echo; \
      echo "  pgvector — PostgreSQL License — https://github.com/pgvector/pgvector"; \
      echo "  pg_search (ParadeDB) ${PG_SEARCH_VERSION} — AGPL-3.0 — https://github.com/paradedb/paradedb"; \
      echo "      Corresponding source: https://github.com/paradedb/paradedb/tree/v${PG_SEARCH_VERSION}"; \
      echo; \
      echo "Stuga itself is AGPL-3.0-only — https://github.com/stuga-dev/stuga"; \
    } > /usr/share/doc/stuga/THIRD-PARTY-NOTICES.txt

RUN echo "shared_preload_libraries = 'pg_search'" >> /usr/share/postgresql/postgresql.conf.sample

# Read by the image's entrypoint when it creates a cluster; the node refuses a database with another collation.
ARG INITDB_ARGS="--encoding=UTF8 --locale-provider=builtin --builtin-locale=C.UTF-8 --locale=C.UTF-8 --data-checksums"
ENV POSTGRES_INITDB_ARGS="${INITDB_ARGS}"

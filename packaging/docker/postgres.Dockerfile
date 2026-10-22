# Stuga's Postgres: the pgvector image, with today's Debian updates and the cluster spec the node expects.
# The defaults below are packaging/versions.env; packaging/check-pins.sh keeps them equal.
ARG PGVECTOR_VERSION=0.8.6
ARG PG_MAJOR=18
ARG DEBIAN_SUITE=trixie
FROM pgvector/pgvector:${PGVECTOR_VERSION}-pg${PG_MAJOR}-${DEBIAN_SUITE}

LABEL org.opencontainers.image.licenses="PostgreSQL"
# The UTC date (restore-drill.sh, release.yml). Each new day reruns the upgrade below, so a cached
# layer never ships packages Debian or PGDG has since fixed.
ARG APT_REFRESH

RUN set -eux; \
    apt-get update; \
    apt-get -y upgrade; \
    rm -rf /var/lib/apt/lists/*

# Read by the image's entrypoint when it creates a cluster; the node refuses a database with another collation.
ARG INITDB_ARGS="--encoding=UTF8 --locale-provider=builtin --builtin-locale=C.UTF-8 --locale=C.UTF-8 --data-checksums"
ENV POSTGRES_INITDB_ARGS="${INITDB_ARGS}"

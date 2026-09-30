# The remote access connector: frpc, built from frp's pinned commit by
# packaging/shared/connector/build.sh, and supervisor.sh, which runs it as the node asks. Idle until
# remote access is turned on. Build from the repository root, natively on each architecture:
#   docker build -f packaging/docker/remote.Dockerfile --build-arg STUGA_VERSION=1.2.3 .
# The default below is packaging/versions.env; packaging/check-pins.sh keeps it equal.
ARG DEBIAN_SUITE=bookworm

FROM debian:${DEBIAN_SUITE}-slim AS build
ARG TARGETARCH
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git; \
    rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Only what build.sh reads: its pins, its download helper and itself.
COPY packaging/versions.env packaging/versions.env
COPY packaging/macos/build/lib/fetch.sh packaging/macos/build/lib/fetch.sh
COPY packaging/shared/connector packaging/shared/connector
# The Go tarball is cached, and checked against its pin on every use.
RUN --mount=type=cache,id=stuga-remote-downloads,target=/downloads \
    STUGA_MACOS_CACHE=/downloads bash packaging/shared/connector/build.sh --target "linux/${TARGETARCH:-amd64}" --out /out

FROM debian:${DEBIAN_SUITE}-slim AS runtime
ARG STUGA_VERSION
LABEL org.opencontainers.image.title="Stuga remote access" \
      org.opencontainers.image.description="The Stuga node's remote access connector (frpc), run as the node asks." \
      org.opencontainers.image.version="${STUGA_VERSION:-0.0.0-dev}" \
      org.opencontainers.image.source="https://github.com/stuga-dev/stuga" \
      org.opencontainers.image.licenses="AGPL-3.0-only AND Apache-2.0"

# The node lays out the shared volume at every start; a new volume mounted here first starts out
# the same way. The subdirectories come first, so they do not inherit the setgid bit.
RUN set -eux; \
    install -d -o root -g 65532 -m 0750 /run/stuga-remote /run/stuga-remote/control; \
    install -d -o 65532 -g 65532 -m 0750 /run/stuga-remote/status; \
    chmod 2750 /run/stuga-remote; \
    install -d -m 0755 /usr/local/lib/stuga /usr/share/doc/stuga

COPY --from=build --chmod=0755 /out/frpc /usr/local/bin/frpc
# frp's license and the notices of every module frpc links; the notices name LICENSE beside them.
COPY --from=build --chmod=0644 /out/LICENSE /usr/share/doc/stuga/LICENSE
COPY --from=build --chmod=0644 /out/THIRD-PARTY-NOTICES.txt /usr/share/doc/stuga/THIRD-PARTY-NOTICES.txt
COPY --chmod=0755 packaging/docker/remote/supervisor.sh /usr/local/lib/stuga/supervisor.sh
COPY --chmod=0644 packaging/shared/connector/check-toml.sh /usr/local/lib/stuga/check-toml.sh

USER 65532:65532
ENV STUGA_REMOTE_DIR=/run/stuga-remote
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --start-interval=1s --retries=3 \
  CMD ["/usr/local/lib/stuga/supervisor.sh", "health"]
CMD ["/usr/local/lib/stuga/supervisor.sh"]

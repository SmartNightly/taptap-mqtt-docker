# syntax=docker/dockerfile:1.7
#
# taptap-mqtt — Tigo TAP/CCA optimizer data → MQTT, packaged as a multi-arch container.
#
# Bundles two upstream projects at pinned versions:
#   - taptap       (Rust, MIT)   https://github.com/litinoveweedle/taptap       — reads the Tigo RS-485 bus
#   - taptap-mqtt  (Python, GPL) https://github.com/litinoveweedle/taptap-mqtt  — publishes to MQTT (HA discovery)
#
# Build args let you bump either version without touching the file:
#   docker build --build-arg TAPTAP_VERSION=v0.2.6 --build-arg TAPTAP_MQTT_VERSION=v0.2.6 .
#
# Supported platforms (mapped to the upstream musl release assets):
#   linux/amd64 → x86_64, linux/arm64 → arm64, linux/arm/v7 → armv7, linux/arm/v6 → arm, linux/386 → i686

ARG PYTHON_VERSION=3.12

# ---------------------------------------------------------------- stage 1: fetch upstream artefacts
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS fetch

ARG TAPTAP_VERSION=v0.2.6
ARG TAPTAP_MQTT_VERSION=v0.2.6
ARG TARGETARCH
ARG TARGETVARIANT

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# taptap: pick the release asset for the *target* platform, verify the published SHA-256, extract the binary.
RUN set -eu; \
    case "${TARGETARCH}/${TARGETVARIANT:-}" in \
      amd64/*) asset=taptap-Linux-musl-x86_64 ;; \
      arm64/*) asset=taptap-Linux-musl-arm64 ;; \
      arm/v7)  asset=taptap-Linux-musleabihf-armv7 ;; \
      arm/v6)  asset=taptap-Linux-musleabihf-arm ;; \
      386/*)   asset=taptap-Linux-musl-i686 ;; \
      *) echo "unsupported platform ${TARGETARCH}/${TARGETVARIANT:-}" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/litinoveweedle/taptap/releases/download/${TAPTAP_VERSION}"; \
    mkdir -p /out/taptap && cd /out/taptap; \
    curl -fsSLo "${asset}.tar.gz"        "${base}/${asset}.tar.gz"; \
    curl -fsSLo "${asset}.tar.gz.sha256" "${base}/${asset}.tar.gz.sha256"; \
    sha256sum -c "${asset}.tar.gz.sha256"; \
    tar -xzf "${asset}.tar.gz" taptap; \
    rm -f "${asset}.tar.gz" "${asset}.tar.gz.sha256"; \
    chmod 0755 taptap

# taptap-mqtt: source tarball of the tagged release (no git needed in the image).
RUN set -eu; \
    mkdir -p /out/taptap-mqtt; \
    curl -fsSL "https://github.com/litinoveweedle/taptap-mqtt/archive/refs/tags/${TAPTAP_MQTT_VERSION}.tar.gz" \
      | tar -xz --strip-components=1 -C /out/taptap-mqtt

# ---------------------------------------------------------------- stage 2: runtime image
FROM python:${PYTHON_VERSION}-slim

ARG TAPTAP_VERSION=v0.2.6
ARG TAPTAP_MQTT_VERSION=v0.2.6

LABEL org.opencontainers.image.title="taptap-mqtt" \
      org.opencontainers.image.description="Tigo TAP/CCA optimizer data to MQTT (taptap + taptap-mqtt), multi-arch" \
      org.opencontainers.image.source="https://github.com/SmartNightly/taptap-mqtt-docker" \
      org.opencontainers.image.licenses="MIT AND GPL-3.0-only" \
      taptap.version="${TAPTAP_VERSION}" \
      taptap-mqtt.version="${TAPTAP_MQTT_VERSION}"

# Python deps of taptap-mqtt (paho-mqtt, python-dateutil, uptime)
COPY --from=fetch /out/taptap-mqtt/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm -f /tmp/requirements.txt

COPY --from=fetch /out/taptap/taptap /usr/local/bin/taptap
COPY --from=fetch /out/taptap-mqtt/taptap-mqtt.py /opt/taptap-mqtt/taptap-mqtt.py
COPY --from=fetch /out/taptap-mqtt/LICENSE        /opt/taptap-mqtt/LICENSE
COPY --from=fetch /out/taptap-mqtt/README.md      /opt/taptap-mqtt/README.md

# Unprivileged runtime user. /config holds config.ini (read-only bind mount),
# /data the persisted optimizer topology (STATE_FILE), /run/taptap the RUN_FILE heartbeat.
RUN groupadd --gid 1000 taptap \
 && useradd --uid 1000 --gid taptap --home-dir /opt/taptap-mqtt --no-create-home --shell /usr/sbin/nologin taptap \
 && mkdir -p /config /data /run/taptap \
 && chown -R taptap:taptap /data /run/taptap \
 && /usr/local/bin/taptap --version

USER taptap
WORKDIR /opt/taptap-mqtt
VOLUME ["/data"]

# taptap-mqtt touches RUN_FILE while it runs and removes it on shutdown → cheap liveness probe.
HEALTHCHECK --interval=60s --timeout=5s --start-period=90s --retries=3 \
  CMD test -f /run/taptap/taptap.run || exit 1

ENTRYPOINT ["python3", "/opt/taptap-mqtt/taptap-mqtt.py"]
CMD ["/config/config.ini"]

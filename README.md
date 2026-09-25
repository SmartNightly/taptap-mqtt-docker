# taptap-mqtt-docker

Multi-arch container image that reads **Tigo optimizer data locally** from the Tigo TAP / CCA RS-485 bus
and publishes it to **MQTT** — no Tigo cloud involved. Works with Home Assistant (MQTT discovery),
OpenHAB, ioBroker, Node-RED or anything else that speaks MQTT.

[![Build and publish](https://github.com/SmartNightly/taptap-mqtt-docker/actions/workflows/docker.yml/badge.svg)](https://github.com/SmartNightly/taptap-mqtt-docker/actions/workflows/docker.yml)

```
ghcr.io/smartnightly/taptap-mqtt        linux/amd64 · linux/arm64 · linux/arm/v7
```

The image bundles two upstream projects at pinned, verified versions:

| Component | What it does | Version | License |
|---|---|---|---|
| [taptap](https://github.com/litinoveweedle/taptap) (litinoveweedle fork of [willglynn/taptap](https://github.com/willglynn/taptap)) | Rust binary that sniffs the Tigo TAP protocol on the RS-485 bus and emits JSON | v0.2.6 | MIT |
| [taptap-mqtt](https://github.com/litinoveweedle/taptap-mqtt) | Python bridge: runs `taptap observe`, aggregates per-module and per-string data, publishes to MQTT with Home Assistant discovery | v0.2.6 | GPL-3.0 |

This repository only adds the packaging (Dockerfile, CI, docs) and two optional integrations. All credit for the
protocol work goes to the upstream authors. Use the litinoveweedle fork of taptap — the original does not
support module barcode discovery that taptap-mqtt relies on.

## Hardware you need

- A Tigo system with a **TAP** (Tigo Access Point) connected to a **CCA** (Cloud Connect Advanced).
- An **RS-485 tap** on the TAP↔CCA bus, either
  - an **RS-485-to-Ethernet converter** (e.g. Waveshare *RS485 TO ETH*, TCP server mode, port 502) — the
    setup this image was developed with, or
  - a **USB RS-485 adapter** on the Docker host (`/dev/ttyUSB0`).

Wiring is described in the upstream README: <https://github.com/willglynn/taptap#connecting>.
The bus is read-only; nothing is sent to the Tigo hardware.

## Quick start

```bash
mkdir taptap-mqtt && cd taptap-mqtt
curl -fsSLO https://raw.githubusercontent.com/SmartNightly/taptap-mqtt-docker/main/docker-compose.yml
mkdir config data
curl -fsSL https://raw.githubusercontent.com/SmartNightly/taptap-mqtt-docker/main/config/config.ini.example -o config/config.ini
# edit config/config.ini: MQTT broker + credentials, ADDRESS/PORT of the converter (or SERIAL), MODULES
docker compose up -d
docker compose logs -f
```

Within a minute you should see `Permanently enumerated node …` lines for modules whose serial is known and
values flowing to `<TOPIC_PREFIX>/<TOPIC_NAME>/…`. At night the Tigo gateway is silent (no PV, no bus traffic);
the `taptap` sub-process may exit and gets restarted by the bridge — that is expected.

### Mounts and paths inside the container

| Path | Purpose |
|---|---|
| `/config/config.ini` | your configuration (read-only bind mount) |
| `/data/taptap.json` | persisted module ↔ serial topology (`STATE_FILE`) — keep it on a volume |
| `/run/taptap/taptap.run` | heartbeat written by taptap-mqtt; used by the image `HEALTHCHECK` |
| `/usr/local/bin/taptap` | the bundled binary (`BINARY` in config) |

The container runs as **uid 1000** (`taptap`). For a USB adapter pass the device and add the host group that
owns it (see the commented block in `docker-compose.yml`).

## Configuration

`config/config.ini.example` is fully commented. The keys that matter most:

| Key | Notes |
|---|---|
| `[MQTT] SERVER/PORT/USER/PASS` | your broker |
| `[TAPTAP] ADDRESS/PORT` **or** `SERIAL` | exactly one transport; the other must be empty |
| `[TAPTAP] MODULES` | `STRING:NAME:SERIAL` triplets. Start with empty serials (`A:01:, A:02:, …`), let it run 24 h, copy the serials from the log, then **pin them**. Unpinned modules are mapped to the "first available" name, so a module that is offline at start-up shifts the mapping and mixes up your history. |
| `[TAPTAP] UPDATE` | seconds between MQTT state updates. A 30-module plant at `15` produces ~1400 value updates per minute; rate-limited consumers (ioBroker's JavaScript adapter stops scripts above 1000 `setState`/min) want `30`. |
| `[HA] DISCOVERY_PREFIX` | `homeassistant` for HA/OpenHAB. **To disable discovery use a dummy prefix such as `disabled`** together with `BIRTH_TOPIC = disabled/status` — v0.2.6 rejects an empty value even though its own comment says "set empty to disable". |
| `[HA] DISCOVERY_LEGACY` | required key (`false`; `true` for OpenHAB or HA < 2024.12). Missing it makes the container crash-loop. |
| `[RUNTIME] MAX_ERROR` | `0` = retry forever and let Docker's restart policy handle the rest |

Full reference: the [upstream README](https://github.com/litinoveweedle/taptap-mqtt#readme) (sensor list,
statistics, discovery details).

## What you get on MQTT

- One retained **state topic** `<prefix>/<name>/state` with a JSON document: every module (`voltage_in`,
  `voltage_out`, `current_in`, `current_out`, `power`, `temperature`, `duty_cycle`, `rssi`, `energy_daily`,
  `timestamp`, `node_serial`, `gateway_address`) plus per-string and overall statistics (min/max/avg/sum,
  `nodes_online`, `nodes_total`, `nodes_identified`).
- With discovery enabled, Home Assistant creates one device per plant with all sensors automatically.

## Integrations included

### ioBroker — `integrations/iobroker/TigoOptimizer.js`

ioBroker's `mqtt` adapter stores the state topic as one JSON string. The script subscribes to it and writes
numeric states per module (`javascript.0.Tigo.<node>.<metric>`) and for the plant statistics
(`javascript.0.Tigo.stats.*`), so they can be logged to InfluxDB and charted.

- Adjust `SRC` (default `mqtt.0.tigo.tigo1.state`) to your `TOPIC_PREFIX`/`TOPIC_NAME`.
- Nodes are created dynamically from the JSON; `NODES_FALLBACK` is only a cold-start hint.
- v0.2.0 guards against the JavaScript adapter's `setState` rate limit (writes only on change, throttled).
  Keep `UPDATE = 30` in `config.ini` for plants with 20+ modules.
- Discovery is not needed for ioBroker; a dummy `DISCOVERY_PREFIX` keeps the `homeassistant/…` topics out of
  your object tree.

### Grafana — `integrations/grafana/tigo-optimizers.json`

Dashboard for InfluxDB v2 (Flux) fed by ioBroker's `influxdb` adapter: modules online, total power, daily
energy, average temperature, per-module power for two strings, temperature outliers (early warning for a
failing optimizer), RSSI per module. Import it and pick your InfluxDB datasource; measurement names follow the
ioBroker state IDs above (strings named `A`/`B`, modules `A01…`, `B01…` — adjust the queries if yours differ).

## Building it yourself

```bash
# native platform
docker build -t taptap-mqtt .
# another platform (needs binfmt/QEMU, e.g. Docker Desktop)
docker buildx build --platform linux/arm64 --load -t taptap-mqtt:arm64 .
# bump upstream versions
docker build --build-arg TAPTAP_VERSION=v0.2.6 --build-arg TAPTAP_MQTT_VERSION=v0.2.6 -t taptap-mqtt .
```

The Dockerfile is two-stage: a fetch stage downloads the taptap release asset for the target architecture and
**verifies the published SHA-256** before extracting, plus the taptap-mqtt source tarball of the tag; the
runtime stage is `python:3.12-slim` with the three Python dependencies. No git, no curl in the final image.

## CI / releases

`.github/workflows/docker.yml`:

1. builds `linux/amd64` and runs a smoke test (`taptap --version`, taptap-mqtt exits `1` with a config error
   when no config is mounted, process runs as uid 1000),
2. builds `linux/amd64, linux/arm64, linux/arm/v7` with QEMU and pushes to GHCR.

| Trigger | Tags pushed |
|---|---|
| tag `vX.Y.Z` | `X.Y.Z`, `X.Y`, `X`, `latest` |
| push to `main` | `edge`, `sha-…` |
| pull request | build + smoke test only |
| manual run | same as above, with upstream versions as inputs |

Dependabot keeps the GitHub Actions and the Python base image current.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Container restarts every few seconds, log shows a config validation error | see the `[HA]` notes above (`DISCOVERY_PREFIX` empty, `DISCOVERY_LEGACY` missing) or the `MODULES` format |
| `TapTap process exited unexpectedly` at night | normal — no bus traffic without sunlight; the bridge restarts it |
| `TimeoutError – timed out` right after start, container exits | MQTT broker not reachable (wrong `SERVER`/`PORT`, firewall). v0.2.6 aborts on this instead of retrying; `restart: unless-stopped` brings the container back — fix the broker address. |
| Values freeze while the container is healthy | consumer side: e.g. ioBroker script stopped by the setState limit → `UPDATE = 30` |
| Module names swap after a restart | serials not pinned in `MODULES` |
| Cannot reach the Ethernet converter | try `network_mode: host`; check that the converter is in TCP-server mode on the configured port |
| USB adapter: permission denied | pass the device and `group_add` the owning host group (uid 1000 is not root) |

## License

Files in this repository: [MIT](LICENSE). The image contains taptap (MIT) and taptap-mqtt (GPL-3.0); their
sources are the upstream repositories at the tags recorded in the image labels `taptap.version` and
`taptap-mqtt.version`.

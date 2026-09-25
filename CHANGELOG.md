# Changelog

All notable changes to this repository are documented here. The image version is the git tag;
the bundled upstream versions are recorded per release.

## [1.0.0] — 2026-09-25

First public release, extracted from a private home-automation monorepo where the image has been
running in production since May 2026 (31 optimizers on two strings, RS-485-to-Ethernet converter).

- Multi-arch image: `linux/amd64`, `linux/arm64`, `linux/arm/v7` (Raspberry Pi 3/4/5, Synology, x86 NAS).
- Bundles **taptap v0.2.6** (litinoveweedle fork, release binary with SHA-256 verification) and
  **taptap-mqtt v0.2.6** (source tarball of the tag, no git in the image).
- Runs unprivileged (uid 1000), `HEALTHCHECK` on the taptap-mqtt heartbeat file.
- GitHub Actions: smoke test on amd64, then multi-arch build and push to GHCR on tags and `main`.
- Integrations: ioBroker JSON parser script (with a setState rate-limit guard) and a Grafana dashboard.
- Documented config pitfalls of taptap-mqtt v0.2.6 (`DISCOVERY_PREFIX` must not be empty,
  `DISCOVERY_LEGACY` is required, `MODULES` triplet format).

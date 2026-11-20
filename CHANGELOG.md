# Changelog

## 1.2.0

_2026-11-20_

### Added
- `downlink_throughput` and `uplink_throughput` (bit/s) and `latency` (ms), as the original signalk-starlink published them, for plugins such as signalk-internet.
- The link is reported `offline`, with the cause `NO_RESPONSE` and one notification, when the dish does not answer two polls in a row.
- `status` and the throughput and latency values are set to `null` when the plugin stops, so other plugins never read a stale state.
- Descriptions for the link paths.

## 1.1.2

_2026-11-19_

### Fixed
- The configuration schema no longer shares one array between the notification state settings, which the Signal K plugin CI reports as a circular reference.

## 1.1.1

_2026-11-19_

### Added
- Signal K plugin CI (the shared `plugin-ci.yml` workflow), so the App Store shows test results for Linux, Raspberry Pi, macOS and Windows.

### Changed
- Changelog headings use the plain `## x.y.z` form that the App Store reads.

## 1.1.0

_2026-11-07_

### Added
- **Unexpected location alert**: the dish's `unexpected_location` alert is published as `alerts.unexpected_location` (true or false) and shown in the status line ("Starlink is online, country FR, unexpected location"). A notification on `notifications.network.providers.starlink.unexpected_location` says "Starlink reports an unexpected location: check that your plan covers this area" when the alert turns on, and returns to `normal` when it turns off. The notification can be switched off, and its state is a setting (`warn` by default).

## 1.0.0

_2026-11-07_

First release as **signalk-starlink-xz**, forked from signalk-starlink 1.1.0 by Ilker Temir.

### Added
- Main purpose: a reminder to switch off paid Ocean Mode when the country code leaves `XZ` (back in territorial waters), and to switch it on on entering `XZ`.
- App Store icon.
- Notification when the dish's country code changes into or out of international waters (`XZ`), telling the crew to enable or disable Ocean Mode. Optionally cleared after a set time.
- `country_code` path.
- Settings for the dish address and the polling interval.

### Changed
- The offline notification names the outage cause, and is updated when the cause changes.
- `outage.cause`, `outage.start` and `outage.duration` are published while offline and set to `null` when back online.
- The first poll runs at start, not after a full interval. Polls never overlap, and each call has a deadline.
- State is reset on every start; the gRPC client is closed on stop.
- Package name and plugin ID `signalk-starlink-xz`, so it can be installed beside the original.
- Dependencies: `@grpc/grpc-js` 1.14.6, `@grpc/proto-loader` 0.8.1.

### Removed
- Auto-stow while moving and the dish position feed of the original.
- `hardware`, `software`, `uptime`, `downlink_throughput` and `uplink_throughput`.

### Fixed
- A crash when the dish's status had no `device_info` or no `dish_get_status`.

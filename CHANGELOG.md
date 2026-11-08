# Changelog

## [1.1.0] - 2026-11-07

### Added
- **Unexpected location alert**: the dish's `unexpected_location` alert is published as `alerts.unexpected_location` (true or false) and shown in the status line ("Starlink is online, country FR, unexpected location"). A notification on `notifications.network.providers.starlink.unexpected_location` says "Starlink reports an unexpected location: check that your plan covers this area" when the alert turns on, and returns to `normal` when it turns off. The notification can be switched off, and its state is a setting (`warn` by default).

## [1.0.0] - 2026-11-07

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

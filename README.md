# signalk-starlink-xz: Starlink Ocean Mode reminder

**The main purpose of this Signal K plugin is to remind you to switch off Starlink Ocean Mode (paid priority data, billed per GB) when you are back in territorial waters.**

Ocean Mode keeps billing per GB until it is switched off by hand, including after the vessel returns to coastal waters. Forgetting it means paying offshore data rates for every gigabyte used in port. The plugin watches the country code the dish reports and raises a notification:

- when the country code **leaves `XZ`** (back inside 12 nm of a coast): **switch Ocean Mode off**;
- when it **becomes `XZ`** (international waters, beyond 12 nm): switch Ocean Mode on, or there is no service;
- when **Starlink goes offline**, naming the cause (for example `OBSTRUCTED` or `NO_SATS`), and when it comes back.

## Why the country code matters

Starlink reports the country it is in as an ISO 3166 code. Beyond 12 nautical miles from shore it reports `XZ`, and service there needs Ocean Mode on the Roam Unlimited and Personal Maritime plans. Ocean Mode is billed per GB on top of the monthly plan: currently **US$6 per GB** (November 2026; it rose from US$2 on 27/09/2026). Prices change and differ by plan and region, so check yours on starlink.com.

At that rate a single 4K film or a large software update can cost tens of dollars. The reminder on leaving `XZ` is the one that saves money.

A change between two countries (for example `ES` to `FR`) does not notify.

## Published paths

Under `network.providers.starlink`:

| Path | Value |
| :--- | :--- |
| `status` | `online` or `offline` |
| `country_code` | ISO 3166 country code, or `XZ` in international waters |
| `outage.cause` | Reason for the outage, while offline (for example `OBSTRUCTED`, `NO_SATS`, `STOWED`, `BOOTING`) |
| `outage.start` | Start of the outage, ISO date |
| `outage.duration` | Duration of the outage so far, in seconds |

The outage values are set to `null` when Starlink is back online.

Notifications:

| Path | When |
| :--- | :--- |
| `notifications.network.providers.starlink.status` | Starlink goes offline, the cause of an outage changes, or Starlink is back online (`normal`) |
| `notifications.network.providers.starlink.country_code_change` | The country code changes into or out of `XZ` |

## Settings

| Setting | Default | Notes |
| :--- | :--- | :--- |
| Dish address | `192.168.100.1:9200` | The dish's local gRPC address |
| Polling interval (s) | 60 | At least 5 |
| Send a notification when Starlink goes offline | on | |
| Offline notification state | `warn` | `alert`, `warn`, `alarm` or `emergency` |
| Send a notification on a change into or out of XZ | on | |
| Country code notification state | `warn` | |
| Clear the country code notification after (min) | 0 | 0 keeps it until the next change, so that the crew acts on it |

## How it works

The plugin asks the dish for its status over its local gRPC interface. Each call has a deadline, and the next poll starts only after the dish has answered or the call has timed out, so slow answers never pile up. After five failed polls in a row, the plugin reports an error and reconnects. All state is reset on every start, so a restart from the admin UI begins cleanly.

## Installation

From the Signal K App Store, search for **Starlink XZ: Ocean Mode reminder**. Or on the server:

```bash
cd ~/.signalk
npm install signalk-starlink-xz
sudo systemctl restart signalk
```

The dish must be reachable from the Signal K server on the boat's network.

## Development

```bash
npm install
npm test
```

The tests use a simulated dish; no Starlink is needed.

## Credits and licence

Based on [signalk-starlink](https://github.com/itemir/signalk-starlink) by Ilker Temir, with the offline notification by Scott Bender. This version adds the country code notification, names the outage cause in the offline notification, makes the dish address and polling interval configurable, and leaves out the original's auto-stow and dish position features.

The Starlink proto files are originally from Elias Wilken's [starlink-rs](https://github.com/ewilken/starlink-rs), as modified in the original plugin.

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).

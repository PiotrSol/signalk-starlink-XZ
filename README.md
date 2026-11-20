# signalk-starlink-xz: Starlink Ocean Mode reminder and METERED status

**The main purpose of this Signal K plugin is to remind you to switch off Starlink Ocean Mode (paid priority data, billed per GB) when you are back in territorial waters.**

Ocean Mode keeps billing per GB until it is switched off by hand, including after the vessel returns to coastal waters. Forgetting it means paying offshore data rates for every gigabyte used in port. The plugin watches the country code the dish reports and raises a notification:

- when the country code **leaves `XZ`** (back inside 12 nm of a coast): **switch Ocean Mode off**;
- when it **becomes `XZ`** (international waters, beyond 12 nm): switch Ocean Mode on, or there is no service;
- when the dish reports an **unexpected location** (somewhere its service plan does not currently cover);
- when **Starlink goes offline**, naming the cause (for example `OBSTRUCTED` or `NO_SATS`), and when it comes back.

**It also reports the link as METERED while you are in international waters.** There every gigabyte is paid, so the plugin sets `network.internet.state` to `metered` (and `network.providers.starlink.metered` to `true`). Plugins that download charts, weather files or updates, or upload logs, read this to hold back heavy transfers until you are back on an unmetered link. Back in a country's waters, or when Starlink is down, the value is cleared again. No other plugin, such as signalk-internet, is needed for this. See [For other plugins](#for-other-plugins).

## Why the country code matters

Starlink reports the country it is in as an ISO 3166 code. Beyond 12 nautical miles from shore it reports `XZ`, and service there needs Ocean Mode on the Roam Unlimited and Personal Maritime plans. Ocean Mode is billed per GB on top of the monthly plan: currently **6USD per GB** (November 2026; it rose from 2USD on 27/09/2026). Prices change and differ by plan and region, so check yours on starlink.com.

At that rate a single 4K film or a large software update can cost tens of dollars. The reminder on leaving `XZ` is the one that saves money.

A change between two countries (for example `ES` to `FR`) does not notify.

## Published paths

Under `network.providers.starlink`:

| Path | Value |
| :--- | :--- |
| `status` | `online` or `offline`; `null` while the plugin is stopped |
| `downlink_throughput` | Download throughput, bit/s |
| `uplink_throughput` | Upload throughput, bit/s |
| `latency` | Latency to the Starlink point of presence, ms; `null` during an outage |
| `metered` | `true` in international waters (country code `XZ`), where Starlink data is paid by the gigabyte (Ocean Mode); `false` in a country's waters; `null` until a country code is known |
| `country_code` | ISO 3166 country code, or `XZ` in international waters |
| `alerts.unexpected_location` | `true` while the dish reports an unexpected location |
| `outage.cause` | Reason for the outage, while offline (for example `OBSTRUCTED`, `NO_SATS`, `STOWED`, `BOOTING`), or `NO_RESPONSE` when the dish does not answer |
| `outage.start` | Start of the outage, ISO date |
| `outage.duration` | Duration of the outage so far, in seconds |

The outage values are set to `null` when Starlink is back online.

### For other plugins

**METERED status.** Plugins that use the internet commonly read `network.internet.state` (`online`, `offline`, `metered`). This plugin sets it to **`metered`** while Starlink is online in international waters (`XZ`), where every gigabyte is paid, so those plugins hold back heavy downloads and uploads until the vessel is back on an unmetered link. No other plugin is needed for this.

- It only ever says `metered`. When Starlink goes offline or leaves `XZ`, or the plugin stops, it clears the value it set with `null`; outside `XZ` it sends nothing.
- So a boat with another uplink (LTE, marina Wi-Fi) is never reported offline because Starlink is down, and another source of the path is not overwritten.
- `network.providers.starlink.metered` gives the same as a boolean: `true` in `XZ`, `false` in a country's waters, `null` until the country is known.
- The setting *Publish network.internet.state = metered in international waters (XZ)* turns the `network.internet.state` part off.

**Link state.** `network.providers.starlink.status` always reflects the dish:

- `online` only while the dish answers and reports no outage;
- `offline` during an outage, and also when the dish stops answering for two polls in a row (it is rebooting, has no power, or the network to it is down), so that nobody goes on reading the last `online`;
- `null` when the plugin stops: nothing reports on the link.

`status` stays `online` or `offline`, never `metered`, as plugins written for the original [signalk-starlink](https://github.com/itemir/signalk-starlink) expect; its paths and values, including throughput and latency, are the same.

**With signalk-internet.** [signalk-internet](https://github.com/meri-imperiumi/signalk-internet) is not needed, but works alongside: its default mapping reads `status` = `online`, and its plotter view shows the throughput and latency. If you use it, turn off this plugin's *Publish network.internet.state* setting, so only one plugin writes that path, and add in signalk-internet's settings:

| Setting | Path | Value | State |
| :--- | :--- | :--- | :--- |
| Contextual State Rules | `network.providers.starlink.metered` | `true` | `metered` |
| Hardware Delta Mappings | `network.providers.starlink.status` | `offline` | `offline` |

Notifications:

| Path | When |
| :--- | :--- |
| `notifications.network.providers.starlink.status` | Starlink goes offline, the cause of an outage changes, or Starlink is back online (`normal`) |
| `notifications.network.providers.starlink.country_code_change` | The country code changes into or out of `XZ` |
| `notifications.network.providers.starlink.unexpected_location` | The dish's unexpected location alert turns on ("check that your plan covers this area"), and `normal` when it turns off |

## Settings

| Setting | Default | Notes |
| :--- | :--- | :--- |
| Dish address | `192.168.100.1:9200` | The dish's local gRPC address. Behind another router, that router needs a route to `192.168.100.1` through the Starlink router |
| Polling interval (s) | 60 | At least 5 |
| Send a notification when Starlink goes offline | on | |
| Offline notification state | `warn` | `alert`, `warn`, `alarm` or `emergency` |
| Send a notification on a change into or out of XZ | on | |
| Country code notification state | `warn` | |
| Clear the country code notification after (min) | 0 | 0 keeps it until the next change, so that the crew acts on it |
| Send a notification when the dish reports an unexpected location | on | |
| Unexpected location notification state | `warn` | |
| Publish network.internet.state = metered in international waters (XZ) | on | See [For other plugins](#for-other-plugins) |

## How it works

The plugin asks the dish for its status over its local gRPC interface. Each call has a deadline, and the next poll starts only after the dish has answered or the call has timed out, so slow answers never pile up. After two polls in a row without an answer, the link is reported `offline` (cause `NO_RESPONSE`), with one notification; after five, the plugin also reports an error and reconnects. All state is reset on every start, so a restart from the admin UI begins cleanly.

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

/*
 * Copyright 2022-2024 Ilker Temir <ilker@ilkertemir.com>
 * Copyright 2026 Piotr (github.com/PiotrSol)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Modified in 2026 by Piotr from Ilker Temir's signalk-starlink
 * (github.com/itemir/signalk-starlink): country code (XZ) notification,
 * outage cause in the offline notification, configurable dish address and
 * polling interval, call deadline, polls that never overlap, state reset
 * on every start, unexpected location alert, the auto-stow and dish GNSS
 * features removed.
 */

'use strict'

const path = require('path')
const protoLoader = require('@grpc/proto-loader')
const grpc = require('@grpc/grpc-js')

const PLUGIN_ID = 'signalk-starlink-xz'
const STARLINK = 'network.providers.starlink'
const INTERNATIONAL_WATERS = 'XZ'
const ERRORS_BEFORE_RECONNECT = 5
// Polls without an answer before the link counts as offline. One missed
// poll can be a busy dish; two in a row means the dish is rebooting, has no
// power or the network to it is down, and Starlink internet with it.
const ERRORS_BEFORE_OFFLINE = 2
const NO_RESPONSE = 'NO_RESPONSE'
// The shared internet state that plugins using the internet read (the path
// signalk-internet publishes). This plugin only ever sets it to "metered".
const INTERNET_STATE = 'network.internet.state'
const STATES = ['alert', 'warn', 'alarm', 'emergency']
const DEFAULTS = {
  address: '192.168.100.1:9200',
  pollInterval: 60,
  callTimeout: 10
}

// The gRPC service definition is parsed once, on first use.
let DeviceService = null
function deviceService () {
  if (!DeviceService) {
    const definition = protoLoader.loadSync('spacex/api/device/service.proto', {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [path.join(__dirname, 'protos')]
    })
    DeviceService = grpc.loadPackageDefinition(definition).SpaceX.API.Device.Device
  }
  return DeviceService
}

function defaultCreateClient (address) {
  const Device = deviceService()
  return new Device(address, grpc.credentials.createInsecure())
}

/** A finite number of zero or more, or null. */
function nonNegative (value) {
  const n = Number(value)
  return value !== undefined && value !== null && Number.isFinite(n) && n >= 0 ? n : null
}

/** Seconds from a nanosecond count (a string, as gRPC int64 arrives), or null. */
function nsToSeconds (ns) {
  const n = Number(ns)
  return Number.isFinite(n) && n >= 0 ? n / 1e9 : null
}

/** ISO date from a nanosecond Unix timestamp, or null. */
function nsToIso (ns) {
  const n = Number(ns)
  return Number.isFinite(n) && n > 0 ? new Date(n / 1e6).toISOString() : null
}

/**
 * What the plugin needs from a get_status response:
 * { online, countryCode, unexpectedLocation, downlink, uplink, latency,
 *   outage: { cause, start, duration } | null }, or
 * null when the response holds no dish status. Every field is checked, so
 * a dish that leaves one out never throws.
 */
function readStatus (response) {
  const status = response && response.dish_get_status
  if (!status) return null
  const outage = status.outage || null
  const info = status.device_info || {}
  const alerts = status.alerts || {}
  return {
    online: !outage,
    countryCode: typeof info.country_code === 'string' && info.country_code ? info.country_code : null,
    unexpectedLocation: alerts.unexpected_location === true,
    // Throughput in bit/s and latency to the point of presence in ms, as
    // the original signalk-starlink published them and signalk-internet
    // shows them.
    downlink: nonNegative(status.downlink_throughput_bps),
    uplink: nonNegative(status.uplink_throughput_bps),
    latency: outage ? null : nonNegative(status.pop_ping_latency_ms),
    outage: outage
      ? {
          cause: outage.cause || 'UNKNOWN',
          start: nsToIso(outage.start_timestamp_ns),
          duration: nsToSeconds(outage.duration_ns)
        }
      : null
  }
}

/**
 * The message for a country code change into or out of international waters
 * (XZ), or null for any other change, or none.
 */
function countryChangeMessage (previous, current) {
  if (!previous || !current || previous === current) return null
  if (current === INTERNATIONAL_WATERS) {
    return `Starlink country code changed from ${previous} to ${current} (international waters). Enable Ocean Mode`
  }
  if (previous === INTERNATIONAL_WATERS) {
    return `Starlink country code changed from ${previous} to ${current} (territorial waters). DISABLE Ocean Mode!`
  }
  return null
}

function notification (state, message) {
  return { state, method: state === 'normal' ? [] : ['visual', 'sound'], message }
}

function formatDuration (seconds) {
  if (seconds === null) return 'unknown time'
  const s = Math.round(seconds)
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min`
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}

module.exports = function (app, { createClient = defaultCreateClient } = {}) {
  const plugin = {
    id: PLUGIN_ID,
    name: 'Starlink XZ: Ocean Mode reminder',
    description: 'Reminds you to switch Starlink Ocean Mode off when back in territorial waters (country code leaves XZ) and on in international waters; reports the link as METERED there (network.internet.state = metered) so other plugins hold back heavy downloads; publishes the Starlink link state, throughput and latency, and notifies when Starlink goes offline'
  }

  // Everything the plugin remembers lives here and is created anew by
  // every start(), so that a restart from the admin UI begins cleanly.
  let run = null

  plugin.schema = {
    type: 'object',
    properties: {
      address: {
        type: 'string',
        title: 'Dish address',
        description: 'gRPC address of the Starlink dish (host:port)',
        default: DEFAULTS.address
      },
      pollInterval: {
        type: 'number',
        title: 'Polling interval (s)',
        default: DEFAULTS.pollInterval,
        minimum: 5
      },
      enableStatusNotification: {
        type: 'boolean',
        title: 'Send a notification when Starlink goes offline',
        default: true
      },
      statusNotificationState: {
        type: 'string',
        title: 'Offline notification state',
        default: 'warn',
        enum: [...STATES]
      },
      enableCountryCodeNotification: {
        type: 'boolean',
        title: 'Send a notification when the country code changes into or out of international waters (XZ)',
        description: 'XZ is reported in international waters, where Starlink service needs Ocean Mode (paid). Changes between two ISO 3166 countries do not notify.',
        default: true
      },
      countryCodeNotificationState: {
        type: 'string',
        title: 'Country code notification state',
        default: 'warn',
        enum: [...STATES]
      },
      enableUnexpectedLocationNotification: {
        type: 'boolean',
        title: 'Send a notification when the dish reports an unexpected location',
        description: 'The dish raises this alert when it is somewhere its service plan does not currently cover',
        default: true
      },
      unexpectedLocationNotificationState: {
        type: 'string',
        title: 'Unexpected location notification state',
        default: 'warn',
        enum: [...STATES]
      },
      publishMeteredInternetState: {
        type: 'boolean',
        title: 'Publish network.internet.state = metered in international waters (XZ)',
        description: 'For plugins that hold back heavy downloads on a metered link. Set only while Starlink is online in XZ, and cleared (null) when it is not; nothing is published otherwise, so it does not overwrite another source of this path.',
        default: true
      },
      countryCodeNotificationClearMinutes: {
        type: 'number',
        title: 'Clear the country code notification after (min)',
        description: '0 keeps it until the next change, so that the crew acts on it',
        default: 0,
        minimum: 0
      }
    }
  }

  function send (values) {
    if (values.length) app.handleMessage(PLUGIN_ID, { updates: [{ values }] })
  }

  function statusLine (s) {
    const where = (s.countryCode ? `, country ${s.countryCode}` : '') + (s.unexpectedLocation ? ', unexpected location' : '')
    if (s.online) return `Starlink is online${where}`
    return `Starlink has been offline (${s.outage.cause}) for ${formatDuration(s.outage.duration)}${where}`
  }

  /** Turns one dish status into Signal K values and notifications. */
  function publish (r, s) {
    const values = [
      { path: `${STARLINK}.status`, value: s.online ? 'online' : 'offline' },
      { path: `${STARLINK}.downlink_throughput`, value: s.downlink },
      { path: `${STARLINK}.uplink_throughput`, value: s.uplink },
      { path: `${STARLINK}.latency`, value: s.latency }
    ]

    if (s.outage) {
      values.push(
        { path: `${STARLINK}.outage.cause`, value: s.outage.cause },
        { path: `${STARLINK}.outage.start`, value: s.outage.start },
        { path: `${STARLINK}.outage.duration`, value: s.outage.duration }
      )
    } else if (r.lastOnline === false) {
      // Back online: the outage values no longer describe anything.
      values.push(
        { path: `${STARLINK}.outage.cause`, value: null },
        { path: `${STARLINK}.outage.start`, value: null },
        { path: `${STARLINK}.outage.duration`, value: null }
      )
    }

    if (s.countryCode) values.push({ path: `${STARLINK}.country_code`, value: s.countryCode })
    // In international waters (XZ) Starlink data is paid by the gigabyte
    // (Ocean Mode), so the link is metered there. Kept from the last known
    // country code while the dish reports none.
    if (s.countryCode) r.metered = s.countryCode === INTERNATIONAL_WATERS
    values.push({ path: `${STARLINK}.metered`, value: r.metered })
    values.push({ path: `${STARLINK}.alerts.unexpected_location`, value: s.unexpectedLocation })

    // Unexpected location: notify when the alert turns on, clear when it
    // turns off; nothing at start while it is off.
    if (r.options.enableUnexpectedLocationNotification !== false && s.unexpectedLocation !== r.lastUnexpectedLocation &&
        (s.unexpectedLocation || r.lastUnexpectedLocation !== undefined)) {
      values.push({
        path: `notifications.${STARLINK}.unexpected_location`,
        value: s.unexpectedLocation
          ? notification(r.options.unexpectedLocationNotificationState || 'warn', 'Starlink reports an unexpected location: check that your plan covers this area')
          : notification('normal', 'Starlink location is covered by the plan')
      })
    }
    r.lastUnexpectedLocation = s.unexpectedLocation

    // Offline notification: on going offline or online, and when the cause
    // of an outage changes, for example from NO_SATS to OBSTRUCTED.
    const cause = s.outage ? s.outage.cause : null
    if (r.options.enableStatusNotification !== false && (s.online !== r.lastOnline || cause !== r.lastCause)) {
      values.push({
        path: `notifications.${STARLINK}.status`,
        value: s.online
          ? notification('normal', 'Starlink is online')
          : notification(r.options.statusNotificationState || 'warn', `Starlink is offline: ${cause}`)
      })
    }

    // Country code notification, only on a change into or out of XZ.
    if (s.countryCode) {
      const message = countryChangeMessage(r.lastCountryCode, s.countryCode)
      if (message) {
        app.debug(message)
        if (r.options.enableCountryCodeNotification !== false) {
          values.push({
            path: `notifications.${STARLINK}.country_code_change`,
            value: notification(r.options.countryCodeNotificationState || 'warn', message)
          })
          scheduleCountryClear(r)
        }
      }
      r.lastCountryCode = s.countryCode
    }

    send(values)
    app.setPluginStatus(statusLine(s))
    internetState(r, s.online)
    r.lastOnline = s.online
    r.lastCause = cause
  }

  function scheduleCountryClear (r) {
    const minutes = Number(r.options.countryCodeNotificationClearMinutes) || 0
    if (r.clearTimer) clearTimeout(r.clearTimer)
    r.clearTimer = null
    if (minutes <= 0) return
    r.clearTimer = setTimeout(() => {
      r.clearTimer = null
      if (r.stopped) return
      send([{ path: `notifications.${STARLINK}.country_code_change`, value: notification('normal', `Starlink country code is ${r.lastCountryCode}`) }])
    }, minutes * 60000)
  }

  /**
   * The dish has not answered: the link counts as offline, so that plugins
   * reading the status (such as signalk-internet) do not go on seeing the
   * last "online". Announced once, with the time of the first missed poll.
   */
  /**
   * network.internet.state: "metered" while Starlink is online in XZ. When
   * that stops, the value this plugin set is cleared with null; any other
   * time nothing is sent, so another source of the path is left alone.
   */
  function internetState (r, online) {
    const metered = r.options.publishMeteredInternetState !== false && online && r.metered === true
    if (metered && r.internet !== 'metered') {
      send([{ path: INTERNET_STATE, value: 'metered' }])
      r.internet = 'metered'
    } else if (!metered && r.internet === 'metered') {
      send([{ path: INTERNET_STATE, value: null }])
      r.internet = null
    }
  }

  function unreachable (r) {
    if (r.lastCause === NO_RESPONSE) return
    const values = [
      { path: `${STARLINK}.status`, value: 'offline' },
      { path: `${STARLINK}.downlink_throughput`, value: null },
      { path: `${STARLINK}.uplink_throughput`, value: null },
      { path: `${STARLINK}.latency`, value: null },
      { path: `${STARLINK}.outage.cause`, value: NO_RESPONSE },
      { path: `${STARLINK}.outage.start`, value: r.firstMiss },
      { path: `${STARLINK}.outage.duration`, value: null }
    ]
    if (r.options.enableStatusNotification !== false) {
      values.push({
        path: `notifications.${STARLINK}.status`,
        value: notification(r.options.statusNotificationState || 'warn', `Starlink is offline: the dish at ${r.address} does not answer`)
      })
    }
    send(values)
    internetState(r, false)
    app.setPluginStatus(`Starlink is offline: no answer from the dish at ${r.address} since ${r.firstMiss}`)
    r.lastOnline = false
    r.lastCause = NO_RESPONSE
  }

  function reconnect (r) {
    try { r.client.close() } catch (e) { /* already closed */ }
    r.client = createClient(r.address)
    app.debug(`Reconnecting to Starlink at ${r.address}`)
  }

  // Polls run one after another: the next is scheduled only when the dish
  // has answered or the call has timed out, so slow answers never pile up.
  function poll (r) {
    if (r.stopped) return
    const deadline = new Date(Date.now() + r.callTimeout * 1000)
    r.client.Handle({ get_status: {} }, { deadline }, (error, response) => {
      if (r.stopped) return
      const s = error ? null : readStatus(response)
      if (!s) {
        r.errorCount++
        r.missCount++
        if (r.missCount === 1) r.firstMiss = new Date().toISOString()
        app.debug(`No status from Starlink at ${r.address}: ${error ? error.message : 'empty response'}`)
        if (r.missCount >= ERRORS_BEFORE_OFFLINE) unreachable(r)
        if (r.errorCount === ERRORS_BEFORE_RECONNECT) {
          if (app.setPluginError) app.setPluginError(`Cannot reach Starlink at ${r.address}`)
          reconnect(r)
          r.errorCount = 0
        }
      } else {
        r.errorCount = 0
        r.missCount = 0
        publish(r, s)
      }
      r.timer = setTimeout(() => poll(r), r.pollInterval * 1000)
    })
  }

  plugin.start = function (options = {}) {
    const pollInterval = Number(options.pollInterval) >= 5 ? Number(options.pollInterval) : DEFAULTS.pollInterval
    run = {
      options,
      address: options.address || DEFAULTS.address,
      pollInterval,
      // A call never waits longer than the polling interval.
      callTimeout: Math.min(DEFAULTS.callTimeout, pollInterval),
      client: null,
      timer: null,
      clearTimer: null,
      errorCount: 0,
      missCount: 0,
      firstMiss: null,
      lastOnline: undefined,
      lastCause: undefined,
      lastCountryCode: undefined,
      metered: null,
      internet: null,
      lastUnexpectedLocation: undefined,
      stopped: false
    }
    run.client = createClient(run.address)
    app.handleMessage(PLUGIN_ID, {
      updates: [{
        meta: [
          { path: `${STARLINK}.outage.duration`, value: { units: 's', description: 'Duration of the current Starlink outage' } },
          { path: `${STARLINK}.status`, value: { description: 'Starlink link: online or offline; null while nothing reports on it' } },
          { path: `${STARLINK}.downlink_throughput`, value: { description: 'Starlink download throughput, bit/s' } },
          { path: `${STARLINK}.uplink_throughput`, value: { description: 'Starlink upload throughput, bit/s' } },
          { path: `${STARLINK}.latency`, value: { description: 'Starlink latency to the point of presence, ms' } },
          { path: `${STARLINK}.metered`, value: { description: 'true in international waters (country code XZ), where Starlink data is paid by the gigabyte (Ocean Mode); null while unknown' } }
        ]
      }]
    })
    app.setPluginStatus(`Connecting to Starlink at ${run.address}`)
    poll(run) // first poll at once, not after a full interval
  }

  plugin.stop = function () {
    if (!run) return
    run.stopped = true
    // Nothing reports on the link any more: say so rather than leave the
    // last state standing for other plugins.
    send([
      { path: `${STARLINK}.status`, value: null },
      { path: `${STARLINK}.downlink_throughput`, value: null },
      { path: `${STARLINK}.uplink_throughput`, value: null },
      { path: `${STARLINK}.latency`, value: null },
      { path: `${STARLINK}.metered`, value: null }
    ])
    if (run.internet === 'metered') send([{ path: INTERNET_STATE, value: null }])
    clearTimeout(run.timer)
    clearTimeout(run.clearTimer)
    try { run.client.close() } catch (e) { /* already closed */ }
    run = null
    app.setPluginStatus('Plugin stopped')
  }

  return plugin
}

// Exposed for the tests.
module.exports.readStatus = readStatus
module.exports.countryChangeMessage = countryChangeMessage
module.exports.formatDuration = formatDuration

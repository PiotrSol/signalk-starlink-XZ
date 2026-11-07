'use strict'

const { describe, it, beforeEach, afterEach, mock } = require('node:test')
const assert = require('node:assert/strict')
const createPlugin = require('..')
const { readStatus, countryChangeMessage, formatDuration } = createPlugin

const STARLINK = 'network.providers.starlink'

/** A simulated dish: answers each Handle() call from a queue of responses. */
function fakeDish () {
  const dish = { clients: 0, closed: 0, calls: 0, queue: [], pending: null }
  dish.createClient = (address) => {
    dish.clients++
    dish.address = address
    return {
      Handle (request, options, callback) {
        dish.calls++
        dish.lastOptions = options
        // An empty queue repeats the last answer, like a dish whose state
        // has not changed.
        const next = dish.queue.length ? dish.queue.shift() : dish.last
        if (next === 'hang') { dish.pending = callback; return }
        dish.last = next
        if (next instanceof Error) return callback(next)
        callback(null, next || online('ES'))
      },
      close () { dish.closed++ }
    }
  }
  return dish
}

const online = (country) => ({ dish_get_status: { outage: null, device_info: { country_code: country } } })
const offline = (cause, country = 'ES') => ({
  dish_get_status: {
    outage: { cause, start_timestamp_ns: '1793900000000000000', duration_ns: '125000000000' },
    device_info: { country_code: country }
  }
})

function mockApp () {
  const app = {
    values: [],
    status: '',
    error: null,
    handleMessage (id, msg) {
      for (const u of msg.updates) for (const v of u.values || []) app.values.push(v)
    },
    setPluginStatus (s) { app.status = s },
    setPluginError (s) { app.error = s },
    debug () {},
    last (path) { return [...app.values].reverse().find((v) => v.path === path) }
  }
  return app
}

function start (options = {}, dish = fakeDish()) {
  const app = mockApp()
  const plugin = createPlugin(app, { createClient: dish.createClient })
  plugin.start({ pollInterval: 60, ...options })
  return { app, plugin, dish }
}

describe('readStatus', () => {
  it('reads an online dish', () => {
    assert.deepEqual(readStatus(online('ES')), { online: true, countryCode: 'ES', outage: null })
  })

  it('reads an outage with its cause, start and duration', () => {
    const s = readStatus(offline('OBSTRUCTED'))
    assert.equal(s.online, false)
    assert.equal(s.outage.cause, 'OBSTRUCTED')
    assert.equal(s.outage.start, new Date(1793900000000).toISOString())
    assert.equal(s.outage.duration, 125)
  })

  it('never throws on a response without status or device info', () => {
    assert.equal(readStatus(null), null)
    assert.equal(readStatus({}), null)
    assert.deepEqual(readStatus({ dish_get_status: {} }), { online: true, countryCode: null, outage: null })
    assert.equal(readStatus({ dish_get_status: { device_info: { country_code: '' } } }).countryCode, null)
  })
})

describe('countryChangeMessage', () => {
  it('asks for Ocean Mode on entering international waters', () => {
    assert.match(countryChangeMessage('ES', 'XZ'), /Enable Ocean Mode/)
  })
  it('asks to disable Ocean Mode on leaving them', () => {
    assert.match(countryChangeMessage('XZ', 'FR'), /DISABLE Ocean Mode/)
  })
  it('stays quiet between two countries, without a change, or on the first reading', () => {
    assert.equal(countryChangeMessage('ES', 'FR'), null)
    assert.equal(countryChangeMessage('XZ', 'XZ'), null)
    assert.equal(countryChangeMessage(undefined, 'XZ'), null)
  })
})

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    assert.equal(formatDuration(42), '42 s')
    assert.equal(formatDuration(125), '2 min')
    assert.equal(formatDuration(3725), '1 h 2 min')
    assert.equal(formatDuration(null), 'unknown time')
  })
})

describe('the plugin', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
  afterEach(() => mock.timers.reset())

  it('polls at once on start, not after a full interval', () => {
    const { app, plugin, dish } = start()
    assert.equal(dish.calls, 1)
    assert.equal(app.last(`${STARLINK}.status`).value, 'online')
    assert.equal(app.last(`${STARLINK}.country_code`).value, 'ES')
    plugin.stop()
  })

  it('uses the configured address and a call deadline', () => {
    const { plugin, dish } = start({ address: '10.0.0.5:9200' })
    assert.equal(dish.address, '10.0.0.5:9200')
    assert.ok(dish.lastOptions.deadline instanceof Date)
    plugin.stop()
  })

  it('polls again after the interval', () => {
    const { plugin, dish } = start({ pollInterval: 30 })
    mock.timers.tick(30000)
    assert.equal(dish.calls, 2)
    plugin.stop()
  })

  it('never starts a poll while the previous one is unanswered', () => {
    const dish = fakeDish()
    dish.queue.push('hang')
    const { plugin } = start({}, dish)
    mock.timers.tick(600000)
    assert.equal(dish.calls, 1)
    dish.pending(null, online('ES'))
    mock.timers.tick(60000)
    assert.equal(dish.calls, 2)
    plugin.stop()
  })

  it('publishes the outage and names its cause in the notification', () => {
    const dish = fakeDish()
    dish.queue.push(offline('NO_SATS'))
    const { app, plugin } = start({}, dish)
    assert.equal(app.last(`${STARLINK}.status`).value, 'offline')
    assert.equal(app.last(`${STARLINK}.outage.cause`).value, 'NO_SATS')
    assert.equal(app.last(`${STARLINK}.outage.duration`).value, 125)
    const n = app.last(`notifications.${STARLINK}.status`).value
    assert.equal(n.state, 'warn')
    assert.match(n.message, /offline: NO_SATS/)
    assert.match(app.status, /offline \(NO_SATS\) for 2 min/)
    plugin.stop()
  })

  it('updates the notification when the cause changes, and clears everything when back online', () => {
    const dish = fakeDish()
    dish.queue.push(offline('NO_SATS'), offline('OBSTRUCTED'), online('ES'))
    const { app, plugin } = start({}, dish)
    mock.timers.tick(60000)
    assert.match(app.last(`notifications.${STARLINK}.status`).value.message, /OBSTRUCTED/)
    mock.timers.tick(60000)
    assert.equal(app.last(`notifications.${STARLINK}.status`).value.state, 'normal')
    assert.equal(app.last(`${STARLINK}.outage.cause`).value, null)
    plugin.stop()
  })

  it('notifies on entering and leaving international waters', () => {
    const dish = fakeDish()
    dish.queue.push(online('ES'), online('XZ'), online('XZ'), online('FR'))
    const { app, plugin } = start({ countryCodeNotificationState: 'alarm' }, dish)
    assert.equal(app.last(`notifications.${STARLINK}.country_code_change`), undefined)
    mock.timers.tick(60000)
    let n = app.last(`notifications.${STARLINK}.country_code_change`).value
    assert.equal(n.state, 'alarm')
    assert.match(n.message, /ES to XZ.*Enable Ocean Mode/)
    const count = app.values.filter((v) => v.path.endsWith('country_code_change')).length
    mock.timers.tick(60000)
    assert.equal(app.values.filter((v) => v.path.endsWith('country_code_change')).length, count, 'no repeat while still in XZ')
    mock.timers.tick(60000)
    n = app.last(`notifications.${STARLINK}.country_code_change`).value
    assert.match(n.message, /XZ to FR.*DISABLE Ocean Mode/)
    plugin.stop()
  })

  it('clears the country code notification after the configured time', () => {
    const dish = fakeDish()
    dish.queue.push(online('ES'), online('XZ'))
    const { app, plugin } = start({ countryCodeNotificationClearMinutes: 30 }, dish)
    mock.timers.tick(60000)
    assert.equal(app.last(`notifications.${STARLINK}.country_code_change`).value.state, 'warn')
    mock.timers.tick(30 * 60000)
    assert.equal(app.last(`notifications.${STARLINK}.country_code_change`).value.state, 'normal')
    plugin.stop()
  })

  it('reconnects after five failed polls and reports the error', () => {
    const dish = fakeDish()
    for (let i = 0; i < 5; i++) dish.queue.push(new Error('UNAVAILABLE'))
    const { app, plugin } = start({}, dish)
    for (let i = 0; i < 4; i++) mock.timers.tick(60000)
    assert.equal(dish.clients, 2)
    assert.equal(dish.closed, 1)
    assert.match(app.error, /Cannot reach Starlink/)
    plugin.stop()
  })

  it('starts afresh after a restart and closes the client on stop', () => {
    const dish = fakeDish()
    const { app, plugin } = start({}, dish)
    plugin.stop()
    assert.equal(dish.closed, 1)
    const before = app.values.filter((v) => v.path === `notifications.${STARLINK}.status`).length
    plugin.start({ pollInterval: 60 })
    assert.equal(app.values.filter((v) => v.path === `notifications.${STARLINK}.status`).length, before + 1, 'status announced again')
    plugin.stop()
    mock.timers.tick(600000)
    assert.equal(dish.calls, 2, 'no polls after stop')
  })
})

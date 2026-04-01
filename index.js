/*
 * Copyright 2022-2024 Ilker Temir <ilker@ilkertemir.com>
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
 */

const POLL_STARLINK_INTERVAL = 60     // Poll every 60 seconds
const STARLINK = 'network.providers.starlink'

const path = require('path');
const protoLoader = require('@grpc/proto-loader');
const grpc = require('@grpc/grpc-js');
const gRpcOptions = {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [path.join(__dirname, '/protos')]
}
const packageDefinition = protoLoader.loadSync('spacex/api/device/service.proto', gRpcOptions);
const Device  = grpc.loadPackageDefinition(packageDefinition).SpaceX.API.Device.Device;
var client = new Device(
    "192.168.100.1:9200",
    grpc.credentials.createInsecure()
);

var dishyStatus;
var errorCount = 0;
var previousCountryCode;

module.exports = function(app) {
  var plugin = {};
  var unsubscribes = [];
  var pollProcess;

  plugin.id = "signalk-starlink";
  plugin.name = "Starlink";
  plugin.description = "Starlink plugin for Signal K";

  plugin.schema = {
    type: 'object',
    required: [],
    properties: {
      enableStatusNotification: {
        type: "boolean",
        title: "Send a notification when offline",
        default: true
      },
      statusNotificationState: {
        title: 'Status Notification State',
        description:
          'Notification state when Starlink goes offline',
        type: 'string',
        default: 'warn',
        enum: ['alert', 'warn', 'alarm', 'emergency']
      },
      enableCountryCodeNotification: {
        type: "boolean",
        title: "Send a notification when country code changes between International Waters (XZ - Requires Ocean Mode paid data) and Territorial Waters - ISO3166 Country Code",
        default: true
      },
      countryCodeNotificationState: {
        title: 'Country Code Change State',
        description:
          'Notification state when country code changes between XZ and other countries',
        type: 'string',
        default: 'warn',
        enum: ['alert', 'warn', 'alarm', 'emergency']
      }
    }
  }

  plugin.start = function(options) {
    pollProcess = setInterval(function() {
      client.Handle({
        'get_status': {}
      }, (error, response) => {
        if (error) {
          app.debug(`Error reading from Dishy.`);
          if (errorCount++ >= 5) {
            client.close();
            client = new Device(
              "192.168.100.1:9200",
              grpc.credentials.createInsecure()
            );
            errorCount = 0;
            app.debug(`Retrying connection`);
          }
          return;
        }

        errorCount = 0;
        let values = [];

        // Determine status: offline or online
        let currentStatus;
        if (response.dish_get_status.outage) {
          currentStatus = 'offline';
        } else {
          currentStatus = 'online';
        }

        // Add status value
        values.push({
          path: `${STARLINK}.status`,
          value: currentStatus
        });

        // Add country code value
        if (response.dish_get_status && response.dish_get_status.device_state && response.dish_get_status.device_info.country_code) {
          const currentCountryCode = response.dish_get_status.device_info.country_code;
          values.push({
            path: `${STARLINK}.country_code`,
            value: currentCountryCode
          });

          // Handle country code change notification
          handleCountryCodeChange(app, options, currentCountryCode);
        }

        // Send all values to SignalK
        app.handleMessage('signalk-starlink', {
          updates: [{
            values: values
          }]
        });

        // Handle status change notification
        if (options.enableStatusNotification !== false) {
          if (currentStatus !== dishyStatus) {
            const notificationPath = `notifications.${STARLINK}.status`;
            const state = currentStatus === 'offline'
              ? (options.statusNotificationState || 'warn')
              : 'normal';
            const message = `Starlink is ${currentStatus}`;

            app.handleMessage('signalk-starlink', {
              updates: [{
                values: [{
                  path: notificationPath,
                  value: {
                    state: state,
                    method: ['visual', 'sound'],
                    message: message
                  }
                }]
              }]
            });

            app.setPluginStatus(`Starlink is ${currentStatus}`);
            dishyStatus = currentStatus;
          }
        }
      });
    }, POLL_STARLINK_INTERVAL * 1000);
  }

  plugin.stop = function() {
    clearInterval(pollProcess);
    app.setPluginStatus('Plugin stopped');
  };

  function handleCountryCodeChange(app, options, currentCountryCode) {
    if (previousCountryCode === undefined) {
      // First time reading country code, just store it
      previousCountryCode = currentCountryCode;
      app.debug(`Country code initialized to: ${currentCountryCode}`);
      return;
    }

    // Check if there's a change involving XZ country code
    const wasInXZ = previousCountryCode === 'XZ';
    const isNowInXZ = currentCountryCode === 'XZ';
    const hasCountryCodeChanged = previousCountryCode !== currentCountryCode;

    if (hasCountryCodeChanged && (wasInXZ || isNowInXZ)) {
      // Country code changed between XZ and something else
      const fromCountry = previousCountryCode;
      const toCountry = currentCountryCode;

      app.debug(`Country code changed from ${fromCountry} to ${toCountry}`);

      if (options.enableCountryCodeNotification !== false) {
        const notificationPath = `notifications.${STARLINK}.country_code_change`;
        const state = options.countryCodeNotificationState || 'warn';
        
        // Build message based on direction of change
        let message;
        if (isNowInXZ) {
          // Changed TO XZ
          message = `Starlink country code changed from ${fromCountry} to ${toCountry}. Enable Ocean Mode`;
        } else {
          // Changed FROM XZ
          message = `Starlink country code changed from ${fromCountry} to ${toCountry}. DISABLE Ocean Mode!`;
        }

        app.handleMessage('signalk-starlink', {
          updates: [{
            values: [{
              path: notificationPath,
              value: {
                state: state,
                method: ['visual', 'sound'],
                message: message
              }
            }]
          }]
        });

        app.setPluginStatus(`Country code change detected: ${fromCountry} -> ${toCountry}`);
      }
    }

    previousCountryCode = currentCountryCode;
  }

  return plugin;
}

/*
 * @copyright Copyright (c) Sematext Group, Inc. - All Rights Reserved
 *
 * @licence SPM for NodeJS is free-to-use, proprietary software.
 * THIS IS PROPRIETARY SOURCE CODE OF Sematext Group, Inc. (Sematext)
 * This source code may not be copied, reverse engineered, or altered for any purpose.
 * This source code is to be used exclusively by users and customers of Sematext.
 * Please see the full license (found in LICENSE in this distribution) for details on its license and the licenses of its dependencies.
 */

'use strict'

/**
 * HttpServerAgent - wraping createServer to add instrumentation
 *
 */

var http = require('http')
var https = require('https')
var cluster = require('cluster')

module.exports = function httpServerAgent () {
  var SpmAgent = require('spm-agent')
  var Agent = SpmAgent.Agent
  var config = SpmAgent.Config
  var logger = SpmAgent.Logger
  var Measured = require('measured')
  var stats = Measured.createCollection()
  var histogram = new Measured.Histogram()
  var timer = new Measured.Timer()
  var resSize = 0
  var reqSize = 0
  function monitorHttp (req, res) {
    try {
      var FINISH_EVENT_NAME = 'finish'
      req._stopwatch = timer.start()
      var endOfConnectionHandler = function () {
        var duration = req._stopwatch.end()
        stats.meter('requests').mark()
        // duration is in ms as float with nanosecond precision,
        // but we use microseconds with the backend
        histogram.update(Math.round(duration * 1000), new Date().getTime())
        if (res.getHeader) {
          resSize += ((res.getHeader('Content-Length') || 0) * 1)
        }
        if (req.headers) {
          reqSize += (req.headers['content-length'] || 0) * 1
        }
        if (res.statusCode >= 300) {
          if (res.statusCode < 400) {
            stats.meter('3xxRate').mark()
          } else if (res.statusCode < 500) {
            stats.meter('errRate').mark()
            stats.meter('4xxRate').mark()
          } else if (res.statusCode >= 500) {
            stats.meter('errRate').mark()
            stats.meter('5xxRate').mark()
          }
        }
        res.removeListener(FINISH_EVENT_NAME, endOfConnectionHandler)
      }
      res.on(FINISH_EVENT_NAME, endOfConnectionHandler)
    } catch (ex) {
      logger.error(ex)
    }
  }
  var hAgent = new Agent(
    {
      start: function (agent) {
        this._agent = agent
        patchHttpServer(monitorHttp)
        patchHttpsServer(monitorHttp)
        var timerId = setInterval(function () {
          var httpStats = stats.toJSON()
          var responseTimes = histogram.toJSON()
          var now = new Date().getTime()
          var metricValue = [
            httpStats['requests'] ? httpStats['requests'].count : 0, // http.requestCount (int)
            httpStats['errRate'] ? httpStats['errRate'].count : 0, // http.errorCount (int)
            httpStats['3xxRate'] ? httpStats['3xxRate'].count : 0, // http.3xx (int)
            httpStats['4xxRate'] ? httpStats['4xxRate'].count : 0, // http.4xx (int)
            httpStats['5xxRate'] ? httpStats['5xxRate'].count : 0, // http.5xx (int)
            reqSize,
            resSize,
            responseTimes.min,
            responseTimes.max,
            responseTimes.sum
          ]
          if (metricValue[0] > 0 || metricValue[1] > 0) {
            agent.addMetrics({ ts: now, name: 'http', value: metricValue })
          }
          stats = Measured.createCollection()
          histogram.reset()
          timer.reset()
          reqSize = 0
          resSize = 0
          if (cluster.isMaster || process.env.NODE_APP_INSTANCE === 0 || process.env.SPM_MASTER_MODE === '1' || process.env.STARTUP === 'true') {
            agent.addMetrics({
              ts: now,
              name: 'numWorkers',
              value: Object.keys(cluster.workers || {}).length || 1
            })
          }
        }, config.collectionInterval)
        if (timerId.unref) {
          timerId.unref()
        }
      }
    })
  return hAgent
}

var origHttpCreateServer = http.createServer
var origHttpsCreateServer = https.createServer
function patchHttpServer (monitorReqHandler) {
  http.createServer = function () {
    var server = origHttpCreateServer.apply(http, arguments)
    server.on('request', monitorReqHandler)
    return server
  }
  http.Server = http.createServer
}
function patchHttpsServer (monitorReqHandler) {
  https.createServer = function () {
    var server = origHttpsCreateServer.apply(https, arguments)
    server.on('request', monitorReqHandler)
    return server
  }
  https.Server = https.createServer
}
function unpatchHttpServer () {
  http.createServer = origHttpCreateServer
  http.Server = origHttpCreateServer
}

function unpatchHttpsServer () {
  https.createServer = origHttpsCreateServer
  https.Server = origHttpsCreateServer
}

module.exports.unpatchHttpServer = unpatchHttpServer
module.exports.unpatchHttpsServer = unpatchHttpsServer

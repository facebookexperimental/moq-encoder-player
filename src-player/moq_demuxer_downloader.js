/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { sendMessageToMain, StateEnum } from './utils.js'
import { moqCreate, moqClose, moqCreateControlStream, moqSendSetup, moqParseSetupResponse, moqParseSubscribeDone, MOQ_PARAMETER_ROLE_PUBLISHER, MOQ_PARAMETER_ROLE_SUBSCRIBER, MOQ_PARAMETER_ROLE_BOTH, moqParseObjectHeader, moqSendSubscribe, moqParseSubscribeResponse, moqSendUnSubscribe} from '../utils/moqt.js'
import { LocPackager } from '../packager/loc_packager.js'
import { RawPackager } from '../packager/raw_packager.js'

const WORKER_PREFIX = '[MOQ-DOWNLOADER]'

// Show verbose exceptions
const MOQT_DEV_MODE = true

const QUIC_EXPIRATION_TIMEOUT_DEF_MS = 10000

let workerState = StateEnum.Created

let urlHostPortEp = ''
let isSendingStats = false
let currentSubscribeId = 0
let currentTrackAlias = 0
let tracks = {} // We add subscribeId and trackAlias
// Example
/* moqTracks: {
    "audio": {
      namespace: "vc",
      name: "-audio",
      authInfo: "secret"
  },
  "video": {
      namespace: "vc",
      name: "-video",
      authInfo: "secret"
  }
} */

// MOQT data
const moqt = moqCreate()

function reportStats () {
  if (isSendingStats) {
    sendMessageToMain(WORKER_PREFIX, 'downloaderstats', { clkms: Date.now() })
  }
}

// Main listener
self.addEventListener('message', async function (e) {
  if ((workerState === StateEnum.Created) || (workerState === StateEnum.Stopped)) {
    workerState = StateEnum.Instantiated
  }

  if (workerState === StateEnum.Stopped) {
    sendMessageToMain(WORKER_PREFIX, 'info', 'downloader is stopped it does not accept messages')
    return
  }

  const type = e.data.type
  if (type === 'stop') {
    workerState = StateEnum.Stopped

    // Abort and wait for all inflight requests
    try {
      await unSubscribeTracks(moqt)
      sendMessageToMain(WORKER_PREFIX, 'info', 'Unsubscribed from all tracks, closing MOQT')
      await moqClose(moqt)
    } catch (err) {
      if (MOQT_DEV_MODE) {throw err}
      // Expected to finish some promises with abort error
      // The abort "errors" are already sent to main "thead" by sendMessageToMain inside the promise
      sendMessageToMain(WORKER_PREFIX, 'error', `Errors closing (some could be ok): ${err}`)
    }
  } else if (type === 'downloadersendini') {
    if (workerState !== StateEnum.Instantiated) {
      sendMessageToMain(WORKER_PREFIX, 'error', 'received ini message in wrong state. State: ' + workerState)
      return
    }
    if (!('urlHostPort' in e.data.downloaderConfig) || !('urlPath' in e.data.downloaderConfig)) {
      sendMessageToMain(WORKER_PREFIX, 'error', 'We need host, streamId to start playback')
      return
    }

    if ('urlHostPort' in e.data.downloaderConfig) {
      urlHostPortEp = e.data.downloaderConfig.urlHostPort
    }
    if ('isSendingStats' in e.data.downloaderConfig) {
      isSendingStats = e.data.downloaderConfig.isSendingStats
    }
    if ('moqTracks' in e.data.downloaderConfig) {
      tracks = e.data.downloaderConfig.moqTracks
    }

    const errTrackStr = checkTrackData()
    if (errTrackStr !== '') {
      sendMessageToMain(WORKER_PREFIX, 'error', errTrackStr)
      return
    }

    try {
      await moqClose(moqt)

      // WT needs https to establish connection
      const url = new URL(urlHostPortEp)
      // Replace protocol
      url.protocol = 'https'

      // Ini WT
      // eslint-disable-next-line no-undef
      moqt.wt = new WebTransport(url.href)
      moqt.wt.closed
        .then(() => {
          sendMessageToMain(WORKER_PREFIX, 'info', 'WT closed transport session')
        })
        .catch(err => {
          if (MOQT_DEV_MODE) {throw err}
          sendMessageToMain(WORKER_PREFIX, 'error', `WT error, closed transport. Err: ${err}`)
        })

      await moqt.wt.ready
      await moqCreateControlStream(moqt)
      await moqCreateSubscriberSession(moqt)

      sendMessageToMain(WORKER_PREFIX, 'info', 'MOQ Initialized')
      workerState = StateEnum.Running

      // Assuming QUIC stream per object
      moqReceiveObjects(moqt, QUIC_EXPIRATION_TIMEOUT_DEF_MS)
    } catch (err) {
      if (MOQT_DEV_MODE) {throw err}
      sendMessageToMain(WORKER_PREFIX, 'error', `Initializing MOQ. Err: ${err}`)
    }
  }
})

async function moqReceiveObjects (moqt) {
  if (workerState === StateEnum.Stopped) {
    return
  }
  if (moqt.wt === null) {
    sendMessageToMain(WORKER_PREFIX, 'error', 'we can not start downloading data because WT is not initialized')
    return
  }

  // Get stream
  const incomingStream = moqt.wt.incomingUnidirectionalStreams
  const readableStream = incomingStream.getReader()

  while (workerState !== StateEnum.Stopped) {
    const stream = await readableStream.read()
    reportStats()
    try {
      if (!stream.done) {
        await moqReceiveProcessObjects(stream.value)
      }
    } catch (err) {
      if (MOQT_DEV_MODE) {throw err}
      sendMessageToMain(WORKER_PREFIX, 'dropped stream', { clkms: Date.now(), seqId: -1, msg: `Dropped stream because WT error: ${err}` })
      sendMessageToMain(WORKER_PREFIX, 'error', `WT request. Err: ${JSON.stringify(err)}`)
    }
  }
}

function getTrackInfoFromTrackAlias (trackAlias, subscribeId) {
  let ret = undefined
  for (const [trackType, trackData] of Object.entries(tracks)) {
    if (trackData.trackAlias === trackAlias) {
      if (subscribeId != undefined && trackData.subscribeId != subscribeId) {
          break
      }
      ret = {type: trackType, data: trackData}
      break
    }
  }
  return ret
}

async function moqReceiveProcessObjects (readerStream) {
  const startTime = Date.now()

  const moqObj = await moqParseObjectHeader(readerStream)
  sendMessageToMain(WORKER_PREFIX, 'debug', `Received MOQT subscribeId: ${moqObj.subscribeId}, trackAlias: ${moqObj.trackAlias}. ${moqObj.groupSeq}/${moqObj.objSeq}(${moqObj.sendOrder})`)

  const trackInfo = getTrackInfoFromTrackAlias(moqObj.trackAlias, moqObj.subscribeId)
  if (trackInfo === undefined) {
    throw new Error(`Unexpected trackAlias/subscriptionId ${moqObj.trackAlias}/${moqObj.subscribeId}. Expecting ${JSON.stringify(tracks)}`)
  }

  if (trackInfo.type !== 'data') {
    const packet = new LocPackager()
    await packet.ReadBytes(readerStream)

    const chunkData = packet.GetData()
    if ((chunkData.chunkType === undefined) || (chunkData.mediaType === undefined)) {
      throw new Error(`Corrupted headers, we can NOT parse the data, headers: ${packet.GetDataStr()}`)
    }
    sendMessageToMain(WORKER_PREFIX, 'debug', `Decoded MOQT-LOC: ${packet.GetDataStr()})`)

    let chunk
    if (chunkData.mediaType === 'audio') {
      // eslint-disable-next-line no-undef
      chunk = new EncodedAudioChunk({
        timestamp: chunkData.timestamp,
        type: chunkData.chunkType,
        data: chunkData.data,
        duration: chunkData.duration
      })
    } else if (chunkData.mediaType === 'video') {
      // eslint-disable-next-line no-undef
      chunk = new EncodedVideoChunk({
        timestamp: chunkData.timestamp,
        type: chunkData.chunkType,
        data: chunkData.data,
        duration: chunkData.duration
      })
    }
    self.postMessage({ type: chunkData.mediaType + 'chunk', clkms: Date.now(), captureClkms: chunkData.firstFrameClkms, seqId: chunkData.seqId, chunk, metadata: chunkData.metadata })

    const reqLatencyMs = Date.now() - startTime
    if (reqLatencyMs > (chunkData.duration / 1000)) {
      sendMessageToMain(WORKER_PREFIX, 'warning', 'response: 200, Latency(ms): ' + reqLatencyMs + ', Frame dur(ms): ' + chunkData.duration / 1000 + '. mediaType: ' + chunkData.mediaType + ', seqId: ' + chunkData.seqId + ', ts: ' + chunkData.timestamp)
    } else {
      sendMessageToMain(WORKER_PREFIX, 'debug', 'response: 200, Latency(ms): ' + reqLatencyMs + ', Frame dur(ms): ' + chunkData.duration / 1000 + '. mediaType: ' + chunkData.mediaType + ', seqId:' + chunkData.seqId + ', ts: ' + chunkData.timestamp)
    }
  } else {
    const packet = new RawPackager()
    await packet.ReadBytes(readerStream)
    sendMessageToMain(WORKER_PREFIX, 'debug', `Decoded MOQT-RAW: ${packet.GetDataStr()})`)

    self.postMessage({ type: 'data', chunk: packet.GetData().data })
  }
}

// MOQT

async function moqCreateSubscriberSession (moqt) {
  await moqSendSetup(moqt.controlWriter, MOQ_PARAMETER_ROLE_SUBSCRIBER)
  const setupResponse = await moqParseSetupResponse(moqt.controlReader)
  if (setupResponse.parameters.role !== MOQ_PARAMETER_ROLE_PUBLISHER && setupResponse.parameters.role !== MOQ_PARAMETER_ROLE_BOTH) {
    throw new Error(`role not supported. Supported ${MOQ_PARAMETER_ROLE_PUBLISHER} or ${MOQ_PARAMETER_ROLE_BOTH}, got from server ${JSON.stringify(setupResponse.parameters.role)}`)
  }
  sendMessageToMain(WORKER_PREFIX, 'info', `Received SETUP response: ${JSON.stringify(setupResponse)}`)

  // Send subscribe for tracks audio and video
  for (const [trackType, trackData] of Object.entries(tracks)) {
    await moqSendSubscribe(moqt.controlWriter, currentSubscribeId, currentTrackAlias, trackData.namespace, trackData.name, trackData.authInfo)
    const subscribeResp = await moqParseSubscribeResponse(moqt.controlReader)
    if (!subscribeResp.isError && subscribeResp.subscribeId === currentSubscribeId) {
      sendMessageToMain(WORKER_PREFIX, 'info', `Received SUBSCRIBE_OK for ${trackData.namespace}/${trackData.name}-(type: ${trackType}): ${JSON.stringify(subscribeResp)}`)
      trackData.subscribeId = currentSubscribeId++
      trackData.trackAlias = currentTrackAlias++
    } else {
      sendMessageToMain(WORKER_PREFIX, 'error', `Received SUBSCRIBE_ERROR response for ${trackData.namespace}/${trackData.name}-(type: ${trackType}): ${JSON.stringify(subscribeResp)}`)
    }
  }
}

function checkTrackData () {
  if (Object.entries(tracks).length <= 0) {
    return 'Number of Track Ids to announce needs to be > 0'
  }

  for (const [, track] of Object.entries(tracks)) {
    if (!('namespace' in track) || !('name' in track) || !('authInfo' in track)) {
      return 'Track malformed, needs to contain namespace, name, and authInfo'
    }
  }
  return ''
}

async function unSubscribeTracks(moqt) {
  sendMessageToMain(WORKER_PREFIX, 'info', `Sending ${Object.entries(tracks).length} unsubscribes`)

  for (const [_, trackData] of Object.entries(tracks)) {
    if ('subscribeId' in trackData) {
      try {
        await moqSendUnSubscribe(moqt.controlWriter, trackData.subscribeId)
        sendMessageToMain(WORKER_PREFIX, 'info', `Sent UnSubscribe for ${trackData.subscribeId}`)
        const subscribeDone = await moqParseSubscribeDone(moqt.controlReader)// TODO check same subscribeID
        // TODO When server works check same subscribeID subscribeDone.subscribeId == trackData.subscribeId
        sendMessageToMain(WORKER_PREFIX, 'info', `Received SubscribeDone for subscibeId: ${subscribeDone.subscribeId}: ${JSON.stringify(subscribeDone)}`)  
      }
      catch (err) {
        if (MOQT_DEV_MODE) {throw err}
        sendMessageToMain(WORKER_PREFIX, 'error', `on UnSubscribe. Err: ${err}`)
      } finally {
        delete trackData.subscribeId
        if ('trackAlias' in trackData) {
          delete trackData.trackAlias
        }
      }
    }
  }
}

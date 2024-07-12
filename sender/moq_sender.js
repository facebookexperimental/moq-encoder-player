/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { sendMessageToMain, StateEnum} from '../utils/utils.js'
import { moqCreate, moqClose, moqParseMsg, moqCreateControlStream, moqSendSubscribeOk, moqSendSubscribeError, moqSendObjectPerStreamToWriter, moqSendObjectPerDatagramToWriter, moqSendSetup, moqSendUnAnnounce, MOQ_PARAMETER_ROLE_PUBLISHER, MOQ_PARAMETER_ROLE_SUBSCRIBER, MOQ_PARAMETER_ROLE_BOTH, moqSendAnnounce, getTrackFullName, moqSendSubscribeDone, MOQ_SUBSCRIPTION_ERROR_INTERNAL, MOQ_SUBSCRIPTION_RETRY_TRACK_ALIAS, MOQ_MESSAGE_SUBSCRIBE, MOQ_MESSAGE_UNSUBSCRIBE, MOQ_SUBSCRIPTION_DONE_ENDED, MOQ_MESSAGE_SERVER_SETUP, MOQ_MESSAGE_ANNOUNCE_OK, MOQ_MESSAGE_ANNOUNCE_ERROR, MOQ_MAPPING_OBJECT_PER_STREAM, MOQ_MAPPING_OBJECT_PER_DATAGRAM} from '../utils/moqt.js'
import { LocPackager } from '../packager/loc_packager.js'
import { RawPackager } from '../packager/raw_packager.js'

const WORKER_PREFIX = '[MOQ-SENDER]'

// Show verbose exceptions
const MOQT_DEV_MODE = true

let moqPublisherState = {}

let workerState = StateEnum.Created

let isSendingStats = true

let tracks = {}
// Example
/* moqTracks: {
    "audio": {
        id: 0,
        maxInFlightRequests: 100,
        isHipri: true,
        authInfo: "secret",
        moqMapping: "ObjStream",
    },
    "video": {
        id: 1,
        maxInFlightRequests: 50,
        isHipri: false,
        authInfo: "secret",
        moqMapping: "ObjStream",
    }
} */

// Inflight req abort signal
const abortController = new AbortController()
let inFlightRequests = {}

// MOQT data
const moqt = moqCreate()

self.addEventListener('message', async function (e) {
  if (workerState === StateEnum.Created) {
    workerState = StateEnum.Instantiated
  }

  if (workerState === StateEnum.Stopped) {
    sendMessageToMain(WORKER_PREFIX, 'info', 'Muxer-send is stopped it does not accept messages')
    return
  }

  const type = e.data.type
  if (type === 'stop') {
    workerState = StateEnum.Stopped

    // Abort and wait for all inflight requests
    try {
      //TODO JOC finish abort controller
      abortController.abort()
      await closeUniDataTrackWritersIfNeeded()
      await Promise.all(getAllInflightRequestsArray())

      await unAnnounceTracks(moqt)
      await moqClose(moqt)
    } catch (err) {
      if (MOQT_DEV_MODE) {throw err}
      // Expected to finish some promises with abort error
      // The abort "errors" are already sent to main "thead" by sendMessageToMain inside the promise
      sendMessageToMain(WORKER_PREFIX, 'info', `Aborting / closing streams while exiting. Err: ${err.message}`)
    }
    return
  }

  if (type === 'muxersendini') {
    if (workerState !== StateEnum.Instantiated) {
      sendMessageToMain(WORKER_PREFIX, 'error', 'received ini message in wrong state. State: ' + workerState)
      return
    }

    let urlHostPortEp = ''

    if ('urlHostPort' in e.data.muxerSenderConfig) {
      urlHostPortEp = e.data.muxerSenderConfig.urlHostPort
    }
    if ('isSendingStats' in e.data.muxerSenderConfig) {
      isSendingStats = e.data.muxerSenderConfig.isSendingStats
    }
    if ('moqTracks' in e.data.muxerSenderConfig) {
      tracks = e.data.muxerSenderConfig.moqTracks
    }

    if (urlHostPortEp === '') {
      sendMessageToMain(WORKER_PREFIX, 'error', 'Empty host port')
      return
    }
    const errTrackStr = checkTrackData()
    if (errTrackStr !== '') {
      sendMessageToMain(WORKER_PREFIX, 'error', errTrackStr)
      return
    }

    try {
      // Reset state
      moqResetState()
      await moqClose(moqt)

      // WT needs https to establish connection
      const url = new URL(urlHostPortEp)
      // Replace protocol
      url.protocol = 'https'

      // Ini WT
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
      await moqCreatePublisherSession(moqt)

      inFlightRequests = initInflightReqData(tracks)

      sendMessageToMain(WORKER_PREFIX, 'info', 'MOQ Initialized, waiting for subscriptions')
      workerState = StateEnum.Running

      startLoopSubscriptionsLoop(moqt.controlReader, moqt.controlWriter)
        .then(() => {
          sendMessageToMain(WORKER_PREFIX, 'info', 'Exited receiving subscription loop in control stream')
        })
        .catch(err => {
          if (MOQT_DEV_MODE) {throw err}
          if (workerState !== StateEnum.Stopped) {
            sendMessageToMain(WORKER_PREFIX, 'error', `Error in the subscription loop in control stream. Err: ${JSON.stringify(err)}`)
          } else {
            sendMessageToMain(WORKER_PREFIX, 'info', `Exited receiving subscription loop in control stream. Err: ${JSON.stringify(err)}`)
          }
        })
    } catch (err) {
      if (MOQT_DEV_MODE) {throw err}
      sendMessageToMain(WORKER_PREFIX, 'error', `Initializing MOQ. Err: ${JSON.stringify(err)}`)
    }

    return
  }

  if (workerState !== StateEnum.Running) {
    sendMessageToMain(WORKER_PREFIX, 'dropped', { clkms: Date.now(), seqId: e.data.seqId, ts: e.data.chunk.timestamp, msg: 'Dropped chunk because transport is NOT open yet' })
    return
  }

  if (!(type in tracks)) {
    sendMessageToMain(WORKER_PREFIX, 'error', `Invalid message received ${type} is NOT in tracks ${JSON.stringify(tracks)}`)
    return
  }

  if (!('subscribers' in tracks[type]) || (tracks[type].subscribers.length <= 0)) {
    sendMessageToMain(WORKER_PREFIX, 'dropped', { clkms: Date.now(), seqId: e.data.seqId, ts: e.data.chunk.timestamp, msg: `Dropped chunk because there is NO subscribers for track ${type}` })
    return
  }

  // Send one object per every subscriber
  // Relay needs to aggregate subscriptions to avoid overload pub -> relay link
  const firstFrameClkms = (e.data.firstFrameClkms === undefined || e.data.firstFrameClkms < 0) ? 0 : e.data.firstFrameClkms
  const compensatedTs = (e.data.compensatedTs === undefined || e.data.compensatedTs < 0) ? 0 : e.data.compensatedTs
  const estimatedDuration = (e.data.estimatedDuration === undefined || e.data.estimatedDuration < 0) ? e.data.chunk.duration : e.data.estimatedDuration
  const seqId = (e.data.seqId === undefined) ? 0 : e.data.seqId
  const chunkData = { mediaType: type, firstFrameClkms, compensatedTs, estimatedDuration, seqId, chunk: e.data.chunk, metadata: e.data.metadata }
  const moqMapping = (e.data.moqMapping === undefined) ? tracks[type].moqMapping : e.data.moqMapping

  let i = 0
  while (i < tracks[type].subscribers.length) {
    const subscribeId = tracks[type].subscribers[i].subscribeId
    const trackAlias = tracks[type].subscribers[i].trackAlias
  
    sendChunkToTransport(chunkData, subscribeId, trackAlias, inFlightRequests[type], tracks[type].maxInFlightRequests, moqMapping)
    .then(val => {
      if (val !== undefined && val.dropped === true) {
        sendMessageToMain(WORKER_PREFIX, 'dropped', { clkms: Date.now(), seqId, mediaType: type, ts: chunkData.timestamp, msg: val.message })
      } else {
        sendMessageToMain(WORKER_PREFIX, 'debug', `SENT CHUNK ${type} - seqId: ${seqId} for subscribeId: ${subscribeId}, trackAlias: ${trackAlias}`)
      }
    })
    .catch(err => {
      if (MOQT_DEV_MODE) {throw err}
      sendMessageToMain(WORKER_PREFIX, 'dropped', { clkms: Date.now(), seqId, mediaType: chunkData.mediaType, ts: chunkData.timestamp, msg: err.message })
      sendMessageToMain(WORKER_PREFIX, 'error', `error sending chunk. For subscribeId: ${subscribeId}, trackAlias: ${trackAlias}. Err:  ${err.message}`)
    })
    i++
  }

  // Report stats
  if (isSendingStats) {
    self.postMessage({ type: 'sendstats', clkms: Date.now(), inFlightReq: getInflightRequestsReport() })
  }
})

async function startLoopSubscriptionsLoop (controlReader, controlWriter) {
  sendMessageToMain(WORKER_PREFIX, 'info', 'Started subscription loop')

  while (workerState === StateEnum.Running) {
    const moqMsg = await moqParseMsg(controlReader)
    if (moqMsg.type === MOQ_MESSAGE_SUBSCRIBE) {
      const subscribe = moqMsg.data
      sendMessageToMain(WORKER_PREFIX, 'info', `Received SUBSCRIBE: ${JSON.stringify(subscribe)}`)
      const fullTrackName = getTrackFullName(subscribe.namespace, subscribe.trackName)
      const track = getTrackFromFullTrackName(fullTrackName)
      if (track == null) {
        sendMessageToMain(WORKER_PREFIX, 'error', `Invalid subscribe received ${fullTrackName} is NOT in tracks ${JSON.stringify(tracks)}`)
        continue
      }
      if (track.authInfo !== subscribe.parameters.authInfo) {
        const errorCode = MOQ_SUBSCRIPTION_ERROR_INTERNAL
        const errReason = `Invalid subscribe authInfo ${subscribe.parameters.authInfo}`
        sendMessageToMain(WORKER_PREFIX, 'error', `${errReason} does not match with ${JSON.stringify(tracks)}`)
        await moqSendSubscribeError(controlWriter, subscribe.subscribeId, errorCode, errReason, subscribe.trackAlias)
        continue
      }
      if (!('subscribers' in track)) {
        track.subscribers = []
      }
      if (getSubscriberTrackFromTrackAlias(subscribe.trackAlias) != null) {
        const errorCode = MOQ_SUBSCRIPTION_RETRY_TRACK_ALIAS
        const errReason = `TrackAlias already in use ${subscribe.trackAlias}`
        sendMessageToMain(WORKER_PREFIX, 'error', `${errReason}`)
        await moqSendSubscribeError(controlWriter, subscribe.subscribeId, errorCode, errReason, subscribe.trackAlias)
        continue
      }
      if (getSubscriberTrackFromSubscribeID(subscribe.subscribeId) != null) {
        const errorCode = MOQ_SUBSCRIPTION_ERROR_INTERNAL
        const errReason = `SubscribeID already in use ${subscribe.subscribeId}`
        sendMessageToMain(WORKER_PREFIX, 'error', `${errReason}`)
        await moqSendSubscribeError(controlWriter, subscribe.subscribeId, errorCode, errReason, subscribe.trackAlias)
        continue
      }
      // Add subscribe
      track.subscribers.push(subscribe)
  
      sendMessageToMain(WORKER_PREFIX, 'info', `New subscriber for track ${subscribe.trackAlias}(${subscribe.namespace}/${subscribe.trackName}). Current num subscriber: ${track.subscribers.length}. AuthInfo MATCHED!`)
      
      const lastSent = getLastSentFromTrackAlias(subscribe.trackAlias)
      await moqSendSubscribeOk(controlWriter, subscribe.subscribeId, 0, lastSent.group, lastSent.obj)
      sendMessageToMain(WORKER_PREFIX, 'info', `Sent SUBSCRIBE_OK for subscribeId: ${subscribe.subscribeId}, last: ${lastSent.group}/${lastSent.obj}`)
    }
    else if (moqMsg.type === MOQ_MESSAGE_UNSUBSCRIBE) {
      const unsubscribe = moqMsg.data
      sendMessageToMain(WORKER_PREFIX, 'info', `Received UNSUBSCRIBE: ${JSON.stringify(unsubscribe)}`)
      const subscribe = removeSubscriberFromTrack(unsubscribe.subscribeId)
      if (subscribe != null) {
        sendMessageToMain(WORKER_PREFIX, 'info', `Removed subscriber for subscribeId: ${subscribe.subscribeId}`)
      } else {
        sendMessageToMain(WORKER_PREFIX, 'error', `Removing subscriber. Could not find subscribeId: ${subscribe.subscribeId}`)
      }
      
      const lastSent = getLastSentFromTrackAlias(subscribe.trackAlias)
      const errorCode = MOQ_SUBSCRIPTION_DONE_ENDED
      const errReason = "Subscription Ended, received unSubscribe"
      await moqSendSubscribeDone(controlWriter, subscribe.subscribeId, errorCode, errReason, lastSent.group, lastSent.obj)
      sendMessageToMain(WORKER_PREFIX, 'info', `Sent SUBSCRIBE_DONE for subscribeId: ${subscribe.subscribeId}, err: ${errorCode}(${errReason}), last: ${lastSent.group}/${lastSent.obj}`)
    }
    else {
      sendMessageToMain(WORKER_PREFIX, 'warning', `Unexpected message (type ${moqMsg.type} received, ignoring`)
    }
  }
}

async function sendChunkToTransport (chunkData, subscribeId, trackAlias, inFlightRequests, maxFlightRequests, moqMapping) {
  if (chunkData == null) {
    return { dropped: true, message: 'chunkData is null' }
  }
  if (Object.keys(inFlightRequests).length >= maxFlightRequests) {
    return { dropped: true, message: 'too many inflight requests' }
  }
  return createRequest(chunkData, subscribeId, trackAlias, moqMapping)
}

async function createRequest (chunkData, subscribeId, trackAlias, moqMapping) {
  let packet = null

  if (chunkData.mediaType === 'data') {
    // Simple
    packet = new RawPackager()
    packet.SetData(chunkData.mediaType, 'key', chunkData.seqId, chunkData.chunk)
  } else {
    // Media LOC packager
    packet = new LocPackager()
    // actual bytes of encoded data
    const chunkDataBuffer = new Uint8Array(chunkData.chunk.byteLength)
    chunkData.chunk.copyTo(chunkDataBuffer)

    packet.SetData(chunkData.mediaType, chunkData.compensatedTs, chunkData.estimatedDuration, chunkData.chunk.type, chunkData.seqId, chunkData.firstFrameClkms, chunkData.metadata, chunkDataBuffer)
  }
  return createSendPromise(packet, subscribeId, trackAlias, moqMapping)
}

async function createSendPromise (packet, subscribeId, trackAlias, moqMapping) {
  if (moqt.wt === null) {
    return { dropped: true, message: `Dropped Object for subscribeId: ${subscribeId}, trackAlias: ${trackAlias}, because transport is NOT open. For ${packet.GetData().mediaType} - ${packet.GetData().seqId}` }
  }
  if (!(trackAlias in moqPublisherState)) {
    if (packet.GetData().chunkType === 'delta') {
      return { dropped: true, message: `Dropped Object for subscribeId: ${subscribeId}, trackAlias: ${trackAlias}, because first object can not be delta, data: ${packet.GetDataStr()}` }
    }
    moqPublisherState[trackAlias] = createTrackState()
  }

  const sendOrder = moqCalculateSendOrder(packet)
  const groupSeq = moqPublisherState[trackAlias].currentGroupSeq
  const objSeq = moqPublisherState[trackAlias].currentObjectSeq

  // Group sequence, Using it as a joining point
  if (packet.GetData().chunkType !== 'delta') {
    moqPublisherState[trackAlias].currentGroupSeq++
    moqPublisherState[trackAlias].currentObjectSeq = 0
  }

  let p = null;
  if (moqMapping === MOQ_MAPPING_OBJECT_PER_DATAGRAM) {
    // Get datagram writer
    const datagramWriter = moqt.wt.datagrams.writable.getWriter();

    sendMessageToMain(WORKER_PREFIX, 'debug', `Sending Object per datagram. subscribeId: ${subscribeId}, trackAlias: ${trackAlias} ${groupSeq}/${objSeq}(${sendOrder}). Data: ${packet.GetDataStr()}`)

    moqSendObjectPerDatagramToWriter(datagramWriter, subscribeId, trackAlias, groupSeq, objSeq, sendOrder, packet.ToBytes())

    datagramWriter.releaseLock()

    moqPublisherState[trackAlias].currentObjectSeq++
  } else if (moqMapping === MOQ_MAPPING_OBJECT_PER_STREAM) {
    // Get stream writer
    const uniStream = await moqt.wt.createUnidirectionalStream({ options: { sendOrder } })
    const uniWriter = uniStream.getWriter()

    sendMessageToMain(WORKER_PREFIX, 'debug', `Sending Object per stream. subscribeId: ${subscribeId}, trackAlias: ${trackAlias} ${groupSeq}/${objSeq}(${sendOrder}). Data: ${packet.GetDataStr()}`)

    moqSendObjectPerStreamToWriter(uniWriter, subscribeId, trackAlias, groupSeq, objSeq, sendOrder, packet.ToBytes())

    moqPublisherState[trackAlias].currentObjectSeq++

    // Write async here
    p = uniWriter.close()
    p.id = packet.GetData().pId

    addToInflight(packet.GetData().mediaType, p)
  } else {
    throw new Error(`Unexpected MOQ - QUIC mapping, received ${moqMapping}`)
  }

  if (p != null) {
    p.finally(() => {
      removeFromInflight(packet.GetData().mediaType, packet.GetData().pId)
      return { dropped: false, message: `Sent object for subscribeId: ${subscribeId}, trackAlias: ${trackAlias}` }
    })
  }
}

function addToInflight (mediaType, p) {
  if (p.id in inFlightRequests[mediaType]) {
    sendMessageToMain(WORKER_PREFIX, 'error', 'id already exists in inflight, this should never happen')
  } else {
    inFlightRequests[mediaType][p.id] = p
  }
}

function removeFromInflight (mediaType, id) {
  if (id in inFlightRequests[mediaType]) {
    delete inFlightRequests[mediaType][id]
  }
}

// MOQT

async function moqCreatePublisherSession (moqt) {
  // SETUP
  await moqSendSetup(moqt.controlWriter, MOQ_PARAMETER_ROLE_PUBLISHER)

  const moqMsg = await moqParseMsg(moqt.controlReader)
  if (moqMsg.type !== MOQ_MESSAGE_SERVER_SETUP) {
    throw new Error(`Expected MOQ_MESSAGE_SERVER_SETUP, received ${moqMsg.type}`)
  }
  const setupResponse = moqMsg.data
  sendMessageToMain(WORKER_PREFIX, 'info', `Received SETUP response: ${JSON.stringify(setupResponse)}`)
  if (setupResponse.parameters.role !== MOQ_PARAMETER_ROLE_SUBSCRIBER && setupResponse.parameters.role !== MOQ_PARAMETER_ROLE_BOTH) {
    throw new Error(`role not supported. Supported  ${MOQ_PARAMETER_ROLE_SUBSCRIBER}, got from server ${JSON.stringify(setupResponse.parameters.role)}`)
  }

  // ANNOUNCE
  const announcedNamespaces = []
  for (const [trackType, trackData] of Object.entries(tracks)) {
    if (!announcedNamespaces.includes(trackData.namespace)) {
      await moqSendAnnounce(moqt.controlWriter, trackData.namespace, trackData.authInfo)
      const moqMsg = await moqParseMsg(moqt.controlReader)
      if (moqMsg.type !== MOQ_MESSAGE_ANNOUNCE_OK && moqMsg.type !== MOQ_MESSAGE_ANNOUNCE_ERROR) {
        throw new Error(`Expected MOQ_MESSAGE_ANNOUNCE_OK or MOQ_MESSAGE_ANNOUNCE_ERROR, received ${moqMsg.type}`)
      }
      if (moqMsg.type === MOQ_MESSAGE_ANNOUNCE_ERROR) {
        throw new Error(`Received ANNOUNCE_ERROR response for ${trackData.namespace}/${trackData.name}-(type: ${trackType}): ${JSON.stringify(moqMsg.data)}`)
      }
      const announceResp = moqMsg.data
      sendMessageToMain(WORKER_PREFIX, 'info', `Received ANNOUNCE_OK response for ${trackData.id}-${trackType}-${trackData.namespace}: ${JSON.stringify(announceResp)}`)
      if (trackData.namespace !== announceResp.namespace) {
        throw new Error(`expecting namespace ${trackData.namespace}, got ${JSON.stringify(announceResp)}`)
      }
      announcedNamespaces.push(trackData.namespace)
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

function initInflightReqData () {
  const ret = {}
  for (const [trackType] of Object.entries(tracks)) {
    ret[trackType] = {}
  }
  return ret
}

function moqResetState () {
  moqPublisherState = {}
}

function moqCalculateSendOrder (packet) {
  // Prioritize:
  // Audio over video
  // New over old

  let ret = packet.GetData().seqId
  if (ret < 0) {
    // Send now
    ret = Number.MAX_SAFE_INTEGER
  } else {
    if (tracks[packet.GetData().mediaType].isHipri) {
      ret = Math.floor(ret + Number.MAX_SAFE_INTEGER / 2)
    }
  }
  return ret
}

function createTrackState () {
  return {
    currentGroupSeq: 0,
    currentObjectSeq: 0,
    uniDataTrackWriter: null,
  }
}

async function closeUniDataTrackWritersIfNeeded() {
  for (const [, trackData] of Object.entries(tracks)) {
    if ('uniDataTrackWriter' in trackData && trackData.uniDataTrackWriter != null) {
      await trackData.uniDataTrackWriter.close();
    }
  }
  return
}

function getTrackFromFullTrackName (fullTrackName) {
  for (const [, trackData] of Object.entries(tracks)) {
    if (getTrackFullName(trackData.namespace, trackData.name) === fullTrackName) {
      return trackData
    }
  }
  return null
}

function getSubscriberTrackFromTrackAlias (trackAlias) {
  for (const [, trackData] of Object.entries(tracks)) {
    if ("subscribers" in trackData && trackData.subscribers.length > 0) {
      let i = 0
      while (i < trackData.subscribers.length) {
        if (trackData.subscribers[i].trackAlias === trackAlias) {
          return trackData
        }
        i++
      }
    }
  }
  return null
}

function getSubscriberTrackFromSubscribeID (subscribeId) {
  for (const [, trackData] of Object.entries(tracks)) {
    if ("subscribers" in trackData && trackData.subscribers.length > 0) {
      let i = 0
      while (i < trackData.subscribers.length) {
        if (trackData.subscribers[i].subscribeId === subscribeId) {
          return trackData
        }
        i++
      }
    }
  }
  return null
}

function removeSubscriberFromTrack (subscribeId) {
  for (const trackData of Object.values(tracks)) {
    if ("subscribers" in trackData && trackData.subscribers.length > 0) {
      let i = 0
      if ('subscribers' in trackData) {
        while (i < trackData.subscribers.length) {
          if (trackData.subscribers[i].subscribeId === subscribeId) {
            const ret = trackData.subscribers[i]
            trackData.subscribers.splice(i, 1)
            return ret
          }
          i++
        }
      }
    }
  }
  return null
}

function getAllInflightRequestsArray () {
  let ret = []
  for (const [trackType] of Object.entries(tracks)) {
    ret = ret.concat(ret, Object.values(inFlightRequests[trackType]))
  }
  return ret
}

function getInflightRequestsReport () {
  const ret = {}
  for (const [trackType] of Object.entries(tracks)) {
    ret[trackType] = Object.keys(inFlightRequests[trackType]).length
  }
  return ret
}

function getLastSentFromTrackAlias(trackAlias) {
  const ret = {group: undefined, obj: undefined}
  if (trackAlias in moqPublisherState) {
    ret.group = moqPublisherState[trackAlias].currentGroupSeq
    ret.obj = moqPublisherState[trackAlias].currentObjectSeq
  }
  return ret
}

async function unAnnounceTracks() {
  for (const trackData of Object.values(tracks)) {
      try {
        await moqSendUnAnnounce(moqt.controlWriter, trackData.namespace)
        sendMessageToMain(WORKER_PREFIX, 'info', `Sent UnAnnounce for ${trackData.namespace}`)
      }
      catch (err) {
        if (MOQT_DEV_MODE) {throw err}
        sendMessageToMain(WORKER_PREFIX, 'error', `on UnAnnounce. Err: ${err}`)
      }
  }
}
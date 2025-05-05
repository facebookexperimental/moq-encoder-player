/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { sendMessageToMain, StateEnum} from '../utils/utils.js'
import { moqCreate, moqClose, moqCloseWrttingStreams, moqParseMsg, moqCreateControlStream, moqSendSubscribeOk, moqSendSubscribeError, moqSendSubgroupHeader, moqSendObjectPerDatagramToWriter, moqSendSetup, moqSendUnAnnounce, MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT, moqSendAnnounce, getTrackFullName, moqSendSubscribeDone, MOQ_SUBSCRIPTION_ERROR_INTERNAL, MOQ_SUBSCRIPTION_RETRY_TRACK_ALIAS, MOQ_MESSAGE_SUBSCRIBE, MOQ_MESSAGE_UNSUBSCRIBE, MOQ_SUBSCRIPTION_DONE_ENDED, MOQ_MESSAGE_SERVER_SETUP, MOQ_MESSAGE_ANNOUNCE_OK, MOQ_MESSAGE_ANNOUNCE_ERROR, MOQ_MAPPING_SUBGROUP_PER_GROUP, MOQ_MAPPING_OBJECT_PER_DATAGRAM, moqSendObjectSubgroupToWriter, moqSendObjectEndOfGroupToWriter} from '../utils/moqt.js'
import { MIPackager, MIPayloadTypeEnum} from '../packager/mi_packager.js'

const WORKER_PREFIX = '[MOQ-SENDER]'

// Show verbose exceptions
const MOQT_DEV_MODE = true

let moqPublisherState = {}

let workerState = StateEnum.Created

let isSendingStats = true

let keepAlivesEveryMs = 0
let keepAliveInterval = null
let keepAliveNameSpace = ""
let certificateHash = null

let lastObjectSentMs = 0

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
    },
} */

// Inflight req abort signal
const abortController = new AbortController()

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
      if (keepAliveInterval != null) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null
      }
      //TODO JOC finish abort controller
      abortController.abort()
      await moqCloseWrttingStreams(moqt)
      
      await sendSubscribeDone(moqt)
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
    if ('keepAlivesEveryMs' in e.data.muxerSenderConfig) {
      keepAlivesEveryMs = e.data.muxerSenderConfig.keepAlivesEveryMs
    }
    if ('certificateHash' in e.data.muxerSenderConfig) {
      certificateHash = e.data.muxerSenderConfig.certificateHash
    }

    if (urlHostPortEp === '') {
      sendMessageToMain(WORKER_PREFIX, 'error', 'Empty host port')
      return
    }

    const errTrackStr = checkTrackData();
    if (errTrackStr != undefined) {
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
      let options = {}
      if (certificateHash != undefined && certificateHash != null) {
        options = { serverCertificateHashes: [{ algorithm: 'sha-256', value: certificateHash}]}
      }
      sendMessageToMain(WORKER_PREFIX, 'info', `WT initiating with options ${JSON.stringify(options)}`)

      moqt.wt = new WebTransport(url.href, options)
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

      if (keepAlivesEveryMs > 0) {
        keepAliveNameSpace = Math.floor(Math.random() * 10000000) + "-keepAlive"
        sendMessageToMain(WORKER_PREFIX, 'info', `Starting keep alive every ${keepAlivesEveryMs}ms, ns: ${keepAliveNameSpace}`)
        keepAliveInterval = setInterval(sendKeepAlive, keepAlivesEveryMs, moqt.controlWriter);
      }
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
  const chunkData = { mediaType: type, firstFrameClkms, compensatedTs, estimatedDuration, seqId, chunk: e.data.chunk, metadata: e.data.metadata, timebase: e.data.timebase, sampleFreq: e.data.sampleFreq, numChannels: e.data.numChannels, codec: e.data.codec, newSubgroupEvery: tracks[type].newSubgroupEvery}
  const moqMapping = (e.data.moqMapping === undefined) ? tracks[type].moqMapping : e.data.moqMapping

  let i = 0
  while (i < tracks[type].subscribers.length) {
    const trackAlias = tracks[type].subscribers[i].trackAlias

    sendChunkToTransport(chunkData, trackAlias, getNumInflightRequestByType(moqt, type), tracks[type].maxInFlightRequests, moqMapping)
    .then(val => {
      if (val !== undefined && val.dropped === true) {
        sendMessageToMain(WORKER_PREFIX, 'dropped', { clkms: Date.now(), seqId, mediaType: type, ts: chunkData.timestamp, msg: val.message })
      } else {
        sendMessageToMain(WORKER_PREFIX, 'debug', `SENT CHUNK ${type} - seqId: ${seqId}, metadataSize: ${(chunkData.metadata != undefined) ? chunkData.metadata.byteLength : 0} for trackAlias: ${trackAlias}`)
      }
    })
    .catch(err => {
      if (MOQT_DEV_MODE) {throw err}
      sendMessageToMain(WORKER_PREFIX, 'dropped', { clkms: Date.now(), seqId, mediaType: chunkData.mediaType, ts: chunkData.timestamp, msg: err.message })
      sendMessageToMain(WORKER_PREFIX, 'error', `error sending chunk. For trackAlias: ${trackAlias}. Err:  ${err.message}`)
    })
    i++
  }

  // Report stats
  if (isSendingStats) {
    self.postMessage({ type: 'sendstats', clkms: Date.now(), inFlightReq: getInflightRequestsReport(moqt) })
  }
})

async function sendKeepAlive(controlWriter) {
  if((Date.now() - lastObjectSentMs) > keepAlivesEveryMs) {
    await moqSendAnnounce(controlWriter, [keepAliveNameSpace], "")
    sendMessageToMain(WORKER_PREFIX, 'info', `Sent keep alive (announce) for ns: ${keepAliveNameSpace}`)
  }
}

async function startLoopSubscriptionsLoop(controlReader, controlWriter) {
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

      if (!('aggregatedNumSubscription' in track)) {
        track.aggregatedNumSubscription = 0
      } else {
        track.aggregatedNumSubscription++
      }
      
      sendMessageToMain(WORKER_PREFIX, 'info', `New subscriber for track ${subscribe.trackAlias}(${subscribe.namespace}/${subscribe.trackName}). Current num subscriber: ${track.subscribers.length}. AuthInfo MATCHED!`)
      
      const lastSent = getLastSentFromTrackAlias(subscribe.trackAlias)
      await moqSendSubscribeOk(controlWriter, subscribe.subscribeId, 0, lastSent.group, lastSent.obj, subscribe.parameters.authInfo)
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
    }
    else if (moqMsg.type === MOQ_MESSAGE_ANNOUNCE_OK && moqMsg.data.namespace.join('') === keepAliveNameSpace) {
      // This is the keep alive answer
    }
    else {
      sendMessageToMain(WORKER_PREFIX, 'warning', `Unexpected message (type ${moqMsg.type} received, ignoring`)
    }
  }
}

async function sendChunkToTransport (chunkData, trackAlias, numInflightReqType, maxFlightRequests, moqMapping) {
  if (chunkData == null) {
    return { dropped: true, message: 'chunkData is null' }
  }
  if (numInflightReqType >= maxFlightRequests) {
    return { dropped: true, message: 'too many inflight requests' }
  }
  return createRequest(chunkData, trackAlias, moqMapping)
}

async function createRequest (chunkData, trackAlias, moqMapping) {
  let packet = null
  let isHiPri = false

  // Media MI packager
  packet = new MIPackager()
  if (chunkData.mediaType === "video") {
    const chunkDataBuffer = new Uint8Array(chunkData.chunk.byteLength)
    chunkData.chunk.copyTo(chunkDataBuffer)
    
    // Assuming NO B-Frames (pts === dts)
    const avcDecoderConfigurationRecord = ("metadata" in chunkData && chunkData.metadata != undefined && chunkData.metadata != null) ? chunkData.metadata : undefined;
    
    packet.SetData(MIPayloadTypeEnum.VideoH264AVCCWCP, chunkData.seqId, chunkData.compensatedTs, chunkData.timebase, chunkData.estimatedDuration, chunkData.firstFrameClkms, chunkDataBuffer, chunkData.compensatedTs, avcDecoderConfigurationRecord, undefined, undefined, chunkData.chunk.type === "delta")
  } else if (chunkData.mediaType == "audio") {
    const chunkDataBuffer = new Uint8Array(chunkData.chunk.byteLength)
    chunkData.chunk.copyTo(chunkDataBuffer)
    let payloadType = MIPayloadTypeEnum.None;
    if (chunkData.codec == "opus") {
      payloadType = MIPayloadTypeEnum.AudioOpusWCP;
    } else {
      payloadType = MIPayloadTypeEnum.AudioAACMP4LCWCP;
    }
    packet.SetData(payloadType, chunkData.seqId, chunkData.compensatedTs, chunkData.timebase, chunkData.estimatedDuration, chunkData.firstFrameClkms, chunkDataBuffer, undefined, undefined, chunkData.sampleFreq, chunkData.numChannels, chunkData.chunk.type === "delta")
    isHiPri = true
  } else if (chunkData.mediaType === 'data') {
    let isDelta = false;
    if (chunkData.newSubgroupEvery > 1) {
      isDelta = (chunkData.seqId % chunkData.newSubgroupEvery == 0) ? false : true;
    }
    packet.SetData(MIPayloadTypeEnum.RAWData, chunkData.seqId, undefined, undefined, undefined, undefined, chunkData.chunk, undefined, undefined, undefined, undefined, isDelta);
  } else {
    throw new Error(`Not supported media type ${chunkData.mediaType}`)
  }
  return createSendPromise(packet, trackAlias, moqMapping, isHiPri)
}

async function createSendPromise (packet, trackAlias, moqMapping, isHiPri) {
  let isFirstObject = false
  if (moqt.wt === null) {
    return { dropped: true, message: `Dropped Object for trackAlias: ${trackAlias}, because transport is NOT open. SeqId: ${packet.GetData().seqId}` }
  }

  // Check about if it is 1st object to be send in this track
  if (!(trackAlias in moqPublisherState)) {
    if (packet.IsDelta()) {
      const msg = `Dropped Object for trackAlias: ${trackAlias}, because first object can not be delta, data: ${packet.GetDataStr()}`
      sendMessageToMain(WORKER_PREFIX, 'debug', msg);
      return { dropped: true, message: msg }
    }
    moqPublisherState[trackAlias] = createTrackState()
    sendMessageToMain(WORKER_PREFIX, 'debug', `Created first object for trackAlias: ${trackAlias}`);
    isFirstObject = true
  }

  // Gets the stream priority
  const sendOrder = moqCalculateSendOrder(packet, isHiPri)
  
  // Group sequence, Using it as a joining point
  const prevGroupSeq = moqPublisherState[trackAlias].currentGroupSeq;
  const prevObjSeq = moqPublisherState[trackAlias].currentObjectSeq;
  if (!packet.IsDelta()) {
    if (!isFirstObject) {
      moqPublisherState[trackAlias].currentGroupSeq++
    }
    sendMessageToMain(WORKER_PREFIX, 'debug', `Created new group for trackAlias: ${trackAlias}`);
    moqPublisherState[trackAlias].currentObjectSeq = 0
  }

  const groupSeq = moqPublisherState[trackAlias].currentGroupSeq
  const objSeq = moqPublisherState[trackAlias].currentObjectSeq
  const publisherPriority = (isHiPri) ? (MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT - 1) : MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT;

  const mediaType = packet.getMediaType();

  let p = null;
  if (moqMapping === MOQ_MAPPING_OBJECT_PER_DATAGRAM) {
    // Get datagram writer
    const datagramWriter = moqt.wt.datagrams.writable.getWriter();

    sendMessageToMain(WORKER_PREFIX, 'debug', `Sending Object per datagram. trackAlias: ${trackAlias} ${groupSeq}/${objSeq}(${sendOrder}). Data: ${packet.GetDataStr()}, Ext Headers: ${JSON.stringify(packet.ExtensionHeaders())}`)

    moqSendObjectPerDatagramToWriter(datagramWriter, trackAlias, groupSeq, objSeq, publisherPriority, packet.PayloadToBytes(), packet.ExtensionHeaders())

    datagramWriter.releaseLock()

    moqPublisherState[trackAlias].currentObjectSeq++;

  } else if (moqMapping === MOQ_MAPPING_SUBGROUP_PER_GROUP) {
    const currentStreamWriterId = createMultiObjectHash(mediaType, trackAlias, groupSeq);
    let currentUniStreamWritter = moqt.multiObjectWritter[currentStreamWriterId]
    // New group
    if (currentUniStreamWritter == undefined) {
      // Create new stream
      const uniStream = await moqt.wt.createUnidirectionalStream({ options: { sendOrder } })
      currentUniStreamWritter = uniStream.getWriter()
      moqt.multiObjectWritter[currentStreamWriterId] = currentUniStreamWritter

      sendMessageToMain(WORKER_PREFIX, 'debug', `Created new subgroup (stream) ${currentStreamWriterId} with sendOrder: ${sendOrder}`);

      moqSendSubgroupHeader(currentUniStreamWritter, trackAlias, groupSeq, publisherPriority);
    }

    // Check and clean old streams
    if (prevGroupSeq != groupSeq) {
      const prevStreamWriterId = createMultiObjectHash(mediaType, trackAlias, prevGroupSeq);
      let prevUniStreamWritter = moqt.multiObjectWritter[prevStreamWriterId];
      if (prevUniStreamWritter != undefined) {
        // Indicate end of group
        moqSendObjectEndOfGroupToWriter(prevUniStreamWritter, prevObjSeq + 1);
        sendMessageToMain(WORKER_PREFIX, 'debug', `Send group close for ${prevStreamWriterId} and ${prevGroupSeq}`);
        p = prevUniStreamWritter.close()
        p.writteId = prevStreamWriterId;
        p.finally(() => {
          if (moqt.multiObjectWritter[p.writteId] != undefined) {
            delete moqt.multiObjectWritter[p.writteId]
          }
          const msg = `Closed stream ${prevStreamWriterId}`
          sendMessageToMain(WORKER_PREFIX, 'debug', msg);
          return { dropped: false, message: msg }
        });
      }
    }

    // Send object to current stream
    moqSendObjectSubgroupToWriter(currentUniStreamWritter, objSeq, packet.PayloadToBytes(), packet.ExtensionHeaders())
    moqPublisherState[trackAlias].currentObjectSeq++;
  }
  else {
    throw new Error(`Unexpected MOQ - QUIC mapping, received ${moqMapping}`)
  }

  lastObjectSentMs = Date.now();
}

function createMultiObjectHash(mediaType, trackAlias, groupId) {
  return `${mediaType}-${trackAlias}-${groupId}`;
}

// MOQT

async function moqCreatePublisherSession (moqt) {
  // SETUP
  await moqSendSetup(moqt.controlWriter)

  const moqMsg = await moqParseMsg(moqt.controlReader)
  if (moqMsg.type !== MOQ_MESSAGE_SERVER_SETUP) {
    throw new Error(`Expected MOQ_MESSAGE_SERVER_SETUP, received ${moqMsg.type}`)
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
      if (!isSameNamespace(trackData.namespace, announceResp.namespace)) {
        throw new Error(`expecting namespace ${JSON.stringify(trackData.namespace)}, got ${JSON.stringify(announceResp)}`)
      }
      announcedNamespaces.push(trackData.namespace)
    }
  }

  lastObjectSentMs = Date.now()
}

function isSameNamespace(a, b) {
  if (a.length !== b.length) {
      return false;
  }
  a.forEach(function (item) {
    if (!b.includes(item)) {
      return false
    }
  });
  b.forEach(function (item) {
    if (!a.includes(item)) {
      return false
    }
  });
  return true
}

function checkTrackData () {
  if (Object.entries(tracks).length <= 0) {
    return 'Number of Track Ids to announce needs to be > 0'
  }
  for (const [, track] of Object.entries(tracks)) {
    if (!('namespace' in track) || (track.namespace.length <= 0) || !('name' in track) || !('authInfo' in track)) {
      return 'Track malformed, needs to contain namespace, name, and authInfo'
    }
  }
  return undefined;
}

function moqResetState () {
  moqPublisherState = {}
}

function moqCalculateSendOrder (packet, isHiPri) {
  // Prioritize:
  // Audio over video
  // New over old

  let ret = packet.GetData().seqId
  if (ret < 0) {
    // Send now
    ret = Number.MAX_SAFE_INTEGER
  } else {
    if (isHiPri) {
      ret += Math.floor(ret + Number.MAX_SAFE_INTEGER / 2)
    }
  }
  return ret
}

function createTrackState () {
  return {
    currentGroupSeq: 0,
    currentObjectSeq: 0,
  }
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

function getListOfSubscribeIdPerTrack(trackData) {
  const ret = []
  if ("subscribers" in trackData && trackData.subscribers.length > 0) {
    let i = 0
    if ('subscribers' in trackData) {
      while (i < trackData.subscribers.length) {
        ret.push(trackData.subscribers[i].subscribeId)
        i++
      }
    }
  }
  return ret
}

function getAggretatedSubscriptions() {
  let ret = 0
  for (const trackData of Object.values(tracks)) {
    if ('aggregatedNumSubscription' in trackData && trackData.aggregatedNumSubscription > 0) {
      ret = ret + trackData.aggregatedNumSubscription 
    }
  }

  return ret
}

function getNumInflightRequestByType(moqt, trackType) {
  let ret = 0
  for (const key of Object.keys(moqt.multiObjectWritter)) {
    if (key.startsWith(trackType)) {
      ret++
    }
  }
  return ret
}

function getInflightRequestsReport (moqt) {
  const ret = {}
  for (const [trackType] of Object.entries(tracks)) {
    ret[trackType] = getNumInflightRequestByType(moqt, trackType)
  }
  return ret
}

// This is an aproximation
function getLastSentFromTrackAlias(trackAlias) {
  const ret = {group: undefined, obj: undefined}
  if (trackAlias in moqPublisherState) {
    ret.group = moqPublisherState[trackAlias].currentGroupSeq
    ret.obj = moqPublisherState[trackAlias].currentObjectSeq
  }
  return ret
}

async function sendSubscribeDone(moqt) {
  const errorCode = MOQ_SUBSCRIPTION_DONE_ENDED
  const errReason = "Subscription Ended, the stream has finsed"
  const numberOfOpenedStreams = getAggretatedSubscriptions()
  
  for (const trackData of Object.values(tracks)) {
    const subscribeIDs = getListOfSubscribeIdPerTrack(trackData)
    for (const subscribeId of subscribeIDs) {
      try {
        await moqSendSubscribeDone(moqt.controlWriter, subscribeId, errorCode, errReason, numberOfOpenedStreams)
        sendMessageToMain(WORKER_PREFIX, 'info', `Sent SUBSCRIBE_DONE for subscribeId: ${subscribeId}, err: ${errorCode}(${errReason}), numberOfOpenedStreams: ${numberOfOpenedStreams}`)
      }
      catch (err) {
        if (MOQT_DEV_MODE) { throw err }
        sendMessageToMain(WORKER_PREFIX, 'error', `on SUBSCRIBE_DONE. Err: ${err}`)
      }
    }
  }
}

async function unAnnounceTracks(moqt) {
  for (const trackData of Object.values(tracks)) {
      try {
        await moqSendUnAnnounce(moqt.controlWriter, [trackData.namespace])
        sendMessageToMain(WORKER_PREFIX, 'info', `Sent UnAnnounce for ${trackData.namespace}`)
      }
      catch (err) {
        if (MOQT_DEV_MODE) {throw err}
        sendMessageToMain(WORKER_PREFIX, 'error', `on UnAnnounce. Err: ${err}`)
      }
  }
}
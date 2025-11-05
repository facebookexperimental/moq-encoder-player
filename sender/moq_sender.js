/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { sendMessageToMain, StateEnum} from '../utils/utils.js'
import { moqCreate, moqClose, moqCloseWrttingStreams, moqParseMsg, moqCreateControlStream, moqSendSubgroupHeader, moqSendObjectPerDatagramToWriter, moqSendClientSetup, moqSendPublishDone, MOQ_PUBLISHER_PRIORITY_BASE_DEFAULT, moqSendPublish, moqSendPublishNamespace, MOQ_SUBSCRIPTION_ERROR_INTERNAL, MOQ_MESSAGE_SERVER_SETUP, MOQ_MESSAGE_PUBLISH_OK, MOQ_MESSAGE_PUBLISH_ERROR, MOQ_MESSAGE_MAX_REQUEST_ID, MOQ_MAPPING_SUBGROUP_PER_GROUP, MOQ_MESSAGE_UNSUBSCRIBE, MOQ_MAPPING_OBJECT_PER_DATAGRAM, moqSendObjectSubgroupToWriter, moqSendObjectEndOfGroupToWriter, getAuthInfofromParameters, MOQ_STATUS_TRACK_ENDED, MOQ_MESSAGE_SUBSCRIBE_UPDATE, MOQ_MESSAGE_PUBLISH_NAMESPACE_OK, MOQ_MESSAGE_PUBLISH_NAMESPACE_ERROR, MOQ_MESSAGE_SUBSCRIBE, moqSendSubscribeOk, moqSendSubscribeError, getTrackFullName} from '../utils/moqt.js'
import { MIPackager, MIPayloadTypeEnum} from '../packager/mi_packager.js'

const WORKER_PREFIX = '[MOQ-SENDER]'

const KEEPALIVE_TRACK_ALIAS = 1

// Show verbose exceptions
const MOQT_DEV_MODE = true

let moqPublisherState = {}

let workerState = StateEnum.Created

let isSendingStats = true

let keepAlivesEveryMs = 0
let keepAliveInterval = null
let keepAliveNameSpace = ""
let keepAliveName = ""

let certificateHash = null

let lastObjectSentMs = 0

let currentClientRequestId = undefined
let currentTrackAlias = KEEPALIVE_TRACK_ALIAS + 1

let tracks = {}

// If true it will send PUBLISH_NAMESPACE once instead of a PUBLISH per track
let usePublishNamespace = false

// Example
/* 
moqTracks: {
  "audio": {
    namespace: ["vc"],
    name: "audio0",
    maxInFlightRequests: 100,
    isHipri: true,
    authInfo: "secret",
    moqMapping: MOQ_MAPPING_SUBGROUP_PER_GROUP,
  },
  "video": {
    namespace: ["vc"],
    name: "video0",
    maxInFlightRequests: 50,
    isHipri: false,
    authInfo: "secret",
    moqMapping: MOQ_MAPPING_SUBGROUP_PER_GROUP,
  }
}
*/

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
      
      await sendPublishDone(moqt)
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
    if ('usePublishNamespace' in e.data.muxerSenderConfig) {
      usePublishNamespace = e.data.muxerSenderConfig.usePublishNamespace
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

      // Reset request IDs
      requestIDsReset()
      
      await moqCreatePublisherSession(moqt, usePublishNamespace)

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
        keepAliveNameSpace = "keepAlive"
        keepAliveName = `${Math.floor(Math.random() * 10000000)}`
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
    const trackAlias = tracks[type].trackAlias

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
    await moqSendPublish(controlWriter, getNextClientReqId(), [keepAliveNameSpace], keepAliveName, KEEPALIVE_TRACK_ALIAS)
    sendMessageToMain(WORKER_PREFIX, 'info', `Sent keep alive (publish) for ns: ${keepAliveNameSpace} name: ${keepAliveName}`)
  }
}

async function startLoopSubscriptionsLoop(controlReader, controlWriter) {
  sendMessageToMain(WORKER_PREFIX, 'info', 'Started subscription loop')

  while (workerState === StateEnum.Running) {
    const moqMsg = await moqParseMsg(controlReader)
    sendMessageToMain(WORKER_PREFIX, 'debug', `Message received: ${JSON.stringify(moqMsg)}`)

    if (moqMsg.type === MOQ_MESSAGE_SUBSCRIBE_UPDATE) {
      const subscribeUpdate = moqMsg.data
      sendMessageToMain(WORKER_PREFIX, 'info', `Received MOQ_MESSAGE_SUBSCRIBE_UPDATE: ${JSON.stringify(subscribeUpdate)}`)
      if (!('subscriptionRequestId' in subscribeUpdate) || !('forward' in subscribeUpdate)) {
        sendMessageToMain(WORKER_PREFIX, 'error', 'Invalid MOQ_MESSAGE_SUBSCRIBE_UPDATE received, subscriptionRequestId or forward not found')
        continue
      }
      const publisherRequestId = subscribeUpdate.subscriptionRequestId
      const track = getTrackFromPublishRequestId(publisherRequestId)
      if (track == null || track == undefined) {
        sendMessageToMain(WORKER_PREFIX, 'error', `Invalid MOQ_MESSAGE_SUBSCRIBE_UPDATE could not find a track from ${publisherRequestId}. Tracks data: ${JSON.stringify(tracks)}`)
        continue
      }
      if (track.authInfo != undefined && track.authInfo != "") {
        const authInfo = getAuthInfofromParameters(subscribeUpdate.parameters)
        if (track.authInfo !== authInfo) {
          const errorCode = MOQ_SUBSCRIPTION_ERROR_INTERNAL
          const errReason = `Invalid MOQ_MESSAGE_SUBSCRIBE_UPDATE authInfo ${authInfo}`
          sendMessageToMain(WORKER_PREFIX, 'error', `${errReason} does not match with ${JSON.stringify(tracks)}`)
          continue
        }
      }
      
      if (subscribeUpdate.forward === 1) {
        addSubscriberToTrack(track, subscribeUpdate.publisherRequestId, 1, subscribeUpdate.parameters)
      } else {
        sendMessageToMain(WORKER_PREFIX, 'info', `NOT added (forward == 0) subscriber for track ${track.trackAlias}(${track.namespace}/${track.trackName}). Current num subscriber: ${track.subscribers.length}. AuthInfo MATCHED!`)
      }
    }
    else if (moqMsg.type === MOQ_MESSAGE_UNSUBSCRIBE) {
      const unsubscribe = moqMsg.data
      sendMessageToMain(WORKER_PREFIX, 'info', `Received MOQ_MESSAGE_UNSUBSCRIBE: ${JSON.stringify(unsubscribe)}`)
      if (!('subscriptionRequestId' in unsubscribe)) {
        sendMessageToMain(WORKER_PREFIX, 'error', 'Invalid MOQ_MESSAGE_UNSUBSCRIBE received, subscriptionRequestId not found')
        continue
      }
      const subscribers = removeSubscriberFromTrackByPublisherId(unsubscribe.subscriptionRequestId)
      if (subscribers.length > 0) {
        sendMessageToMain(WORKER_PREFIX, 'info', `Removed subscriber(s) for subscriptionRequestId: ${JSON.stringify(subscribers)}`)
      } else {
        sendMessageToMain(WORKER_PREFIX, 'error', `Removing subscriber. Could not find subscribeId: ${unsubscribe.subscriptionRequestId}`)
      }
    }
    else if (moqMsg.type === MOQ_MESSAGE_SUBSCRIBE) {
      const subscribe = moqMsg.data
      sendMessageToMain(WORKER_PREFIX, 'info', `Received SUBSCRIBE: ${JSON.stringify(subscribe)}`)
      const fullTrackName = getTrackFullName(subscribe.namespace, subscribe.trackName)
      const trackData = getTrackFromFullTrackName(fullTrackName)
      if (trackData == null) {
        sendMessageToMain(WORKER_PREFIX, 'error', `Invalid subscribe received ${fullTrackName} is NOT in tracks ${JSON.stringify(trackData)}`)
        continue
      }
      if (trackData.authInfo != undefined && trackData.authInfo != "") {
        const authInfo = getAuthInfofromParameters(subscribe.parameters)
        if (trackData.authInfo !== authInfo) {
          const errorCode = MOQ_SUBSCRIPTION_ERROR_INTERNAL
          const errReason = `Invalid subscribe authInfo ${authInfo}`
          sendMessageToMain(WORKER_PREFIX, 'error', `${errReason} does not match with ${JSON.stringify(trackData)}`)
          await moqSendSubscribeError(controlWriter, subscribe.requestId, errorCode, errReason)
          continue
        }
      }
      addSubscriberToTrack(trackData, subscribe.requestId, 1, subscribe.parameters)

      const lastSent = getLastSentFromTrackAlias(trackData.trackAlias)
      await moqSendSubscribeOk(controlWriter, subscribe.requestId, trackData.trackAlias, 0, lastSent.group, lastSent.obj, subscribe.parameters.authInfo)
      sendMessageToMain(WORKER_PREFIX, 'info', `Sent SUBSCRIBE_OK for requestId: ${subscribe.requestId}, last: ${lastSent.group}/${lastSent.obj}`)
    }
    else if (moqMsg.type === MOQ_MESSAGE_PUBLISH_OK) {
      // This could be the keep alive answer
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

  if (moqMapping === MOQ_MAPPING_OBJECT_PER_DATAGRAM) {
    // Get datagram writer
    const datagramWriter = moqt.wt.datagrams.writable.getWriter();

    sendMessageToMain(WORKER_PREFIX, 'debug', `Sending Object per datagram. trackAlias: ${trackAlias} ${groupSeq}/${objSeq}(${sendOrder}). Data: ${packet.GetDataStr()}, Ext Headers: ${JSON.stringify(packet.ExtensionHeaders())}`)

    moqSendObjectPerDatagramToWriter(datagramWriter, trackAlias, groupSeq, objSeq, publisherPriority, packet.PayloadToBytes(), packet.ExtensionHeaders(), true)

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
        moqSendObjectEndOfGroupToWriter(prevUniStreamWritter, prevObjSeq + 1, [], true);
        sendMessageToMain(WORKER_PREFIX, 'debug', `Send group close for ${prevStreamWriterId} and ${prevGroupSeq}`);
        if (moqt.multiObjectWritter[prevStreamWriterId] != undefined) {
          delete moqt.multiObjectWritter[prevStreamWriterId]
        }
        const msg = `Closing stream ${prevStreamWriterId}`
        sendMessageToMain(WORKER_PREFIX, 'debug', msg);
      }
    }

    // Send object to current stream
    // ObjID delta will be always 0, since we are always incrementing
    moqSendObjectSubgroupToWriter(currentUniStreamWritter, 0, packet.PayloadToBytes(), packet.ExtensionHeaders())
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

async function moqCreatePublisherSession (moqt, usePublishNamespace) {
  // SETUP
  await moqSendClientSetup(moqt.controlWriter)
  sendMessageToMain(WORKER_PREFIX, 'info', 'Sent client setup')

  const moqMsg = await moqParseMsg(moqt.controlReader)
  if (moqMsg.type !== MOQ_MESSAGE_SERVER_SETUP) {
    throw new Error(`Expected MOQ_MESSAGE_SERVER_SETUP, received ${moqMsg.type}`)
  }
  sendMessageToMain(WORKER_PREFIX, 'info', `Received MOQ_MESSAGE_SERVER_SETUP: ${JSON.stringify(moqMsg)}`)
  
  if (usePublishNamespace) {
    // PUBLISH the namespace
    const publishedNamespacesStr = []
    for (const [_, trackData] of Object.entries(tracks)) {
      trackData.trackAlias = getNextTrackAlias()
      const ns_str = stringifyNamespace(trackData.namespace)
      if (!publishedNamespacesStr.includes(ns_str)) {
        const publishReqId = getNextClientReqId()
        await moqSendPublishNamespace(moqt.controlWriter, publishReqId, trackData.namespace, trackData.authInfo)
        sendMessageToMain(WORKER_PREFIX, 'info', `Sent MOQ_MESSAGE_PUBLISH_NAMESPACE (${publishReqId}) ${trackData.namespace}, authinfo: ${JSON.stringify(trackData.authInfo)}`)
      
        let continueLoopingForAnswer = true
        while (continueLoopingForAnswer) {
          const moqMsg = await moqParseMsg(moqt.controlReader)
          if (moqMsg.type !== MOQ_MESSAGE_PUBLISH_NAMESPACE_OK && moqMsg.type !== MOQ_MESSAGE_PUBLISH_NAMESPACE_ERROR && moqMsg.type != MOQ_MESSAGE_MAX_REQUEST_ID && moqMsg.type != MOQ_MESSAGE_SUBSCRIBE) {
            throw new Error(`Expected MOQ_MESSAGE_PUBLISH_NAMESPACE_OK or MOQ_MESSAGE_PUBLISH_NAMESPACE_ERROR or MOQ_MESSAGE_MAX_REQUEST_ID or MOQ_MESSAGE_SUBSCRIBE, received ${moqMsg.type}`)
          }
          if (moqMsg.type === MOQ_MESSAGE_PUBLISH_NAMESPACE_ERROR) {
            throw new Error(`Received MOQ_MESSAGE_PUBLISH_NAMESPACE_ERROR response for ${trackData.namespace}/${trackData.name}: ${JSON.stringify(moqMsg.data)}`)
          }
          else if (moqMsg.type === MOQ_MESSAGE_PUBLISH_NAMESPACE_OK) {
            const reqResp = moqMsg.data
            sendMessageToMain(WORKER_PREFIX, 'info', `Received MOQ_MESSAGE_PUBLISH_NAMESPACE_OK response for (${publishReqId}) ${trackData.namespace}: ${JSON.stringify(reqResp)}`)
            if (publishReqId != reqResp.reqId) {
              throw new Error(`Received RequestID ${reqResp.reqId} does NOT match with the one sent in MOQ_MESSAGE_PUBLISH ${publishReqId}`)
            }
            publishedNamespacesStr.push(ns_str)
            continueLoopingForAnswer = false
          } 
          else {
            sendMessageToMain(WORKER_PREFIX, 'warning', `UNKNOWN message received ${JSON.stringify(moqMsg)}`)
          }
        }
      }
    }
  } else {
    // PUBLISH each track
    for (const [trackType, trackData] of Object.entries(tracks)) {
      trackData.trackAlias = getNextTrackAlias()
      const publishReqId = getNextClientReqId()
      trackData.publisherRequestId = publishReqId
      await moqSendPublish(moqt.controlWriter, publishReqId, trackData.namespace, trackData.name, trackData.trackAlias, trackData.authInfo)
      sendMessageToMain(WORKER_PREFIX, 'info', 'Sent MOQ_MESSAGE_PUBLISH')
      let continueLoopingForAnswer = true
      while (continueLoopingForAnswer) {
        const moqMsg = await moqParseMsg(moqt.controlReader)
        if (moqMsg.type !== MOQ_MESSAGE_PUBLISH_OK && moqMsg.type !== MOQ_MESSAGE_PUBLISH_ERROR && moqMsg.type != MOQ_MESSAGE_MAX_REQUEST_ID) {
          throw new Error(`Expected MOQ_MESSAGE_PUBLISH_OK or MOQ_MESSAGE_PUBLISH_ERROR or MOQ_MESSAGE_MAX_REQUEST_ID, received ${moqMsg.type}`)
        }
        if (moqMsg.type === MOQ_MESSAGE_PUBLISH_ERROR) {
          throw new Error(`Received MOQ_MESSAGE_PUBLISH_ERROR response for ${trackData.namespace}/${trackData.name}-(type: ${trackType}): ${JSON.stringify(moqMsg.data)}`)
        }
        else if (moqMsg.type === MOQ_MESSAGE_PUBLISH_OK) {
          const publishResp = moqMsg.data
          sendMessageToMain(WORKER_PREFIX, 'info', `Received MOQ_MESSAGE_PUBLISH_OK response for ${trackData.id}-${trackType}-${trackData.namespace}: ${JSON.stringify(publishResp)}`)
          if (publishReqId != publishResp.reqId) {
            throw new Error(`Received RequestID ${publishResp.reqId} does NOT match with the one sent in MOQ_MESSAGE_PUBLISH ${publishReqId}`)
          }
          if (publishResp.forward === 1) {
            addSubscriberToTrack(trackData, publishReqId, 1, publishResp.parameters)
          }
          continueLoopingForAnswer = false
        }
        else {
          sendMessageToMain(WORKER_PREFIX, 'warning', `UNKNOWN message received ${JSON.stringify(moqMsg)}`)
        }
      }
    }
  }

  lastObjectSentMs = Date.now()
}

function checkTrackData () {
  if (Object.entries(tracks).length <= 0) {
    return 'Number of Track Ids to publish needs to be > 0'
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

function getTrackFromPublishRequestId (reqId) {
  for (const [, trackData] of Object.entries(tracks)) {
    if ('publisherRequestId' in trackData && trackData.publisherRequestId === reqId) {
      return trackData
    }
  }
  return null
}

function removeSubscriberFromTrackByPublisherId (requestId) {
  const ret = []
  for (const trackData of Object.values(tracks)) {
    if ("subscribers" in trackData && trackData.subscribers.length > 0) {
      let i = 0
      let idx_todel = []
      while (i < trackData.subscribers.length) {
        if (trackData.subscribers[i].subscriptionRequestId === requestId) {
          idx_todel.push(i)
        }
        i++
      }
      for (i = idx_todel.length - 1; i >= 0; i--) {
        ret.push(trackData.subscribers[i])
        trackData.subscribers.splice(i, 1)
      } 
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

async function sendPublishDone(moqt) {
  for (const trackData of Object.values(tracks)) {
      try {
        if ('publisherRequestId' in trackData) {
          const requestId = trackData.publisherRequestId
          const statusCode = MOQ_STATUS_TRACK_ENDED
          let streamCount = 0
          if ('aggregatedNumSubscription' in trackData) {
            streamCount = trackData.aggregatedNumSubscription
          }
          const reason = "Subscription Ended, the stream has finished"
          await moqSendPublishDone(moqt.controlWriter, requestId, statusCode, streamCount, reason)
          sendMessageToMain(WORKER_PREFIX, 'info', `Sent PUBLISH_DONE for ${JSON.stringify(trackData)}`)
        }
      }
      catch (err) {
        if (MOQT_DEV_MODE) {throw err}
        sendMessageToMain(WORKER_PREFIX, 'error', `on PUBLISH_DONE. Err: ${err}`)
      }
  }
}

// Requests IDs
function requestIDsReset() {
  currentClientRequestId = undefined
}

function getNextClientReqId() {
  if (typeof currentClientRequestId == 'undefined') {
    currentClientRequestId = 0
  } else {
    currentClientRequestId = currentClientRequestId + 2
  }
  return currentClientRequestId
}

function getNextTrackAlias() {
  const ret = currentTrackAlias
  currentTrackAlias++
  return ret
}

function createSubscribeUpdate(requestId, subscriptionRequestId, forward, parameters) {
  const ret = {}
  ret.requestId = requestId
  ret.subscriptionRequestId = subscriptionRequestId
  ret.start = {group: 0, obj: 0}
  ret.end = { group: Number.MAX_SAFE_INTEGER, obj: Number.MAX_SAFE_INTEGER }
  ret.subscriberPriority = 5
  ret.forward = forward
  ret.parameters = parameters

  return ret
}

function addSubscriberToTrack(trackData, subscriptionRequestId, forward, parameters) {
  const subsUpdate = createSubscribeUpdate(0, subscriptionRequestId, forward, parameters)
  if (!('subscribers' in trackData)) {
    trackData.subscribers = []
  }
  trackData.subscribers.push(subsUpdate)

  if (!('aggregatedNumSubscription' in trackData)) {
    trackData.aggregatedNumSubscription = 0
  } else {
    trackData.aggregatedNumSubscription++
  }
  sendMessageToMain(WORKER_PREFIX, 'info', `New subscriber for track ${trackData.trackAlias}(${trackData.namespace}/${trackData.trackName}). Current num subscriber: ${trackData.subscribers.length}`)
}

function stringifyNamespace(ns) {
  return ns.join('-')
}

function getTrackFromFullTrackName (fullTrackName) {
  for (const [, trackData] of Object.entries(tracks)) {
    if (getTrackFullName(trackData.namespace, trackData.name) === fullTrackName) {
      return trackData
    }
  }
  return null
}

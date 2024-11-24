/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { sendMessageToMain, StateEnum, convertTimestamp } from '../utils/utils.js'
import { moqCreate, moqClose, moqCreateControlStream, moqSendSetup, MOQ_SETUP_PARAMETER_ROLE_PUBLISHER, MOQ_SETUP_PARAMETER_ROLE_SUBSCRIBER, MOQ_SETUP_PARAMETER_ROLE_BOTH, moqParseObjectHeader, moqSendSubscribe, moqSendUnSubscribe, MOQ_MESSAGE_SUBSCRIBE_DONE, moqParseMsg, MOQ_MESSAGE_SERVER_SETUP, MOQ_MESSAGE_SUBSCRIBE_OK, MOQ_MESSAGE_SUBSCRIBE_ERROR, MOQ_MESSAGE_OBJECT_DATAGRAM, MOQ_MESSAGE_STREAM_HEADER_SUBGROUP, moqParseObjectFromSubgroupHeader, MOQ_OBJ_STATUS_END_OF_GROUP, MOQ_OBJ_STATUS_END_OF_TRACK_AND_GROUP, MOQ_OBJ_STATUS_END_OF_SUBGROUP} from '../utils/moqt.js'
import { MIPackager, MIPayloadTypeEnum} from '../packager/mi_packager.js'
import { ContainsNALUSliceIDR , DEFAULT_AVCC_HEADER_LENGTH } from "../utils/media/avcc_parser.js"

const WORKER_PREFIX = '[MOQ-DOWNLOADER]'

// Show verbose exceptions
const MOQT_DEV_MODE = true

const SLEEP_SUBSCRIBE_ERROR_MS = 2000

let workerState = StateEnum.Created

let urlHostPortEp = ''
let isSendingStats = false
let currentSubscribeId = 0
let currentTrackAlias = 0
let certificateHash = null
let tracks = {} // We add subscribeId and trackAlias
// Example
/* moqTracks: {
    "audio": {
      namespace: "vc",
      name: "audio0",
      authInfo: "secret"
  },
  "video": {
      namespace: "vc",
      name: "video0",
      authInfo: "secret"
  }
} */

// Timebases
let systemVideoTimebase = 1000000 // WebCodecs default = 1us
let systemAudioTimebase = 1000000 // WebCodecs default = 1us

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
    if ('certificateHash' in e.data.downloaderConfig) {
      certificateHash = e.data.downloaderConfig.certificateHash
    }
    if ('systemVideoTimebase' in e.data.downloaderConfig) {
      systemVideoTimebase = e.data.downloaderConfig.systemVideoTimebase
    }
    if ('systemAudioTimebase' in e.data.downloaderConfig) {
      systemAudioTimebase = e.data.downloaderConfig.systemAudioTimebase
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
      let options = {}
      if (certificateHash != undefined && certificateHash != null) {
        options = { serverCertificateHashes: [{ algorithm: 'sha-256', value: certificateHash}]}
      }
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
      await moqCreateSubscriberSession(moqt)

      sendMessageToMain(WORKER_PREFIX, 'info', 'MOQ Initialized')
      workerState = StateEnum.Running

      // We need independent async functions to receive streams and datagrams, something like await Promise.any([wtReadableStream.read(), wtDataGramReader.read()]) does NOT work
      moqReceiveObjects(moqt)      
    } catch (err) {
      if (MOQT_DEV_MODE) {throw err}
      sendMessageToMain(WORKER_PREFIX, 'error', `Initializing MOQ. Err: ${err}`)
    }
  }
})

async function moqReceiveObjects(moqt) {
  if (workerState === StateEnum.Stopped) {
    return
  }
  if (moqt.wt === null) {
    sendMessageToMain(WORKER_PREFIX, 'error', 'we can not start downloading streams because WT is not initialized')
    return
  }

  try {
    // NO await on purpose!
    moqReceiveStreamObjects(moqt)
    // NO await on purpose!
    moqReceiveDatagramObjects(moqt)  
  } catch(err) {
    if (MOQT_DEV_MODE) {throw err}
    sendMessageToMain(WORKER_PREFIX, 'dropped data', { clkms: Date.now(), seqId: -1, msg: `Dropped stream because WT error: ${err}` })
    sendMessageToMain(WORKER_PREFIX, 'error', `WT request. Err: ${JSON.stringify(err)}`)
  }
}

async function moqReceiveStreamObjects (moqt) {
  // Get stream
  const incomingStream = moqt.wt.incomingUnidirectionalStreams
  const wtReadableStream = incomingStream.getReader()

  while (workerState !== StateEnum.Stopped) {
    const stream = await wtReadableStream.read()

    if (!stream.done) {
      sendMessageToMain(WORKER_PREFIX, 'debug', 'New QUIC stream')

      const moqStreamsObjHeader = await moqParseObjectHeader(stream.value)
      if (moqStreamsObjHeader.type === MOQ_MESSAGE_STREAM_HEADER_SUBGROUP) {
        sendMessageToMain(WORKER_PREFIX, 'debug', `Received object header subgrp ${JSON.stringify(moqStreamsObjHeader)}`)
        // NO await on purpose!
        moqReceiveMultiObjectStream(stream.value)
      } else {
        sendMessageToMain(WORKER_PREFIX, 'error', `Unsupported stream type for sterams ${moqStreamsObjHeader.type}`)
      }
    }
  }
  sendMessageToMain(WORKER_PREFIX, 'info', `Exited receive objects loop`)
}

async function moqReceiveMultiObjectStream(readerStream) {
  let isEOF = false
  let moqHeader = {} 
  while (workerState !== StateEnum.Stopped && isEOF === false) {
    reportStats()
    try {
      moqHeader = await moqParseObjectFromSubgroupHeader(readerStream)
      
      sendMessageToMain(WORKER_PREFIX, 'debug', `Received subgrp object header ${JSON.stringify(moqHeader)}`);

      // Check if we received the end of the subgroup
      isEOF = ("status" in moqHeader && (moqHeader.status == MOQ_OBJ_STATUS_END_OF_GROUP || moqHeader.status == MOQ_OBJ_STATUS_END_OF_TRACK_AND_GROUP || moqHeader.status == MOQ_OBJ_STATUS_END_OF_SUBGROUP))
      if (!isEOF && moqHeader.payloadLength > 0) {
        isEOF = await readAndSendPayload(readerStream, moqHeader.payloadLength)
      }
    } catch(err) {
      // We receive ERROR when we have a reader and the stream closes
      if (err instanceof WebTransportError && err.message.includes("The session is closed")) {
        isEOF = true
      } else {
        throw err
      }
    }
  }
  sendMessageToMain(WORKER_PREFIX, 'debug', 'Exited from subgroup reader loop')
}

async function moqReceiveDatagramObjects (moqt) {
  if (moqt.datagramsReader != null) {
    throw new Error('Unexpected already initialized datagramsReader')
  }

  // Get datagrams
  moqt.datagramsReader = moqt.wt.datagrams.readable.getReader();
  
  while (workerState !== StateEnum.Stopped) {
    const stream = await moqt.datagramsReader.read()

    if (!stream.done) {
      // Create a BYOT capable reader for the data by reading whole datagram      
      const readableStream = new ReadableStream({
        start(controller) {
          controller.enqueue(stream.value);
          controller.close();
        },
        type: "bytes",
      });
      reportStats()

      const moqObjHeader = await moqParseObjectHeader(readableStream)
      sendMessageToMain(WORKER_PREFIX, 'debug', `Received object datagram header ${JSON.stringify(moqObjHeader)}`)

      if (moqObjHeader.type != MOQ_MESSAGE_OBJECT_DATAGRAM) {
        throw new Error(`Received via datagram a non properly encoded object ${JSON.stringify(moqObjHeader)}`)
      }
      await readAndSendPayload(readableStream)
    }
  }

  sendMessageToMain(WORKER_PREFIX, 'debug', 'Exited from datagrams loop')
}

async function readAndSendPayload(readerStream, length) {
  const packet = new MIPackager()
  if (length != undefined) {
    await packet.ReadLengthBytes(readerStream, length)
  } else {
    await packet.ReadBytesToEOF(readerStream)
  }
  const isEOF = packet.IsEof();

  const chunkData = packet.GetData()
  if (chunkData.type === undefined) {
    throw new Error(`Corrupted headers, we can NOT parse the data, headers: ${packet.GetDataStr()}`)
  }
  sendMessageToMain(WORKER_PREFIX, 'debug', `Decoded MOQT-MI: ${packet.GetDataStr()})`)
  
  let chunk
  let appMediaType
  if (chunkData.type == MIPayloadTypeEnum.AudioOpusWCP || chunkData.type == MIPayloadTypeEnum.AudioAACMP4LCWCP) {
    appMediaType = "audiochunk"
    const timestamp = convertTimestamp(chunkData.pts, chunkData.timebase, systemAudioTimebase);
    const duration = convertTimestamp(chunkData.duration, chunkData.timebase, systemAudioTimebase);
    chunk = new EncodedAudioChunk({
      timestamp: timestamp,
      type: "key",
      data: chunkData.data,
      duration: duration
    })
  } else if (chunkData.type == MIPayloadTypeEnum.VideoH264AVCCWCP) {
    appMediaType = "videochunk"
    // Find NALU SliceIDR to specify if this is key or delta
    // We could infer if this is IDR from MOQT, identifying if this is start of group, but this method is less error prone
    const isIdr = ContainsNALUSliceIDR(chunkData.data, DEFAULT_AVCC_HEADER_LENGTH)
    const timestamp = convertTimestamp(chunkData.pts, chunkData.timebase, systemVideoTimebase);
    const duration = convertTimestamp(chunkData.duration, chunkData.timebase, systemVideoTimebase);
    chunk = new EncodedVideoChunk({
      timestamp: timestamp,
      type: isIdr ? "key": "delta",
      data: chunkData.data,
      duration: duration
    })
  } else if (chunkData.type == MIPayloadTypeEnum.RAWData) {
    appMediaType = "data"
    chunk = chunkData.data
  }

  self.postMessage({ type: appMediaType, clkms: Date.now(), packagerType: chunkData.type, captureClkms: chunkData.wallclock, seqId: chunkData.seqId, chunk, metadata: chunkData.metadata, sampleFreq: chunkData.sampleFreq , numChannels: chunkData.numChannels })

  return isEOF;
}

// MOQT

async function moqCreateSubscriberSession (moqt) {
  await moqSendSetup(moqt.controlWriter, MOQ_SETUP_PARAMETER_ROLE_SUBSCRIBER)
  const moqMsg = await moqParseMsg(moqt.controlReader)
  if (moqMsg.type !== MOQ_MESSAGE_SERVER_SETUP) {
    throw new Error(`Expected MOQ_MESSAGE_SERVER_SETUP, received ${moqMsg.type}`)
  }
  const setupResponse = moqMsg.data
  if (setupResponse.parameters.role !== MOQ_SETUP_PARAMETER_ROLE_PUBLISHER && setupResponse.parameters.role !== MOQ_SETUP_PARAMETER_ROLE_BOTH) {
    throw new Error(`role not supported. Supported ${MOQ_SETUP_PARAMETER_ROLE_PUBLISHER} or ${MOQ_SETUP_PARAMETER_ROLE_BOTH}, got from server ${JSON.stringify(setupResponse.parameters.role)}`)
  }
  sendMessageToMain(WORKER_PREFIX, 'info', `Received SETUP response: ${JSON.stringify(setupResponse)}`)

  // Send subscribe for tracks audio and video (loop until both done or error)
  let pending_subscribes = Object.entries(tracks)
  while (pending_subscribes.length > 0) {
    const [trackType, trackData] = pending_subscribes[0];
    await moqSendSubscribe(moqt.controlWriter, currentSubscribeId, currentTrackAlias, [trackData.namespace], trackData.name, trackData.authInfo)
    const moqMsg = await moqParseMsg(moqt.controlReader)
    if (moqMsg.type !== MOQ_MESSAGE_SUBSCRIBE_OK && moqMsg.type !== MOQ_MESSAGE_SUBSCRIBE_ERROR) {
      throw new Error(`Expected MOQ_MESSAGE_SUBSCRIBE_OK or MOQ_MESSAGE_SUBSCRIBE_ERROR, received ${moqMsg.type}`)
    }
    if (moqMsg.type === MOQ_MESSAGE_SUBSCRIBE_ERROR) {
      sendMessageToMain(WORKER_PREFIX, 'warning', `Received SUBSCRIBE_ERROR response for ${trackData.namespace}/${trackData.name} (type: ${trackType}): ${JSON.stringify(moqMsg.data)}. waiting for ${SLEEP_SUBSCRIBE_ERROR_MS}ms and Retrying!!`)

      await new Promise(r => setTimeout(r, SLEEP_SUBSCRIBE_ERROR_MS));
    } else {
      const subscribeResp = moqMsg.data    
      if (subscribeResp.subscribeId !== currentSubscribeId) {
        throw new Error(`Received subscribeId does NOT match with subscriptionId ${subscribeResp.subscribeId} != ${currentSubscribeId}`)
      }
      sendMessageToMain(WORKER_PREFIX, 'info', `Received SUBSCRIBE_OK for ${trackData.namespace}/${trackData.name}-(type: ${trackType}): ${JSON.stringify(subscribeResp)}`)
      trackData.subscribeId = currentSubscribeId++
      trackData.trackAlias = currentTrackAlias++

      pending_subscribes.shift()
    }
  }
  sendMessageToMain(WORKER_PREFIX, 'info', 'Finished subscription loop')
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

  for (const trackData of Object.values(tracks)) {
    if ('subscribeId' in trackData) {
      try {
        await moqSendUnSubscribe(moqt.controlWriter, trackData.subscribeId)
        sendMessageToMain(WORKER_PREFIX, 'info', `Sent UnSubscribe for ${trackData.subscribeId}`)
        const moqMsg = await moqParseMsg(moqt.controlReader)
        if (moqMsg.type !== MOQ_MESSAGE_SUBSCRIBE_DONE) {
          throw new Error(`Expected MOQ_MESSAGE_SUBSCRIBE_DONE received ${moqMsg.type}`)
        }
        const subscribeDone = moqMsg.data
        sendMessageToMain(WORKER_PREFIX, 'info', `Received SubscribeDone for subscibeId: ${subscribeDone.subscribeId}: ${JSON.stringify(subscribeDone)}`)
        if (subscribeDone.subscribeId != trackData.subscribeId) {
          throw new Error(`Expected MOQ_MESSAGE_SUBSCRIBE_DONE for subscribeId: ${trackData.subscribeId}, received: ${subscribeDone.subscribeId}`)
        }
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

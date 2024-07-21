/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

import { sendMessageToMain, StateEnum } from '../utils/utils.js'
import { moqCreate, moqClose, moqCreateControlStream, moqSendSetup, MOQ_PARAMETER_ROLE_PUBLISHER, MOQ_PARAMETER_ROLE_SUBSCRIBER, MOQ_PARAMETER_ROLE_BOTH, moqParseObjectHeader, moqSendSubscribe, moqSendUnSubscribe, MOQ_MESSAGE_SUBSCRIBE_DONE, moqParseMsg, MOQ_MESSAGE_SERVER_SETUP, MOQ_MESSAGE_SUBSCRIBE_OK, MOQ_MESSAGE_SUBSCRIBE_ERROR, MOQ_MESSAGE_OBJECT_STREAM, MOQ_MESSAGE_STREAM_HEADER_TRACK, MOQ_MESSAGE_OBJECT_DATAGRAM, MOQ_MESSAGE_STREAM_HEADER_GROUP, moqParseObjectFromTrackPerStreamHeader, moqParseObjectFromGroupPerStreamHeader} from '../utils/moqt.js'
import { LocPackager } from '../packager/loc_packager.js'
import { RawPackager } from '../packager/raw_packager.js'

const WORKER_PREFIX = '[MOQ-DOWNLOADER]'

// Show verbose exceptions
const MOQT_DEV_MODE = true

const SLEEP_SUBSCRIBE_ERROR_MS = 2000

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

      const moqObjHeader = await moqParseObjectHeader(stream.value)
      sendMessageToMain(WORKER_PREFIX, 'debug', `Received object header ${JSON.stringify(moqObjHeader)}`)

      const trackInfo = getTrackInfoFromTrackAlias(moqObjHeader.trackAlias, moqObjHeader.subscribeId)
      if (trackInfo === undefined) {
        throw new Error(`Unexpected trackAlias/subscriptionId ${moqObjHeader.trackAlias}/${moqObjHeader.subscribeId}. Expecting ${JSON.stringify(tracks)}`)
      }

      // Once stream per track started no other forward types will be read
      if (moqObjHeader.type === MOQ_MESSAGE_STREAM_HEADER_TRACK || moqObjHeader.type === MOQ_MESSAGE_STREAM_HEADER_GROUP) {
        // NO await on purpose!
        moqReceiveMultiObjectStream(moqObjHeader.type, stream.value, trackInfo.type)
      } else if (moqObjHeader.type === MOQ_MESSAGE_OBJECT_STREAM) {
        reportStats()

        await readAndSendPayload(stream.value, trackInfo.type)
      }
    }
  }
}

async function moqReceiveMultiObjectStream(multiObjectType, readerStream, mediaType) {
  let isEOF = false
  let moqHeader = {} 
  let multiObjectTypeStr = "unknown"
  while (workerState !== StateEnum.Stopped && isEOF === false) {
    reportStats()
    try {
      if (multiObjectType == MOQ_MESSAGE_STREAM_HEADER_GROUP) {
        multiObjectTypeStr = "StreamPerGroup"
        moqHeader = await moqParseObjectFromGroupPerStreamHeader(readerStream)
      } else if (multiObjectType == MOQ_MESSAGE_STREAM_HEADER_TRACK) {
        multiObjectTypeStr = "StreamPerTrack"
        moqHeader = await moqParseObjectFromTrackPerStreamHeader(readerStream)
      } else {
        throw new Error(`Not supported multiobject type ${multiObjectType}`);
      }
      sendMessageToMain(WORKER_PREFIX, 'debug', `Received ${multiObjectTypeStr} header ${JSON.stringify(moqHeader)}`)

      // TODO exit the loop on status End of group
      isEOF = await readAndSendPayload(readerStream, mediaType, moqHeader.payloadLength)
    } catch(err) {
      // Error we receive when I have a reader and the stream closes
      if (err instanceof WebTransportError && err.message.includes("The session is closed")) {
        isEOF = true
      } else {
        throw err
      }
    }
  }
  sendMessageToMain(WORKER_PREFIX, 'debug', `Exited from ${multiObjectTypeStr} reader loop`)
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
    sendMessageToMain(WORKER_PREFIX, 'debug', `Received object header ${JSON.stringify(moqObjHeader)}`)
   
    const trackInfo = getTrackInfoFromTrackAlias(moqObjHeader.trackAlias, moqObjHeader.subscribeId)
    if (trackInfo === undefined) {
      throw new Error(`Unexpected trackAlias/subscriptionId ${moqObjHeader.trackAlias}/${moqObjHeader.subscribeId}. Expecting ${JSON.stringify(tracks)}`)
    }

    if (moqObjHeader.type != MOQ_MESSAGE_OBJECT_DATAGRAM) {
      throw new Error(`Received via datagram a non properly encoded object ${JSON.stringify(moqObjHeader)}`)
    }
    await readAndSendPayload(readableStream, trackInfo.type)
    }
  }

  sendMessageToMain(WORKER_PREFIX, 'debug', 'Exited from datagrams loop')
}

async function readAndSendPayload(readerStream, mediaType, length) {
  let isEOF = false
  if (mediaType !== 'data') {
    const data = await readMediaPackager(readerStream, length)
    isEOF = data.isEOF
    self.postMessage({ type: data.chunkData.mediaType + 'chunk', clkms: Date.now(), captureClkms: data.chunkData.firstFrameClkms, seqId: data.chunkData.seqId, chunk: data.chunk, metadata: data.chunkData.metadata })
  } else {
    const packet = await readRAWPackager(readerStream, length)
    self.postMessage({ type: 'data', chunk: packet.GetData().data })
    isEOF = packet.IsEof()
  }
  return isEOF
} 

async function readMediaPackager(readerStream, length) {
  const packet = new LocPackager()
  if (length != undefined) {
    await packet.ReadLengthBytes(readerStream, length)
  } else {
    await packet.ReadBytesToEOF(readerStream)
  }
  
  const chunkData = packet.GetData()
  if ((chunkData.chunkType === undefined) || (chunkData.mediaType === undefined)) {
    throw new Error(`Corrupted headers, we can NOT parse the data, headers: ${packet.GetDataStr()}`)
  }
  sendMessageToMain(WORKER_PREFIX, 'debug', `Decoded MOQT-LOC: ${packet.GetDataStr()})`)
  
  let chunk
  if (chunkData.mediaType === 'audio') {
    chunk = new EncodedAudioChunk({
      timestamp: chunkData.timestamp,
      type: chunkData.chunkType,
      data: chunkData.data,
      duration: chunkData.duration
    })
  } else if (chunkData.mediaType === 'video') {
    chunk = new EncodedVideoChunk({
      timestamp: chunkData.timestamp,
      type: chunkData.chunkType,
      data: chunkData.data,
      duration: chunkData.duration
    })
  }

  return {chunkData, chunk, isEOF: packet.IsEof()}
}

async function readRAWPackager(readerStream, length) {
  const packet = new RawPackager()
  if (length != undefined) {
    await packet.ReadLengthBytes(readerStream, length)
  } else {
    await packet.ReadBytesToEOF(readerStream)
  }

  sendMessageToMain(WORKER_PREFIX, 'debug', `Decoded MOQT-RAW stream per obj: ${packet.GetDataStr()})`)

  return packet
}

// MOQT

async function moqCreateSubscriberSession (moqt) {
  await moqSendSetup(moqt.controlWriter, MOQ_PARAMETER_ROLE_SUBSCRIBER)
  const moqMsg = await moqParseMsg(moqt.controlReader)
  if (moqMsg.type !== MOQ_MESSAGE_SERVER_SETUP) {
    throw new Error(`Expected MOQ_MESSAGE_SERVER_SETUP, received ${moqMsg.type}`)
  }
  const setupResponse = moqMsg.data
  if (setupResponse.parameters.role !== MOQ_PARAMETER_ROLE_PUBLISHER && setupResponse.parameters.role !== MOQ_PARAMETER_ROLE_BOTH) {
    throw new Error(`role not supported. Supported ${MOQ_PARAMETER_ROLE_PUBLISHER} or ${MOQ_PARAMETER_ROLE_BOTH}, got from server ${JSON.stringify(setupResponse.parameters.role)}`)
  }
  sendMessageToMain(WORKER_PREFIX, 'info', `Received SETUP response: ${JSON.stringify(setupResponse)}`)

  // Send subscribe for tracks audio and video (loop until both done or error)
  let pending_subscribes = Object.entries(tracks)
  while (pending_subscribes.length > 0) {
    const [trackType, trackData] = pending_subscribes[0];
    await moqSendSubscribe(moqt.controlWriter, currentSubscribeId, currentTrackAlias, trackData.namespace, trackData.name, trackData.authInfo)
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
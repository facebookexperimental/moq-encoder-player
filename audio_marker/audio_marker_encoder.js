/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

const START_FREQ_HZ = 1000
const STEP_FREQ_HZ = 100
const STOP_FREQ_HZ = 18000
const SIN_AMPLITUDE = 0.75

export class AudioMarkerEncoder {
    constructor () {
        this.intToFreq = []
        for (let f = START_FREQ_HZ; f < STOP_FREQ_HZ; f = f + STEP_FREQ_HZ) {
            this.intToFreq.push(f)
        }
    }

    Encode (aFrame, data) {
        if (aFrame.format != "f32-planar") {
            throw new Error('Only f32-planar format supported')
        }        
        if (aFrame.numberOfChannels != 1) {
            throw new Error('Only one channel supported')
        }
        if (aFrame.duration < 10000) {
            throw new Error('We need at least 10ms audio frames')
        }
        if (aFrame.sampleRate < 40000) {
            throw new Error('We need at least 40KHz sample freq')
        }

        // numberOfFrames are samples in planar
        const freq = this.intToFreq[data % this.intToFreq.length]

        const newAFrameData = new Float32Array(aFrame.numberOfFrames)
        aFrame.copyTo(newAFrameData, {planeIndex: 0})
    
        this.addSin(newAFrameData, freq, SIN_AMPLITUDE, aFrame.sampleRate, aFrame.numberOfFrames)

        const options = {format: 'f32-planar', sampleRate: aFrame.sampleRate, numberOfFrames: aFrame.numberOfFrames, numberOfChannels: aFrame.numberOfChannels, timestamp: aFrame.timestamp, data: newAFrameData, transfer: [newAFrameData.buffer]}
        const newAFrame = new AudioData(options)
        aFrame.close()
        
        return newAFrame
    }

    addSin(original, freq, amplitude, sampleRate, numSamples) {
        for (let s = 0; s < numSamples; s++) {
            const sampleVal = original[s] + amplitude * Math.sin(2*Math.PI*freq*(s/sampleRate))
            if (sampleVal > 1.0) {
                original[s] = 1.0
            } else if (sampleVal < -1.0) {
                original[s] = -1.0
            } else {
                original[s] = sampleVal
            }
        }
    }
}

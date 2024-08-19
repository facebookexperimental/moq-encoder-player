/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

const DEFAULT_START_LINE = 0
const DEFAULT_NUM_LINES = 2
const DEFAULT_BITS_TO_READ = 64
const START_SEQ = "1010"

export class OverlayDecoder {
    constructor () {
        this.startLine = DEFAULT_START_LINE
        this.numLines = DEFAULT_NUM_LINES
        this.bitsToRead = DEFAULT_BITS_TO_READ
    }

    Decode (vFrame) {
        if (vFrame.format != "I420") {
            throw new Error('Only NV12 format supported')
        }
        if ((!('codedWidth' in vFrame)) || (!('codedHeight' in vFrame))) {
            throw new Error('Bad frame format NV12 format supported')
        }
        if (vFrame.codedWidth < this.bitsToRead) {
            throw new Error(`Image is to small to decode ${this.bitsToRead} bits, we need at lease ${this.bitsToRead} width`)
        }
        if (vFrame.codedHeight < this.numLines) {
            throw new Error(`Image is to small, we need at list ${ this.numLines} height`)
        }

        const mewFramepixelsData = new Uint8Array(parseInt((vFrame.codedWidth * vFrame.codedHeight) * (1 + 1/2 + 1/2)))
    
        const copyOptions = {layout: [{offset: 0, stride: vFrame.codedWidth}, {offset: vFrame.codedHeight * vFrame.codedWidth, stride: vFrame.codedWidth / 2}, {offset: vFrame.codedHeight * vFrame.codedWidth + vFrame.codedHeight * vFrame.codedWidth / 2, stride: vFrame.codedWidth / 2}]}
        vFrame.copyTo(mewFramepixelsData, copyOptions)

        // Y is stored at start for I420
        const pixelsPerBit = vFrame.displayWidth / this.bitsToRead
        let bin_str = ""

        for (let b = 0; b < this.bitsToRead; b++) {
            let totalVal = 0
            const baseOffset = Math.floor(b * pixelsPerBit)
            for (let x = 0; x < pixelsPerBit; x++) {
                for (let y = this.startLine; y < this.numLines; y++) {
                    totalVal += mewFramepixelsData[y * vFrame.codedWidth + baseOffset + x]
                }
            }
            let val = totalVal / (pixelsPerBit * this.numLines)
            if (val >= 128) {
                bin_str += '1'
            } else {
                bin_str += '0'
            }
        }

        let ret_conf = 0
        if (bin_str.length >= START_SEQ.length && bin_str.substring(0,START_SEQ.length) == START_SEQ) {
            ret_conf = 1
            bin_str = bin_str.substring(START_SEQ.length).padStart(this.bitsToRead, '0')
        }

        return { val: BigInt('0b' + bin_str), confidence: ret_conf}
    }
}

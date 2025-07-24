if (!self.MediaStreamTrackProcessor) {
  console.warn("Non standard MediaStreamTrackProcessor loaded!!!")
  self.MediaStreamTrackProcessor = class MediaStreamTrackProcessor {
    constructor(track) {
      if (track.kind == "video") {
        this.readable = new ReadableStream({
          // eslint-disable-next-line no-unused-vars
          async start(controller) {
            this.video = document.createElement("video");
            this.video.srcObject = new MediaStream([track]);
            await Promise.all([this.video.play(), new Promise(r => this.video.onloadedmetadata = r)]);
            this.track = track;
            this.canvas = new OffscreenCanvas(this.video.videoWidth, this.video.videoHeight);
            this.ctx = this.canvas.getContext('2d', {desynchronized: true});
            this.t1 = performance.now();
          },
          async pull(controller) {
            while (performance.now() - this.t1 < 1000 / track.getSettings().frameRate) {
              await new Promise(r => requestAnimationFrame(r));
            }
            this.t1 = performance.now();
            this.ctx.drawImage(this.video, 0, 0);
            controller.enqueue(new VideoFrame(this.canvas, {timestamp: this.t1}));
          }
        });
      } else if (track.kind == "audio") {
          this.readable = new ReadableStream({
          // eslint-disable-next-line no-unused-vars
          async start(controller) {
            this.ac = new AudioContext;
            this.arrays = [];
            function worklet() {
              registerProcessor("mstp-shim", class Processor extends AudioWorkletProcessor {
                  process(input) { this.port.postMessage(input); return true; }
              });
            }
            await this.ac.audioWorklet.addModule(`data:text/javascript,(${worklet.toString()})()`);
            this.node = new AudioWorkletNode(this.ac, "mstp-shim");
            this.ac.createMediaStreamSource(new MediaStream([track])).connect(this.node);
            this.node.port.addEventListener("message", ({data}) => data[0][0] && this.arrays.push(data));
          },
          async pull(controller) {
            while (!this.arrays.length) await new Promise(r => this.node.port.onmessage = r);
            const [channels] = this.arrays.shift();
            const joined = new Float32Array(channels.reduce((a, b) => a + b.length, 0));
            channels.reduce((offset, a) => (joined.set(a, offset), offset + a.length), 0);
            controller.enqueue(new AudioData({
              format: "f32-planar",
              sampleRate: this.ac.sampleRate,
              numberOfFrames: channels[0].length,
              numberOfChannels: channels.length,
              timestamp: this.ac.currentTime * 1e6 | 0,
              data: joined,
              transfer: [joined.buffer]
            }));
          }
        });
      }
    }
  };
}

/**
 * AudioWorklet：把麦克风输入按块搬到主线程。
 *
 * 放在 public/ 下用 ctx.audioWorklet.addModule('/wave-worklet.js') 加载。
 * worklet 运行在独立的音频线程，必须是一个独立的 JS 文件，不能被打进 bundle。
 *
 * 关键：绝不能把输入写进 outputs，否则麦克风收到的声音会立刻从扬声器放出来，
 * 直接啸叫。这里 outputs 保持静音。
 */
class WaveCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.batch = new Float32Array(2048)
    this.count = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true

    for (let i = 0; i < channel.length; i++) {
      this.batch[this.count++] = channel[i]
      if (this.count === this.batch.length) {
        // slice() 复制一份再发，否则主线程可能读到被后续音频覆盖的缓冲
        this.port.postMessage(this.batch.slice(0))
        this.count = 0
      }
    }
    return true
  }
}

registerProcessor('wave-capture', WaveCaptureProcessor)

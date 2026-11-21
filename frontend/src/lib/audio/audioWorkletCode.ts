// AudioWorklet processor code for high-performance, glitch-free audio processing off the main UI thread.

export const audioWorkletCode = `
// 1. Playback Processor: Queues incoming PCM audio chunks and plays them back smoothly
class StreamingPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.streamEnded = false;

    this.port.onmessage = (event) => {
      if (event.data === null || event.data === 'end') {
        this.streamEnded = true;
      } else if (event.data === 'clear') {
        this.chunks = [];
        this.streamEnded = false;
      } else if (event.data instanceof Float32Array) {
        this.chunks.push(event.data);
      }
    };
  }

  process(inputs, outputs) {
    const outputChannel = outputs[0]?.[0];
    if (!outputChannel) return true;

    const bufferSize = outputChannel.length;
    let samplesProcessed = 0;

    while (samplesProcessed < bufferSize && this.chunks.length > 0) {
      const chunk = this.chunks[0];
      const remainingInChunk = chunk.length;
      const toProcess = Math.min(bufferSize - samplesProcessed, remainingInChunk);

      outputChannel.set(chunk.subarray(0, toProcess), samplesProcessed);
      samplesProcessed += toProcess;

      if (toProcess < remainingInChunk) {
        this.chunks[0] = chunk.subarray(toProcess);
      } else {
        this.chunks.shift();
      }
    }

    if (samplesProcessed < bufferSize) {
      outputChannel.fill(0, samplesProcessed);
    }

    if (this.streamEnded && this.chunks.length === 0) {
      this.port.postMessage('playback-finished');
      this.streamEnded = false;
    }

    return true;
  }
}

// 2. Recording Processor: Captures microphone Float32 PCM, downsamples/converts to Int16 PCM, and posts to main thread
class PcmRecordingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 2048;
    this.buffer = new Float32Array(this.bufferSize);
    this.bytesWritten = 0;
  }

  process(inputs) {
    const inputChannel = inputs[0]?.[0];
    if (!inputChannel) return true;

    for (let i = 0; i < inputChannel.length; i++) {
      this.buffer[this.bytesWritten++] = inputChannel[i];

      if (this.bytesWritten >= this.bufferSize) {
        // Convert Float32 to 16-bit PCM Int16Array
        const pcm16 = new Int16Array(this.bufferSize);
        for (let j = 0; j < this.bufferSize; j++) {
          const s = Math.max(-1, Math.min(1, this.buffer[j]));
          pcm16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Post raw PCM buffer to main thread
        this.port.postMessage(pcm16.buffer, [pcm16.buffer]);

        this.buffer = new Float32Array(this.bufferSize);
        this.bytesWritten = 0;
      }
    }

    return true;
  }
}

registerProcessor('streaming-playback-processor', StreamingPlaybackProcessor);
registerProcessor('pcm-recording-processor', PcmRecordingProcessor);
`;

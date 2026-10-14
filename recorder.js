/** Record locally, convert to a compact mono WAV, then let the user choose to submit. */
export function encodeWav(samples, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => {
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, value < 0 ? value * 32768 : value * 32767, true);
  });
  return buffer;
}

export class VoiceRecorder {
  async start(onTick, onAutoStop) {
    if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
      throw new Error('Recording needs microphone support and a secure HTTPS connection. Try a recent browser.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
      this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
      this.chunks = [];
      this.recorder.ondataavailable = event => { if (event.data.size) this.chunks.push(event.data); };
      this.recorder.start(1000);
      this.started = performance.now();
      onTick(0);
      this.timer = setInterval(() => {
        const elapsed = Math.min(120, (performance.now() - this.started) / 1000);
        onTick(elapsed);
        if (elapsed >= 120) { clearInterval(this.timer); onAutoStop(); }
      }, 250);
    } catch (error) { this.release(); throw error; }
  }

  release() {
    clearInterval(this.timer);
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
  }

  async stop() {
    if (!this.recorder || this.recorder.state === 'inactive') throw new Error('There is no active recording.');
    const durationSeconds = Math.min(120, (performance.now() - this.started) / 1000);
    const recorder = this.recorder;
    await new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = () => reject(new Error('The recording could not be completed. Please try again.'));
      recorder.stop();
    }).finally(() => this.release());
    const original = new Blob(this.chunks, { type: recorder.mimeType });
    this.chunks = [];
    if (!original.size || durationSeconds < 1) throw new Error('Record at least a few seconds before submitting.');
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContext) throw new Error('This browser cannot prepare your audio. Please try a recent browser.');
    const context = new AudioContext({ sampleRate: 16000 });
    try {
      const decoded = await context.decodeAudioData(await original.arrayBuffer());
      const length = Math.min(Math.round(decoded.duration * 16000), 120 * 16000);
      const samples = new Float32Array(length);
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
      for (let i = 0; i < length; i++) {
        const index = Math.min(decoded.length - 1, Math.floor(i * decoded.sampleRate / 16000));
        samples[i] = channels.reduce((sum, channel) => sum + channel[index], 0) / channels.length;
      }
      const blob = new Blob([encodeWav(samples)], { type: 'audio/wav' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return { blob, base64: btoa(binary), durationSeconds, url: URL.createObjectURL(blob) };
    } finally { await context.close(); }
  }

  cancel() {
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.release();
    this.chunks = [];
  }
}

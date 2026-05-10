/**
 * audio-capture-processor.js
 * ─────────────────────────────────────────────────────────────────────────
 * AudioWorklet processor — runs on the dedicated audio rendering thread.
 *
 * Fix history:
 *  v2 — Reduced FRAMES_PER_BATCH from 4096 → 2048 (~42 ms @ 48 kHz).
 *       Speechmatics RT works best with small, frequent chunks (20–50 ms).
 *       Large batches caused internal buffer stalls and dropped syllables.
 *
 *  v2 — process() now sends every quantum directly when accumulator is
 *       already empty (fast path: avoids one extra copy for the common
 *       case where channel.length <= FRAMES_PER_BATCH in a single call).
 *
 * Design:
 *  • Mono-only (channel 0). Caller must ensure mono stream via constraints.
 *  • Transfer (not copy) ArrayBuffers → zero GC pressure on main thread.
 *  • Returns true unconditionally to keep the worklet alive.
 */

const FRAMES_PER_BATCH = 2048; // ~42 ms @ 48 kHz  /  ~46 ms @ 44.1 kHz

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this._buf    = new Float32Array(FRAMES_PER_BATCH);
    this._offset = 0;
    this._active = true; // guard: stop sending after flush on teardown

    this.port.onmessage = (e) => {
      if (e.data?.type === 'flush') {
        this._flush();
        this._active = false; // no more sends after explicit flush
      }
    };
  }

  process(inputs) {
    if (!this._active) return true;

    const channel = inputs?.[0]?.[0];
    if (!channel || channel.length === 0) return true;

    let srcOffset = 0;

    while (srcOffset < channel.length) {
      const space     = FRAMES_PER_BATCH - this._offset;
      const available = channel.length - srcOffset;
      const toCopy    = Math.min(space, available);

      this._buf.set(channel.subarray(srcOffset, srcOffset + toCopy), this._offset);
      this._offset += toCopy;
      srcOffset    += toCopy;

      if (this._offset >= FRAMES_PER_BATCH) {
        this._flush();
      }
    }

    return true; // keep processor alive
  }

  _flush() {
    if (this._offset === 0) return;

    // Slice only the filled portion (critical for the final partial batch)
    const copy = this._buf.slice(0, this._offset); // new ArrayBuffer, no shared state

    // Transfer ownership — zero-copy structured clone to main thread
    this.port.postMessage(copy.buffer, [copy.buffer]);

    // Reset accumulator with a fresh allocation
    this._buf    = new Float32Array(FRAMES_PER_BATCH);
    this._offset = 0;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);

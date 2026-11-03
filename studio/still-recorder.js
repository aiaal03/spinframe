(() => {
  "use strict";
  const unsupported = "Браузер не смог записать HEVC. Открой сайт в обновлённом Safari на iPhone.";
  const invalid = () => new Error("Не удалось прочитать видеокадр, записанный браузером.");
  const abortError = () => new DOMException("Отменено", "AbortError");

  // Read the sample description and the first independently decodable picture
  // in the video-only recording just made by this browser.
  function firstPicture(buffer) {
    const bytes = new Uint8Array(buffer), view = new DataView(buffer);
    function children(start, end) {
      const result = [];
      for (let p = start; p < end;) {
        if (end - p < 8 || result.length > 4096) throw invalid();
        let size = view.getUint32(p), header = 8;
        if (size === 1) {
          if (end - p < 16 || view.getUint32(p + 8) !== 0) throw invalid();
          size = view.getUint32(p + 12); header = 16;
        } else if (size === 0) size = end - p;
        if (size < header || p + size > end) throw invalid();
        result.push({type:String.fromCharCode(...bytes.subarray(p + 4, p + 8)), start:p + header, end:p + size});
        p += size;
      }
      return result;
    }
    const tops = children(0, bytes.length);
    let boxes = tops;
    for (const type of ["moov", "trak", "mdia", "minf", "stbl", "stsd"]) {
      const box = boxes.find(b => b.type === type);
      if (!box) throw invalid();
      boxes = children(box.start + (type === "stsd" ? 8 : 0), box.end);
    }
    const entry = boxes.find(b => b.type === "hvc1" || b.type === "hev1");
    if (!entry || entry.end - entry.start < 78 ||
        view.getUint16(entry.start + 24) !== 1376 || view.getUint16(entry.start + 26) !== 1840) throw invalid();
    const config = children(entry.start + 78, entry.end);
    const record = config.find(b => b.type === "hvcC");
    const mdat = tops.find(b => b.type === "mdat" && b.end > b.start);
    if (!record || record.end - record.start < 23 || !mdat) throw invalid();
    const description = bytes.subarray(record.start, record.end);
    const prefix = (description[21] & 3) + 1;
    let first, last;
    for (let p = mdat.start; p < mdat.end;) {
      if (p + prefix > mdat.end) throw invalid();
      let size = 0;
      for (let n = 0; n < prefix; n++) size = size * 256 + bytes[p + n];
      const nalu = p + prefix, end = nalu + size;
      if (size < 3 || end > mdat.end) throw invalid();
      const type = (bytes[nalu] >> 1) & 63;
      if (type <= 31) {
        const beginsPicture = !!(bytes[nalu + 2] & 128);
        if (first !== undefined && beginsPicture) break;
        if (first === undefined) {
          if (!beginsPicture || type < 16 || type > 21) throw invalid();
          first = p;
        }
        last = end;
      } else if (first !== undefined && [32, 33, 34, 35, 39].includes(type)) break;
      p = end;
    }
    if (first === undefined || last - first > 512 * 1024) throw invalid();
    const color = config.find(b => b.type === "colr");
    let colorSpace;
    if (color && color.end - color.start >= 10) {
      const i = color.start, scheme = String.fromCharCode(...bytes.subarray(i, i + 4));
      if (scheme === "nclc" || scheme === "nclx") {
        colorSpace = {
          primaries: ({1:"bt709", 9:"bt2020", 12:"smpte432"})[view.getUint16(i + 4)],
          transfer: ({1:"bt709", 13:"iec61966-2-1", 16:"pq", 18:"hlg"})[view.getUint16(i + 6)],
          // The recorder can label limited HEVC as full in its MP4 colr.
          // Keep the characteristics and let the decoder use the HEVC range.
          matrix: ({0:"rgb", 1:"bt709", 6:"smpte170m", 9:"bt2020-ncl"})[view.getUint16(i + 8)]
        };
      }
    }
    return {data:bytes.subarray(first, last), description, colorSpace};
  }

  function record(canvas, stream, mimeType, signal) {
    const recorder = new MediaRecorder(stream, {mimeType, videoBitsPerSecond:3500000});
    return new Promise((resolve, reject) => {
      const parts = [], track = stream.getVideoTracks()[0];
      let redraw, stop, timeout, size = 0, done = false;
      function finish(error) {
        if (done) return;
        done = true;
        clearInterval(redraw); clearTimeout(stop); clearTimeout(timeout);
        signal?.removeEventListener("abort", cancel);
        if (recorder.state !== "inactive") recorder.stop();
        if (error) reject(error);
        else resolve(new Blob(parts));
      }
      const cancel = () => finish(abortError());
      signal?.addEventListener("abort", cancel, {once:true});
      if (signal?.aborted) return cancel();
      recorder.ondataavailable = e => {
        size += e.data.size;
        if (size > 8 * 1024 * 1024) finish(invalid());
        else parts.push(e.data);
      };
      recorder.onerror = () => finish(new Error(unsupported));
      recorder.onstop = () => finish();
      const ctx = canvas.getContext("2d");
      try {
        recorder.start();
        // A repeated draw wakes captureStream even when the scene is static.
        const pixel = ctx.getImageData(0, 0, 1, 1);
        redraw = setInterval(() => { ctx.putImageData(pixel, 0, 0); track.requestFrame?.(); }, 50);
        stop = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 850);
        timeout = setTimeout(() => finish(new Error(unsupported)), 5000);
      } catch (err) { finish(err); }
    });
  }

  async function encode(canvas, {signal, onProgress} = {}) {
    if (signal?.aborted) throw abortError();
    if (!window.MediaRecorder || !canvas.captureStream) throw new Error(unsupported);
    const codecs = ["hvc1.1.6.L150.B0", "hvc1.1.6.L123.B0", "hvc1"];
    const formats = codecs.map(c => "video/mp4;codecs=" + c).filter(t => MediaRecorder.isTypeSupported(t));
    for (const type of formats) {
      const stream = canvas.captureStream(30);
      try {
        onProgress?.(0.1);
        const clip = await record(canvas, stream, type, signal);
        const {data, description, colorSpace} = firstPicture(await clip.arrayBuffer());
        if (signal?.aborted) throw abortError();
        onProgress?.(0.8);
        const samples = Array.from({length:120}, (_, n) => ({data, timestamp:Math.round(n * 1e6 / 30), type:"key"}));
        return SpinMOV.mux(samples, description, colorSpace);
      } catch {
        if (signal?.aborted) throw abortError();
      } finally {
        stream.getTracks().forEach(track => track.stop());
      }
    }
    throw new Error(unsupported);
  }
  Object.defineProperty(window, "SpinRecorder", {value:Object.freeze({encode})});
})();

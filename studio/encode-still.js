(() => {
  "use strict";

  const WIDTH = 1376, HEIGHT = 1840, FPS = 30, FRAMES = 120;
  const time = index => Math.round(index * 1e6 / FPS);
  const hlgColor = { primaries: "bt2020", transfer: "hlg", matrix: "bt2020-ncl", fullRange: false };
  const unsupported = "Этот браузер не смог закодировать фото в HEVC. Для проверки можно скачать готовый пример MOV.";

  function checkAbort(signal) {
    if (signal?.aborted) throw new DOMException("Экспорт отменён.", "AbortError");
  }

  async function hlgFrame(ctx, signal) {
    // Convert the sRGB canvas to BT.2100 HLG once. Diffuse SDR white maps to
    // 203 cd/m² on a 1000 cd/m² reference display (75% HLG).
    const rgba = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
    const linear = Float64Array.from({ length: 256 }, (_, n) => {
      const v = n / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    const encodeHlg = x => x <= 1 / 12 ? Math.sqrt(3 * x) : 0.17883277 * Math.log(12 * x - 0.28466892) + 0.55991073;
    const white = 0.203 ** (1 / 1.2);
    const size = WIDTH * HEIGHT;
    const planes = new Uint8Array(size * 1.5);
    let chroma = 0;
    for (let y = 0; y < HEIGHT; y += 2) {
      if (y % 128 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
        checkAbort(signal);
      }
      for (let x = 0; x < WIDTH; x += 2) {
        let cb = 0, cr = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const pos = (y + dy) * WIDTH + x + dx;
            const r = linear[rgba[pos * 4]], g = linear[rgba[pos * 4 + 1]], b = linear[rgba[pos * 4 + 2]];
            const lum = 0.212639 * r + 0.715169 * g + 0.072192 * b;
            const gain = lum > 0 ? white * lum ** (1 / 1.2 - 1) : 0;
            const red = encodeHlg(gain * (0.627404 * r + 0.329283 * g + 0.043313 * b));
            const green = encodeHlg(gain * (0.069097 * r + 0.919540 * g + 0.011363 * b));
            const blue = encodeHlg(gain * (0.016391 * r + 0.088013 * g + 0.895596 * b));
            const luma = 0.2627 * red + 0.6780 * green + 0.0593 * blue;
            planes[pos] = Math.round(16 + 219 * luma);
            cb += (blue - luma) / (2 * (1 - 0.0593));
            cr += (red - luma) / (2 * (1 - 0.2627));
          }
        }
        planes[size + chroma] = Math.round(128 + 224 * cb / 4);
        planes[size + size / 4 + chroma++] = Math.round(128 + 224 * cr / 4);
      }
    }
    return new VideoFrame(planes, { format: "I420", codedWidth: WIDTH, codedHeight: HEIGHT,
      timestamp: 0, colorSpace: hlgColor, transfer: [planes.buffer] });
  }

  async function encodeFrames(frame, config, hlg, signal, progress) {
    const chunks = [];
    let description, color, failure, total = 0;
    const encoder = new VideoEncoder({
      output(chunk, meta) {
        if (failure) return;
        const info = meta?.decoderConfig;
        if (info) {
          if (info.description) description = new Uint8Array(info.description);
          color = info.colorSpace;
        }
        if (hlg && Object.keys(hlgColor).some(key => color?.[key] !== hlgColor[key])) {
          failure = new Error("Кодек не сохранил цвет HLG.");
          return;
        }
        total += chunk.byteLength;
        if (chunks.length >= FRAMES || total > 24 * 1024 * 1024) {
          failure = new Error("Размер видео превышает допустимый.");
          return;
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push({ data, timestamp: chunk.timestamp, type: chunk.type });
      },
      error(error) { failure = error; }
    });
    const close = () => { if (encoder.state !== "closed") encoder.close(); };
    signal?.addEventListener("abort", close, { once: true });
    const timer = setTimeout(close, 20000);
    try {
      checkAbort(signal);
      encoder.configure(config);
      for (let i = 0; i < FRAMES; i++) {
        const sample = new VideoFrame(frame, { timestamp: time(i), duration: time(i + 1) - time(i) });
        try { encoder.encode(sample, { keyFrame: i === 0 }); }
        finally { sample.close(); }
        // Drain in small batches to bound the number of live pixel buffers.
        if ((i + 1) % 6 === 0) {
          await encoder.flush();
          checkAbort(signal);
          if (failure) throw failure;
          progress((i + 1) / FRAMES * 0.97);
        }
      }
      if (!description?.length || chunks.length !== FRAMES) throw new Error("Неполная запись HEVC.");
      // The HEVC stream signals its own range. In particular WebKit can report
      // full-range sRGB here while the encoded video actually uses 16–235.
      const colorimetry = color && { primaries: color.primaries, transfer: color.transfer, matrix: color.matrix };
      return window.SpinMOV.mux(chunks, description, colorimetry);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", close);
      close();
    }
  }

  async function encode(source, { fit = "contain", focus = 0.5, signal, onProgress } = {}) {
    checkAbort(signal);
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    let lastProgress = 0;
    const progress = value => {
      if (value > lastProgress) { lastProgress = value; onProgress?.(value); }
    };
    try {
      const ctx = canvas.getContext("2d", { alpha: false, colorSpace: "srgb" });
      if (!ctx) throw new Error("Браузеру не хватило памяти для фото.");
      window.SpinJPEG.draw(ctx, source, WIDTH, HEIGHT, { fit, focus });
      if (typeof VideoEncoder === "function" && typeof VideoFrame === "function") {
        for (const hardwareAcceleration of ["prefer-hardware", "no-preference"]) {
          const config = { codec: "hvc1.1.6.L150.B0", width: WIDTH, height: HEIGHT,
            bitrate: 8000000, framerate: FPS, latencyMode: "realtime", hardwareAcceleration, hevc: { format: "hevc" } };
          const support = await VideoEncoder.isConfigSupported(config).catch(() => null);
          checkAbort(signal);
          if (!support?.supported) continue;
          for (const hlg of [true, false]) {
            let frame;
            try {
              frame = hlg ? await hlgFrame(ctx, signal) : new VideoFrame(canvas, { timestamp: 0 });
              const mov = await encodeFrames(frame, config, hlg, signal, progress);
              progress(1);
              return mov;
            } catch { checkAbort(signal); }
            finally { frame?.close(); }
          }
        }
      }
      if (window.SpinRecorder) {
        try {
          const mov = await window.SpinRecorder.encode(canvas, { signal, onProgress: progress });
          progress(1);
          return mov;
        } catch { checkAbort(signal); }
      }
      throw new Error(unsupported);
    } finally {
      canvas.width = canvas.height = 1;
    }
  }

  Object.defineProperty(window, "SpinStill", { value: Object.freeze({ encode }) });
})();

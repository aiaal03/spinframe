(() => {
  "use strict";

  const WIDTH = 3024;
  const HEIGHT = 4032;

  function dimensions(source) {
    let width, height;
    if (source instanceof HTMLImageElement) {
      width = source.naturalWidth;
      height = source.naturalHeight;
    } else if (source instanceof HTMLCanvasElement ||
               (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) ||
               (typeof OffscreenCanvas !== "undefined" && source instanceof OffscreenCanvas)) {
      ({ width, height } = source);
    } else {
      throw new TypeError("Сначала откройте изображение.");
    }
    if (!width || !height || Math.max(width, height) > 32768 || width * height > 64000000) {
      throw new RangeError("Поддерживаются изображения до 64 Мп и до 32 768 пикселей по стороне.");
    }
    return { width, height };
  }

  function draw(ctx, source, width, height, { fit = "contain", focus = 0.5 } = {}) {
    const input = dimensions(source);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
        Math.max(width, height) > 32768 || width * height > 64000000) {
      throw new RangeError("Недопустимый размер кадра.");
    }
    if ((fit !== "contain" && fit !== "cover") || !Number.isFinite(focus)) {
      throw new TypeError("Проверьте режим кадрирования.");
    }
    focus = Math.max(0, Math.min(1, focus));
    const scale = (fit === "cover" ? Math.max : Math.min)(width / input.width, height / input.height);
    const dw = scale * input.width, dh = scale * input.height;
    ctx.save();
    try {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.fillStyle = "#29272a";
      ctx.fillRect(0, 0, width, height);
      if (fit === "cover") {
        const sw = width / scale, sh = height / scale;
        ctx.drawImage(source, (input.width - sw) * focus, (input.height - sh) * focus,
                      sw, sh, 0, 0, width, height);
        return;
      }
      if (width - dw > 0.5 || height - dh > 0.5) {
        // Upscaling just a few sampled colours creates a soft matte without
        // allocating another full-resolution canvas or relying on canvas filters.
        const matte = document.createElement("canvas");
        matte.width = 6;
        matte.height = 8;
        const brush = matte.getContext("2d");
        if (brush) {
          brush.drawImage(source, 0, 0, 6, 8);
          ctx.globalAlpha = 0.37;
          ctx.drawImage(matte, 0, 0, width, height);
          ctx.globalAlpha = 1;
        }
      }
      ctx.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh);
    } finally {
      ctx.restore();
    }
  }

  function profileSegment() {
    const ascii = new TextEncoder();
    const strings = ["Meta AI", "Ray-Ban Meta Smart Glasses 2", "Spinframe"].map(s => ascii.encode(s + "\0"));
    const dirSize = n => 2 + n * 12 + 4;
    const main = 8, exif = main + dirSize(5);
    let next = exif + dirSize(3);
    const offsets = strings.map(bytes => {
      const start = next;
      next += bytes.length + bytes.length % 2;
      return start;
    });
    const tiffStart = 10; // FF E1, length, "Exif\0\0", then TIFF-relative offsets
    const bytes = new Uint8Array(tiffStart + next);
    bytes.set([0xff, 0xe1, 0, 0, 0x45, 0x78, 0x69, 0x66, 0, 0]);
    new DataView(bytes.buffer).setUint16(2, bytes.length - 2);
    const tiff = new DataView(bytes.buffer, tiffStart);
    tiff.setUint16(0, 0x4949);
    tiff.setUint16(2, 42, true);
    tiff.setUint32(4, main, true);
    tiff.setUint16(main, 5, true);
    tiff.setUint16(exif, 3, true);
    function entry(directory, index, tag, type, count, value) {
      const pos = directory + 2 + index * 12;
      tiff.setUint16(pos, tag, true);
      tiff.setUint16(pos + 2, type, true);
      tiff.setUint32(pos + 4, count, true);
      if (type === 3) tiff.setUint16(pos + 8, value, true);
      else tiff.setUint32(pos + 8, value, true);
    }
    entry(main, 0, 0x010f, 2, strings[0].length, offsets[0]); // Make
    entry(main, 1, 0x0110, 2, strings[1].length, offsets[1]); // Model
    entry(main, 2, 0x0112, 3, 1, 1);                        // Orientation
    entry(main, 3, 0x0131, 2, strings[2].length, offsets[2]); // Software
    entry(main, 4, 0x8769, 4, 1, exif);
    entry(exif, 0, 0xa001, 3, 1, 1);                         // sRGB
    entry(exif, 1, 0xa002, 4, 1, WIDTH);
    entry(exif, 2, 0xa003, 4, 1, HEIGHT);
    strings.forEach((value, i) => bytes.set(value, tiffStart + offsets[i]));
    return bytes;
  }

  async function addProfile(jpeg) {
    // Only the browser's freshly encoded JPEG reaches here. Replace leading
    // APP1 records while preserving JFIF/ICC and the compressed pixels.
    const head = new DataView(await jpeg.slice(0, 256 * 1024).arrayBuffer());
    if (head.byteLength < 4 || head.getUint16(0) !== 0xffd8) {
      throw new Error("Браузер не смог создать JPEG.");
    }
    const parts = [jpeg.slice(0, 2)];
    let pos = 2;
    while (pos + 4 <= head.byteLength) {
      const marker = head.getUint16(pos);
      if (marker < 0xffe0 || marker > 0xffef) break;
      const length = head.getUint16(pos + 2);
      const end = pos + 2 + length;
      if (length < 2 || end + 2 > head.byteLength) throw new Error("Неожиданная структура JPEG.");
      if (marker !== 0xffe1) parts.push(jpeg.slice(pos, end));
      pos = end;
    }
    parts.push(profileSegment(), jpeg.slice(pos));
    return new Blob(parts, { type: "image/jpeg" });
  }

  async function encode(source, options = {}) {
    dimensions(source);
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    try {
      const ctx = canvas.getContext("2d", { alpha: false, colorSpace: "srgb" });
      if (!ctx) throw new Error("Недостаточно памяти для экспорта. Закройте лишние вкладки.");
      draw(ctx, source, WIDTH, HEIGHT, options);
      const jpeg = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.94));
      if (!jpeg || jpeg.type !== "image/jpeg") throw new Error("Не удалось экспортировать JPEG.");
      return await addProfile(jpeg);
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
  }

  Object.defineProperty(window, "SpinJPEG", { value: Object.freeze({ draw, encode }) });
})();

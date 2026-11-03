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

  function profileSegment(profile) {
    const ascii = new TextEncoder();
    const string = value => ascii.encode(value + "\0");
    const gen1 = profile === "gen1";
    const model = gen1 ? "Ray-Ban Meta Smart Glasses" : "Ray-Ban Meta Smart Glasses 2";
    const mainFields = [
      [0x010f, 2, string("Meta AI")], [0x0110, 2, string(model)],
      [0x0112, 3, 1], [0x0131, 2, string("Spinframe")]
    ];
    const exifFields = [];
    if (gen1) {
      // These timestamps describe this exported copy, and the UUID is unique to it.
      const now = new Date();
      const pad = n => String(n).padStart(2, "0");
      const date = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join(":");
      const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(pad).join(":");
      const timestamp = string(date + " " + time);
      mainFields.push([0x0132, 2, timestamp]);
      exifFields.push(
        [0x9000, 7, ascii.encode("0220")],                  // ExifVersion
        [0x9003, 2, timestamp], [0x9004, 2, timestamp],     // DateTimeOriginal, DateTimeDigitized
        [0x9101, 7, Uint8Array.of(1, 2, 3, 0)],             // ComponentsConfiguration
        [0x9286, 7, ascii.encode("ASCII\0\0\0" + crypto.randomUUID().toUpperCase())],
        [0xa000, 7, ascii.encode("0100")]                   // FlashpixVersion
      );
    }
    exifFields.push([0xa001, 3, 1], [0xa002, 4, WIDTH], [0xa003, 4, HEIGHT]); // sRGB and dimensions

    const dirSize = n => 2 + n * 12 + 4;
    const main = 8, exif = main + dirSize(mainFields.length + 1);
    mainFields.push([0x8769, 4, exif]);
    let next = exif + dirSize(exifFields.length);
    const aligned = length => length + length % 2;
    let size = next;
    for (const [, , value] of [...mainFields, ...exifFields]) {
      if (value instanceof Uint8Array && value.length > 4) size += aligned(value.length);
    }
    const tiffStart = 10; // FF E1, length, "Exif\0\0", then TIFF-relative offsets
    const bytes = new Uint8Array(tiffStart + size);
    bytes.set([0xff, 0xe1, 0, 0, 0x45, 0x78, 0x69, 0x66, 0, 0]);
    new DataView(bytes.buffer).setUint16(2, bytes.length - 2);
    const tiff = new DataView(bytes.buffer, tiffStart);
    tiff.setUint16(0, 0x4949);
    tiff.setUint16(2, 42, true);
    tiff.setUint32(4, main, true);
    function writeDirectory(directory, fields) {
      tiff.setUint16(directory, fields.length, true);
      fields.forEach(([tag, type, value], index) => {
        const pos = directory + 2 + index * 12;
        tiff.setUint16(pos, tag, true);
        tiff.setUint16(pos + 2, type, true);
        tiff.setUint32(pos + 4, typeof value === "number" ? 1 : value.length, true);
        if (typeof value === "number") {
          if (type === 3) tiff.setUint16(pos + 8, value, true);
          else tiff.setUint32(pos + 8, value, true);
        } else if (value.length <= 4) {
          bytes.set(value, tiffStart + pos + 8);
        } else {
          tiff.setUint32(pos + 8, next, true);
          bytes.set(value, tiffStart + next);
          next += aligned(value.length);
        }
      });
    }
    writeDirectory(main, mainFields);
    writeDirectory(exif, exifFields);
    return bytes;
  }

  async function addProfile(jpeg, profile) {
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
    parts.push(profileSegment(profile), jpeg.slice(pos));
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
      return await addProfile(jpeg, options.profile);
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
  }

  Object.defineProperty(window, "SpinJPEG", { value: Object.freeze({ draw, encode }) });
})();

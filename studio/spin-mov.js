(() => {
  "use strict";

  const text = new TextEncoder();
  const template = Object.fromEntries(Object.entries(window.SpinMOVTemplate).map(([name, value]) =>
    [name, Uint8Array.from(atob(value), character => character.charCodeAt(0))]));
  const frames = 120, fps = 30, audioPackets = 189;
  const invalid = () => { throw new Error("Браузер вернул неподходящие данные HEVC для этого MOV."); };

  function words(...values) {
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    values.forEach((value, i) => view.setUint32(i * 4, value));
    return bytes;
  }

  function header(type, length) {
    const bytes = words(length, typeof type === "number" ? type : 0);
    if (typeof type === "string") bytes.set(text.encode(type), 4);
    return bytes;
  }

  function atom(type, ...parts) {
    const size = parts.reduce((sum, part) => sum + part.byteLength, 8);
    const bytes = new Uint8Array(size);
    bytes.set(header(type, size));
    let offset = 8;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return bytes;
  }

  // A hvc1 sample entry carries the parameter sets in hvcC. Samples use its NAL length prefix.
  function nalLengthSize(config) {
    if (!(config instanceof Uint8Array) || config.length < 23 || config.length > 65535 || config[0] !== 1) invalid();
    const width = 1 + (config[21] & 3);
    if (width === 3) invalid();
    const types = new Set();
    let pos = 23;
    for (let i = 0; i < config[22]; i++) {
      if (pos + 3 > config.length) invalid();
      const type = config[pos] & 63;
      const count = config[pos + 1] * 256 + config[pos + 2];
      pos += 3;
      for (let j = 0; j < count; j++) {
        if (pos + 2 > config.length) invalid();
        const length = config[pos] * 256 + config[pos + 1];
        pos += 2;
        if (length < 2 || pos + length > config.length || ((config[pos] >> 1) & 63) !== type) invalid();
        types.add(type);
        pos += length;
      }
    }
    if (pos !== config.length || !types.has(32) || !types.has(33) || !types.has(34)) invalid();
    return width;
  }

  function validateSample(bytes, width, key) {
    let pos = 0, picture = false, independent = false;
    while (pos < bytes.length) {
      if (pos + width > bytes.length) invalid();
      let size = 0;
      for (let i = 0; i < width; i++) size = size * 256 + bytes[pos++];
      if (size < 2 || pos + size > bytes.length || (bytes[pos] & 0x80) || !(bytes[pos + 1] & 7)) invalid();
      const type = (bytes[pos] >> 1) & 63;
      if (type <= 31) picture = true;
      if (type >= 16 && type <= 21) independent = true;
      pos += size;
    }
    if (!picture || (key && !independent)) invalid();
  }

  function colorAtom(space) {
    const empty = new Uint8Array(0);
    if (!space) return empty;
    const p = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9, smpte432: 12 }[space.primaries];
    const t = { bt709: 1, smpte170m: 6, linear: 8, "iec61966-2-1": 13, pq: 16, hlg: 18 }[space.transfer];
    const m = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, "bt2020-ncl": 9 }[space.matrix];
    if (![p, t, m].every(Number.isInteger)) return empty;
    const full = space.fullRange === true;
    const values = new Uint8Array(full ? 7 : 6);
    const view = new DataView(values.buffer);
    [p, t, m].forEach((value, i) => view.setUint16(i * 2, value));
    if (full) values[6] = 0x80;
    return atom("colr", text.encode(full ? "nclx" : "nclc"), values);
  }

  function track(prefix, description, sizes, offset, sync) {
    // Each track occupies one contiguous chunk. The silent AAC track retains its priming edit.
    const stbl = atom("stbl", description, template[prefix + "Timing"],
      sync ? atom("stss", words(0, sync.length, ...sync)) : new Uint8Array(0),
      atom("stsc", words(0, 1, 1, sizes.length, 1)),
      atom("stsz", words(0, 0, sizes.length, ...sizes)), atom("stco", words(0, 1, offset)),
      sync ? new Uint8Array(0) : template.audioRecovery);
    const minf = atom("minf", template[prefix + "MinfHeaders"], stbl);
    const mdia = atom("mdia", template[prefix + "MediaHeaders"], minf);
    return atom("trak", template[prefix + "TrackHeaders"], mdia);
  }

  function metadata() {
    const model = "Ray-Ban Meta Smart Glasses 2";
    const values = ["Meta AI", "app=Meta AI&device=" + model + "&id=" + crypto.randomUUID().toUpperCase(),
      model, new Date().toISOString().slice(0, 19) + "Z"];
    const items = values.map((value, i) => atom(i + 1, atom("data", words(1, 0), text.encode(value))));
    return atom("meta", template.metadataHeaders, atom("ilst", ...items));
  }

  function mux(chunks, description, colorSpace) {
    if (!Array.isArray(chunks) || chunks.length !== frames) invalid();
    const width = nalLengthSize(description);
    const samples = [], sizes = [], sync = [];
    let videoBytes = 0;
    for (let i = 0; i < frames; i++) {
      const chunk = chunks[i];
      // Presentation order must equal decode order. The fixed sample clock has 20 ticks per frame.
      if (!chunk || !Number.isSafeInteger(chunk.timestamp) ||
          Math.abs(chunk.timestamp - i * 1000000 / fps) > 1 || !(chunk.data instanceof Uint8Array) ||
          (chunk.type !== "key" && chunk.type !== "delta") || (i === 0 && chunk.type !== "key")) invalid();
      videoBytes += chunk.data.byteLength;
      if (videoBytes > 96 * 1024 * 1024) throw new Error("Видео превышает 96 МБ. Попробуй другой снимок.");
      validateSample(chunk.data, width, chunk.type === "key");
      if (chunk.type === "key") sync.push(i + 1);
      sizes.push(chunk.data.byteLength);
      samples.push(chunk.data);
    }

    const hvc1 = atom("hvc1", template.videoEntryFields, atom("hvcC", description),
      template.videoFieldOrder, colorAtom(colorSpace), template.pixelAspect);
    const videoOffset = template.fileHeader.byteLength + 8;
    const video = track("video", atom("stsd", words(0, 1), hvc1), sizes, videoOffset, sync);
    const silence = [template.audioPriming, ...Array(audioPackets - 1).fill(template.audioSilence)];
    const audio = track("audio", template.audioSampleDescription, silence.map(s => s.byteLength), videoOffset + videoBytes);
    const mdatSize = 8 + videoBytes + silence.reduce((sum, packet) => sum + packet.byteLength, 0);
    const moov = atom("moov", template.movieHeader, video, audio, metadata());
    return new Blob([template.fileHeader, header("mdat", mdatSize), ...samples, ...silence, moov], { type: "video/quicktime" });
  }

  Object.defineProperty(window, "SpinMOV", { value: Object.freeze({ mux }) });
})();

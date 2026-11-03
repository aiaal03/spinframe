(() => {
  "use strict";

  const limit = 1024 * 1024;
  const damaged = "Не удалось прочитать метаданные. Заголовок JPEG или блок EXIF повреждён.";
  const missing = "В метаданных JPEG нет полей производителя и модели камеры. Для сравнения выбери файл, скачанный прямо из Spinframe.";
  const inconclusive = "Заголовок выходит за пределы первого мегабайта. Определить метки камеры не удалось.";
  const decoder = new TextDecoder("ascii");

  function readCamera(view) {
    if (view.byteLength < 8) return damaged;
    const order = view.getUint16(0);
    const le = order === 0x4949;
    if ((!le && order !== 0x4d4d) || view.getUint16(2, le) !== 42) return damaged;
    const dir = view.getUint32(4, le);
    if (dir < 8 || dir + 2 > view.byteLength) return damaged;
    const entries = view.getUint16(dir, le);
    if (dir + 2 + 12 * entries + 4 > view.byteLength) return damaged;

    let make = "", model = "";
    for (let i = 0; i < entries; i++) {
      const entry = dir + 2 + i * 12;
      const tag = view.getUint16(entry, le);
      if (tag !== 0x010f && tag !== 0x0110) continue;
      if (view.getUint16(entry + 2, le) !== 2) return damaged;
      const size = view.getUint32(entry + 4, le);
      const start = size <= 4 ? entry + 8 : view.getUint32(entry + 8, le);
      if (!size || start + size > view.byteLength || view.getUint8(start + size - 1) !== 0) return damaged;
      const raw = new Uint8Array(view.buffer, view.byteOffset + start, size - 1);
      // Keep display compact and avoid interpreting control characters as part of a name.
      let value = decoder.decode(raw.subarray(0, 100)).replace(/\0+$/, "").replace(/[^ -~]/g, "�");
      if (raw.length > 100) value += "…";
      if (tag === 0x010f) make = value;
      else model = value;
    }
    if (make === "Meta AI" && (model === "Ray-Ban Meta Smart Glasses" || model === "Ray-Ban Meta Smart Glasses 2")) {
      return `Метки Ray-Ban Meta сохранились. Модель в файле — ${model}. Значок в сторис присваивает Instagram.`;
    }
    if (!make && !model) return missing;
    return `Производитель — ${make || "не указан"}. Модель — ${model || "не указана"}.`;
  }

  function checkJPEG(buffer, fileSize) {
    const view = new DataView(buffer);
    const length = view.byteLength;
    if (length < 2 || view.getUint16(0) !== 0xffd8) {
      return "Формат JPEG не распознан. Выбери файл .jpg или .jpeg.";
    }
    const short = length < fileSize ? inconclusive : damaged;
    let pos = 2;
    while (pos < length) {
      if (view.getUint8(pos) !== 0xff) return damaged;
      while (pos < length && view.getUint8(pos) === 0xff) pos++;
      if (pos === length) return short;
      const marker = view.getUint8(pos++);
      if (marker === 0xd9) return missing;
      if (marker === 0x01) continue;
      if (marker === 0 || (marker >= 0xd0 && marker <= 0xd8)) return damaged;
      if (pos + 2 > length) return short;
      const size = view.getUint16(pos);
      const end = pos + size;
      if (size < 2 || end > fileSize) return damaged;
      if (end > length) return inconclusive;
      if (marker === 0xda) return missing;
      if (marker === 0xe1 && size >= 8 && view.getUint32(pos + 2) === 0x45786966 && view.getUint16(pos + 6) === 0) {
        return readCamera(new DataView(buffer, pos + 8, size - 8));
      }
      pos = end;
    }
    return short;
  }

  const details = document.getElementById("badge-check");
  const input = document.getElementById("badgeFile");
  const status = document.getElementById("badgeStatus");
  function openFromHash() {
    if (location.hash === "#badge-check") details.open = true;
  }
  window.addEventListener("hashchange", openFromHash);
  document.querySelectorAll('a[href="#badge-check"]').forEach(link => {
    link.addEventListener("click", () => { details.open = true; });
  });
  openFromHash();

  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) {
      status.textContent = "";
      return;
    }
    status.textContent = "Читаю метаданные JPEG…";
    let message;
    try {
      message = checkJPEG(await file.slice(0, limit).arrayBuffer(), file.size);
    } catch {
      message = "Не удалось открыть файл. Выбери его ещё раз.";
    }
    if (input.files[0] === file) status.textContent = message;
  });
})();

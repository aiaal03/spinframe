(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const viewer = $("viewer");
  const canvas = $("stage");
  const ctx = canvas.getContext("2d", {alpha:false, colorSpace:"srgb"});
  const fallback = "Этот файл не открылся. Выбери JPEG или PNG. Для HEIC попробуй Safari или сохрани копию в JPEG.";
  let source, localURL, pending = 0, version = 0, busy = false, loading = false, frameNumber = 1;
  let fit = "contain", focus = 0.5, mode = "look";
  let exportURL, exportFile, encodeTimer;
  let canSend = false, sharing = false;
  const showStatus = message => { $("status").textContent = message; };

  function resetOutput() {
    version++;
    clearTimeout(encodeTimer);
    encodeTimer = undefined;
    if (exportURL) URL.revokeObjectURL(exportURL);
    exportURL = exportFile = undefined;
    canSend = false;
    $("prepare").disabled = true;
    $("prepare").firstElementChild.textContent = "Готовлю JPEG…";
    $("quickSave").hidden = true;
    $("quickSave").removeAttribute("href");
    $("save").removeAttribute("href");
    $("resultThumb").removeAttribute("src");
    if (source && !loading) {
      encodeTimer = setTimeout(() => { encodeTimer = undefined; void encodeCurrent(); }, 250);
    }
  }

  async function encodeCurrent() {
    if (busy || loading || !source || exportFile) return;
    const stamp = version;
    busy = true;
    try {
      const blob = await SpinJPEG.encode(source, {fit, focus});
      if (stamp !== version) return;
      exportFile = new File([blob], "spinframe-story.jpg", {type:"image/jpeg"});
      exportURL = URL.createObjectURL(blob);
      try {
        canSend = typeof navigator.share === "function" &&
          typeof navigator.canShare === "function" && navigator.canShare({files:[exportFile]});
      } catch { canSend = false; }
      $("save").href = $("quickSave").href = exportURL;
      $("quickSave").hidden = false;
      $("resultSpecs").textContent = "3024 × 4032  ·  JPEG  ·  " + (blob.size/1048576).toLocaleString("ru-RU",{maximumFractionDigits:2}) + " МБ";
      $("prepare").firstElementChild.textContent = canSend ? "Поделиться фото" : "Открыть готовый JPEG";
      $("prepare").querySelector("use").setAttribute("href", canSend ? "#share" : "#arrow");
      $("prepare").disabled = sharing;
    } catch (error) {
      if (stamp === version) {
        $("prepare").disabled = false;
        $("prepare").firstElementChild.textContent = "Повторить подготовку";
        showStatus(error.message || "Не удалось подготовить JPEG. Попробуй снимок меньшего размера.");
      }
    } finally {
      busy = false;
      if (stamp !== version && encodeTimer === undefined) void encodeCurrent();
    }
  }

  const frame = document.createElement("canvas");
  const frameCtx = frame.getContext("2d", {alpha:false, colorSpace:"srgb"});
  frame.width = 864; frame.height = 1152;
  let dirtyFrame = true;
  let angle = 0, viewportAngle = 0, pointer, animation, motionActive = false;

  function signedAngle(degrees) {
    const wrapped = degrees % 360;
    return wrapped > 180 ? wrapped - 360 : wrapped < -180 ? wrapped + 360 : wrapped;
  }
  function paint() {
    if (!source || !ctx || !frameCtx) return;
    const bounds = canvas.getBoundingClientRect();
    const resolution = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(bounds.width * resolution));
    const h = Math.max(1, Math.round(bounds.height * resolution));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (dirtyFrame) {
      SpinJPEG.draw(frameCtx, source, frame.width, frame.height, {fit,focus});
      dirtyFrame = false;
    }
    if (mode === "look") {
      SpinPreview.draw(ctx, frame, w, h, angle, viewportAngle);
    } else {
      ctx.fillStyle = "#20332e"; ctx.fillRect(0, 0, w, h);
      const fh = Math.min(h * .96, w / .75), fw = fh * .75;
      ctx.drawImage(frame, (w-fw)/2, (h-fh)/2, fw, fh);
    }
  }
  function setAngle(value, viewport = 0) {
    angle = signedAngle(value); viewportAngle = signedAngle(viewport);
    const rounded = Math.round(angle);
    $("rollAngle").value = String(rounded);
    $("rollAngle").setAttribute("aria-valuetext", rounded + "°");
    $("bearing").textContent = rounded + "°";
    paint();
  }
  function sensorNote(text) {
    if ($("sensorNote").textContent !== text) $("sensorNote").textContent = text;
    $("sensorNote").hidden = !text;
  }
  function stopMotion() {
    SpinRoll.stop();
    motionActive = false;
    $("motion").setAttribute("aria-pressed","false");
    $("motion").textContent = SpinRoll.capability() === "quarters" ? "По автоповороту · 90°" : "Поворот телефоном";
    sensorNote("");
  }
  function stopDemo() {
    if (animation !== undefined) cancelAnimationFrame(animation);
    animation = undefined;
    $("replay").setAttribute("aria-pressed", "false");
    $("replay").querySelector("span").textContent = "Показать поворот";
  }
  function endDrive() { stopDemo(); stopMotion(); }
  function setMode(next) {
    endDrive();
    mode = next; viewportAngle = 0;
    const spin = mode === "look";
    viewer.classList.toggle("spinning", spin);
    viewer.tabIndex = spin ? 0 : -1;
    $("modeLook").setAttribute("aria-pressed", String(spin));
    $("modeFrame").setAttribute("aria-pressed", String(!spin));
    $("gesture").querySelector("span").textContent = spin ? "Вращай рамку по кругу" : "Итоговая рамка JPEG";
    $("gesture").querySelector("use").setAttribute("href", spin ? "#turn" : "#expand");
    viewer.querySelector(".view-index").hidden = !spin;
    $("rollControls").hidden = $("replay").hidden = !spin;
    $("motion").hidden = !spin || !SpinRoll.available();
    paint();
  }
  function setFit(next) {
    fit = next; dirtyFrame = true; resetOutput(); showStatus("");
    $("contain").setAttribute("aria-pressed", String(fit === "contain"));
    $("cover").setAttribute("aria-pressed", String(fit === "cover"));
    $("focusBox").hidden = fit !== "cover";
    $("fitNote").textContent = fit === "contain" ? "Весь снимок войдёт в JPEG. Поля заполнятся мягким фоном." : "Рамка заполнится снимком. Сдвинь кадр, чтобы выбрать нужный фрагмент.";
    setMode("frame");
  }
  $("contain").addEventListener("click", () => setFit("contain"));
  $("cover").addEventListener("click", () => setFit("cover"));
  $("focus").addEventListener("input", () => {
    focus = Number($("focus").value) / 100; dirtyFrame = true; resetOutput(); setMode("frame");
  });
  $("modeLook").addEventListener("click", () => setMode("look"));
  $("modeFrame").addEventListener("click", () => setMode("frame"));
  $("rollAngle").addEventListener("input", () => { endDrive(); setAngle(Number($("rollAngle").value)); });
  $("resetAngle").addEventListener("click", () => { endDrive(); setAngle(0); });

  function pointerAngle(e) {
    const b = viewer.getBoundingClientRect();
    const dx = e.clientX - b.left - b.width/2, dy = e.clientY - b.top - b.height/2;
    // A radial drag through the pivot has no defined angle there.
    if (Math.hypot(dx,dy) < Math.min(b.width,b.height)*.12) return null;
    return Math.atan2(dy,dx) * 180 / Math.PI;
  }
  viewer.addEventListener("pointerdown", e => {
    if (mode !== "look" || !e.isPrimary || e.button !== 0) return;
    endDrive(); setAngle(angle);
    pointer = {id:e.pointerId, previous:pointerAngle(e)};
    viewer.setPointerCapture(e.pointerId);
  });
  viewer.addEventListener("pointermove", e => {
    if (!pointer || e.pointerId !== pointer.id) return;
    const current = pointerAngle(e);
    if (current !== null && pointer.previous !== null) {
      const delta = signedAngle(current-pointer.previous);
      if (Math.abs(delta) < 120) setAngle(angle+delta);
    }
    pointer.previous = current;
  });
  viewer.addEventListener("lostpointercapture", () => { pointer = undefined; });
  viewer.addEventListener("keydown", e => {
    if (mode !== "look" || !["ArrowLeft","ArrowRight","Home"].includes(e.key)) return;
    e.preventDefault(); endDrive();
    setAngle(e.key === "Home" ? 0 : angle+(e.key === "ArrowRight" ? 5 : -5));
  });

  $("replay").addEventListener("click", () => {
    if (animation !== undefined) { stopDemo(); return; }
    stopMotion();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setAngle(Math.abs(angle-90)<1 ? 0 : 90); return;
    }
    setAngle(0);
    $("replay").setAttribute("aria-pressed","true");
    $("replay").querySelector("span").textContent = "Остановить";
    const start = performance.now(), duration = 1300, pause = 800;
    function tick(now) {
      const t = now-start;
      if (t >= duration*2+pause) { setAngle(0); stopDemo(); return; }
      const fraction = Math.max(0,Math.min(1,t/duration,(2*duration+pause-t)/duration));
      setAngle(90*(.5-.5*Math.cos(fraction*Math.PI)));
      animation = requestAnimationFrame(tick);
    }
    animation = requestAnimationFrame(tick);
  });
  $("motion").addEventListener("click", () => {
    if (motionActive) { stopMotion(); setAngle(angle); return; }
    stopDemo(); motionActive = true;
    $("motion").setAttribute("aria-pressed","true"); $("motion").textContent = "Выключить датчик";
    SpinRoll.start((physical, viewport, inputMode) => {
      sensorNote(inputMode === "quarters" ? "Включи автоповорот экрана. Браузер сообщает положение с шагом 90°. Для плавного вращения используй ползунок." : "Держи телефон перед собой и поверни его из портретного положения в альбомное.");
      setAngle(physical, viewport);
    }, reason => {
      stopMotion(); setAngle(0);
      sensorNote(reason === "denied" ? "Доступ к датчику закрыт. Угол можно выбрать ползунком." : "Датчик недоступен. Угол можно выбрать ползунком.");
    });
  });

  const resize = new ResizeObserver(paint);
  resize.observe(viewer);
  const demo = new Image();
  demo.onload = () => {
    if (!source) { source = demo; resetOutput(); setMode("look"); }
  };
  demo.src = "./studio/demo.jpg";

  // Only decoded raster formats enter the canvas; ignore filename and MIME claims.
  async function checkFile(file) {
    if (!file.size || file.size > 32*1024*1024) throw new Error("Выбери снимок размером до 32 МБ.");
    const bytes = new Uint8Array(await file.slice(0,64).arrayBuffer());
    const sig = (i,n) => String.fromCharCode(...bytes.slice(i,i+n));
    if (bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return "image/jpeg";
    if (bytes[0]===137 && sig(1,3)==="PNG" && bytes[4]===13 && bytes[5]===10 && bytes[6]===26 && bytes[7]===10) return "image/png";
    if (sig(0,4)==="RIFF" && sig(8,4)==="WEBP") return "image/webp";
    if (sig(4,4)==="ftyp") {
      const brands = [sig(8,4)];
      for (let i=16;i+4<=bytes.length;i+=4) brands.push(sig(i,4));
      if (brands.some(b=>b==="avif" || b==="avis")) return "image/avif";
      if (brands.some(b=>["heic","heix","hevc","hevx","mif1","msf1"].includes(b))) return "image/heic";
    }
    throw new Error("Этот формат не поддерживается. Выбери JPEG, PNG, WebP или фото из галереи.");
  }
  async function openFile(file) {
    if (!file) return;
    const token = ++pending;
    loading = true; resetOutput();
    const img = new Image();
    let url;
    $("prepare").disabled = true;
    showStatus("Открываю снимок…");
    try {
      const type = await checkFile(file);
      url = URL.createObjectURL(file.slice(0,file.size,type));
      img.src = url;
      await img.decode();
      const {naturalWidth:w,naturalHeight:h} = img;
      if (!w || !h || w*h > 64000000 || Math.max(w,h)>32768) throw new RangeError("Выбери фото до 64 Мп и до 32 768 пикселей по стороне.");
      if (token !== pending) return;
      if (localURL) URL.revokeObjectURL(localURL);
      localURL = url; url = undefined;
      stopMotion(); sensorNote("");
      source = img; dirtyFrame = true; focus = .5; $("focus").value = 50; setAngle(0);
      $("sceneKind").lastChild.textContent = "ТВОЙ КАДР";
      const number = String(++frameNumber).padStart(2,"0");
      $("filmNumber").textContent = number; $("frameId").textContent = "S — "+number;
      $("inputDims").textContent = w+" × "+h;
      $("caption").textContent = file.name || "Снимок с камеры";
      setMode("look"); showStatus("");
    } catch (error) {
      if (token === pending) showStatus(error instanceof Error && error.name !== "EncodingError" ? error.message : fallback);
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (token === pending) { loading = false; resetOutput(); }
    }
  }
  function fromInput(id) {
    const input = $(id);
    input.addEventListener("change", () => {
      const file = input.files[0]; input.value = ""; openFile(file);
    });
  }
  fromInput("library"); fromInput("capture");
  $("pick").addEventListener("click", () => $("library").click());
  $("shoot").addEventListener("click", () => $("capture").click());

  function openResult(message) {
    $("saveNote").textContent = message;
    $("resultThumb").src = exportURL;
    $("share").hidden = !canSend;
    endDrive(); setAngle(angle);
    if (!$("result").open) $("result").showModal();
    $("save").focus();
  }
  const saveHelp = "На iPhone открой JPEG в «Файлах» и нажми «Поделиться» → «Сохранить изображение». Затем выбери его из галереи в редакторе сторис.";
  async function sendOrSave() {
    const file = exportFile;
    if (!file) { showStatus(""); resetOutput(); return; }
    if (!canSend) {
      openResult("Сохрани файл в галерею и выбери его в редакторе сторис Instagram.");
      return;
    }
    if (sharing) return;
    sharing = true;
    $("prepare").disabled = true;
    try {
      // The file is ready before the tap. Keep share() inside its activation.
      await navigator.share({files:[file]});
    } catch (error) {
      if (file === exportFile && error.name !== "AbortError") {
        openResult("Меню отправки недоступно. Скачай JPEG и выбери его из галереи в редакторе сторис.");
      }
    } finally {
      sharing = false;
      if (exportFile) $("prepare").disabled = false;
    }
  }
  $("prepare").addEventListener("click", sendOrSave);
  $("share").addEventListener("click", sendOrSave);
  $("save").addEventListener("click", () => { $("saveNote").textContent = saveHelp; });
  $("quickSave").addEventListener("click", () => { showStatus(saveHelp); });
  $("closeResult").addEventListener("click", () => $("result").close());
  $("result").addEventListener("click", e => {
    if (e.target !== $("result")) return;
    const rect = $("result").getBoundingClientRect();
    if (e.clientX<rect.left || e.clientX>rect.right || e.clientY<rect.top || e.clientY>rect.bottom) $("result").close();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { endDrive(); setAngle(angle); }
  });
})();

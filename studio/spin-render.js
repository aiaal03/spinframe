(() => {
  "use strict";

  const rad = Math.PI / 180;
  // All geometry is expressed relative to a 1000-unit short edge.
  const phoneHeight = 800, phoneWidth = 450;
  const screenHeight = 780, screenWidth = screenHeight * 9 / 16;
  const sceneSpan = Math.hypot(screenWidth, screenHeight) + 2;

  function draw(ctx, frame, w, h, rollDegrees, viewportDegrees = 0) {
    if (!frame?.width || !frame.height || !(w > 0 && h > 0) ||
        ![w, h, rollDegrees, viewportDegrees].every(Number.isFinite)) return;
    const unit = Math.min(w, h) / 1000;
    ctx.save();
    ctx.fillStyle = "#172c28";
    ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);
    ctx.scale(unit, unit);

    // Fine marks give the turning frame a fixed reference.
    ctx.beginPath();
    ctx.arc(0, 0, 462, 0, Math.PI * 2);
    ctx.strokeStyle = "#365047";
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < 72; i++) {
      const r = i % 6 === 0 ? 480 : 471;
      const x = Math.sin(i * 5 * rad), y = -Math.cos(i * 5 * rad);
      ctx.moveTo(x * 462, y * 462);
      ctx.lineTo(x * r, y * r);
    }
    ctx.strokeStyle = "#53665b";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.rotate((rollDegrees - viewportDegrees) * rad);
    ctx.beginPath();
    ctx.roundRect(-phoneWidth / 2, -phoneHeight / 2, phoneWidth, phoneHeight, 52);
    ctx.fillStyle = "#101712";
    ctx.fill();
    ctx.strokeStyle = "#8b9990";
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(-screenWidth / 2, -screenHeight / 2, screenWidth, screenHeight, 45);
    ctx.clip();
    // The aperture turns with the handset. Counter-rotate the photograph
    // inside it, keeping its centre, scale and world horizon in place.
    ctx.rotate(-rollDegrees * rad);
    const scale = sceneSpan / Math.min(frame.width, frame.height);
    const photoWidth = frame.width * scale, photoHeight = frame.height * scale;
    ctx.drawImage(frame, -photoWidth / 2, -photoHeight / 2, photoWidth, photoHeight);
    ctx.restore();

    // Story chrome belongs to the turning screen.
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255,255,249,.78)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-screenWidth / 2 + 30, -screenHeight / 2 + 27);
    ctx.lineTo(screenWidth / 2 - 30, -screenHeight / 2 + 27);
    ctx.stroke();
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(-44, screenHeight / 2 - 21);
    ctx.lineTo(44, screenHeight / 2 - 21);
    ctx.stroke();
    ctx.restore();
  }

  Object.defineProperty(window, "SpinPreview", {value: Object.freeze({draw})});
})();

(() => {
  "use strict";

  const radians = Math.PI / 180;
  let session;

  function screenAngle() {
    const angle = window.screen.orientation?.angle;
    if (Number.isFinite(angle)) return angle;
    return Number.isFinite(window.orientation) ? window.orientation : null;
  }

  function capability() {
    if (!navigator.maxTouchPoints) return null;
    if (window.isSecureContext && window.DeviceOrientationEvent) return "sensor";
    return screenAngle() === null ? null : "quarters";
  }

  function stop() {
    if (!session) return;
    session.abort();
    session = undefined;
  }

  function step(from, to) {
    return ((to - from + 540) % 360) - 180;
  }

  async function start(onChange, onUnavailable) {
    stop();
    const controller = new AbortController();
    const { signal } = controller;
    session = controller;
    let mode = capability();
    let failure = "unavailable";
    const sensor = window.DeviceOrientationEvent;
    if (mode === "sensor" && typeof sensor.requestPermission === "function") {
      try {
        if (await sensor.requestPermission() !== "granted") failure = "denied";
      } catch { failure = "denied"; }
      if (signal.aborted) return false;
      if (failure === "denied") mode = screenAngle() === null ? null : "quarters";
    }
    if (!mode) {
      stop();
      onUnavailable(failure);
      return false;
    }

    let previousScreen = screenAngle();
    let screenDelta = 0, physical = 0, previousRoll, timer;
    function publish() {
      // ScreenOrientation reports CCW from natural. Its compensation is
      // added to CW device roll to obtain the page's angle in the room.
      if (mode === "quarters") onChange(-screenDelta, 0, mode);
      else onChange(physical, physical + screenDelta, mode);
    }
    function readScreen() {
      const next = screenAngle();
      if (next === null || previousScreen === null) return;
      screenDelta += step(previousScreen, next);
      previousScreen = next;
    }
    function screenChanged() { readScreen(); publish(); }
    function deviceChanged(event) {
      if (mode !== "sensor" || !Number.isFinite(event.beta) || !Number.isFinite(event.gamma)) return;
      // Project world up into the screen plane (intrinsic Z-X'-Y'' matrix).
      // Its direction gives roll independently of alpha/compass heading.
      const beta = event.beta * radians, gamma = event.gamma * radians;
      const rightDown = Math.cos(beta) * Math.sin(gamma), topUp = Math.sin(beta);
      if (Math.hypot(rightDown, topUp) < 0.2) return;
      const roll = Math.atan2(rightDown, topUp) / radians;
      if (previousRoll !== undefined) physical += step(previousRoll, roll);
      previousRoll = roll;
      clearTimeout(timer);
      readScreen();
      publish();
    }

    if (previousScreen !== null) {
      if (window.screen.orientation?.addEventListener) {
        window.screen.orientation.addEventListener("change", screenChanged, { signal });
      } else {
        window.addEventListener("orientationchange", screenChanged, { signal });
      }
    }
    if (mode === "sensor") {
      window.addEventListener("deviceorientation", deviceChanged, { signal });
      timer = setTimeout(() => {
        if (signal.aborted || previousRoll !== undefined) return;
        if (previousScreen === null) {
          stop(); onUnavailable("unavailable");
        } else {
          mode = "quarters";
          window.removeEventListener("deviceorientation", deviceChanged);
          readScreen(); publish();
        }
      }, 4500);
      signal.addEventListener("abort", () => clearTimeout(timer), {once:true});
    }
    publish();
    return true;
  }

  window.SpinRoll = Object.freeze({available: () => capability() !== null, capability, start, stop});
})();

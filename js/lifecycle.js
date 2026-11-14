/* lifecycle.js: tab visibility pause/resume for the render loop.
   Loaded before main.js. Exposes window.IOS.Lifecycle.
   iOS Safari does not always fire visibilitychange before freezing a
   backgrounded tab, so pagehide is treated as a pause too. */
'use strict';

(function () {

  const doc = document;
  const pauseHandlers = [];
  const resumeHandlers = [];
  let paused = false;

  function fire(list) {
    for (let i = 0; i < list.length; i++) {
      try { list[i](); } catch (err) { console.warn('[lifecycle]', err); }
    }
  }

  function setPaused(next) {
    if (next === paused) return;
    paused = next;
    if (paused) fire(pauseHandlers); else fire(resumeHandlers);
  }

  function hidden() {
    return doc.hidden || doc.visibilityState === 'hidden';
  }

  doc.addEventListener('visibilitychange', function () { setPaused(hidden()); });
  window.addEventListener('pagehide', function () { setPaused(true); });
  window.addEventListener('pageshow', function () { setPaused(hidden()); });

  window.IOS = window.IOS || {};
  window.IOS.Lifecycle = {
    get paused() { return paused; },
    onPause: function (fn) { if (typeof fn === 'function') pauseHandlers.push(fn); },
    onResume: function (fn) { if (typeof fn === 'function') resumeHandlers.push(fn); }
  };

  setPaused(hidden());
})();

/* ---- Screen: viewport height + portrait-phone detection ---- */
function ScreenModule(doc, body) {
  function isPortraitPhone() {
    const portrait = window.innerHeight >= window.innerWidth;
    const narrow = Math.min(window.innerWidth, window.innerHeight) < 600;
    return portrait && narrow;
  }

  function applyViewportHeight() {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    body.style.setProperty('--vh', h + 'px');
  }

  function refresh() {
    applyViewportHeight();
    body.classList.toggle('portrait', isPortraitPhone());
  }
  /* Wake lock: keeps the screen on during flight. Resolves to null when
     the platform has no Screen Wake Lock API (older iOS) or refuses
     because the tab is not visible; every failure is silent by design. */
  let wakeLock = null;

  function wakeOn() {
    if (!navigator.wakeLock || wakeLock) return;
    if (doc.hidden) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () { wakeLock = null; });
  }

  function wakeOff() {
    const lock = wakeLock;
    wakeLock = null;
    if (lock) {
      try { lock.release(); } catch (err) { /* already released */ }
    }
  }
  return {
    init: function () {
      refresh();
      window.addEventListener('resize', refresh);
      window.addEventListener('orientationchange', function () { setTimeout(refresh, 250); });
      if (window.visualViewport) window.visualViewport.addEventListener('resize', applyViewportHeight);
    },
    refresh: refresh,
    isPortraitPhone: isPortraitPhone,
    applyViewportHeight: applyViewportHeight,
    wakeOn: wakeOn,
    wakeOff: wakeOff
  };
}

/* ---- Fullscreen: standard + webkit-prefixed (iOS < 16.4 webkit exits;
   modern Safari on iPad/iPhone uses document.* if present). ---- */
function FullscreenModule(doc) {
  const handlers = [];

  function el() { return doc.documentElement; }
  function isSupported() {
    const e = el();
    return !!(e && (e.requestFullscreen || e.webkitRequestFullscreen));
  }

  function currentEl() {
    return doc.fullscreenElement || doc.webkitFullscreenElement || doc.webkitCurrentFullScreenElement || null;
  }

  function isActive() { return !!currentEl(); }

  /* iOS Safari in a tab exposes no requestFullscreen on <html>, and iPad
     can reject the promise even when it exists. Every path returns a
     Promise<boolean>; a false result just leaves the tab as-is. */
  function request(e) {
    const target = e || el();
    let p;
    try {
      if (target.requestFullscreen) {
        p = target.requestFullscreen();
      } else if (target.webkitRequestFullscreen) {
        p = target.webkitRequestFullscreen();
      } else {
        return Promise.resolve(false);
      }
    } catch (err) {
      return Promise.resolve(false);
    }
    const settled = (p && typeof p.then === 'function') ? p : Promise.resolve();
    return settled.then(function () { return isActive(); }, function () { return false; });
  }
  function exit() {
    try {
      if (doc.exitFullscreen) {
        const p = doc.exitFullscreen();
        if (p && typeof p.catch === 'function') p.catch(function () {});
        return Promise.resolve();
      }
      const p2 = doc.webkitExitFullscreen || doc.webkitCancelFullScreen;
      if (p2) { p2.call(doc); return Promise.resolve(); }
    } catch (err) { /* ignore */ }
    return Promise.resolve();
  }
  function toggle(e) {
    if (isActive()) return exit();
    return request(e);
  }

  function onChange(fn) {
    if (typeof fn === 'function') handlers.push(fn);
  }

  function emit() {
    const active = isActive();
    for (let i = 0; i < handlers.length; i++) {
      try { handlers[i](active); } catch (err) { /* ignore */ }
    }
  }

  /* All four spellings: standard events fire on document; the vendor
     prefixed ones are emitted by old Android Chrome and Safari 16.3. */
  ['fullscreenchange', 'webkitfullscreenchange',
   'fullscreenerror', 'webkitfullscreenerror'].forEach(function (name) {
    doc.addEventListener(name, emit, false);
  });

  return {
    isSupported: isSupported,
    isActive: isActive,
    request: request,
    exit: exit,
    toggle: toggle,
    onChange: onChange
  };
}

/* ---- public surface ---- */
window.IOS = window.IOS || {};
window.IOS.Screen = ScreenModule(document, document.body);
window.IOS.Fullscreen = FullscreenModule(document);
window.IOS.Screen.init();

window.IOS.Lifecycle.onResume(function () { window.IOS.Screen.refresh(); });

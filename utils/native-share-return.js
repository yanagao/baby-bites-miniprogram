'use strict';

// wx.onAppHide reason (base library 3.5.7+) distinguishes native pages from
// ordinary exits. Neither a share callback nor an entry scene proves a return.
function createShareReturn(api, timers = {}) {
  const schedule = timers.setTimeout || setTimeout;
  const cancel = timers.clearTimeout || clearTimeout;
  let token = null, timer = null, hidden = false, reason, epoch = 0, disposed = false;
  function stopTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
  }
  function clear() { stopTimer(); token = null; }
  function onAppHide(options) {
    if (disposed) return;
    hidden = true;
    reason = options && options.reason;
    epoch++;
    if (reason === 2 && token && token.epoch === null) {
      token.epoch = epoch;
      stopTimer();
    } else clear();
  }
  const listening = api && typeof api.onAppHide === 'function' && typeof api.offAppHide === 'function';
  if (listening) api.onAppHide(onAppHide);
  return {
    share(value) {
      clear();
      if (disposed || !listening || hidden && reason !== 2) return;
      const next = {value, epoch: hidden ? epoch : null};
      token = next;
      if (!hidden) {
        // A canceled share can leave the page visible without any lifecycle
        // event. Unpaired intent must not authorize an unrelated future hide.
        timer = schedule(() => {
          if (token === next && next.epoch === null) clear();
        }, 0);
      }
    },
    show() {
      const value = !disposed && token && token.epoch === epoch && hidden && reason === 2 ? token.value : null;
      clear();
      hidden = false;
      reason = undefined;
      return value;
    },
    clear,
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      if (listening) api.offAppHide(onAppHide);
    }
  };
}

module.exports = {createShareReturn};

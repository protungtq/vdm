'use strict';

const { execFile } = require('child_process');

const LABELS = { exit: 'Exit app', sleep: 'Sleep', hibernate: 'Hibernate', shutdown: 'Shut down' };
const DELAY_S = 60;

/**
 * Runs the "when the queue finishes" action after a cancellable countdown.
 * onState({ action, label, seconds } | null) keeps the UI informed.
 */
class PowerActions {
  constructor({ onState, quitApp }) {
    this.onState = onState;
    this.quitApp = quitApp;
    this.pending = null;
  }

  schedule(action) {
    if (!LABELS[action]) return;
    this.cancel();
    const deadline = Date.now() + DELAY_S * 1000;
    const tick = () => {
      const seconds = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      this.onState({ action, label: LABELS[action], seconds });
      if (seconds <= 0) {
        this.pending = null;
        this.onState(null);
        this.run(action);
      }
    };
    this.pending = { action, timer: setInterval(tick, 1000) };
    tick();
  }

  cancel() {
    if (!this.pending) return false;
    clearInterval(this.pending.timer);
    this.pending = null;
    this.onState(null);
    return true;
  }

  run(action) {
    if (action === 'exit') return this.quitApp();
    if (process.platform === 'darwin') {
      const mac = (cmd, args) => execFile(cmd, args, (e) => e && console.error('[power]', e.message));
      if (action === 'shutdown') mac('osascript', ['-e', 'tell application "System Events" to shut down']);
      else mac('pmset', ['sleepnow']); // macOS has no separate hibernate
      return;
    }
    if (process.platform !== 'win32') {
      console.log(`[power] would ${action} now (only performed on Windows)`);
      return;
    }
    const sys = (cmd, args) => execFile(cmd, args, { windowsHide: true }, (e) => e && console.error('[power]', e.message));
    if (action === 'shutdown') sys('shutdown', ['/s', '/t', '0']);
    else if (action === 'hibernate') sys('shutdown', ['/h']);
    else if (action === 'sleep') {
      sys('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)",
      ]);
    }
  }
}

module.exports = { PowerActions, LABELS };

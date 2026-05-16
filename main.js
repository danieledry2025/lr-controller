const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const { execFile, spawn } = require('child_process');
const path = require('path');

let win = null;

// ── Swift helper path ─────────────────────────────────────────────────────
function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'lr-helper')
    : path.join(__dirname, 'helper', 'lr-helper');
}

// ── HID device capture (node-hid — in-process, uses app's own permissions) ──
const HID_KEY_NAMES = {
  4:'A',5:'B',6:'C',7:'D',8:'E',9:'F',10:'G',11:'H',
  12:'I',13:'J',14:'K',15:'L',16:'M',17:'N',18:'O',19:'P',
  20:'Q',21:'R',22:'S',23:'T',24:'U',25:'V',26:'W',27:'X',
  28:'Y',29:'Z',
  30:'1',31:'2',32:'3',33:'4',34:'5',35:'6',36:'7',37:'8',38:'9',39:'0',
  40:'ENTER',41:'ESC',42:'BACKSPACE',43:'TAB',44:'SPACE',
  45:'-',46:'=',47:'[',48:']',51:';',52:"'",53:'`',54:',',55:'.',56:'/',
  58:'F1',59:'F2',60:'F3',61:'F4',62:'F5',63:'F6',
  64:'F7',65:'F8',66:'F9',67:'F10',68:'F11',69:'F12',
  73:'INSERT',74:'HOME',75:'PAGEUP',76:'DELETE',77:'END',78:'PAGEDOWN',
  79:'RIGHT',80:'LEFT',81:'DOWN',82:'UP',
  104:'F13',105:'F14',106:'F15',107:'F16',
};

function hidModStr(modByte) {
  let s = '';
  if (modByte & 0x08 || modByte & 0x80) s += '⌘';
  if (modByte & 0x04 || modByte & 0x40) s += '⌥';
  if (modByte & 0x01 || modByte & 0x10) s += '⌃';
  if (modByte & 0x02 || modByte & 0x20) s += '⇧';
  return s;
}

let hidDevice   = null;
let hidPrevKeys = new Set();

function startDeviceCapture(vendorId, productId) {
  stopAllCapture();
  try {
    const HID = require('node-hid');
    // Prefer keyboard interface (usagePage=1, usage=6); fall back to first match
    const allIfaces = HID.devices().filter(d => d.vendorId === vendorId && d.productId === productId);
    const iface = allIfaces.find(d => d.usagePage === 1 && d.usage === 6) || allIfaces[0];
    if (!iface) return { ok: false, error: `Device ${vendorId}:${productId} not found` };
    hidDevice = new HID.HID(iface.path);
    hidDevice.on('data', (data) => {
      const mod  = hidModStr(data[0]);
      const keys = new Set();
      for (let i = 2; i < data.length; i++) {
        if (data[i] > 3) keys.add(data[i]);
      }
      for (const code of keys) {
        if (!hidPrevKeys.has(code)) {
          const base = HID_KEY_NAMES[code] || `KEY${code}`;
          const name = mod ? `${mod}+${base}` : base;
          if (!win) continue;
          if (recording) {
            recordKeyStep(name, hidUsageToScript(code, name));
            win.webContents.send('recorded-step', { type: 'key', name });
          } else {
            win.webContents.send('global-keydown', { name, usage: code });
          }
        }
      }
      for (const code of hidPrevKeys) {
        if (!keys.has(code)) {
          const base = HID_KEY_NAMES[code] || `KEY${code}`;
          const name = mod ? `${mod}+${base}` : base;
          if (win) win.webContents.send('global-keyup', { name, usage: code });
        }
      }
      hidPrevKeys = keys;
    });
    hidDevice.on('error', (err) => {
      hidDevice = null;
      hidPrevKeys = new Set();
      if (win) win.webContents.send('capture-status', { ok: false, error: err.message });
    });
    if (win) win.webContents.send('capture-status', { ok: true, seized: false, mode: 'device' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function stopDeviceCapture() {
  if (hidDevice) {
    try { hidDevice.close(); } catch (_) {}
    hidDevice = null;
    hidPrevKeys = new Set();
  }
}

// ── CGEventTap capture (global, active — consumes keyboard events) ────────
// Keys in mappedKeys are consumed (LR doesn't see them) and we fire the action.
// All other keys are re-injected via osascript so normal typing still works.
let tapProc   = null;
let tapBuf    = '';
let preTapMode = false;
let mappedKeys = new Set();

function tapKeyToScript(vkCode, name) {
  const m = [];
  if (name.includes('⌘')) m.push('command down');
  if (name.includes('⌥')) m.push('option down');
  if (name.includes('⌃')) m.push('control down');
  if (name.includes('⇧')) m.push('shift down');
  const ms = m.length ? ` using {${m.join(',')}}` : '';
  return `key code ${vkCode}${ms}`;
}

function startTapCapture() {
  stopAllCapture();
  tapProc = spawn(helperPath(), ['tap']);
  let tapErrorHandled = false;

  tapProc.on('error', (e) => {
    tapProc = null; tapBuf = '';
    tapErrorHandled = true;
    const r = startGlobalCapture();
    if (win) win.webContents.send('capture-status',
      r.ok ? { ok: true, seized: false, mode: 'global' }
           : { ok: false, error: r.error || e.message });
  });

  tapProc.stdout.on('data', (chunk) => {
    tapBuf += chunk.toString();
    const lines = tapBuf.split('\n');
    tapBuf = lines.pop();
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      try {
        const ev = JSON.parse(l);
        if (!win) continue;

        if (recording) {
          // During recording: record the key AND re-inject so LR performs the action
          if (ev.event === 'keydown') {
            const script = tapKeyToScript(ev.vkCode, ev.name);
            recordKeyStep(ev.name, script);
            win.webContents.send('recorded-step', { type: 'key', name: ev.name });
          }
          const script = tapKeyToScript(ev.vkCode, ev.name);
          if (script) execFile('/usr/bin/osascript',
            ['-e', `tell application "System Events" to ${script}`],
            { timeout: 1000 }, () => {});
        } else {
          if (ev.event === 'keydown') {
            if (mappedKeys.has(ev.name)) {
              // Mapped key — consumed by tap, fire our LR action
              win.webContents.send('global-keydown', { name: ev.name });
            } else {
              // Unmapped — re-inject so other apps receive it normally
              const script = tapKeyToScript(ev.vkCode, ev.name);
              if (script) execFile('/usr/bin/osascript',
                ['-e', `tell application "System Events" to ${script}`],
                { timeout: 1000 }, () => {});
            }
          } else if (ev.event === 'keyup') {
            win.webContents.send('global-keyup', { name: ev.name });
            if (!mappedKeys.has(ev.name)) {
              execFile('/usr/bin/osascript',
                ['-e', `tell application "System Events" to key code ${ev.vkCode}`],
                { timeout: 1000 }, () => {});
            }
          }
        }
      } catch (_) {}
    }
  });

  let tapStderr = '';
  tapProc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    tapStderr = msg;
    if (msg.startsWith('READY') && win) {
      win.webContents.send('capture-status', { ok: true, seized: true, mode: 'tap' });
    } else if (msg.startsWith('ERROR')) {
      tapErrorHandled = true;
      stopTapCapture();
      const r = startGlobalCapture();
      if (win) win.webContents.send('capture-status',
        r.ok ? { ok: true, seized: false, mode: 'global' }
             : { ok: false, error: msg });
    }
  });

  tapProc.on('close', (code) => {
    const wasHandled = tapErrorHandled;
    tapProc = null;
    if (!wasHandled && code !== 0 && win) {
      const detail = tapStderr.startsWith('ERROR') ? tapStderr : `Tap exited (${code})`;
      win.webContents.send('capture-status', { ok: false, error: detail });
    }
  });

  return { ok: true };
}

function stopTapCapture() {
  if (tapProc) { try { tapProc.kill(); } catch (_) {} tapProc = null; tapBuf = ''; }
}

// ── uiohook global capture (passive — fallback when tap unavailable) ──────
let uiohook = null;
let uioActive = false;

const MOD_KC = new Set([42,54,29,3613,56,3640,3675,3676,58,70,3666]);
const KC_NAME = {
  3667:'F1',3668:'F2',3669:'F3',3670:'F4',3671:'F5',3672:'F6',
  3673:'F7',3674:'F8',3675:'F9',3676:'F10',3677:'F11',3678:'F12',
  30:'A',48:'B',46:'C',32:'D',18:'E',33:'F',34:'G',35:'H',
  23:'I',36:'J',37:'K',38:'L',50:'M',49:'N',24:'O',25:'P',
  16:'Q',19:'R',31:'S',20:'T',22:'U',47:'V',17:'W',45:'X',21:'Y',44:'Z',
  2:'1',3:'2',4:'3',5:'4',6:'5',7:'6',8:'7',9:'8',10:'9',11:'0',
  57:'SPACE',28:'ENTER',14:'BACKSPACE',15:'TAB',1:'ESC',
  57416:'UP',57424:'DOWN',57419:'LEFT',57421:'RIGHT',
  57392:'PGUP',57417:'PGDN',57391:'HOME',57423:'END',3663:'DELETE',
};

function uioKeyName(kc, mask) {
  const base = KC_NAME[kc] || `KEY${kc}`;
  const m = [];
  if (mask & 0x04) m.push('⌘');
  if (mask & 0x08) m.push('⌥');
  if (mask & 0x02) m.push('⌃');
  if (mask & 0x01) m.push('⇧');
  return m.length ? m.join('') + '+' + base : base;
}

function startGlobalCapture() {
  if (uioActive) return { ok: true };
  try {
    const { uIOhook } = require('uiohook-napi');
    uiohook = uIOhook;

    uiohook.on('error', (e) => {
      if (win) win.webContents.send('capture-status',
        { ok: false, error: `uiohook error — grant Input Monitoring in System Settings (${e.message})` });
    });

    uiohook.on('keydown', (e) => {
      if (!win || MOD_KC.has(e.keycode)) return;
      const name   = uioKeyName(e.keycode, e.mask || 0);
      const script = uioToScript(e.keycode, e.mask || 0);
      if (recording) {
        recordKeyStep(name, script);
        win.webContents.send('recorded-step', { type: 'key', name });
        return;
      }
      win.webContents.send('global-keydown', { name });
    });

    uiohook.on('keyup', (e) => {
      if (!win || MOD_KC.has(e.keycode)) return;
      win.webContents.send('global-keyup', { name: uioKeyName(e.keycode, e.mask || 0) });
    });

    uiohook.on('mousedown', (e) => {
      if (!recording || !win) return;
      // uiohook reports physical pixels on Retina; getBounds() returns logical points.
      // Divide by scale factor to compare in the same coordinate space.
      const sf = screen.getPrimaryDisplay().scaleFactor || 1;
      const b = win.getBounds();
      if (e.x >= b.x * sf && e.x < (b.x + b.width) * sf &&
          e.y >= b.y * sf && e.y < (b.y + b.height) * sf) return;
      // Store logical coordinates so playback works with CGEvent (which uses logical points)
      const lx = Math.round(e.x / sf);
      const ly = Math.round(e.y / sf);
      recordClickStep(lx, ly);
      win.webContents.send('recorded-step', { type: 'click', x: lx, y: ly });
    });

    uiohook.start();
    uioActive = true;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function stopGlobalCapture() {
  if (!uioActive || !uiohook) return;
  try { uiohook.stop(); uiohook.removeAllListeners(); } catch (_) {}
  uiohook = null;
  uioActive = false;
}

function stopAllCapture() {
  stopDeviceCapture();
  stopGlobalCapture();
  stopTapCapture();
}

// ── osascript conversion ──────────────────────────────────────────────────
const UIO_CHAR = {
  30:'a',48:'b',46:'c',32:'d',18:'e',33:'f',34:'g',35:'h',
  23:'i',36:'j',37:'k',38:'l',50:'m',49:'n',24:'o',25:'p',
  16:'q',19:'r',31:'s',20:'t',22:'u',47:'v',17:'w',45:'x',21:'y',44:'z',
  2:'1',3:'2',4:'3',5:'4',6:'5',7:'6',8:'7',9:'8',10:'9',11:'0',
  12:'-',13:'=',51:',',52:'.',53:'/',39:';',40:"'",41:'`',
};
const UIO_KC = {
  57:49,28:36,14:51,15:48,1:53,
  57416:126,57424:125,57419:123,57421:124,
  57392:116,57417:121,57391:115,57423:119,3663:117,
  3667:122,3668:120,3669:99,3670:118,3671:96,3672:97,
  3673:98,3674:100,3675:101,3676:109,3677:103,3678:111,
};

function uioToScript(kc, mask) {
  const m = [];
  if (mask & 0x04) m.push('command down');
  if (mask & 0x08) m.push('option down');
  if (mask & 0x02) m.push('control down');
  if (mask & 0x01) m.push('shift down');
  const ms = m.length ? ` using {${m.join(',')}}` : '';
  const ch = UIO_CHAR[kc];
  if (ch) return `keystroke "${ch}"${ms}`;
  const k = UIO_KC[kc];
  if (k !== undefined) return `key code ${k}${ms}`;
  return null;
}

const HID_CHAR = {
  4:'a',5:'b',6:'c',7:'d',8:'e',9:'f',10:'g',11:'h',
  12:'i',13:'j',14:'k',15:'l',16:'m',17:'n',18:'o',19:'p',
  20:'q',21:'r',22:'s',23:'t',24:'u',25:'v',26:'w',27:'x',28:'y',29:'z',
  30:'1',31:'2',32:'3',33:'4',34:'5',35:'6',36:'7',37:'8',38:'9',39:'0',
  45:'-',46:'=',47:'[',48:']',51:';',52:"'",53:'`',54:',',55:'.',56:'/',
};
const HID_KC = {
  40:36,41:53,42:51,43:48,44:49,
  79:124,80:123,81:125,82:126,
  74:115,75:116,77:119,78:121,76:117,
  58:122,59:120,60:99,61:118,62:96,63:97,
  64:98,65:100,66:101,67:109,68:103,69:111,
  104:105,105:107,106:113,107:64,
};

function hidUsageToScript(usage, name) {
  const mods = [];
  if (name.includes('⌘')) mods.push('command down');
  if (name.includes('⌥')) mods.push('option down');
  if (name.includes('⌃')) mods.push('control down');
  if (name.includes('⇧')) mods.push('shift down');
  const ms = mods.length ? ` using {${mods.join(',')}}` : '';
  const ch = HID_CHAR[usage];
  if (ch) return `keystroke "${ch}"${ms}`;
  const k = HID_KC[usage];
  if (k !== undefined) return `key code ${k}${ms}`;
  return null;
}

// ── Recording ─────────────────────────────────────────────────────────────
let recording = false;
let recSteps  = [];
let recLastT  = 0;

function recordKeyStep(name, script) {
  const now = Date.now();
  const delay = recLastT ? Math.min(now - recLastT, 3000) : 0;
  recLastT = now;
  if (script) recSteps.push({ type: 'key', name, script, delay });
}

function recordClickStep(x, y) {
  const now = Date.now();
  const delay = recLastT ? Math.min(now - recLastT, 3000) : 0;
  recLastT = now;
  recSteps.push({ type: 'click', x, y, delay });
}

function startRecording() {
  preTapMode = !!tapProc;
  if (tapProc) {
    // Tap mode: tap re-injects all keys during recording so LR responds.
    // Also start uiohook for mouse click capture.
    if (!uioActive) startGlobalCapture();
    recSteps = [];
    recLastT = 0;
    recording = true;
    return { ok: true };
  }
  // Standard: stop device seizure, use uiohook (passive) for everything
  stopDeviceCapture();
  if (!uioActive) {
    const r = startGlobalCapture();
    if (!r.ok) return r;
  }
  recSteps = [];
  recLastT = 0;
  recording = true;
  return { ok: true };
}

function stopRecording(wasDeviceMode, vendorId, productId) {
  recording = false;
  const steps = [...recSteps];
  recSteps = [];

  if (preTapMode) {
    // Was in tap mode before recording — stop uiohook (used for mouse), restart tap
    stopGlobalCapture();
    if (!tapProc) startTapCapture();
    preTapMode = false;
  } else if (wasDeviceMode && vendorId && productId) {
    stopGlobalCapture();
    startDeviceCapture(vendorId, productId);
  }

  if (steps.length === 0 && win) {
    win.webContents.send('capture-status',
      { ok: false, error: 'לא הוקלטו צעדים — ודא שניתנה הרשאת Input Monitoring ל-LR Controller' });
  }
  return { ok: true, steps };
}

// ── Action execution ──────────────────────────────────────────────────────
function sendLRAction(script) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript',
      ['-e', `tell application "System Events" to ${script}`],
      { timeout: 2000 },
      (err) => resolve(err ? { ok: false, error: err.message } : { ok: true }));
  });
}

async function playMacro(steps) {
  if (!steps || steps.length === 0) return { ok: true };
  const hasClicks = steps.some(s => s.type === 'click');

  if (!hasClicks) {
    let as = 'tell application "System Events"\n';
    for (let i = 0; i < steps.length; i++) {
      if (i > 0 && steps[i].delay > 50)
        as += `  delay ${(steps[i].delay / 1000).toFixed(3)}\n`;
      if (steps[i].script) as += `  ${steps[i].script}\n`;
    }
    as += 'end tell';
    return new Promise((resolve) => {
      execFile('/usr/bin/osascript', ['-e', as], { timeout: 15000 },
        (err) => resolve(err ? { ok: false, error: err.message } : { ok: true }));
    });
  }

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (i > 0 && s.delay > 0)
      await new Promise(r => setTimeout(r, Math.min(s.delay, 2000)));

    if (s.type === 'click') {
      await new Promise(r =>
        execFile(helperPath(), ['click', String(s.x), String(s.y)],
          { timeout: 3000 }, r));
    } else if (s.type === 'key' && s.script) {
      await new Promise(r =>
        execFile('/usr/bin/osascript',
          ['-e', `tell application "System Events" to ${s.script}`],
          { timeout: 2000 }, r));
    }
  }
  return { ok: true };
}

// ── IPC ────────────────────────────────────────────────────────────────────
ipcMain.handle('list-devices', () => {
  try {
    const HID = require('node-hid');
    const seen = new Set();
    const result = [];
    for (const d of HID.devices()) {
      const key = `${d.vendorId}:${d.productId}`;
      if (d.vendorId && !seen.has(key)) {
        seen.add(key);
        result.push({
          vendorId:     d.vendorId,
          productId:    d.productId,
          name:         d.product      || 'Unknown',
          manufacturer: d.manufacturer || '',
          usagePage:    d.usagePage    || 0,
        });
      }
    }
    return result;
  } catch (_) {
    return [];
  }
});

ipcMain.handle('start-device-capture', (_, { vendorId, productId }) => {
  const r = startDeviceCapture(vendorId, productId);
  if (!r.ok && win) win.webContents.send('capture-status', { ok: false, error: r.error });
  return r;
});

// Global mode uses tap capture (active — keys consumed for mapped, re-injected otherwise)
ipcMain.handle('start-global-capture', () => {
  stopDeviceCapture();
  return startTapCapture();
});

ipcMain.handle('stop-capture', () => {
  stopAllCapture();
  return { ok: true };
});

ipcMain.handle('send-lr-action', (_, script) => sendLRAction(script));
ipcMain.handle('play-macro', (_, steps) => playMacro(steps));

ipcMain.handle('start-recording', () => startRecording());
ipcMain.handle('stop-recording', (_, opts) =>
  stopRecording(opts && opts.wasDevice, opts && opts.vendorId, opts && opts.productId));

// Renderer sends the current set of mapped key names so tap mode knows
// which keys to consume vs. re-inject to other applications
ipcMain.handle('set-mapped-keys', (_, keys) => {
  mappedKeys = new Set(Array.isArray(keys) ? keys : []);
  return { ok: true };
});

ipcMain.handle('open-accessibility', () =>
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'));
ipcMain.handle('open-input-monitoring', () =>
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'));

// ── Window ─────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1060, height: 840, minWidth: 760, minHeight: 600,
    title: 'LR Controller', backgroundColor: '#0d0d14',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.loadFile('index.html');
  win.webContents.on('render-process-gone', (_, d) => {
    console.error('Renderer crashed:', d.reason);
    setTimeout(() => { if (win && !win.isDestroyed()) win.loadFile('index.html'); }, 500);
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => {
  stopAllCapture();
  if (process.platform !== 'darwin') app.quit();
});

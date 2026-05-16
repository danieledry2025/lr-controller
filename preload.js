const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lrCtrl', {
  listDevices:         ()       => ipcRenderer.invoke('list-devices'),
  startDeviceCapture:  (v, p)   => ipcRenderer.invoke('start-device-capture', { vendorId: v, productId: p }),
  startGlobalCapture:  ()       => ipcRenderer.invoke('start-global-capture'),
  stopCapture:         ()       => ipcRenderer.invoke('stop-capture'),
  sendLRAction:        (s)      => ipcRenderer.invoke('send-lr-action', s),
  playMacro:           (steps)  => ipcRenderer.invoke('play-macro', steps),
  startRecording:      ()       => ipcRenderer.invoke('start-recording'),
  stopRecording:       (opts)   => ipcRenderer.invoke('stop-recording', opts),
  setMappedKeys:       (keys)   => ipcRenderer.invoke('set-mapped-keys', keys),
  openAccessibility:   ()       => ipcRenderer.invoke('open-accessibility'),
  openInputMonitoring: ()       => ipcRenderer.invoke('open-input-monitoring'),
  onKeyDown:       (cb) => ipcRenderer.on('global-keydown',   (_, d) => cb(d)),
  onKeyUp:         (cb) => ipcRenderer.on('global-keyup',     (_, d) => cb(d)),
  onCaptureStatus: (cb) => ipcRenderer.on('capture-status',   (_, d) => cb(d)),
  onRecordedStep:  (cb) => ipcRenderer.on('recorded-step',    (_, d) => cb(d)),
});

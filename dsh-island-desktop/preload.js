const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__island', {
  onState(handler) {
    ipcRenderer.on('island:state', (_event, state) => handler(state));
  },
  onTheme(handler) {
    ipcRenderer.on('island:theme', (_event, theme) => handler(theme));
  },
  // Dragging is done by hand (no -webkit-app-region) so the same surface can also
  // tell a click from a double click.
  dragStart(point) {
    ipcRenderer.send('island:drag-start', point);
  },
  dragMove(point) {
    ipcRenderer.send('island:drag-move', point);
  },
  dragEnd() {
    ipcRenderer.send('island:drag-end');
  },
  // The renderer measures the row and asks the window to hug it.
  fit(width) {
    ipcRenderer.send('island:fit', Number(width) || 0);
  },
  openDsh() {
    return ipcRenderer.invoke('island:open-dsh');
  },
  log(kind) {
    ipcRenderer.send('island:gesture', String(kind));
  },
});

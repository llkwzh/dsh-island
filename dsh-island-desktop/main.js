// Electron shell for the desktop island.
//
// One frameless, transparent, always-on-top window that floats over the whole
// desktop — not inside any app window. It is a long-lived companion of the DSH
// host process: the host plugin starts it, feeds it over a loopback HTTP
// endpoint, and kills it when the plugin unloads.
const { app, BrowserWindow, Menu, screen, shell, nativeTheme, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();
app.setAppUserModelId('com.dsh.island');
// A second copy would put two identical cards on the desktop.
if (!app.requestSingleInstanceLock()) app.exit(0);

const argv = process.argv.slice(1);
function arg(name, fallback) {
  const hit = argv.find((value) => value.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const feedUrl = arg('feed', '');
// auto (default) follows the OS app theme; light/dark are pinned by --theme or the right-click menu.
let themeMode = arg('theme', '') || readThemePref() || 'auto';
const logFile = path.join(app.getPath('userData'), 'island.log');

function log(...parts) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, new Date().toISOString() + ' ' + parts.join(' ') + '\n');
  } catch (e) {}
}

// One row: the window hugs the text, so the width lives in `currentWidth`
// and is re-measured by the renderer after every paint.
const MIN_WIDTH = 220;
const MAX_WIDTH = 760;
const HEIGHT = 52;
// How close (in DIP) an edge has to be before the card is pulled flush against it.
const SNAP_THRESHOLD = 20;

function themePrefFile() {
  return path.join(app.getPath('userData'), 'theme.json');
}

function readThemePref() {
  try {
    const parsed = JSON.parse(fs.readFileSync(themePrefFile(), 'utf8'));
    if (parsed && (parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'auto')) {
      return parsed.theme;
    }
  } catch (e) {}
  return '';
}

function writeThemePref(mode) {
  try {
    fs.mkdirSync(path.dirname(themePrefFile()), { recursive: true });
    fs.writeFileSync(themePrefFile(), JSON.stringify({ theme: mode }));
  } catch (e) {}
}

/** Palette in force right now: pinned by --theme / the menu, otherwise the OS app theme. */
function currentTheme() {
  if (themeMode === 'light' || themeMode === 'dark') return themeMode;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

/** Switch the palette live (no restart) and remember the choice for next launch. */
function applyTheme(mode, persist = true) {
  themeMode = mode === 'light' || mode === 'dark' ? mode : 'auto';
  if (persist) writeThemePref(themeMode);
  log('theme', themeMode, '->', currentTheme());
  if (win && !win.isDestroyed()) win.webContents.send('island:theme', currentTheme());
}

function positionFile() {
  return path.join(app.getPath('userData'), 'position.json');
}

function readPosition() {
  try {
    const parsed = JSON.parse(fs.readFileSync(positionFile(), 'utf8'));
    if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) return parsed;
  } catch (e) {}
  return null;
}

function writePosition(bounds) {
  try {
    fs.mkdirSync(path.dirname(positionFile()), { recursive: true });
    fs.writeFileSync(positionFile(), JSON.stringify({ x: bounds.x, y: bounds.y }));
  } catch (e) {}
}

function defaultPosition() {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + (area.width - currentWidth) / 2),
    y: area.y + 10,
  };
}

/** Keep the card fully on a display even after a resize or a monitor change. */
function clampToWorkArea(position) {
  const display = screen.getDisplayNearestPoint({ x: position.x, y: position.y });
  const area = (display ?? screen.getPrimaryDisplay()).workArea;
  return {
    x: Math.min(Math.max(position.x, area.x), Math.max(area.x, area.x + area.width - currentWidth)),
    y: Math.min(Math.max(position.y, area.y), Math.max(area.y, area.y + area.height - HEIGHT)),
  };
}

/**
 * Edge magnet: when a border comes within SNAP_THRESHOLD of the work area's border, the card is
 * pulled flush against it. Returns the position it should occupy (unchanged when nothing is near).
 */
function snappedPosition(bounds, area) {
  const next = { x: bounds.x, y: bounds.y };
  const left = bounds.x - area.x;
  const right = area.x + area.width - (bounds.x + bounds.width);
  const top = bounds.y - area.y;
  const bottom = area.y + area.height - (bounds.y + bounds.height);
  if (left >= 0 && left <= SNAP_THRESHOLD) next.x = area.x;
  else if (right >= 0 && right <= SNAP_THRESHOLD) next.x = area.x + area.width - bounds.width;
  if (top >= 0 && top <= SNAP_THRESHOLD) next.y = area.y;
  else if (bottom >= 0 && bottom <= SNAP_THRESHOLD) next.y = area.y + area.height - bounds.height;
  return next;
}

let win = null;
// Guards the move handler against re-entering itself while it nudges the window.
let snapping = false;
// A hand-rolled drag in progress (see the island:drag-* channels below).
let dragging = false;
let dragOrigin = null;
// A width/height change in progress; the magnet must stay out of the way while it runs.
let resizing = false;
// Windows grows a frameless window by ~1px on every setPosition/setBounds that
// omits the size, so every placement re-states the full geometry.
let currentWidth = 316;
const currentHeight = HEIGHT;

function place(x, y, width) {
  if (!win || win.isDestroyed()) return;
  currentWidth = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)));
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: currentWidth, height: HEIGHT });
}

function nudgeWindow(target, bounds) {
  if (!win || win.isDestroyed()) return;
  if (target.x === bounds.x && target.y === bounds.y) return;
  snapping = true;
  place(target.x, target.y, currentWidth);
  setTimeout(() => {
    snapping = false;
  }, 120);
}

function createWindow() {
  const saved = readPosition();
  const position = clampToWorkArea(saved || defaultPosition());

  win = new BrowserWindow({
    width: currentWidth,
    height: HEIGHT,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: 'DSH Island',
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const query = {
    feed: feedUrl,
    version: app.getVersion(),
    theme: currentTheme(),
  };
  win.loadFile(path.join(__dirname, 'index.html'), { query });

  // Magnet: snapping mid-drag fights the OS move loop, so wait until the card settles
  // (the drag paused or ended), then pull it flush against the nearest border.
  let settleTimer = null;
  const magnetise = () => {
    if (snapping || dragging || resizing || !win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    // A card dragged past the border comes back on-screen first, then gets pulled flush.
    const clamped = clampToWorkArea({ x: bounds.x, y: bounds.y });
    const target = snappedPosition({ ...bounds, x: clamped.x, y: clamped.y }, area);
    if (target.x === bounds.x && target.y === bounds.y) return;
    snapping = true;
    place(target.x, target.y, currentWidth);
    setTimeout(() => {
      snapping = false;
      if (win && !win.isDestroyed()) writePosition(win.getBounds());
    }, 120);
  };
  // Persist only once the geometry has been quiet for a moment: snapping during the drag
  // makes intermediate bounds meaningless, and the final bounds are what should survive.
  let persistTimer = null;
  const persistSoon = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) writePosition(win.getBounds());
    }, 240);
  };
  win.on('move', () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(magnetise, 150);
    persistSoon();
  });

  // ------------------------------------------------------------ click / drag / expand
  //
  // The card must tell a click from a double click, so dragging is done by hand:
  // -webkit-app-region: drag would hand the mouse to the OS and the page would never
  // see pointerup. The renderer sends screen coordinates; we move the window by delta.
  // The renderer measures its single row and asks for the width that fits it.
  // Growing keeps the left edge pinned, so the card opens to the right like a label.
  let fitTimer = null;
  let pendingWidth = 0;
  ipcMain.on('island:fit', (_event, width) => {
    const wanted = Number(width);
    if (!Number.isFinite(wanted) || !win || win.isDestroyed()) return;
    pendingWidth = wanted;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const bounds = win.getBounds();
      const target = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, pendingWidth)));
      if (Math.abs(target - bounds.width) < 3) return;
      resizing = true;
      place(bounds.x, bounds.y, target);
      setTimeout(() => {
        resizing = false;
      }, 90);
    }, 90);
  });

  let dragProbe = 0;
  ipcMain.on('island:drag-start', (_event, point) => {
    if (!win || win.isDestroyed() || !point) return;
    const bounds = win.getBounds();
    dragOrigin = {
      winX: bounds.x,
      winY: bounds.y,
      screenX: Number(point.screenX) || 0,
      screenY: Number(point.screenY) || 0,
    };
    dragging = true;
    clearTimeout(settleTimer);
  });

  ipcMain.on('island:drag-move', (_event, point) => {
    if (!dragging || !dragOrigin || !win || win.isDestroyed() || !point) return;
    const bounds = win.getBounds();
    const x = dragOrigin.winX + (Number(point.screenX) - dragOrigin.screenX);
    const y = dragOrigin.winY + (Number(point.screenY) - dragOrigin.screenY);
    place(x, y, currentWidth);
    if (!dragProbe || Date.now() - dragProbe > 200) {
      dragProbe = Date.now();
      log('drag-bounds', JSON.stringify(win.getBounds()), 'want', Math.round(x) + ',' + Math.round(y));
    }
  });

  ipcMain.on('island:drag-end', () => {
    if (!dragging) return;
    dragging = false;
    dragOrigin = null;
    magnetise();
    persistSoon();
  });

  ipcMain.on('island:gesture', (_event, kind) => log('gesture', String(kind)));

  // Double click: bring the DSH window back to the front. Our own process is a plain
  // Node side-car, so the only handle we have on the app window is the OS.
  const activateDsh = () => {
    const script = [
      "Add-Type -Namespace Island -Name Win -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);';",
      "$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like '*DeepSeek*' } | Select-Object -First 1;",
      "if ($p) { $h = $p.MainWindowHandle; $ws = New-Object -ComObject WScript.Shell; $ws.AppActivate($p.Id) | Out-Null; [Island.Win]::ShowWindow($h, 9) | Out-Null; [Island.Win]::SetForegroundWindow($h) | Out-Null; 'activated ' + $p.Id } else { 'no-window' }",
    ].join(' ');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    return new Promise((resolve) => {
      try {
        const child = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
          windowsHide: true,
          env,
        });
        let out = '';
        child.stdout.on('data', (chunk) => {
          out += chunk;
        });
        child.on('error', (error) => {
          const message = String(error && error.message);
          log('open-dsh failed', message);
          resolve({ ok: false, reason: message });
        });
        child.on('close', () => {
          const text = out.trim();
          log('open-dsh', text || '(no output)');
          const hit = /activated (\d+)/.exec(text);
          resolve(hit ? { ok: true, pid: Number(hit[1]) } : { ok: false, reason: text || 'no-window' });
        });
      } catch (error) {
        const message = String(error && error.message);
        log('open-dsh threw', message);
        resolve({ ok: false, reason: message });
      }
    });
  };
  ipcMain.handle('island:open-dsh', () => activateDsh());

  // Keep the palette in step with the OS theme (no-op while a mode is pinned).
  nativeTheme.on('updated', () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('island:theme', currentTheme());
  });

  // Right-click: pick the palette, or put the card back at the top centre.
  const buildMenu = () => {
    const options = [
      { label: '跟随系统', mode: 'auto' },
      { label: '浅色', mode: 'light' },
      { label: '深色', mode: 'dark' },
    ];
    return Menu.buildFromTemplate([
      ...options.map((option) => ({
        label: option.label,
        type: 'radio',
        checked: themeMode === option.mode,
        click: () => applyTheme(option.mode),
      })),
      { type: 'separator' },
      {
        label: '位置复位',
        click: () => {
          const home = defaultPosition();
          if (win && !win.isDestroyed()) place(home.x, home.y, currentWidth);
          writePosition(home);
        },
      },
      { label: '回到 DSH', click: () => activateDsh() },
      { label: '重新加载', click: () => win && !win.isDestroyed() && win.webContents.reload() },
    ]);
  };
  let menuOpenedAt = 0;
  const popupMenu = (point) => {
    if (!win || win.isDestroyed()) return;
    // Windows fires both `system-context-menu` and a DOM `contextmenu` for one
    // right-click; showing two menus in a row closes the first one instantly.
    const stamp = Date.now();
    if (stamp - menuOpenedAt < 200) return;
    menuOpenedAt = stamp;
    const menu = buildMenu();
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      menu.popup({ window: win, x: Math.round(point.x), y: Math.round(point.y) });
    } else {
      menu.popup({ window: win });
    }
  };

  win.webContents.on('context-menu', () => { log('menu', 'dom-contextmenu'); popupMenu(); });

  // The card is one big `-webkit-app-region: drag` surface, so Windows answers a
  // right-click with the native window menu instead of a DOM contextmenu event.
  // Intercept it and show ours at the same spot.
  win.on('system-context-menu', (event, point) => {
    log('menu', 'system-context-menu', JSON.stringify(point));
    event.preventDefault();
    popupMenu(point);
  });

  // Re-fit on resolution / taskbar / monitor changes so the card never ends up half off-screen.
  const refit = () => {
    if (!win || win.isDestroyed() || snapping) return;
    const bounds = win.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const clamped = clampToWorkArea({ x: bounds.x, y: bounds.y });
    const snapped = snappedPosition({ ...bounds, x: clamped.x, y: clamped.y }, area);
    nudgeWindow(snapped, bounds);
  };
  screen.on('display-metrics-changed', refit);
  screen.on('display-added', refit);
  screen.on('display-removed', refit);

  win.once('ready-to-show', () => {
    win.showInactive();
    log('shown', JSON.stringify(win.getBounds()), 'feed=' + (feedUrl || '(none)'));
    const shot = arg('shot', '');
    if (shot) {
      // Verification hook: render one frame to disk so the visuals can be inspected without
      // a screen grab (and without depending on DPI awareness of the grabbing tool).
      setTimeout(() => {
        win.webContents
          .capturePage()
          .then((image) => {
            fs.writeFileSync(shot, image.toPNG());
            log('shot', shot, image.getSize().width + 'x' + image.getSize().height);
          })
          .catch((error) => log('shot failed', String(error && error.message)));
      }, 700);
    }
  });



  win.on('moved', persistSoon);
  win.on('will-resize', (event, newBounds, details) => {
    log('will-resize', JSON.stringify(newBounds), JSON.stringify(details || null));
  });
  win.on('resize', () => {
    if (win && !win.isDestroyed()) log('resize', JSON.stringify(win.getBounds()));
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    log('renderer gone', JSON.stringify(details));
  });

  win.on('closed', () => {
    win = null;
    app.quit();
  });
}

app.whenReady().then(() => {
  log('boot', 'pid=' + process.pid);
  try {
    createWindow();
  } catch (error) {
    log('FATAL', error && error.stack ? error.stack : String(error));
    app.exit(1);
  }
});

app.on('second-instance', () => app.quit());
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => log('quit'));

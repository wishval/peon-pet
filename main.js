const { app, BrowserWindow, screen, Menu, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  isValidSessionId,
  createSessionTracker,
  buildSessionStates,
  EVENT_TO_ANIM,
} = require('./lib/session-tracker');

let win;
let petVisible = true;
let currentCorner = 'bottom-left';
let currentDisplayIndex = 0;

const WIN_SIZE = 200;
const MARGIN = 20;

// --- Character system ---
// Canonical asset names → orc bundled filenames
const ORC_FILE_MAP = {
  'sprite-atlas.png': 'orc-sprite-atlas.png',
  'borders.png':      'orc-borders.png',
  'bg.png':           'bg-pixel.png',
  'dock-icon.png':    'orc-dock-icon.png',
};

function loadPetConfig() {
  try {
    return JSON.parse(fs.readFileSync(
      path.join(app.getPath('userData'), 'peon-pet-config.json'), 'utf8'
    ));
  } catch { return {}; }
}

function savePetConfig(patch) {
  const cfgPath = path.join(app.getPath('userData'), 'peon-pet-config.json');
  const existing = loadPetConfig();
  fs.writeFileSync(cfgPath, JSON.stringify({ ...existing, ...patch }, null, 2));
}

function getTargetDisplay(displayIndex) {
  const displays = screen.getAllDisplays();
  if (displayIndex >= 0 && displayIndex < displays.length) {
    return { display: displays[displayIndex], index: displayIndex };
  }
  const primary = screen.getPrimaryDisplay();
  const idx = displays.indexOf(primary);
  return { display: primary, index: Math.max(idx, 0) };
}

function calculateWindowPosition(corner, displayIndex) {
  const { display, index } = getTargetDisplay(displayIndex);
  const { x: wx, y: wy, width, height } = display.workArea;

  const positions = {
    'top-left':     { x: wx + MARGIN,                     y: wy + MARGIN },
    'top-right':    { x: wx + width - WIN_SIZE - MARGIN,  y: wy + MARGIN },
    'bottom-left':  { x: wx + MARGIN,                     y: wy + height - WIN_SIZE - MARGIN },
    'bottom-right': { x: wx + width - WIN_SIZE - MARGIN,  y: wy + height - WIN_SIZE - MARGIN },
  };

  return { ...positions[corner], displayIndex: index };
}

function moveWindowTo(corner, displayIndex) {
  const pos = calculateWindowPosition(corner, displayIndex);
  currentCorner = corner;
  currentDisplayIndex = pos.displayIndex;

  if (win && !win.isDestroyed()) {
    win.setPosition(pos.x, pos.y);
  }

  savePetConfig({ position: currentCorner, displayIndex: currentDisplayIndex });
  if (process.platform === 'darwin') {
    app.dock.setMenu(buildDockMenu());
  }
}

function registerCharacterProtocol() {
  const cfg = loadPetConfig();
  const char = cfg.character || 'orc';
  const orcAssetsDir = path.join(__dirname, 'renderer', 'assets');
  const customCharDir = path.join(app.getPath('userData'), 'characters', char);

  protocol.handle('peon-asset', (request) => {
    const filename = new URL(request.url).hostname;
    // For custom character: try custom dir first, fall back to orc
    if (char !== 'orc' && fs.existsSync(path.join(customCharDir, filename))) {
      return net.fetch('file://' + path.join(customCharDir, filename));
    }
    // Default orc: map canonical → actual filename
    const orcFile = ORC_FILE_MAP[filename] || filename;
    return net.fetch('file://' + path.join(orcAssetsDir, orcFile));
  });

  return { char, orcAssetsDir, customCharDir };
}

// Path to peon-ping state file
const STATE_FILE = path.join(os.homedir(), '.claude', 'hooks', 'peon-ping', '.state.json');

let lastTimestamp = 0;

const tracker = createSessionTracker();
const sessionCwds = new Map();  // session_id → cwd string
const remoteSessionIds = new Set();
const remoteLastEvents = new Map();  // session_id → last event string
const SESSION_PRUNE_MS = 10 * 60 * 1000;  // 10min — prune cold sessions
const HOT_MS  = 30 * 1000;       // 30s  — actively working right now
const WARM_MS = 2 * 60 * 1000;   // 2min — session open but idle

function readStateFile() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readRemoteState(baseUrl) {
  try {
    const res = await net.fetch(`${baseUrl}/state`, { signal: AbortSignal.timeout(150) });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function processStateUpdate(state, lastTs, setLastTs) {
  if (!state || !state.last_active) return lastTs;

  const { timestamp, event, session_id, cwd } = state.last_active;
  if (timestamp === lastTs) return lastTs;
  setLastTs(timestamp);

  const now = Date.now();

  if (isValidSessionId(session_id)) {
    if (event === 'SessionEnd') {
      tracker.remove(session_id);
      sessionCwds.delete(session_id);
    } else {
      // On SessionStart, deduplicate: if exactly one other session was seen
      // within the last 5s, it's likely the same window transitioning to a
      // resumed session (e.g. /resume in Claude Code) — replace it.
      if (event === 'SessionStart') {
        const existing = tracker.entries();
        const isNew = !existing.some(([id]) => id === session_id);
        if (isNew && existing.length === 1) {
          const [oldId, oldTime] = existing[0];
          if ((now - oldTime) < 5000) {
            tracker.remove(oldId);
          }
        }
      }
      tracker.update(session_id, now);
      if (cwd) sessionCwds.set(session_id, cwd);
    }
    tracker.prune(now - SESSION_PRUNE_MS);
    // Keep sessionCwds in sync with tracker
    for (const id of sessionCwds.keys()) {
      if (!tracker.entries().some(([sid]) => sid === id)) sessionCwds.delete(id);
    }
  }

  if (win && !win.isDestroyed()) {
    const sessions = buildSessionStates(tracker.entries(), now, HOT_MS, WARM_MS, 10);
    const sessionsWithCwd = sessions.map(s => ({
      ...s,
      cwd: sessionCwds.get(s.id) || null,
    }));
    win.webContents.send('session-update', { sessions: sessionsWithCwd });
  }

  const anim = EVENT_TO_ANIM[event];
  if (anim && win && !win.isDestroyed()) {
    win.webContents.send('peon-event', { anim, event });
  }

  return timestamp;
}

function syncRemoteSessionsToTracker(state) {
  if (!state || !state.sessions) return;
  const now = Date.now();
  const incoming = state.sessions;

  for (const [sid, entry] of Object.entries(incoming)) {
    if (!isValidSessionId(sid)) continue;
    tracker.update(sid, entry.timestamp * 1000);  // relay uses Unix seconds
    if (entry.cwd) sessionCwds.set(sid, entry.cwd);
    remoteSessionIds.add(sid);
    const anim = EVENT_TO_ANIM[entry.event];
    if (anim && entry.event !== remoteLastEvents.get(sid)) {
      remoteLastEvents.set(sid, entry.event);
      if (win && !win.isDestroyed()) win.webContents.send('peon-event', { anim, event: entry.event });
    }
  }

  for (const sid of [...remoteSessionIds]) {
    if (!incoming[sid]) {
      tracker.remove(sid);
      sessionCwds.delete(sid);
      remoteSessionIds.delete(sid);
      remoteLastEvents.delete(sid);
    }
  }

  if (win && !win.isDestroyed()) {
    const sessions = buildSessionStates(tracker.entries(), now, HOT_MS, WARM_MS, 10);
    const sessionsWithCwd = sessions.map(s => ({ ...s, cwd: sessionCwds.get(s.id) || null }));
    win.webContents.send('session-update', { sessions: sessionsWithCwd });
  }
}

function startPolling() {
  const cfg = loadPetConfig();
  const remoteUrl = cfg.remoteUrl || 'http://127.0.0.1:19998';

  setInterval(async () => {
    processStateUpdate(readStateFile(), lastTimestamp, (ts) => { lastTimestamp = ts; });
    syncRemoteSessionsToTracker(await readRemoteState(remoteUrl));
  }, 200);
}

// Poll cursor position to enable mouse events only when hovering the window.
// This lets the renderer receive mousemove for tooltips while keeping click-through.
function startMouseTracking() {
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const { x: cx, y: cy } = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    const [ww, wh] = win.getSize();
    const inside = cx >= wx && cx <= wx + ww && cy >= wy && cy <= wy + wh;
    win.setIgnoreMouseEvents(!inside);
  }, 50);
}

function buildDockMenu() {
  const corners = [
    { label: 'Bottom Left',  value: 'bottom-left' },
    { label: 'Bottom Right', value: 'bottom-right' },
    { label: 'Top Left',     value: 'top-left' },
    { label: 'Top Right',    value: 'top-right' },
  ];

  const displays = screen.getAllDisplays();
  const hasMultipleDisplays = displays.length > 1;

  const positionSubmenu = [
    ...corners.map(c => ({
      label: c.label,
      type: 'radio',
      checked: currentCorner === c.value,
      click() { moveWindowTo(c.value, currentDisplayIndex); },
    })),
    { type: 'separator' },
    {
      label: 'Move to Next Screen',
      enabled: hasMultipleDisplays,
      click() {
        const nextIndex = (currentDisplayIndex + 1) % displays.length;
        moveWindowTo(currentCorner, nextIndex);
      },
    },
  ];

  return Menu.buildFromTemplate([
    {
      label: petVisible ? 'Hide Pet' : 'Show Pet',
      click() {
        if (!win || win.isDestroyed()) return;
        if (petVisible) {
          win.hide();
        } else {
          win.show();
        }
        petVisible = !petVisible;
        app.dock.setMenu(buildDockMenu());
      },
    },
    { type: 'separator' },
    {
      label: 'Position',
      submenu: positionSubmenu,
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click() {
        app.quit();
      },
    },
  ]);
}

function createWindow() {
  const cfg = loadPetConfig();
  currentCorner = cfg.position || 'bottom-left';
  currentDisplayIndex = cfg.displayIndex || 0;

  const pos = calculateWindowPosition(currentCorner, currentDisplayIndex);
  currentDisplayIndex = pos.displayIndex;

  win = new BrowserWindow({
    width: WIN_SIZE,
    height: WIN_SIZE,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setIgnoreMouseEvents(true);

  win.loadFile('renderer/index.html');

  if (process.platform === 'darwin') {
    const char = cfg.character || 'orc';
    const customIcon = path.join(app.getPath('userData'), 'characters', char, 'dock-icon.png');
    const iconPath = (char !== 'orc' && fs.existsSync(customIcon))
      ? customIcon
      : path.join(__dirname, 'renderer', 'assets', 'orc-dock-icon.png');
    app.dock.setIcon(iconPath);
    app.dock.setMenu(buildDockMenu());
  }

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  // Start polling once window is ready
  win.webContents.once('did-finish-load', () => {
    startPolling();
    startMouseTracking();
  });
}

app.setName('Peon Pet');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    registerCharacterProtocol();
    createWindow();

    screen.on('display-removed', () => {
      const displays = screen.getAllDisplays();
      if (currentDisplayIndex >= displays.length) {
        moveWindowTo(currentCorner, 0);
      }
      if (process.platform === 'darwin') {
        app.dock.setMenu(buildDockMenu());
      }
    });

    screen.on('display-added', () => {
      if (process.platform === 'darwin') {
        app.dock.setMenu(buildDockMenu());
      }
    });
  });
  app.on('window-all-closed', () => app.quit());
}

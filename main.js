const { app, BrowserWindow, ipcMain, Menu,
        shell, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

let mainWindow;

const STEAM_SEARCH_URL = 'https://store.steampowered.com/api/storesearch/';
const STEAM_APP_DETAILS_URL = 'https://store.steampowered.com/api/appdetails';
const STEAM_STORE_APP = 'https://store.steampowered.com/app/';

const GAMES_FILE = () => path.join(app.getPath('userData'), 'games.json');
const COVERS_DIR = () => path.join(app.getPath('userData'), 'covers');

async function fetchMoreLikeThis(appid) {
  try {
    const url = `https://store.steampowered.com/recommended/morelike/${appid}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const html = await res.text();
    const appids = [];
    const regex = /store\.steampowered\.com\/app\/(\d+)\//g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      if (!appids.includes(match[1])) {
        appids.push(match[1]);
      }
    }
    return appids.slice(0, 15);
  } catch (e) {
    console.error('More like this failed for appid', appid, e);
    return [];
  }
}

async function fetchGameDetails(appid) {
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic`;
    const res = await fetch(url);
    const data = await res.json();
    const appData = data[appid]?.data;
    if (!appData) return null;
    return {
      appid: String(appid),
      name: appData.name,
      header_image: `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`,
    };
  } catch (e) {
    console.error('Game details failed for', appid, e);
    return null;
  }
}

function isSteamAppid(appid) {
  return appid && !String(appid).startsWith('custom_');
}

function getRecentCompletedGames(library, limit = 3) {
  return library
    .filter((game) => game.status === 'completed' && isSteamAppid(game.appid))
    .sort((a, b) => b.addedAt - a.addedAt)
    .slice(0, limit);
}

function getSourceGamesFromAppids(library, sourceAppids) {
  return sourceAppids
    .map((appid) =>
      library.find(
        (g) =>
          String(g.appid) === String(appid) &&
          g.status === 'completed' &&
          isSteamAppid(g.appid)
      )
    )
    .filter(Boolean);
}

async function buildSuggestionsFromCompleted(library, sourceAppids) {
  const sourceGames =
    Array.isArray(sourceAppids) && sourceAppids.length > 0
      ? getSourceGamesFromAppids(library, sourceAppids)
      : getRecentCompletedGames(library, 3);

  const derivedSourceAppids = sourceGames.map((g) => g.appid);

  if (derivedSourceAppids.length === 0) {
    return { suggestions: [], reason: 'no_completed', basedOn: [] };
  }

  const libraryAppIds = new Set(
    library.filter((g) => g.appid).map((g) => String(g.appid))
  );

  const morelikeResults = await Promise.all(
    derivedSourceAppids.slice(0, 3).map((appid) => fetchMoreLikeThis(appid))
  );
  const allSuggestedIds = [...new Set(morelikeResults.flat())];

  if (allSuggestedIds.length === 0) {
    return {
      suggestions: [],
      reason: 'fetch_failed',
      basedOn: sourceGames.map((g) => ({ appid: g.appid, name: g.name })),
    };
  }

  const detailResults = await Promise.all(
    allSuggestedIds
      .filter((id) => !libraryAppIds.has(String(id)))
      .slice(0, 12)
      .map((appid) => fetchGameDetails(appid))
  );

  const suggestions = [];
  for (const details of detailResults) {
    if (!details) continue;

    let tags = [];
    try {
      tags = await fetchSteamTags(details.appid);
    } catch {
      tags = [];
    }

    suggestions.push({
      appid: Number(details.appid),
      name: details.name,
      headerImage: details.header_image,
      storeUrl: `${STEAM_STORE_APP}${details.appid}/`,
      tags,
    });
  }

  if (suggestions.length === 0 && allSuggestedIds.length > 0) {
    return {
      suggestions: [],
      reason: 'all_owned',
      basedOn: sourceGames.map((g) => ({ appid: g.appid, name: g.name })),
    };
  }

  if (suggestions.length === 0) {
    return {
      suggestions: [],
      reason: 'fetch_failed',
      basedOn: sourceGames.map((g) => ({ appid: g.appid, name: g.name })),
    };
  }

  return {
    suggestions,
    reason: 'ok',
    basedOn: sourceGames.map((g) => ({ appid: g.appid, name: g.name })),
  };
}
async function steamFetch(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Steam API error: ${res.status}`);
  return res.json();
}

function extractTagsFromAppDetails(data, appid) {
  const entry = data[String(appid)];
  if (!entry?.success || !entry.data) return [];

  const tags = new Set();
  for (const genre of entry.data.genres || []) {
    if (genre.description) tags.add(genre.description);
  }
  for (const category of entry.data.categories || []) {
    if (category.description) tags.add(category.description);
  }
  return [...tags];
}

async function fetchSteamTags(appid) {
  const url = `${STEAM_APP_DETAILS_URL}?appids=${appid}&l=english`;
  const data = await steamFetch(url);
  return extractTagsFromAppDetails(data, appid);
}

async function searchSteamStore(term) {
  const url = `${STEAM_SEARCH_URL}?term=${encodeURIComponent(term)}&l=english&cc=US`;
  const data = await steamFetch(url);
  return data.items || [];
}

async function ensureCoversDir() {
  await fs.mkdir(COVERS_DIR(), { recursive: true });
}

async function readGamesFile() {
  const filePath = GAMES_FILE();
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    const games = Array.isArray(data.games) ? data.games : [];
    return games.map(normalizeGame);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function normalizeGame(game) {
  return {
    ...game,
    status: game.status === 'completed' ? 'completed' : 'backlog',
    tags: Array.isArray(game.tags) ? game.tags : [],
    addedAt: game.addedAt || Date.now(),
  };
}

async function writeGamesFile(games) {
  const filePath = GAMES_FILE();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ games }, null, 2), 'utf8');
}

function parseLibraryImport(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.games)) return data.games;
  return null;
}

async function triggerAppReload() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('trigger-refresh');
    await new Promise((r) => setTimeout(r, 600));
    mainWindow.webContents.reload();
  }
}

function handleMenuRefresh() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('trigger-refresh');
  }
}

async function handleMenuExport() {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Library',
    defaultPath: 'game-library-export.json',
    filters: [{ name: 'JSON Files', extensions: ['json'] }],
  });

  if (result.canceled || !result.filePath) return;

  try {
    let content;
    try {
      content = await fs.readFile(GAMES_FILE(), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        content = JSON.stringify({ games: [] }, null, 2);
      } else {
        throw err;
      }
    }
    await fs.writeFile(result.filePath, content, 'utf8');

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('export-success');
    }
  } catch (err) {
    dialog.showErrorBox('Export Failed', err.message || 'Could not export library.');
  }
}

async function askMergeDialog() {
  return new Promise((resolve) => {
    const handler = (_event, result) => {
      ipcMain.removeListener('merge-dialog-response', handler);
      resolve(result);
    };
    ipcMain.once('merge-dialog-response', handler);
    mainWindow.webContents.send('show-merge-dialog');
  });
}

function mergeLibraries(existingGames, importedGames) {
  const mergedGames = [...existingGames];

  for (const importedGame of importedGames) {
    if (!importedGame.appid) {
      mergedGames.push(importedGame);
      continue;
    }

    const existingGame = mergedGames.find(
      (g) => g.appid === importedGame.appid
    );

    if (!existingGame) {
      if (!importedGame.status ||
          (importedGame.status !== 'completed' &&
           importedGame.status !== 'backlog')) {
        importedGame.status = 'backlog';
      }
      mergedGames.push(importedGame);
    } else {
      if (importedGame.status === 'completed' &&
          existingGame.status !== 'completed') {
        existingGame.status = 'completed';
      }

      if (!existingGame.status ||
          (existingGame.status !== 'completed' &&
           existingGame.status !== 'backlog')) {
        existingGame.status = 'backlog';
      }
    }
  }

  return mergedGames;
}

async function handleMenuLoad() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Load Library',
    filters: [{ name: 'JSON Files', extensions: ['json'] }],
    properties: ['openFile'],
  });

  if (result.canceled || !result.filePaths.length) return;

  try {
    const raw = await fs.readFile(result.filePaths[0], 'utf8');
    const parsed = JSON.parse(raw);
    const games = parseLibraryImport(parsed);

    if (!games) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('show-toast', {
          message: 'Import failed — file is not a valid Game Library export.',
          color: '#c6d4df',
        });
      }
      return;
    }

    const importedGames = games.map(normalizeGame);
    const existingGames = await readGamesFile();

    if (existingGames.length === 0) {
      await writeGamesFile(importedGames);
      await triggerAppReload();
      return;
    }

    const choice = await askMergeDialog();

    if (choice === 'cancel') return;

    if (choice === 'merge') {
      await writeGamesFile(mergeLibraries(existingGames, importedGames));
    } else if (choice === 'replace') {
      await writeGamesFile(importedGames);
    } else {
      return;
    }
  } catch {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('show-toast', {
        message: 'Import failed — file is not a valid Game Library export.',
        color: '#c6d4df',
      });
    }
    return;
  }

  await triggerAppReload();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#171a21',
    autoHideMenuBar: true,
    menuBarVisible: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
  Menu.setApplicationMenu(null);
}

app.whenReady().then(() => {
  createWindow();

  globalShortcut.register('CmdOrCtrl+R', () => {
    if (mainWindow) {
      mainWindow.webContents.send('trigger-refresh');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('trigger-refresh', () => handleMenuRefresh());
ipcMain.on('export-library', () => handleMenuExport());
ipcMain.on('load-library', () => handleMenuLoad());
ipcMain.on('open-github', () => {
  shell.openExternal('https://github.com/SassyCortana007/Sassy-Game-Library');
});

ipcMain.handle('games:load', async () => readGamesFile());

ipcMain.handle('shell:open-external', async (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});

ipcMain.handle('games:save', async (_event, games) => {
  await writeGamesFile(games);
  return true;
});

ipcMain.handle('steam:search', async (_event, term) => {
  if (!term?.trim()) return { items: [] };
  try {
    const items = await searchSteamStore(term.trim());
    return { items };
  } catch (err) {
    return { items: [], error: err.message };
  }
});

ipcMain.handle('steam:fetch-tags', async (_event, appid) => {
  try {
    const tags = await fetchSteamTags(appid);
    return { tags };
  } catch {
    return { tags: [] };
  }
});

ipcMain.handle('steam:get-suggestions', async (_event, payload) => {
  const library = Array.isArray(payload?.games)
    ? payload.games
    : Array.isArray(payload)
      ? payload
      : [];

  let sourceAppids = payload?.sourceAppids;

  if (!sourceAppids || sourceAppids.length === 0) {
    sourceAppids = library
      .filter((g) =>
        g.status === 'completed' &&
        g.appid &&
        !String(g.appid).startsWith('custom_'))
      .slice(-3)
      .map((g) => String(g.appid));
  }

  if (sourceAppids.length === 0) {
    return {
      suggestions: [],
      reason: 'no_completed',
      token: payload?.token,
    };
  }

  try {
    const result = await buildSuggestionsFromCompleted(library, sourceAppids);
    const response = {
      suggestions: result.suggestions,
      reason: result.reason,
      basedOn: result.basedOn,
      token: payload?.token,
    };
    return response;
  } catch (err) {
    console.error('Suggestions fetch failed:', err);
    return {
      suggestions: [],
      reason: 'fetch_failed',
      basedOn: [],
      token: payload?.token,
    };
  }
});
ipcMain.handle('covers:save', async (_event, { id, sourcePath }) => {
  await ensureCoversDir();
  const ext = path.extname(sourcePath) || '.png';
  const destPath = path.join(COVERS_DIR(), `${id}${ext}`);
  await fs.copyFile(sourcePath, destPath);
  return `covers/${id}${ext}`;
});

ipcMain.handle('covers:resolve', async (_event, relativePath) => {
  if (!relativePath || relativePath.startsWith('http')) return relativePath;
  const fullPath = path.join(app.getPath('userData'), relativePath);
  if (!fsSync.existsSync(fullPath)) return null;
  return `file://${fullPath.replace(/\\/g, '/')}`;
});

ipcMain.handle('covers:delete', async (_event, relativePath) => {
  if (!relativePath || relativePath.startsWith('http')) return;
  const fullPath = path.join(app.getPath('userData'), relativePath);
  try {
    await fs.unlink(fullPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
});

ipcMain.handle('dialog:pick-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select cover image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('context-menu:show', async (event, { gameId, x, y }) => {
  return new Promise((resolve) => {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Remove from library',
        click: () => resolve({ action: 'remove', gameId }),
      },
      { type: 'separator' },
      { label: 'Cancel', click: () => resolve({ action: 'cancel' }) },
    ]);
    menu.popup({
      window: BrowserWindow.fromWebContents(event.sender),
      x: Math.round(x),
      y: Math.round(y),
      callback: () => resolve({ action: 'cancel' }),
    });
  });
});

const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

const isDev = !app.isPackaged;
const DEV_SERVER_URL = process.env.ELECTRON_DEV_SERVER_URL || 'http://localhost:5173';

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Alt' && !input.control && !input.meta && !input.shift) {
      event.preventDefault();
    }
  });

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
    mainWindow.loadFile(indexPath);
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

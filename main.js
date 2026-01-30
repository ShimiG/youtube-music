const { app, BrowserWindow } = require('electron');
const path = require('path');

// 1. IMPORT YOUR SERVER
require('./server'); 

function createWindow() {
    // 2. Create the browser window.
    const mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        title: "YouTube Music App",
        // This handles the icon for Windows/Linux taskbars
        icon: path.join(__dirname, 'public', 'logo.png'), 
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // 3. Robust Loading (Fixes the Unhandled Promise Rejection)
    const loadApp = () => {
        mainWindow.loadURL('http://localhost:3000').catch((err) => {
                setTimeout(loadApp, 1000);
            });
    };

    loadApp();
}

// 4. Lifecycle Events
app.whenReady().then(() => {
    // MAC SPECIFIC: Force the Dock Icon
    if (process.platform === 'darwin') {
        app.dock.setIcon(path.join(__dirname, 'public', 'icon.png'));
    }

    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});
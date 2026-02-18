const { app, BrowserWindow } = require('electron');
const path = require('path');

require('./server'); 

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        title: "YouTube Music App",
        icon: path.join(__dirname, 'public', 'logo.png'), 
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    const loadApp = () => {
        mainWindow.loadURL('http://localhost:3000').catch((err) => {
                setTimeout(loadApp, 1000);
            });
    };

    loadApp();
}

app.whenReady().then(() => {
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
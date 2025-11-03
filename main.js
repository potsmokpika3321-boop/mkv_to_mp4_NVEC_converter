const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const Converter = require('./converter');

function createWindow() {
  const win = new BrowserWindow({
    width: 820,
    height: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile('renderer.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC: show open dialog
ipcMain.handle('show-open-dialog', async (_, options) => {
  const result = await dialog.showOpenDialog(options);
  return result;
});

// IPC: start conversion
ipcMain.handle('convert-files', async (_, files) => {
  // files: array of absolute file paths
  // returns an array of result objects per file
  
  // Determine optimal number of parallel conversions based on CPU cores
  const os = require('os');
  const cpuCount = os.cpus().length;
  // Use 75% of available cores (minimum 2, maximum 8)
  let maxParallel = Math.max(2, Math.min(8, Math.floor(cpuCount * 0.75)));

  // If we have a GPU encoder like NVENC, don't start too many concurrent GPU encodes by default.
  try {
    const enc = await Converter.detectHardwareEncoder();
    if (enc === 'h264_nvenc' || enc === 'h264_qsv' || enc === 'h264_amf' || enc === 'h264_vaapi') {
      // limit concurrent jobs for GPU encoders to 2 to avoid over-subscribing the GPU
      maxParallel = Math.min(maxParallel, 2);
    }
  } catch (e) {
    // ignore detection errors and fall back to cpu-based maxParallel
  }
  
  const results = [];
  const queue = [...files];

  // worker that pulls files from the queue until empty
  const worker = async () => {
    while (true) {
      const file = queue.shift();
      if (!file) break;
      try {
        const iter = Converter.convertWithProgress(file, (progress) => {
          BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('conversion-progress', { file, progress });
          });
        });

        const res = await iter;
        results.push({ file, success: true, output: res.outputPath, info: res.info });
      } catch (err) {
        results.push({ file, success: false, error: err?.message || String(err) });
      }
    }
  };

  const workers = [];
  const workersToStart = Math.min(maxParallel, files.length);
  for (let i = 0; i < workersToStart; i++) workers.push(worker());

  await Promise.all(workers);

  return results;
});

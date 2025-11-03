const pickBtn = document.getElementById('btnPick');
const convertBtn = document.getElementById('btnConvert');
const fileListEl = document.getElementById('fileList');
const dropArea = document.getElementById('dropArea');
const logArea = document.getElementById('logArea');

let files = []; // array of absolute paths

function renderList() {
  fileListEl.innerHTML = '';
  files.forEach((f, idx) => {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.dataset.path = f;

    const meta = document.createElement('div');
    meta.className = 'file-meta';
    const name = document.createElement('div');
    name.textContent = f;
    name.style.wordBreak = 'break-all';
    const small = document.createElement('div');
    small.className = 'small';
    small.textContent = '';

    const progressWrap = document.createElement('div');
    progressWrap.className = 'progress';
    const progressInner = document.createElement('div');
    progressInner.className = 'progress-inner';
    progressInner.style.width = '0%';
    progressWrap.appendChild(progressInner);

    meta.appendChild(name);
    meta.appendChild(progressWrap);
    meta.appendChild(small);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.onclick = () => {
      files.splice(idx, 1);
      renderList();
      convertBtn.disabled = files.length === 0;
    };

    li.appendChild(meta);
    li.appendChild(removeBtn);
    fileListEl.appendChild(li);
  });
}

pickBtn.onclick = async () => {
  const res = await window.api.openFileDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'MKV Video', extensions: ['mkv'] }]
  });
  if (!res.canceled && res.filePaths.length) {
    // append unique
    for (const p of res.filePaths) {
      if (!files.includes(p)) files.push(p);
    }
    renderList();
    convertBtn.disabled = files.length === 0;
  }
};

convertBtn.onclick = async () => {
  if (!files.length) return;
  convertBtn.disabled = true;
  pickBtn.disabled = true;
  log('Starting conversion of ' + files.length + ' file(s)...');

  // subscribe to progress
  window.api.onProgress((data) => {
    const { file, progress } = data;
    // progress objects may include informational messages emitted by converter
    if (progress && progress.type === 'start' && progress.cmdline) {
      log(`ffmpeg command for ${file}: ${progress.cmdline}`);
      return;
    }
    if (progress && progress.type === 'info' && progress.message) {
      log(`${file}: ${progress.message}`);
      return;
    }
    if (progress && progress.type === 'stderr' && progress.message) {
      log(`${file} [ffmpeg stderr]: ${progress.message}`);
      return;
    }
    updateProgress(file, progress);
  });

  const results = await window.api.convertFiles(files);
  // show results
  for (const r of results) {
    if (r.success) {
      log(`✅ ${r.file} → ${r.output}`);
      updateProgress(r.file, { percent: 100 });
    } else {
      log(`❌ ${r.file} failed: ${r.error}`);
    }
  }

  log('All done.');
  convertBtn.disabled = false;
  pickBtn.disabled = false;
};

function updateProgress(filePath, progress) {
  const items = Array.from(document.querySelectorAll('.file-item'));
  const item = items.find(i => i.dataset.path === filePath);
  if (!item) return;
  const inner = item.querySelector('.progress-inner');
  const small = item.querySelector('.small');

  let percent = 0;
  // progress.percent may be available or we compute from timemark not available
  if (progress && typeof progress.percent === 'number') {
    percent = Math.min(100, Math.round(progress.percent));
  } else if (progress && progress.timemark) {
    // best-effort: can't compute percent without duration; show timemark
    percent = 0;
  }

  inner.style.width = `${percent}%`;
  small.textContent = progress.timemark ? `time: ${progress.timemark} ${percent ? `• ${percent}%` : ''}` : (percent ? `${percent}%` : '');
}

function log(s) {
  const p = document.createElement('div');
  p.textContent = s;
  logArea.appendChild(p);
  logArea.scrollTop = logArea.scrollHeight;
}

/* Drag & drop */
['dragenter', 'dragover'].forEach(evt => {
  dropArea.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropArea.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach(evt => {
  dropArea.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropArea.classList.remove('dragover');
  });
});

dropArea.addEventListener('drop', (e) => {
  const dropped = Array.from(e.dataTransfer.files || []).map(f => f.path).filter(p => p.toLowerCase().endsWith('.mkv'));
  for (const p of dropped) if (!files.includes(p)) files.push(p);
  renderList();
  convertBtn.disabled = files.length === 0;
});

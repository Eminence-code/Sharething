const tabModeFile = document.getElementById('tabModeFile');
const tabModeText = document.getElementById('tabModeText');
const fileContentSection = document.getElementById('fileContentSection');
const textContentSection = document.getElementById('textContentSection');

const dropTarget = document.getElementById('dropTarget');
const filePicker = document.getElementById('filePicker');
const fileSelectedPill = document.getElementById('fileSelectedPill');
const selectedFileName = document.getElementById('selectedFileName');
const selectedFileSize = document.getElementById('selectedFileSize');

const textShareInput = document.getElementById('textShareInput');
const uploadForm = document.getElementById('uploadForm');
const submitActionBtn = document.getElementById('submitActionBtn');

const uploadProgressBox = document.getElementById('uploadProgressBox');
const progressBar = document.getElementById('progressBar');
const progressPercent = document.getElementById('progressPercent');
const progressBytes = document.getElementById('progressBytes');

const resultDisplaySection = document.getElementById('resultDisplaySection');
const qrContainer = document.getElementById('qrContainer');
const shareUrlDisplay = document.getElementById('shareUrlDisplay');
const copyUrlBtn = document.getElementById('copyUrlBtn');
const downloadQrImageBtn = document.getElementById('downloadQrImageBtn');

let currentMode = 'file'; // 'file' or 'text'
let selectedFile = null;
const MAX_FILE_SIZE = 3 * 1024 * 1024 * 1024; // 3 GB in bytes

// Format bytes into readable KB / MB / GB
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Switch between File and Text tabs
tabModeFile.addEventListener('click', () => {
  currentMode = 'file';
  tabModeFile.classList.add('active');
  tabModeText.classList.remove('active');
  fileContentSection.classList.add('active');
  textContentSection.classList.remove('active');
});

tabModeText.addEventListener('click', () => {
  currentMode = 'text';
  tabModeText.classList.add('active');
  tabModeFile.classList.remove('active');
  textContentSection.classList.add('active');
  fileContentSection.classList.remove('active');
});

// Handle file selection
function handleFileSelection(file) {
  if (!file) return;
  if (file.size > MAX_FILE_SIZE) {
    alert('File exceeds the 3 GB maximum limit.');
    filePicker.value = '';
    selectedFile = null;
    fileSelectedPill.style.display = 'none';
    return;
  }
  selectedFile = file;
  selectedFileName.textContent = file.name;
  selectedFileSize.textContent = formatBytes(file.size);
  fileSelectedPill.style.display = 'flex';
}

dropTarget.addEventListener('click', () => filePicker.click());

filePicker.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    handleFileSelection(e.target.files[0]);
  }
});

// Drag and drop events
dropTarget.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropTarget.classList.add('drag-active');
});

dropTarget.addEventListener('dragleave', () => {
  dropTarget.classList.remove('drag-active');
});

dropTarget.addEventListener('drop', (e) => {
  e.preventDefault();
  dropTarget.classList.remove('drag-active');
  if (e.dataTransfer.files.length > 0) {
    handleFileSelection(e.dataTransfer.files[0]);
  }
});

// Render QR and share link
function displayResult(shareId) {
  const fullUrl = `${window.location.origin}/download/${shareId}`;
  shareUrlDisplay.textContent = fullUrl;

  qrContainer.innerHTML = '';
  new QRCode(qrContainer, {
    text: fullUrl,
    width: 200,
    height: 200,
    colorDark: '#000000',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });

  resultDisplaySection.style.display = 'block';
}

// Form submission
uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  resultDisplaySection.style.display = 'none';

  // 1. TEXT SHARE MODE
  if (currentMode === 'text') {
    const content = textShareInput.value.trim();
    if (!content) {
      alert('Please enter some text or a link to share.');
      return;
    }

    submitActionBtn.disabled = true;
    submitActionBtn.textContent = 'Generating...';

    try {
      const res = await fetch('/api/share-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save text');

      displayResult(data.id);
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      submitActionBtn.disabled = false;
      submitActionBtn.textContent = 'Generate QR Code';
    }
    return;
  }

  // 2. FILE SHARE MODE (Direct-to-R2 via Presigned URL)
  if (!selectedFile) {
    alert('Please select a file first.');
    return;
  }

  submitActionBtn.disabled = true;
  submitActionBtn.textContent = 'Preparing Upload...';
  uploadProgressBox.style.display = 'block';
  progressBar.style.width = '0%';
  progressPercent.textContent = '0%';
  progressBytes.textContent = `0 B / ${formatBytes(selectedFile.size)}`;

  try {
    // Step A: Request Presigned Upload URL from backend
    const ticketRes = await fetch('/api/get-upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: selectedFile.name,
        fileType: selectedFile.type || 'application/octet-stream',
        size: selectedFile.size
      })
    });

    const ticketData = await ticketRes.json();
    if (!ticketRes.ok) throw new Error(ticketData.error || 'Could not get upload ticket.');

    const { uploadUrl, fileKey, id } = ticketData;

    // Step B: Stream file directly to Cloudflare R2
    submitActionBtn.textContent = 'Uploading...';

    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl, true);
      xhr.setRequestHeader('Content-Type', selectedFile.type || 'application/octet-stream');

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          progressBar.style.width = percent + '%';
          progressPercent.textContent = percent + '%';
          progressBytes.textContent = `${formatBytes(event.loaded)} / ${formatBytes(event.total)}`;
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Cloud storage upload failed (Status ${xhr.status})`));
      };

      xhr.onerror = () => reject(new Error('Network error during direct upload. Check CORS settings on R2.'));
      xhr.send(selectedFile);
    });

    // Step C: Confirm and save metadata in SQLite
    const saveRes = await fetch('/api/save-file-share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        originalName: selectedFile.name,
        storedName: fileKey,
        size: selectedFile.size
      })
    });

    const saveData = await saveRes.json();
    if (!saveRes.ok) throw new Error(saveData.error || 'Failed to record file metadata.');

    displayResult(id);
  } catch (err) {
    alert('Upload Error: ' + err.message);
  } finally {
    submitActionBtn.disabled = false;
    submitActionBtn.textContent = 'Generate QR Code';
  }
});

// Copy URL button
copyUrlBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(shareUrlDisplay.textContent);
  copyUrlBtn.textContent = 'Copied!';
  setTimeout(() => (copyUrlBtn.textContent = 'Copy'), 2000);
});

// Download QR PNG button
downloadQrImageBtn.addEventListener('click', () => {
  const canvas = qrContainer.querySelector('canvas');
  const img = qrContainer.querySelector('img');
  const dataUrl = canvas ? canvas.toDataURL('image/png') : (img ? img.src : null);

  if (!dataUrl) return;
  const link = document.createElement('a');
  link.download = 'sharething-qr.png';
  link.href = dataUrl;
  link.click();
});
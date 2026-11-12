const loadingIndicator = document.getElementById('loadingIndicator');
const errorView = document.getElementById('errorView');
const errorMessage = document.getElementById('errorMessage');
const filePayloadView = document.getElementById('filePayloadView');
const textPayloadView = document.getElementById('textPayloadView');

const payloadFileName = document.getElementById('payloadFileName');
const payloadFileSize = document.getElementById('payloadFileSize');
const fileDownloadTrigger = document.getElementById('fileDownloadTrigger');

const payloadTextContent = document.getElementById('payloadTextContent');
const copyPayloadTextBtn = document.getElementById('copyPayloadTextBtn');
const expiryNotice = document.getElementById('expiryNotice');

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatRemainingTime(createdAt) {
  const expiryTime = createdAt + 12 * 60 * 60 * 1000;
  const remainingMs = expiryTime - Date.now();
  if (remainingMs <= 0) return 'Expired';
  const hours = Math.floor(remainingMs / (1000 * 60 * 60));
  const mins = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
  return `Expires in ${hours}h ${mins}m`;
}

async function loadSharedItem() {
  const pathParts = window.location.pathname.split('/');
  const shareId = pathParts[pathParts.length - 1];

  try {
    const res = await fetch(`/api/item/${shareId}`);
    const data = await res.json();

    loadingIndicator.style.display = 'none';

    if (!res.ok) {
      errorMessage.textContent = data.error || 'Item not found or has expired.';
      errorView.style.display = 'block';
      return;
    }

    if (data.createdAt) {
      expiryNotice.textContent = formatRemainingTime(data.createdAt);
    }

    if (data.type === 'text') {
      payloadTextContent.textContent = data.content;
      textPayloadView.style.display = 'block';
    } else if (data.type === 'file') {
      payloadFileName.textContent = data.filename;
      payloadFileSize.textContent = formatBytes(data.size);
      fileDownloadTrigger.href = data.downloadUrl;
      filePayloadView.style.display = 'block';
    }
  } catch (err) {
    loadingIndicator.style.display = 'none';
    errorMessage.textContent = 'Failed to connect to server.';
    errorView.style.display = 'block';
  }
}

copyPayloadTextBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(payloadTextContent.textContent);
  copyPayloadTextBtn.textContent = '✅ Copied to Clipboard!';
  setTimeout(() => (copyPayloadTextBtn.textContent = '📋 Copy Text'), 2000);
});

loadSharedItem();
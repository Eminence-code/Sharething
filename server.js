require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { nanoid } = require('nanoid');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
const PORT = process.env.PORT || 3000;
const EXPIRY_DURATION_MS = 12 * 60 * 60 * 1000; // 12 hours

// Ensure local uploads folder exists for fallback mode
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR);
}

// Check if R2 is configured
const hasR2 = Boolean(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY
);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const r2 = hasR2
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

const BUCKET_NAME = process.env.R2_BUCKET_NAME || 'sharething-bucket';

// Initialize SQLite Database
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) console.error('Database error:', err.message);
  else console.log(`Connected to SQLite. Storage Mode: ${hasR2 ? 'Cloudflare R2' : 'Local Disk (uploads/)'}`);
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      type TEXT,
      original_name TEXT,
      stored_name TEXT,
      size INTEGER,
      content TEXT,
      created_at INTEGER
    )
  `);
});

// 1. SHARE TEXT / LINK ENDPOINT
app.post('/api/share-text', (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Text content cannot be empty.' });
  }

  const id = nanoid(6);
  const createdAt = Date.now();

  db.run(
    `INSERT INTO shares (id, type, content, created_at) VALUES (?, 'text', ?, ?)`,
    [id, content.trim(), createdAt],
    (err) => {
      if (err) return res.status(500).json({ error: 'Database failed to save text.' });
      res.json({ id });
    }
  );
});

// 2. GENERATE UPLOAD URL (R2 OR LOCAL FALLBACK)
app.post('/api/get-upload-url', async (req, res) => {
  const { filename, fileType, size } = req.body;

  if (size > 3 * 1024 * 1024 * 1024) {
    return res.status(400).json({ error: 'File exceeds the 3 GB limit.' });
  }

  const id = nanoid(6);
  const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const fileKey = `${id}-${safeName}`;

  // Fallback to local streaming if R2 keys are not set
  if (!hasR2) {
    return res.json({
      uploadUrl: `/api/local-upload/${encodeURIComponent(fileKey)}`,
      fileKey,
      id
    });
  }

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
    ContentType: fileType || 'application/octet-stream',
  });

  try {
    const uploadUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });
    res.json({ uploadUrl, fileKey, id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate cloud upload URL.' });
  }
});

// 2B. LOCAL DIRECT STREAM UPLOAD ENDPOINT (Handles up to 3 GB with zero RAM spike)
app.put('/api/local-upload/:fileKey', (req, res) => {
  const fileKey = path.basename(req.params.fileKey);
  const filePath = path.join(UPLOADS_DIR, fileKey);
  const writeStream = fs.createWriteStream(filePath);

  req.pipe(writeStream);

  writeStream.on('finish', () => res.status(200).end());
  writeStream.on('error', (err) => {
    console.error('Local write error:', err);
    res.status(500).json({ error: 'Disk write failed.' });
  });
});

// 3. SAVE FILE METADATA
app.post('/api/save-file-share', (req, res) => {
  const { id, originalName, storedName, size } = req.body;
  const createdAt = Date.now();

  db.run(
    `INSERT INTO shares (id, type, original_name, stored_name, size, created_at) VALUES (?, 'file', ?, ?, ?, ?)`,
    [id, originalName, storedName, size, createdAt],
    (err) => {
      if (err) return res.status(500).json({ error: 'Failed to save file record.' });
      res.json({ success: true, id });
    }
  );
});

// 4. FETCH ITEM METADATA OR DOWNLOAD LINK
app.get('/api/item/:id', (req, res) => {
  const { id } = req.params;

  db.get(`SELECT * FROM shares WHERE id = ?`, [id], async (err, item) => {
    if (err || !item) {
      return res.status(404).json({ error: 'This share link does not exist or has expired.' });
    }

    if (Date.now() - item.created_at > EXPIRY_DURATION_MS) {
      return res.status(410).json({ error: 'This item has passed its 12-hour expiration limit.' });
    }

    if (item.type === 'text') {
      return res.json({
        type: 'text',
        content: item.content,
        createdAt: item.created_at
      });
    }

    if (item.type === 'file') {
      if (!hasR2) {
        return res.json({
          type: 'file',
          filename: item.original_name,
          size: item.size,
          downloadUrl: `/api/local-download/${item.id}`,
          createdAt: item.created_at
        });
      }

      try {
        const command = new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: item.stored_name,
          ResponseContentDisposition: `attachment; filename="${item.original_name}"`
        });

        const downloadUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });
        return res.json({
          type: 'file',
          filename: item.original_name,
          size: item.size,
          downloadUrl,
          createdAt: item.created_at
        });
      } catch (e) {
        return res.status(500).json({ error: 'Could not generate download link.' });
      }
    }
  });
});

// 4B. LOCAL FILE DOWNLOAD ENDPOINT
app.get('/api/local-download/:id', (req, res) => {
  db.get(`SELECT * FROM shares WHERE id = ?`, [req.params.id], (err, item) => {
    if (err || !item || item.type !== 'file') {
      return res.status(404).send('File not found.');
    }
    const filePath = path.join(UPLOADS_DIR, path.basename(item.stored_name));
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File no longer exists on disk.');
    }
    res.download(filePath, item.original_name);
  });
});

// 5. SERVE RECEIVER HTML PAGE
app.get('/download/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'download.html'));
});

// 6. AUTOMATIC 12-HOUR CLEANUP JOB
async function cleanupExpiredShares() {
  const cutoff = Date.now() - EXPIRY_DURATION_MS;

  db.all(`SELECT * FROM shares WHERE created_at < ?`, [cutoff], async (err, rows) => {
    if (err || !rows || rows.length === 0) return;

    for (const row of rows) {
      if (row.type === 'file' && row.stored_name) {
        if (hasR2) {
          try {
            await r2.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: row.stored_name }));
          } catch (e) {}
        } else {
          const localPath = path.join(UPLOADS_DIR, path.basename(row.stored_name));
          if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
        }
      }
    }

    db.run(`DELETE FROM shares WHERE created_at < ?`, [cutoff]);
  });
}

setInterval(cleanupExpiredShares, 15 * 60 * 1000);

const server = app.listen(PORT, () => {
  console.log(`sharething running on http://localhost:${PORT}`);
});
server.setTimeout(0); // Disable timeout so large 3 GB local streams never drop
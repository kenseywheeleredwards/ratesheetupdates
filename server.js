// server.js
// -----------------------------------------------------------------------------
// Rate Sheet HTML Tool
// - CSV upload -> generates HTML (for your admin tool)
// - Google Sheets integration -> reads latest tab and generates HTML
// - /rates/latest endpoint -> Instapage calls this to render live table
// - /admin/refresh-rates -> cron/manual refresh of cached HTML
// -----------------------------------------------------------------------------

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { google } = require('googleapis');

const app = express();

// ---------------------- BASIC APP SETUP --------------------------------------

const PORT = process.env.PORT || 3000;

// Allow Instapage (and anything else) to hit the API
app.use(cors({ origin: '*' }));

// Parse JSON / form bodies for any admin-related requests
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (admin.html, template.html, etc.) from /public
app.use(express.static(path.join(__dirname, 'public')));

// File uploads (for CSV)
const upload = multer({ dest: path.join(__dirname, 'uploads') });

// ---------------------- SHARED HTML GENERATION ------------------------------
//
// This function is the “brain” that turns your tabular data into the HTML
// you want. It is used by BOTH:
//   - CSV upload handler
//   - Google Sheets pull
//
// Right now it's a simple <table>. If you had custom HTML logic before,
// you can paste it inside this function and still reuse it for Sheets.
//

function generateRateSheetHtml(rows) {
  // rows: [ [cellA1, cellB1, ...], [cellA2, cellB2, ...], ... ]

  if (!rows || rows.length === 0) {
    return '<p>No data found.</p>';
  }

  const [headerRow, ...dataRows] = rows;

  let html = '';
  html += '<table class="rate-sheet-table">';
  html += '<thead><tr>';

  headerRow.forEach((cell) => {
    html += `<th>${cell !== undefined ? escapeHtml(String(cell)) : ''}</th>`;
  });

  html += '</tr></thead><tbody>';

  dataRows.forEach((row) => {
    // Ignore completely empty rows
    const hasContent = row.some((cell) => cell && String(cell).trim() !== '');
    if (!hasContent) return;

    html += '<tr>';
    headerRow.forEach((_, colIndex) => {
      const value = row[colIndex] !== undefined ? row[colIndex] : '';
      html += `<td>${escapeHtml(String(value))}</td>`;
    });
    html += '</tr>';
  });

  html += '</tbody></table>';

  return html;
}

// Small helper to avoid HTML injection issues
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ---------------------- CSV UPLOAD ENDPOINT ---------------------------------
//
// This keeps your existing “upload CSV -> get HTML” functionality.
// If your current admin.html posts to a different path, you can:
//   - either update admin.html to post to /api/upload-csv
//   - or add another route alias below.
//

app.post('/api/upload-csv', upload.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send('No CSV file uploaded.');
    }

    const filePath = req.file.path;
    const raw = fs.readFileSync(filePath, 'utf8');

    // Parse CSV into rows
    const records = parse(raw, {
      skip_empty_lines: true,
    });

    // Generate HTML table(s) from rows
    const html = generateRateSheetHtml(records);

    // Clean up temp file
    fs.unlink(filePath, () => {});

    // Return HTML directly (your admin front-end can display / copy this)
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('Error processing CSV upload:', err);
    res.status(500).send('Error processing CSV file.');
  }
});

// OPTIONAL: backward-compat route aliases in case your existing admin.html
// posts to something like /upload or /generate-html. This way, you’re more
// likely to be compatible without editing the HTML form at all.
app.post('/upload', upload.single('csvFile'), (req, res) =>
  app._router.handle(req, res, () => {}, '/api/upload-csv')
);
app.post('/generate-html', upload.single('csvFile'), (req, res) =>
  app._router.handle(req, res, () => {}, '/api/upload-csv')
);

// ---------------------- GOOGLE SHEETS INTEGRATION ---------------------------
//
// Uses a service account to read the LAST tab in the spreadsheet whose ID
// lives in RATE_SHEET_ID. The spreadsheet is assumed to be shared with the
// service account's email (Viewer access is enough).
//

const RATE_SHEET_ID = process.env.RATE_SHEET_ID;

let sheetsAuth = null;
let sheetsApi = null;

// Cached HTML from Sheets + last refresh timestamp
let cachedRatesHtml = '';
let lastRefresh = null;

// Initialize Google API client lazily
async function getSheetsClient() {
  if (!RATE_SHEET_ID) {
    throw new Error('RATE_SHEET_ID environment variable is not set.');
  }

  if (!sheetsAuth) {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
      throw new Error(
        'GOOGLE_SERVICE_ACCOUNT environment variable is not set.'
      );
    }

    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

    sheetsAuth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    sheetsApi = google.sheets({ version: 'v4', auth: sheetsAuth });
  }

  return sheetsApi;
}

// Refreshes the cached HTML from the latest sheet tab
async function refreshRatesHtml() {
  console.log('Refreshing rates HTML from Google Sheets…');

  const sheets = await getSheetsClient();

  // 1) Get spreadsheet metadata (to find the last tab)
  const metaRes = await sheets.spreadsheets.get({
    spreadsheetId: RATE_SHEET_ID,
  });

  const sheetsMeta = metaRes.data.sheets || [];
  if (!sheetsMeta.length) {
    throw new Error('No sheets found in spreadsheet.');
  }

  // 2) "Latest tab" = last sheet in the array
  const lastSheet = sheetsMeta[sheetsMeta.length - 1];
  const sheetTitle = lastSheet.properties.title;

  console.log(`Using latest tab: "${sheetTitle}"`);

  // 3) Read a reasonably wide range from that sheet.
  // Adjust A:Z if you have more columns.
  const valuesRes = await sheets.spreadsheets.values.get({
    spreadsheetId: RATE_SHEET_ID,
    range: `'${sheetTitle}'!A:Z`,
  });

  const rows = valuesRes.data.values || [];

  // 4) Convert rows -> HTML using the same function as CSV
  const html = generateRateSheetHtml(rows);

  cachedRatesHtml = html;
  lastRefresh = new Date();

  console.log(`Rates refreshed at ${lastRefresh.toISOString()}`);

  return html;
}

// ---------------------- ENDPOINTS FOR INSTAPAGE & CRON ----------------------
//
// 1) GET /rates/latest
//    - Instapage calls this to embed the latest rate sheet HTML.
//
// 2) POST /admin/refresh-rates
//    - You or a Render cron job can hit this once a day to refresh cache.
//
// -----------------------------------------------------------------------------

app.get('/rates/latest', async (req, res) => {
  try {
    // If we have no cache yet, or if you want time-based refresh, you can
    // add a timeout check here. For now, if empty, we refresh.
    if (!cachedRatesHtml) {
      await refreshRatesHtml();
    }

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(cachedRatesHtml);
  } catch (err) {
    console.error('Error in /rates/latest:', err);
    res.status(500).send('<p>Error loading rate sheet.</p>');
  }
});

// For daily cron or manual trigger
app.post('/admin/refresh-rates', async (req, res) => {
  try {
    await refreshRatesHtml();
    res.json({
      ok: true,
      lastRefresh,
    });
  } catch (err) {
    console.error('Error in /admin/refresh-rates:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------- START SERVER ----------------------------------------

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// server.js
// -----------------------------------------------------------------------------
// Rate Sheet HTML Tool
// - CSV upload -> generates HTML (for your admin tool)
// - Google Sheets integration -> reads latest tab and generates promo-style HTML
// - Groups rows by Program Name so each program gets its own table
// - /rates/latest endpoint -> Instapage calls this to render live tables
// - /admin/refresh-rates -> cron/manual refresh of cached HTML
// -----------------------------------------------------------------------------

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------- BASIC APP SETUP --------------------------------------

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (admin.html, etc.) from /public
app.use(express.static(path.join(__dirname, 'public')));

// File uploads (for CSV)
const upload = multer({ dest: path.join(__dirname, 'uploads') });

// ---------------------- UTILITY HELPERS --------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Find column index whose header contains a keyword (case insensitive)
function findColumnIndex(headerRow, keyword) {
  if (!headerRow) return -1;
  const needle = keyword.toLowerCase();
  return headerRow.findIndex((cell) => {
    if (!cell) return false;
    return String(cell).toLowerCase().includes(needle);
  });
}

// Turn "36 Months" -> "36M" etc.
function formatTermLabel(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const match = s.match(/^(\d+)\s*month/i);
  if (match) {
    return match[1] + 'M';
  }
  return s;
}

// Ensure "Tier 1" style labels
function formatTierLabel(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^tier\s+/i.test(s)) return s;
  return 'Tier ' + s;
}

// Fallback simple table if we can't pivot nicely
function simpleTableHtml(rows) {
  if (!rows || !rows.length) return '<p>No data found.</p>';

  const [headerRow, ...dataRows] = rows;
  let html = '<table class="rate-sheet-table">';
  html += '<thead><tr>';

  headerRow.forEach((cell) => {
    html += `<th>${cell !== undefined ? escapeHtml(cell) : ''}</th>`;
  });

  html += '</tr></thead><tbody>';

  dataRows.forEach((row) => {
    if (!row) return;
    const hasContent = row.some((cell) => cell && String(cell).trim() !== '');
    if (!hasContent) return;

    html += '<tr>';
    headerRow.forEach((_, idx) => {
      const value = row[idx] !== undefined ? row[idx] : '';
      html += `<td>${escapeHtml(value)}</td>`;
    });
    html += '</tr>';
  });

  html += '</tbody></table>';
  return html;
}

// ---------------------- PROMO BLOCK BUILDER ---------------------------------

function buildPromoBlock(programName, headerRow, dataRows, indices) {
  const {
    tierIdx,
    rateIdx,
    termIdx,
    dpIdx,
    capIdx,
    feeIdx,
    eligibilityIdx,
  } = indices;

  // Build pivot: tiers x terms
  const termSet = new Set();
  const tierMap = new Map(); // tier -> { termLabel: rate }
  const tierMeta = new Map(); // tier -> { dp, cap, fee }

  dataRows.forEach((row) => {
    if (!row) return;

    const tierRaw = row[tierIdx];
    const rateRaw = row[rateIdx];
    const termRaw = row[termIdx];

    if (!tierRaw || !rateRaw || !termRaw) return;

    const tierLabel = formatTierLabel(tierRaw);
    const termLabel = formatTermLabel(termRaw);

    termSet.add(termLabel);

    if (!tierMap.has(tierLabel)) {
      tierMap.set(tierLabel, {});
      tierMeta.set(tierLabel, { dp: '', cap: '', fee: '' });
    }

    const rateStr = String(rateRaw).trim();
    tierMap.get(tierLabel)[termLabel] = rateStr;

    const meta = tierMeta.get(tierLabel);
    if (dpIdx !== -1 && row[dpIdx] && !meta.dp) meta.dp = String(row[dpIdx]).trim();
    if (capIdx !== -1 && row[capIdx] && !meta.cap) meta.cap = String(row[capIdx]).trim();
    if (feeIdx !== -1 && row[feeIdx] && !meta.fee) meta.fee = String(row[feeIdx]).trim();
  });

  if (!tierMap.size || !termSet.size) {
    // Nothing meaningful, bail out for this program
    return '';
  }

  const termLabels = Array.from(termSet);
  // Sort terms numerically when possible (36M, 60M, etc.)
  termLabels.sort((a, b) => {
    const ma = String(a).match(/^(\d+)/);
    const mb = String(b).match(/^(\d+)/);
    if (ma && mb) {
      return parseInt(ma[1], 10) - parseInt(mb[1], 10);
    }
    return String(a).localeCompare(String(b));
  });

  const tierLabels = Array.from(tierMap.keys());

  let html = '';

  html += '<div class="promo-rate-block">';
  html += `<h3 class="promo-heading">${escapeHtml(programName)}</h3>`;
  html += '<hr class="promo-divider" />';

  // Table wrapper
  html += '<div class="promo-table-wrapper">';
  html += '<table class="rate-sheet-table promo-layout">';
  html += '<thead><tr>';

  html += '<th class="promo-col-tier">Tiers</th>';
  termLabels.forEach((term) => {
    html += `<th>${escapeHtml(term)}</th>`;
  });
  if (dpIdx !== -1) html += '<th>Down Payment</th>';
  if (capIdx !== -1) html += '<th>Front-End Cap</th>';
  if (feeIdx !== -1) html += '<th>Dealer Fee</th>';

  html += '</tr></thead><tbody>';

  tierLabels.forEach((tier) => {
    const rowMap = tierMap.get(tier);
    const meta = tierMeta.get(tier) || { dp: '', cap: '', fee: '' };

    html += '<tr>';
    html += `<td class="promo-tier-cell">${escapeHtml(tier)}</td>`;

    termLabels.forEach((term) => {
      const rate = rowMap[term] || '';
      html += `<td>${escapeHtml(rate)}</td>`;
    });

    if (dpIdx !== -1) html += `<td>${escapeHtml(meta.dp)}</td>`;
    if (capIdx !== -1) html += `<td>${escapeHtml(meta.cap)}</td>`;
    if (feeIdx !== -1) html += `<td>${escapeHtml(meta.fee)}</td>`;

    html += '</tr>';
  });

  html += '</tbody></table>';
  html += '</div>'; // promo-table-wrapper

  // Eligibility block (per program)
  if (eligibilityIdx !== -1) {
    const eligSet = new Set();

    dataRows.forEach((row) => {
      if (!row || !row[eligibilityIdx]) return;
      const text = String(row[eligibilityIdx]).trim();
      if (text) eligSet.add(text);
    });

    const eligItems = Array.from(eligSet);
    if (eligItems.length) {
      html += '<div class="promo-eligibility">';
      html += '<h4>Eligible Products/Models:</h4>';
      html += '<ul>';

      eligItems.forEach((item) => {
        const parts = String(item)
          .split(/\r?\n/)
          .map((p) => p.trim())
          .filter((p) => p !== '');

        if (parts.length > 1) {
          parts.forEach((p) => {
            html += `<li>${escapeHtml(p)}</li>`;
          });
        } else {
          html += `<li>${escapeHtml(item)}</li>`;
        }
      });

      html += '</ul>';
      html += '</div>';
    }
  }

  html += '</div>'; // promo-rate-block

  return html;
}

// ---------------------- MASTER HTML GENERATOR -------------------------------

function generateRateSheetHtml(rows) {
  if (!rows || rows.length === 0) {
    return '<p>No data found.</p>';
  }

  const headerRow = rows[0];
  const dataRows = rows.slice(1);

  // Find key columns once
  const tierIdx = findColumnIndex(headerRow, 'tier');
  const rateIdx = findColumnIndex(headerRow, 'interest rate');
  const termIdx = findColumnIndex(headerRow, 'repayment term');
  const dpIdx = findColumnIndex(headerRow, 'down payment');
  const capIdx = findColumnIndex(headerRow, 'front-end cap');
  const feeIdx = findColumnIndex(headerRow, 'dealer fee');
  const eligibilityIdx = findColumnIndex(headerRow, 'eligibility list');
  const programNameIdx = findColumnIndex(headerRow, 'program name');

  // If we can't find core columns, just dump a basic table
  if (tierIdx === -1 || rateIdx === -1 || termIdx === -1) {
    console.warn(
      'Could not find tier/rate/term columns, falling back to simple table.'
    );
    return simpleTableHtml(rows);
  }

  const indices = {
    tierIdx,
    rateIdx,
    termIdx,
    dpIdx,
    capIdx,
    feeIdx,
    eligibilityIdx,
    programNameIdx,
  };

  let html = '';

  // If we have Program Name, group by it.
  if (programNameIdx !== -1) {
    const groupMap = new Map(); // programName -> rows[]

    dataRows.forEach((row) => {
      if (!row) return;
      const rawName = row[programNameIdx];
      if (!rawName) return;
      const key = String(rawName).trim();
      if (!key) return;

      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(row);
    });

    if (groupMap.size === 0) {
      // Fallback: just treat as one block
      html += buildPromoBlock('Promotional Rates', headerRow, dataRows, indices);
    } else {
      for (const [programName, rowsForProgram] of groupMap.entries()) {
        const blockHtml = buildPromoBlock(
          programName,
          headerRow,
          rowsForProgram,
          indices
        );
        if (blockHtml) {
          html += blockHtml;
        }
      }
    }
  } else {
    // No Program Name column -> single block
    html += buildPromoBlock('Promotional Rates', headerRow, dataRows, indices);
  }

  return html || '<p>No promo data found.</p>';
}

// ---------------------- CSV UPLOAD ENDPOINT ---------------------------------

app.post('/api/upload-csv', upload.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send('No CSV file uploaded.');
    }

    const filePath = req.file.path;
    const raw = fs.readFileSync(filePath, 'utf8');

    const records = parse(raw, {
      skip_empty_lines: true,
    });

    const html = generateRateSheetHtml(records);

    fs.unlink(filePath, () => {});

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('Error processing CSV upload:', err);
    res.status(500).send('Error processing CSV file.');
  }
});

// ---------------------- GOOGLE SHEETS INTEGRATION ---------------------------

const RATE_SHEET_ID = process.env.RATE_SHEET_ID;

let sheetsAuth = null;
let sheetsApi = null;
let cachedRatesHtml = '';
let lastRefresh = null;

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

async function refreshRatesHtml() {
  console.log('Refreshing rates HTML from Google Sheets…');

  const sheets = await getSheetsClient();

  const metaRes = await sheets.spreadsheets.get({
    spreadsheetId: RATE_SHEET_ID,
  });

  const sheetsMeta = metaRes.data.sheets || [];
  if (!sheetsMeta.length) {
    throw new Error('No sheets found in spreadsheet.');
  }

  const lastSheet = sheetsMeta[sheetsMeta.length - 1];
  const sheetTitle = lastSheet.properties.title;

  console.log(`Using latest tab: "${sheetTitle}"`);

  const valuesRes = await sheets.spreadsheets.values.get({
    spreadsheetId: RATE_SHEET_ID,
    range: `'${sheetTitle}'!A:Z`,
  });

  const rows = valuesRes.data.values || [];

  const html = generateRateSheetHtml(rows);

  cachedRatesHtml = html;
  lastRefresh = new Date();

  console.log(`Rates refreshed at ${lastRefresh.toISOString()}`);

  return html;
}

// ---------------------- ENDPOINTS FOR INSTAPAGE & CRON ----------------------

app.get('/rates/latest', async (req, res) => {
  try {
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

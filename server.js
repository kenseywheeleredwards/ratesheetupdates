// server.js
// -----------------------------------------------------------------------------
// Rate Sheet HTML Tool
// - CSV upload -> generates HTML (for your admin tool)
// - Google Sheets integration -> reads latest tab and generates promo-style HTML
// - Groups rows by Program Name Stub so each program gets its own table
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

// Find first column whose header matches ANY of a list of keywords
function findAnyColumnIndex(headerRow, keywords) {
  if (!headerRow) return -1;
  const lower = headerRow.map((c) => (c ? String(c).toLowerCase() : ''));
  for (const keyword of keywords) {
    const needle = keyword.toLowerCase();
    const idx = lower.findIndex((cell) => cell.includes(needle));
    if (idx !== -1) return idx;
  }
  return -1;
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

function buildPromoBlock(heading, headerRow, dataRows, indices) {
  const {
    tierIdx,
    rateIdx,
    termIdx,
    dpIdx,
    capIdx,
    feeIdx,
    eligibilityIdx,
    productIdx,
    modelYearsIdx,
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
    return '';
  }

  const termLabels = Array.from(termSet);
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

  // Outer wrapper only (no per-table heading)
  html += '<div class="mb-20">';

  // Table wrapper
  html += '<div class="overflow-x-auto">';
  html +=
    '<table class="min-w-full divide-y divide-x divide-gray-300 border border-gray-300">';
  html += '<thead class="bg-gray-100"><tr>';

  // First column: tiers
  html +=
    '<th scope="col" class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider whitespace-nowrap text-left">Tiers</th>';

  // Term columns
  termLabels.forEach((term) => {
    html += `<th scope="col" class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider whitespace-nowrap text-center">${escapeHtml(
      term
    )}</th>`;
  });

  // Optional DP / Cap / Dealer columns
  if (dpIdx !== -1) {
    html +=
      '<th scope="col" class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider whitespace-nowrap text-right">Down Payment</th>';
  }
  if (capIdx !== -1) {
    html +=
      '<th scope="col" class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider whitespace-nowrap text-right">Front-End Cap</th>';
  }
  if (feeIdx !== -1) {
    html +=
      '<th scope="col" class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider whitespace-nowrap text-right">Dealer Fee</th>';
  }

  html += '</tr></thead>';

  // Body – mirrors original promo template
  html += '<tbody class="bg-white divide-y divide-x divide-gray-200">';

  tierLabels.forEach((tier) => {
    const rowMap = tierMap.get(tier);
    const meta = tierMeta.get(tier) || { dp: '', cap: '', fee: '' };

    html += '<tr class="hover:bg-gray-50">';

    // Tier cell
    html += `<td class="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">${escapeHtml(
      tier
    )}</td>`;

    // Rates for each term
    termLabels.forEach((term) => {
      const rate = rowMap[term] || '';
      html += `<td class="px-4 py-3 whitespace-nowrap text-sm text-center font-mono text-gray-700">${escapeHtml(
        rate
      )}</td>`;
    });

    // Meta columns
    if (dpIdx !== -1) {
      html += `<td class="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-700">${escapeHtml(
        meta.dp
      )}</td>`;
    }
    if (capIdx !== -1) {
      html += `<td class="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-700">${escapeHtml(
        meta.cap
      )}</td>`;
    }
    if (feeIdx !== -1) {
      html += `<td class="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-700">${escapeHtml(
        meta.fee
      )}</td>`;
    }

    html += '</tr>';
  });

  html += '</tbody></table></div>'; // table + overflow-x-auto

  // ----------------- Eligibility section (left aligned) ----------------------
  // Priority:
  // 1) If an explicit "eligibility" column exists, use that text
  // 2) Otherwise, build "Product (Model Years)" from productIdx + modelYearsIdx

  const eligSet = new Set();

  dataRows.forEach((row) => {
    if (!row) return;

    let text = '';

    // 1) Explicit eligibility column
    if (eligibilityIdx !== -1 && row[eligibilityIdx]) {
      text = String(row[eligibilityIdx]).trim();
    } else {
      // 2) Build from product + years
      const product =
        productIdx !== -1 && row[productIdx]
          ? String(row[productIdx]).trim()
          : '';
      const years =
        modelYearsIdx !== -1 && row[modelYearsIdx]
          ? String(row[modelYearsIdx]).trim()
          : '';

      if (product || years) {
        if (product && years) {
          text = `${product} (${years})`;
        } else {
          text = product || years;
        }
      }
    }

    if (text) {
      eligSet.add(text);
    }
  });

  const eligItems = Array.from(eligSet);

  if (eligItems.length) {
    html += '<div class="mt-3 text-left">';
    html +=
      '<h3 class="text-lg font-semibold mb-2 text-gray-700 text-left">Eligible Products/Models:</h3>';
    html +=
      '<ul class="list-disc list-inside space-y-1 text-sm text-gray-600 pl-4 text-left">';

    eligItems.forEach((item) => {
      const parts = String(item)
        .split(/\r?\n/)
        .map((p) => p.trim())
        .filter((p) => p !== '');

      if (parts.length > 1) {
        parts.forEach((p) => {
          html += `<li><span class="font-medium">${escapeHtml(
            p
          )}</span></li>`;
        });
      } else {
        html += `<li><span class="font-medium">${escapeHtml(
          item
        )}</span></li>`;
      }
    });

    html += '</ul></div>';
  }

  html += '</div>'; // mb-20 outer wrapper

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

  // 1) Optional "eligibility list" style column (old sheets)
  const eligibilityIdx = findAnyColumnIndex(headerRow, [
    'eligibility list',
    'eligible products/models',
    'eligible products',
    'eligible models',
    'eligible makes',
    'makes & models',
    'makes and models',
    'eligibility',
    'eligible',
  ]);

  // 2) Product + Eligible Model Years (new sheets)
  const productIdx = findAnyColumnIndex(headerRow, ['product']);
  const modelYearsIdx = findAnyColumnIndex(headerRow, [
    'eligible model years',
    'model years',
    'model year',
  ]);

  const programNameIdx = findColumnIndex(headerRow, 'program name');
  const programStubIdx = findColumnIndex(headerRow, 'program name stub');

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
    productIdx,
    modelYearsIdx,
  };

  let html = '';

  // Decide grouping key: prefer Program Name Stub, then Program Name, else single block
  if (programStubIdx !== -1 || programNameIdx !== -1) {
    const groupMap = new Map(); // key -> rows[]

    dataRows.forEach((row) => {
      if (!row) return;

      let key = '';
      if (programStubIdx !== -1 && row[programStubIdx]) {
        key = String(row[programStubIdx]).trim();
      } else if (programNameIdx !== -1 && row[programNameIdx]) {
        key = String(row[programNameIdx]).trim();
      }

      if (!key) return;

      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(row);
    });

    if (groupMap.size === 0) {
      // Fallback: treat entire sheet as one block
      const heading =
        programNameIdx !== -1 && dataRows[0] && dataRows[0][programNameIdx]
          ? String(dataRows[0][programNameIdx]).trim()
          : 'Promotional Rates';

      html += buildPromoBlock(heading, headerRow, dataRows, indices);
    } else {
      for (const [key, rowsForProgram] of groupMap.entries()) {
        // Heading preference: Program Name (if any row has it), else the stub key
        let heading = key;
        if (programNameIdx !== -1) {
          const withName = rowsForProgram.find(
            (r) => r[programNameIdx] && String(r[programNameIdx]).trim() !== ''
          );
          if (withName) {
            heading = String(withName[programNameIdx]).trim();
          }
        }

        const blockHtml = buildPromoBlock(
          heading,
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
    // No program columns -> single block for whole sheet
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

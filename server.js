const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const { parse } = require("csv-parse");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from /public (admin.html + generated HTML)
app.use(express.static(path.join(__dirname, "public")));

// Configure multer to store uploads in memory
const upload = multer({ storage: multer.memoryStorage() });

// Health check (optional)
app.get("/health", (req, res) => {
  res.send("OK");
});

// Escape HTML
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Helper: find a column index in the header row using
 * case-insensitive "contains" matching on a set of keywords.
 */
function findColumn(headers, keywords) {
  const lowerHeaders = headers.map((h) => (h || "").toString().toLowerCase());

  for (let i = 0; i < lowerHeaders.length; i++) {
    const h = lowerHeaders[i];
    let ok = true;
    for (const kw of keywords) {
      if (!h.includes(kw.toLowerCase())) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

/**
 * Build tables from an OEM-style promo CSV (like "BRP Promotions - November 2025").
 * We automatically detect:
 *  - Product column
 *  - Eligible models / model years column
 *  - Repayment term column
 *  - Promo Rate RT 1 / 1.12 / 2 / 2.1 / 2.2 columns
 *  - Dealer Fee RT 1 / 1.12 / 2 / 2.1 / 2.2 columns
 */
function buildTablesHtmlFromCsv(records) {
  if (!records || records.length < 2) {
    return '<p class="text-red-600">No data found in CSV.</p>';
  }

  // Normalize header row
  const headerRow = records[0].map((h) => (h || "").toString().trim());
  const dataRows = records.slice(1);

  // Try to detect key columns by keywords
  const idxProduct = findColumn(headerRow, ["product"]);
  const idxYears = findColumn(headerRow, ["eligible", "model"]); // "Eligible models", "Eligible Model Years", etc.
  const idxTerm = findColumn(headerRow, ["term"]); // "Repayment Term", "Term", etc.

  // Find promo rate columns by looking for "promo" + "rate" + "rt"
  const rateCols = []; // { idx, tierName }
  headerRow.forEach((h, i) => {
    const lower = h.toLowerCase();
    if (lower.includes("promo") && lower.includes("rate") && lower.includes("rt")) {
      // Try to extract RT number, e.g. "Promo Rate RT 1.12"
      const m = lower.match(/rt\s*([0-9.]+)/);
      let tierName = null;
      if (m && m[1]) {
        const rt = m[1];
        if (rt === "1") tierName = "Tier 1";
        else if (rt === "1.12" || rt === "1,12") tierName = "Tier 1.12";
        else if (rt === "2") tierName = "Tier 2";
        else if (rt === "2.1" || rt === "2,1") tierName = "Tier 2.1";
        else if (rt === "2.2" || rt === "2,2") tierName = "Tier 2.2";
        else tierName = `Tier ${rt}`;
      }
      if (tierName) {
        rateCols.push({ idx: i, tierName });
      }
    }
  });

  // Find dealer fee columns similarly
  const feeCols = []; // { idx, tierName }
  headerRow.forEach((h, i) => {
    const lower = h.toLowerCase();
    if (lower.includes("dealer") && lower.includes("fee") && lower.includes("rt")) {
      const m = lower.match(/rt\s*([0-9.]+)/);
      let tierName = null;
      if (m && m[1]) {
        const rt = m[1];
        if (rt === "1") tierName = "Tier 1";
        else if (rt === "1.12" || rt === "1,12") tierName = "Tier 1.12";
        else if (rt === "2") tierName = "Tier 2";
        else if (rt === "2.1" || rt === "2,1") tierName = "Tier 2.1";
        else if (rt === "2.2" || rt === "2,2") tierName = "Tier 2.2";
        else tierName = `Tier ${rt}`;
      }
      if (tierName) {
        feeCols.push({ idx: i, tierName });
      }
    }
  });

  // Basic sanity check – if we can't find these, the format isn't what we expect
  if (idxProduct === -1 || idxYears === -1 || idxTerm === -1 || rateCols.length === 0) {
    const headerPreview = headerRow.join(" | ");
    throw new Error(
      "CSV format not recognized automatically. Header row is: " + headerPreview
    );
  }

  // Helper to turn "36.0" -> "36M"
  function termLabelFrom(value) {
    const str = (value || "").toString().trim();
    const num = parseFloat(str);
    if (!isNaN(num)) {
      return `${String(num).replace(/\.0+$/, "")}M`;
    }
    return str || "";
  }

  // Group rows by Product + Years
  const groups = new Map();

  dataRows.forEach((row) => {
    if (!row || row.every((cell) => !cell || String(cell).trim() === "")) {
      return; // skip completely empty rows
    }

    const product = (row[idxProduct] || "").toString().trim();
    const years = (row[idxYears] || "").toString().trim();
    const termRaw = row[idxTerm];

    if (!product && !years && !termRaw) return;

    const termLabel = termLabelFrom(termRaw);
    if (!termLabel) return;

    const key = `${product}|||${years}`;

    if (!groups.has(key)) {
      groups.set(key, {
        product,
        years,
        terms: new Set(),
        tierRates: {}, // tierName -> { termLabel -> rate }
        tierFees: {}, // tierName -> dealer fee
      });
    }

    const group = groups.get(key);
    group.terms.add(termLabel);

    function setTierFromCols(colArray, isFee) {
      colArray.forEach(({ idx, tierName }) => {
        const value = (row[idx] || "").toString().trim();
        if (!value) return;

        if (isFee) {
          group.tierFees[tierName] = value;
        } else {
          if (!group.tierRates[tierName]) {
            group.tierRates[tierName] = {};
          }
          group.tierRates[tierName][termLabel] = value;
        }
      });
    }

    setTierFromCols(rateCols, false);
    setTierFromCols(feeCols, true);
  });

  const tierOrder = ["Tier 1", "Tier 1.12", "Tier 2", "Tier 2.1", "Tier 2.2"];
  let html = "";

  groups.forEach((group) => {
    const termsSorted = Array.from(group.terms);
    termsSorted.sort((a, b) => {
      const na = parseFloat(a);
      const nb = parseFloat(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    });

    const headerCells = ["Tiers", ...termsSorted, "Down Payment", "Front-End Cap", "Dealer Fee"];
    const rows = [];

    tierOrder.forEach((tierName) => {
      const tierRates = group.tierRates[tierName];
      if (!tierRates) return;

      const rowCells = [tierName];

      termsSorted.forEach((termLabel) => {
        rowCells.push(tierRates[termLabel] || "");
      });

      // For now, assume these constants (can be adjusted later)
      rowCells.push("0%");       // Down Payment
      rowCells.push("130%");     // Front-End Cap
      rowCells.push(group.tierFees[tierName] || "");

      rows.push(rowCells);
    });

    if (rows.length === 0) return;

    const eligibleText = group.years
      ? `${group.product} (${group.years})`
      : group.product;

    html += buildTableBlock(headerCells, rows, eligibleText);
    html += "\n\n";
  });

  if (!html) {
    return '<p class="text-red-600">No promo rows found in CSV.</p>';
  }

  return html;
}

// Build ONE table block (table + Eligible Products/Models text)
function buildTableBlock(headerCells, rows, eligibleText) {
  const thead = `
    <thead class="bg-gray-100">
      <tr>
        ${headerCells
          .map((h, idx) => {
            const align =
              idx === 0
                ? "text-left"
                : idx === headerCells.length - 1
                ? "text-right"
                : "text-center";
            return `
          <th scope="col" class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider whitespace-nowrap ${align}">
            ${escapeHtml(h)}
          </th>`;
          })
          .join("")}
      </tr>
    </thead>`;

  const tbody = `
    <tbody class="bg-white divide-y divide-x divide-gray-200">
      ${rows
        .map((row) => {
          const cellsHtml = row
            .map((cell, idx) => {
              const isFirst = idx === 0;
              const isLast = idx === row.length - 1;
              const align = isFirst
                ? "text-left font-medium text-gray-900"
                : isLast
                ? "text-right text-gray-700"
                : "text-center font-mono text-gray-700";
              return `
          <td class="px-4 py-3 whitespace-nowrap text-sm ${align}">
            ${escapeHtml(cell)}
          </td>`;
            })
            .join("");
          return `
        <tr class="hover:bg-gray-50">
          ${cellsHtml}
        </tr>`;
        })
        .join("\n")}
    </tbody>`;

  const eligibleHtml = eligibleText
    ? `
    <div class="mt-3">
      <h3 class="text-lg font-semibold mb-2 text-gray-700">Eligible Products/Models:</h3>
      <p class="text-sm text-gray-700">
        ${escapeHtml(eligibleText)}
      </p>
    </div>`
    : "";

  const tableHtml = `
  <div class="mb-20">
    <div class="overflow-x-auto">
      <table class="min-w-full divide-y divide-x divide-gray-300 border border-gray-300">
        ${thead}
        ${tbody}
      </table>
    </div>
    ${eligibleHtml}
  </div>`;

  return tableHtml;
}

// Replace section between <!-- TABLES_START --> and <!-- TABLES_END --> in template.html
function applyTablesToTemplate(tablesHtml, oemName) {
  const templatePath = path.join(__dirname, "template.html");
  const template = fs.readFileSync(templatePath, "utf8");

  const startMarker = "<!-- TABLES_START -->";
  const endMarker = "<!-- TABLES_END -->";

  const startIndex = template.indexOf(startMarker);
  const endIndex = template.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error(
      "Could not find TABLES_START / TABLES_END markers in template.html"
    );
  }

  const before = template.slice(0, startIndex + startMarker.length);
  const after = template.slice(endIndex);

  let result = `${before}\n${tablesHtml}\n${after}`;

  // Swap "Polaris Promotional Rates" with "<OEM> Promotional Rates"
  const safeOem = escapeHtml(oemName || "");
  if (safeOem) {
    result = result.replace(
      /Polaris Promotional Rates/g,
      `${safeOem} Promotional Rates`
    );
  }

  const outPath = path.join(__dirname, "public", "promo_output_polaris.html");
  fs.writeFileSync(outPath, result, "utf8");

  return outPath;
}

// CSV upload endpoint
app.post("/upload-csv", upload.single("ratesCsv"), (req, res) => {
  if (!req.file) {
    return res.status(400).send("No file uploaded.");
  }

  const csvBuffer = req.file.buffer;
  const csvText = csvBuffer.toString("utf8");

  parse(
    csvText,
    {
      columns: false,
      skip_empty_lines: true,
    },
    (err, records) => {
      if (err) {
        console.error("Error parsing CSV:", err);
        return res
          .status(500)
          .send("Error parsing CSV file. Please check the format.");
      }

      try {
        const tablesHtml = buildTablesHtmlFromCsv(records);
const oemName = (req.body && req.body.oemName) || "";
const outputPath = applyTablesToTemplate(tablesHtml, oemName);
console.log("Updated HTML written to:", outputPath);

res.send(
  "CSV uploaded and HTML updated successfully.\nYou can view the updated HTML at: /promo_output_polaris.html"
);
      } catch (e) {
        console.error("Error updating HTML:", e);
        res.status(500).send("Error updating HTML template: " + e.message);
      }
    }
  );
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Upload page: /admin.html");
});


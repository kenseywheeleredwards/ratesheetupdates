const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const { parse } = require("csv-parse");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from /public (this gives us admin.html)
app.use(express.static(path.join(__dirname, "public")));

// Configure multer to store uploads in memory
const upload = multer({ storage: multer.memoryStorage() });

// Health check
app.get("/health", (req, res) => {
  res.send("OK");
});

// Helper: escape HTML special characters
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build ALL tables + Eligible Products/Models sections from CSV.
 *
 * CSV header must be:
 * Table Group, Eligible Products/Models, Tiers, 36M, 48M, 60M, 72M, 84M, Down Payment, Front-End Cap, Dealer Fee
 */
// Build tables from OEM-style promo CSV (like "BRP Promotions - November 2025")
function buildTablesHtmlFromCsv(records) {
  if (!records || records.length < 2) {
    return '<p class="text-red-600">No data found in CSV.</p>';
  }

  // Normalize header row (trim & string)
  const headerRow = records[0].map((h) => (h || "").toString().trim());
  const dataRows = records.slice(1);

  // Column indexes we care about
  const idxProduct = headerRow.indexOf("Product");
  const idxYears = headerRow.indexOf("Eligible Model Years");
  const idxTerm = headerRow.indexOf("Repayment Term");

  const idxRate1 = headerRow.indexOf("Promo Rate RT 1");
  const idxRate112 = headerRow.indexOf("Promo Rate RT 1.12");
  const idxRate2 = headerRow.indexOf("Promo Rate RT 2");
  const idxRate21 = headerRow.indexOf("Promo Rate RT 2.1");
  const idxRate22 = headerRow.indexOf("Promo Rate RT 2.2");

  const idxFee1 = headerRow.indexOf("Dealer Fee RT 1");
  const idxFee112 = headerRow.indexOf("Dealer Fee RT 1.12");
  const idxFee2 = headerRow.indexOf("Dealer Fee RT 2");
  const idxFee21 = headerRow.indexOf("Dealer Fee RT 2.1");
  const idxFee22 = headerRow.indexOf("Dealer Fee RT 2.2");

  // Basic sanity check
  if (idxProduct === -1 || idxYears === -1 || idxTerm === -1 || idxRate1 === -1 || idxRate2 === -1) {
    throw new Error(
      'CSV format not recognized. Expected columns like "Product", "Eligible Model Years", "Repayment Term", "Promo Rate RT 1", "Promo Rate RT 2".'
    );
  }

  // Helper to turn "36.0" -> "36M"
  function termLabelFrom(value) {
    const str = (value || "").toString().trim();
    const num = parseFloat(str);
    if (!isNaN(num)) {
      return `${String(num).replace(/\.0+$/, "")}M`;
    }
    return str;
  }

  // Group rows by Product + Years
  const groups = new Map();

  dataRows.forEach((row) => {
    const product = (row[idxProduct] || "").toString().trim();
    const years = (row[idxYears] || "").toString().trim();
    const termRaw = row[idxTerm];

    if (!product && !years && (termRaw === null || termRaw === undefined || String(termRaw).trim() === "")) {
      return; // skip empty rows
    }

    const termLabel = termLabelFrom(termRaw);
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

    function setTier(tierName, rateIdx, feeIdx) {
      if (rateIdx === -1) return;
      const rate = (row[rateIdx] || "").toString().trim();
      if (!rate) return;

      if (!group.tierRates[tierName]) {
        group.tierRates[tierName] = {};
      }
      group.tierRates[tierName][termLabel] = rate;

      if (feeIdx !== -1) {
        const fee = (row[feeIdx] || "").toString().trim();
        if (fee) {
          group.tierFees[tierName] = fee;
        }
      }
    }

    setTier("Tier 1", idxRate1, idxFee1);
    setTier("Tier 1.12", idxRate112, idxFee112);
    setTier("Tier 2", idxRate2, idxFee2);
    setTier("Tier 2.1", idxRate21, idxFee21);
    setTier("Tier 2.2", idxRate22, idxFee22);
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

    // Header: Tiers | 36M | 60M | ... | Down Payment | Front-End Cap | Dealer Fee
    const headerCells = ["Tiers", ...termsSorted, "Down Payment", "Front-End Cap", "Dealer Fee"];

    const rows = [];

    tierOrder.forEach((tierName) => {
      const tierRates = group.tierRates[tierName];
      if (!tierRates) return; // no data for this tier

      const rowCells = [tierName];

      termsSorted.forEach((termLabel) => {
        rowCells.push(tierRates[termLabel] || "");
      });

      // Assumptions – adjust if your data encodes these somewhere else:
      rowCells.push("0%"); // Down Payment
      rowCells.push("130%"); // Front-End Cap
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

// Replace TABLES_START / TABLES_END section in template.html and write promo_output_polaris.html
function applyTablesToTemplate(tablesHtml) {
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

  const result = `${before}\n${tablesHtml}\n${after}`;

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
      columns: false, // first row is header
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
        const outputPath = applyTablesToTemplate(tablesHtml);
        console.log("Updated HTML written to:", outputPath);

       res.send(
  "CSV uploaded and HTML updated successfully.\n" +
    "You can view the updated HTML at: /promo_output_polaris.html"
);
      } catch (e) {
        console.error("Error updating HTML:", e);
        res.status(500).send("Error updating HTML template: " + e.message);
      }
    }
  );
});

// Start server (Render will run `npm start`, which runs this)
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Upload page: /admin.html");
});

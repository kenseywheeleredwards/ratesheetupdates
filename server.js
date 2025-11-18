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
function buildTablesHtmlFromCsv(records) {
  if (!records || records.length < 2) {
    return '<p class="text-red-600">No data found in CSV.</p>';
  }

  const headerRow = records[0];
  const dataRows = records.slice(1);

  const groupIdx = headerRow.indexOf("Table Group");
  const eligibleIdx = headerRow.indexOf("Eligible Products/Models");
  const tiersIdx = headerRow.indexOf("Tiers");

  if (groupIdx === -1 || eligibleIdx === -1 || tiersIdx === -1) {
    throw new Error(
      'CSV must have "Table Group", "Eligible Products/Models", and "Tiers" columns in the header row.'
    );
  }

  // All other columns become value columns (36M, 48M, 60M, 72M, 84M, Down Payment, Front-End Cap, Dealer Fee)
  const valueColIndexes = headerRow
    .map((_, idx) => idx)
    .filter(
      (idx) => idx !== groupIdx && idx !== eligibleIdx && idx !== tiersIdx
    );
  const valueHeaders = valueColIndexes.map((idx) => headerRow[idx]);

  // Group rows by Table Group
  const groups = new Map();

  dataRows.forEach((row) => {
    if (!row || row.every((cell) => !cell || String(cell).trim() === "")) {
      return; // skip empty rows
    }

    const groupKey = row[groupIdx] || "Group 1";
    const eligibleText = row[eligibleIdx] || "";

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        eligibleText,
        rows: [],
      });
    }

    const group = groups.get(groupKey);

    // First cell is Tier, rest are the value columns in order
    const rowCells = [
      row[tiersIdx] || "",
      ...valueColIndexes.map((idx) => row[idx] || ""),
    ];

    group.rows.push(rowCells);
  });

  let html = "";

  groups.forEach((group) => {
    const headerCells = ["Tiers", ...valueHeaders];
    html += buildTableBlock(headerCells, group.rows, group.eligibleText);
    html += "\n\n";
  });

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

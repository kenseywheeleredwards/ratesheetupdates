const express = require("express");
const fileUpload = require("express-fileupload");
const fs = require("fs");
const path = require("path");
const csvParser = require("csv-parser");

const app = express();
app.use(express.static("public"));
app.use(fileUpload());
app.use(express.json({ limit: "10mb" }));

// ----------------------------
// Utility: Clean cell contents
// ----------------------------
function clean(value) {
  if (!value) return "";
  return String(value).replace(/(\r\n|\n|\r)/gm, "").trim();
}

// ----------------------------
// Detect CSV Type
// ----------------------------
function detectCsvType(rows) {
  const headerRow = rows[0].map(clean).join(" | ");
  if (headerRow.includes("Table Group") && headerRow.includes("Eligible Products")) {
    return "promo";
  }

  const first10 = rows.slice(0, 10).map(r => r.join(" ")).join(" ");
  if (first10.toUpperCase().includes("STANDARD PROGRAM")) {
    return "standard";
  }

  return "unknown";
}

// ----------------------------
// PARSE — PROMOTIONAL
// ----------------------------
function parsePromo(rows) {
  const header = rows[0].map(clean);
  const groupIndex = header.indexOf("Table Group");
  const productIndex = header.indexOf("Eligible Products/Models");
  const tiersIndex = header.indexOf("Tiers");

  if (groupIndex === -1 || productIndex === -1 || tiersIndex === -1) {
    throw new Error("CSV missing required promotional headers.");
  }

  const grouped = {};

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i].map(clean);
    if (!row[groupIndex]) continue;

    const group = row[groupIndex];
    if (!grouped[group]) grouped[group] = { rows: [], productLine: "" };

    grouped[group].rows.push(row);
    if (!grouped[group].productLine) {
      grouped[group].productLine = row[productIndex];
    }
  }

  return grouped;
}

// ----------------------------
// PARSE — STANDARD (Rows 3–23)
// ----------------------------
function parseStandard(rows) {
  // Extract only the first 23 rows as requested
  const slice = rows.slice(0, 23);

  // Detect table start
  let startIndex = slice.findIndex(r => r[0] && r[0].toUpperCase().includes("TIERS"));
  if (startIndex === -1) {
    throw new Error("Unable to detect Standard table header row.");
  }

  const header = slice[startIndex].map(clean);
  const tables = [];
  let currentTable = { title: "", headers: header, rows: [] };

  // Identify table title rows (contain ":" and not a header)
  for (let i = 0; i < slice.length; i++) {
    const row = slice[i].map(clean);
    const joined = row.join(" ");

    if (joined.includes("PARTNER")) {
      if (currentTable.rows.length) tables.push(currentTable);
      currentTable = { title: "Partner & Subvented", headers: header, rows: [] };
    }

    if (joined.includes("NON-PARTNER")) {
      if (currentTable.rows.length) tables.push(currentTable);
      currentTable = { title: "Non-Partner Unsubvented", headers: header, rows: [] };
    }

    if (joined.includes("USED")) {
      if (currentTable.rows.length) tables.push(currentTable);
      currentTable = { title: "Used", headers: header, rows: [] };
    }

    // Actual data rows start AFTER header row and when first column starts with "Tier"
    if (i > startIndex && row[0] && row[0].toUpperCase().includes("TIER")) {
      currentTable.rows.push(row);
    }
  }

  // Push last table
  if (currentTable.rows.length) tables.push(currentTable);

  return tables;
}

// ----------------------------
// HTML GENERATION
// ----------------------------
function generateTableHTML(table) {
  return `
    <h3 class="section-title">${table.title}</h3>
    <table>
      <thead>
        <tr>${table.headers.map(h => `<th>${clean(h)}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${table.rows
          .map(row => `<tr>${row.map(c => `<td>${clean(c)}</td>`).join("")}</tr>`)
          .join("")}
      </tbody>
    </table>
  `;
}

function generateStandardHTML(tables, oem) {
  return `
  <div class="rate-sheet">

    <h1 class="title">${oem} Powersports Rates</h1>

    ${tables.map(t => generateTableHTML(t)).join("")}

  </div>
  `;
}

function generatePromoHTML(groups, oem) {
  return `
  <div class="rate-sheet">

    <h1 class="title">${oem} Promotional Rates</h1>

    ${Object.keys(groups)
      .map(group => {
        return `
        <h3 class="section-title">${group}</h3>
        <table>
          <thead>
            <tr>${groups[group].rows[0].map(h => `<th>${clean(h)}</th>`).join("")}</tr>
          </thead>
          <tbody>
            ${groups[group].rows
              .map(r => `<tr>${r.map(c => `<td>${clean(c)}</td>`).join("")}</tr>`)
              .join("")}
          </tbody>
        </table>

        <div class="product-line">Eligible: ${groups[group].productLine}</div>
        `;
      })
      .join("")}

  </div>
  `;
}

// ----------------------------
// Main Upload Route
// ----------------------------
app.post("/upload", async (req, res) => {
  try {
    const oem = req.body.oem.trim();
    if (!req.files || !req.files.csvFile) {
      return res.status(400).send("No CSV file uploaded.");
    }

    const fileData = req.files.csvFile.data.toString("utf8");

    const rows = fileData
      .split("\n")
      .map(line => line.split(","))
      .filter(r => r.length > 1);

    const type = detectCsvType(rows);

    let html = "";

    if (type === "promo") {
      const groups = parsePromo(rows);
      html = generatePromoHTML(groups, oem);
    } else if (type === "standard") {
      const tables = parseStandard(rows);
      html = generateStandardHTML(tables, oem);
    } else {
      throw new Error("CSV format not recognized (neither promotional nor standard).");
    }

    return res.json({ success: true, html });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.listen(10000, () => {
  console.log("Server running on port 10000");
});


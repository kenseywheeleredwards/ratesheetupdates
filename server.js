const express = require("express");
const fileUpload = require("express-fileupload");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");

const app = express();
app.use(express.static("public"));
app.use(fileUpload());

/**
 * ----------------------------------------
 * HELPER: Clean a CSV row (trim, remove empties)
 * ----------------------------------------
 */
function cleanRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.trim(), String(v).trim()])
  );
}

/**
 * ----------------------------------------
 * DETECT FORMAT — Promo or Standard
 * ----------------------------------------
 */
function detectFormat(rows) {
  if (!rows || rows.length === 0) return "unknown";

  // 1. PROMOTIONAL FORMAT — clear unique fields
  const headerKeys = Object.keys(rows[0]).map(h => h.toLowerCase());

  const promoHeaders = ["table group", "eligible products/models", "tiers"];
  const promoMatch = promoHeaders.every(h =>
    headerKeys.some(k => k.includes(h))
  );

  if (promoMatch) return "promo";

  // 2. STANDARD FORMAT — detect table shape (NOT text!)
  // Look for a header-like row with:
  // - First cell containing "Tier"
  // - ~7+ numeric-like columns (12M, 24M, 36M, etc.)
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const values = Object.values(rows[i]).map(v => String(v).trim());
    if (values.length < 5) continue;

    const first = values[0].toLowerCase();

    const numericCols = values.slice(1).filter(v =>
      v.match(/^\d{2}m$/i)
    );

    if (first.includes("tier") && numericCols.length >= 3) {
      return "standard";
    }
  }

  return "unknown";
}

/**
 * ----------------------------------------
 * PARSE PROMO
 * ----------------------------------------
 */
function parsePromo(rows) {
  const grouped = {};

  rows.forEach(r => {
    const row = cleanRow(r);

    if (!row["Table Group"] || !row["Eligible Products/Models"]) return;

    const group = row["Table Group"];
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(row);
  });

  return grouped;
}

/**
 * ----------------------------------------
 * PARSE STANDARD
 * ----------------------------------------
 */
function parseStandard(rows) {
  // Find header row by structure, not text
  let headerIndex = -1;

  for (let i = 0; i < 30; i++) {
    const vals = Object.values(rows[i]).map(v => String(v).trim());

    const hasTier = vals[0]?.toLowerCase().includes("tier");
    const numericCols = vals.slice(1).filter(v => v.match(/^\d{2}m$/i));

    if (hasTier && numericCols.length >= 3) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) throw new Error("Could not locate Standard header row.");

  // Extract header names
  const header = Object.values(rows[headerIndex]).map(v => v.trim());

  // Now extract data rows until blank row
  const tables = [];
  let current = [];

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const vals = Object.values(rows[i]).map(v => v.trim());

    const isBlank = vals.every(v => !v);
    if (isBlank) {
      if (current.length > 0) {
        tables.push(current);
        current = [];
      }
      continue;
    }

    current.push(vals);
  }

  if (current.length > 0) tables.push(current);

  return { header, tables };
}

/**
 * ----------------------------------------
 * HTML GENERATION (uses same style for all)
 * ----------------------------------------
 */
function generateHTML({ oemName, promoData, standardData, format }) {
  // Updated colors per your palette
  const primary = "#231F20";
  const background = "#F7F7F7";
  const overlay = "#70737C";
  const highlight = "#0096D7";
  const alt = "#E4F0F7";

  let title = `${oemName} Rate Sheet`;

  let bodyContent = "";

  /** ----------------------
   * PROMOTIONAL HTML
   * ---------------------- */
  if (format === "promo") {
    for (const group in promoData) {
      bodyContent += `
        <h2 style="color:${primary}; margin-top:40px;">${group}</h2>
        <table style="width:100%; border-collapse:collapse; margin-bottom:30px;">
          <thead>
            <tr style="background:${alt};">
              <th style="padding:10px; border:1px solid ${overlay};">Eligible Products/Models</th>
              <th style="padding:10px; border:1px solid ${overlay};">Tiers</th>
            </tr>
          </thead>
          <tbody>
      `;

      promoData[group].forEach(row => {
        bodyContent += `
          <tr>
            <td style="padding:8px; border:1px solid ${overlay};">${row["Eligible Products/Models"]}</td>
            <td style="padding:8px; border:1px solid ${overlay};">${row["Tiers"]}</td>
          </tr>
        `;
      });

      bodyContent += `</tbody></table>`;
    }
  }

  /** ----------------------
   * STANDARD HTML
   * ---------------------- */
  if (format === "standard") {
    const { header, tables } = standardData;

    tables.forEach((table, idx) => {
      bodyContent += `
        <h2 style="color:${primary}; margin-top:40px;">${oemName} Standard Rates — Table ${
          idx + 1
        }</h2>
        <table style="width:100%; border-collapse:collapse; margin-bottom:30px;">
          <thead style="background:${alt};">
            <tr>
              ${header
                .map(
                  h =>
                    `<th style="padding:10px; border:1px solid ${overlay};">${h}</th>`
                )
                .join("")}
            </tr>
          </thead>
          <tbody>
            ${table
              .map(
                row =>
                  `<tr>${row
                    .map(
                      cell =>
                        `<td style="padding:8px; border:1px solid ${overlay};">${cell}</td>`
                    )
                    .join("")}</tr>`
              )
              .join("")}
          </tbody>
        </table>
      `;
    });
  }

  /** ----------------------
   * FULL TEMPLATE
   * ---------------------- */
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;700&display=swap" rel="stylesheet">
</head>
<body style="font-family:Roboto, sans-serif; background:${background}; padding:40px;">

  <h1 style="color:${primary}; text-align:center; margin-bottom:40px;">
    ${title}
  </h1>

  ${bodyContent}

</body>
</html>`;
}

/**
 * ----------------------------------------
 * MAIN UPLOAD ENDPOINT
 * ----------------------------------------
 */
app.post("/upload", (req, res) => {
  if (!req.files || !req.files.csvFile) {
    return res.status(400).json({ error: "No CSV uploaded." });
  }

  const oemName = req.body.oemName?.trim() || "Unknown OEM";
  const file = req.files.csvFile;
  const tempPath = path.join(__dirname, "temp.csv");

  file.mv(tempPath, err => {
    if (err) return res.status(500).json({ error: err.message });

    const rows = [];

    fs.createReadStream(tempPath)
      .pipe(csv())
      .on("data", row => rows.push(row))
      .on("end", () => {
        const format = detectFormat(rows);

        if (format === "unknown") {
          return res.json({
            error:
              "CSV format not recognized as Promotional or Standard. Please verify file structure."
          });
        }

        let html = "";

        if (format === "promo") {
          const promoData = parsePromo(rows);
          html = generateHTML({ oemName, promoData, format });
        }

        if (format === "standard") {
          const standardData = parseStandard(rows);
          html = generateHTML({ oemName, standardData, format });
        }

        fs.unlinkSync(tempPath);
        return res.json({ success: true, html });
      });
  });
});

/**
 * Start server
 */
app.listen(10000, () => {
  console.log("Server running on port 10000");
});


const express = require("express");
const fileUpload = require("express-fileupload");
const fs = require("fs");
const path = require("path");
const Papa = require("papaparse");

const app = express();
app.use(fileUpload());
app.use(express.static("public"));

app.post("/upload", (req, res) => {
  if (!req.files || !req.files.file) {
    return res.status(400).send("No CSV file uploaded.");
  }

  const csvFile = req.files.file.data.toString("utf8");
  const oem = req.body.oem || "OEM";

  const parsed = Papa.parse(csvFile, { header: true });

  if (!parsed.data || parsed.data.length === 0) {
    return res.status(400).send("CSV parsing failed.");
  }

  // --- Extract distinct groups ---
  const groups = {};
  parsed.data.forEach(row => {
    const group = row["Table Group"];
    const model = row["Eligible Products/Models"];
    const tier = row["Tiers"];
    const apr = row["APR"] || row["apr"];

    if (!group || !model || !tier) return;

    if (!groups[group]) groups[group] = [];
    groups[group].push({ model, tier, apr });
  });

  let htmlTables = "";

  for (const group in groups) {
    htmlTables += `
      <h2 style="margin-top:30px; font-size:22px; color:#231F20;">${group}</h2>
      <table style="width:100%; border-collapse:collapse; margin-bottom:20px;">
        <tr style="background:#E4F0F7;">
          <th style="padding:10px; border:1px solid #ccc;">Model</th>
          <th style="padding:10px; border:1px solid #ccc;">Tier</th>
          <th style="padding:10px; border:1px solid #ccc;">APR</th>
        </tr>
    `;

    groups[group].forEach(row => {
      htmlTables += `
        <tr>
          <td style="padding:10px; border:1px solid #ddd;">${row.model}</td>
          <td style="padding:10px; border:1px solid #ddd;">${row.tier}</td>
          <td style="padding:10px; border:1px solid #ddd;">${row.apr}</td>
        </tr>
      `;
    });

    htmlTables += `</table>`;
  }

  const templatePath = path.join(__dirname, "template.html");
  let template = fs.readFileSync(templatePath, "utf8");

  template = template.replace("{{OEM}}", oem);
  template = template.replace("{{TABLES}}", htmlTables);

  res.send(template);
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Server running on port ${port}`));

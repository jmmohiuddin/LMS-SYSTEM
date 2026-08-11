/**
 * A CSV reader for files that came out of a real school's computer.
 *
 * This exists because F-1601 — bulk import, "the practical blocker to any
 * pilot" — turns entirely on reading a spreadsheet a head teacher exported
 * from Excel, and the ways that file differs from the RFC are not exotic
 * edge cases. They are the common case:
 *
 *   • Excel writes a UTF-8 BOM. Consume it and the first header becomes
 *     "﻿roll_no", which matches nothing, so every row reports a
 *     missing roll number and the operator concludes the importer is
 *     broken. This is the single most common real-world CSV failure.
 *
 *   • Excel on a Bangla or European locale writes SEMICOLONS, because the
 *     list separator follows the locale. The file looks fine when opened
 *     in Excel and parses as one giant column anywhere else.
 *
 *   • Line endings are CRLF from Windows, LF from a Mac export, and
 *     occasionally lone CR from something older.
 *
 *   • A guardian's name contains a comma, so the field is quoted; an
 *     address contains a newline INSIDE the quotes.
 *
 * Everything here is about those. There is no dependency: the TRD's
 * dependency budget does not stretch to a CSV library, and the subset that
 * matters is small enough to own and test.
 *
 * Deliberately NOT here: type coercion, header aliasing, and anything that
 * knows what a roll number is. This returns strings keyed by header. What
 * those strings mean belongs to the importer that understands the domain.
 */

export interface CsvRow {
  /** 1-based line number in the ORIGINAL file, header included. */
  lineNo: number;
  /** Header → cell, trimmed. Missing trailing cells read as ''. */
  cells: Record<string, string>;
  /** Cells in file order, for reporting a ragged row honestly. */
  raw: string[];
}

export interface CsvTable {
  headers: string[];
  rows: CsvRow[];
  delimiter: string;
  /** Rows whose cell count disagreed with the header. Never dropped silently. */
  ragged: Array<{ lineNo: number; expected: number; got: number }>;
}

const DELIMITERS = [',', ';', '\t', '|'];

/**
 * Which separator is this file using?
 *
 * Counted on the header line only, and outside quotes — a quoted guardian
 * name full of commas in row 1 must not outvote the real delimiter. Ties
 * go to the comma, which is what an unambiguous single-column file is.
 */
export function sniffDelimiter(firstLine: string): string {
  let best = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') {
        if (inQuotes && firstLine[i + 1] === '"') { i++; continue; }
        inQuotes = !inQuotes;
      } else if (ch === d && !inQuotes) {
        count++;
      }
    }
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

/**
 * Split the whole text into records of fields.
 *
 * One pass, character by character, because a quoted field may contain the
 * delimiter AND a newline — so neither splitting on lines first nor
 * splitting on the delimiter first is correct, however tempting.
 */
function parseRecords(text: string, delimiter: string): Array<{ lineNo: number; fields: string[] }> {
  const records: Array<{ lineNo: number; fields: string[] }> = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let lineNo = 1;
  let recordStart = 1;
  let sawAny = false;

  const endField = (): void => { fields.push(field); field = ''; sawAny = true; };
  const endRecord = (): void => {
    endField();
    records.push({ lineNo: recordStart, fields });
    fields = [];
    sawAny = false;
    recordStart = lineNo;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // "" inside a quoted field is one literal quote.
        if (text[i + 1] === '"') { field += '"'; i++; continue; }
        inQuotes = false;
        continue;
      }
      if (ch === '\n') lineNo++;
      field += ch;
      continue;
    }

    if (ch === '"' && field === '') { inQuotes = true; continue; }
    if (ch === delimiter) { endField(); continue; }

    if (ch === '\r' || ch === '\n') {
      // CRLF is one break, not two. A lone CR is still a break.
      if (ch === '\r' && text[i + 1] === '\n') i++;
      lineNo++;
      // A blank line between records is skipped rather than becoming a row
      // of empty cells — a trailing newline is normal, and every file has
      // one.
      if (fields.length === 0 && field === '' && !sawAny) { recordStart = lineNo; continue; }
      endRecord();
      continue;
    }

    field += ch;
  }

  // Whatever is buffered at EOF is a final record, unless the file simply
  // ended with a newline.
  if (field !== '' || fields.length > 0 || sawAny) endRecord();
  return records;
}

/**
 * Read a CSV file into headers and rows.
 *
 * `text` is the decoded file. Decoding is the caller's problem, with one
 * exception handled here: the BOM, because it is invisible, it is Excel's
 * default, and leaving it attached to the first header silently breaks
 * every row.
 */
export function parseCsv(text: string, opts: { delimiter?: string } = {}): CsvTable {
  // U+FEFF. Not whitespace, not stripped by trim(), and byte-identical to
  // nothing a human can see.
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const firstBreak = clean.search(/\r\n|\n|\r/);
  const firstLine = firstBreak === -1 ? clean : clean.slice(0, firstBreak);
  const delimiter = opts.delimiter ?? sniffDelimiter(firstLine);

  const records = parseRecords(clean, delimiter);
  if (records.length === 0) {
    return { headers: [], rows: [], delimiter, ragged: [] };
  }

  const headers = records[0].fields.map((h) => h.trim());
  const rows: CsvRow[] = [];
  const ragged: CsvTable['ragged'] = [];

  for (const rec of records.slice(1)) {
    // A row of nothing but empty cells is a spreadsheet artefact — Excel
    // emits them for rows a user once touched and cleared. Treating one as
    // a student would report "name required" for a row that is not there.
    if (rec.fields.every((f) => f.trim() === '')) continue;

    if (rec.fields.length !== headers.length) {
      // Reported, not dropped and not repaired. A ragged row usually means
      // an unescaped quote earlier in the file, and quietly padding it
      // would import the wrong values into the right-hand columns.
      ragged.push({ lineNo: rec.lineNo, expected: headers.length, got: rec.fields.length });
    }

    const cells: Record<string, string> = {};
    headers.forEach((h, i) => { cells[h] = (rec.fields[i] ?? '').trim(); });
    rows.push({ lineNo: rec.lineNo, cells, raw: rec.fields });
  }

  return { headers, rows, delimiter, ragged };
}

/**
 * Render rows back to CSV — for the downloadable error list §10.2 requires
 * ("the error list is downloadable so it can be fixed in the source
 * spreadsheet").
 *
 * Always writes a BOM. The file is round-tripping back into the Excel it
 * came from, and without one Excel renders Bangla as mojibake — the same
 * quirk that makes the BOM a problem on the way in makes it mandatory on
 * the way out.
 */
export function toCsv(headers: string[], rows: Array<Record<string, string>>): string {
  const quote = (v: string): string =>
    /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const lines = [headers.map(quote).join(',')];
  for (const r of rows) lines.push(headers.map((h) => quote(r[h] ?? '')).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

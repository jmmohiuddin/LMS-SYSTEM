/**
 * Branded document foundation — the letterhead every printed thing sits on.
 *
 * R-1 of docs/11-MASTER-PLAN.md builds ONLY this foundation. The documents
 * themselves (fee receipt, report card, admit card, ID card, testimonial,
 * transfer certificate) are R-5. What ships here is the part they all share
 * and none of them should re-invent: the institution's logo, name, address
 * and contact block at the top; its watermark behind the page; its
 * authorised signature at the foot.
 *
 * ── Why an HTML string, not DOM ─────────────────────────────────────────
 * Printing means handing a complete document to a print window or a
 * server-side PDF renderer, and both take markup. Building a string keeps
 * this module free of any DOM dependency, so it is testable in plain
 * `node --test` with no jsdom, and reusable later from a background worker
 * that has no `document` at all.
 *
 * ── Why everything is escaped ───────────────────────────────────────────
 * Every value here is tenant-controlled text that a school IT user typed.
 * It is being interpolated into markup. escapeHtml() is applied to every
 * interpolation without exception — including the ones that "obviously"
 * cannot contain markup, because that judgement is what rots.
 *
 * Asset URLs get validateAssetUrl() from ./branding.ts rather than
 * escaping alone: the attribute needs a scheme allowlist, not quoting.
 */
import {
  type Branding,
  brandName,
  validateAssetUrl,
  LIMITS,
} from './branding.ts';

export interface BrandedDocumentOptions {
  branding: Branding;
  /** Document title — printed under the letterhead and used as page title. */
  title: string;
  /** Body markup. The caller owns this; it is NOT escaped. */
  bodyHtml: string;
  /** 'bn' | 'en' — chooses which of the two institution names leads. */
  locale?: string;
  /** Right-hand meta lines under the title: receipt no, date, class… */
  meta?: { label: string; value: string }[];
  /** Print a signature block at the foot. Off for documents that need none. */
  showSignature?: boolean;
  /** Caption under the signature line. Defaults to the head's name. */
  signatureCaption?: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * An asset URL safe to place in an attribute, or '' if it is absent or
 * fails the allowlist. Returning '' rather than throwing is deliberate: a
 * receipt with a missing logo must still print. A receipt that throws is a
 * parent standing at a counter with no proof of payment.
 */
function safeAsset(field: keyof typeof LIMITS, url: string): string {
  if (!url) return '';
  try {
    return escapeHtml(validateAssetUrl(String(field), url, LIMITS[field] as number));
  } catch {
    return '';
  }
}

/**
 * The letterhead block: logo, institution name, address, contact line.
 *
 * Exported separately from brandedDocument() so a screen can render the
 * same header inline — the branding editor's live preview uses exactly
 * this, which is what makes the preview honest rather than a lookalike.
 */
export function brandedLetterhead(branding: Branding, locale = 'bn'): string {
  const name = escapeHtml(brandName(branding, locale));
  const logo = safeAsset('logoUrl', branding.logoUrl);
  const contact = [
    branding.phone && `ফোন: ${branding.phone}`,
    branding.email,
    branding.website,
  ].filter(Boolean).map((s) => escapeHtml(String(s))).join(' · ');

  return [
    '<header class="doc-head">',
    logo ? `<img class="doc-logo" src="${logo}" alt="">` : '',
    '<div class="doc-ident">',
    `<h1 class="doc-org">${name}</h1>`,
    branding.address ? `<p class="doc-addr">${escapeHtml(branding.address)}</p>` : '',
    contact ? `<p class="doc-contact">${contact}</p>` : '',
    '</div>',
    '</header>',
  ].filter(Boolean).join('');
}

/**
 * The signature block. The name is printed under the rule whether or not a
 * signature image exists — a document a head has to sign by hand is still a
 * valid document, and printing the line is what makes that possible.
 */
export function brandedSignature(branding: Branding, caption?: string): string {
  const sig = safeAsset('signatureUrl', branding.signatureUrl);
  const who = escapeHtml(caption ?? branding.headmasterName ?? '');
  return [
    '<div class="doc-sign">',
    sig ? `<img class="doc-sign-img" src="${sig}" alt="">` : '<div class="doc-sign-gap"></div>',
    '<div class="doc-sign-rule"></div>',
    who ? `<div class="doc-sign-name">${who}</div>` : '',
    '<div class="doc-sign-role">অনুমোদিত স্বাক্ষর</div>',
    '</div>',
  ].filter(Boolean).join('');
}

/**
 * Print stylesheet for the foundation.
 *
 * Inlined into the document rather than linked: a print window and a PDF
 * renderer may not share the app's origin or its cache, and a receipt that
 * prints unstyled because a stylesheet 404'd is worse than one that never
 * offered styling. It is small enough that inlining costs nothing.
 *
 * The watermark is a fixed, low-opacity, centred layer behind the content
 * with `print-color-adjust: exact`, because browsers strip background
 * imagery from printed pages by default — which is precisely the setting
 * that would silently drop a school's watermark from every receipt.
 */
export function brandedDocumentCss(branding: Branding): string {
  const watermark = safeAsset('watermarkUrl', branding.watermarkUrl);
  return [
    '*{box-sizing:border-box}',
    'body{margin:0;font-family:"Noto Sans Bengali",system-ui,sans-serif;color:#1f2937;background:#fff}',
    '.doc{position:relative;max-width:210mm;min-height:297mm;margin:0 auto;padding:16mm 14mm;background:#fff}',
    watermark
      ? '.doc-watermark{position:absolute;inset:0;background-image:url("' + watermark + '");'
        + 'background-repeat:no-repeat;background-position:center;background-size:60% auto;'
        + 'opacity:.07;pointer-events:none;z-index:0;'
        + '-webkit-print-color-adjust:exact;print-color-adjust:exact}'
      : '',
    '.doc-body,.doc-head,.doc-title-row,.doc-foot{position:relative;z-index:1}',
    '.doc-head{display:flex;gap:12px;align-items:center;border-bottom:2px solid var(--doc-primary,#D23B2E);padding-bottom:10px}',
    '.doc-logo{width:64px;height:64px;object-fit:contain;flex:none}',
    '.doc-org{margin:0;font-size:20px;font-weight:700;color:var(--doc-primary,#D23B2E)}',
    '.doc-addr,.doc-contact{margin:2px 0 0;font-size:11px;color:#4b5563}',
    '.doc-title-row{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin:14px 0 10px}',
    '.doc-title{margin:0;font-size:15px;font-weight:700}',
    '.doc-meta{font-size:11px;color:#4b5563;text-align:right}',
    '.doc-meta div{margin-bottom:2px}',
    '.doc-meta b{font-weight:600;color:#1f2937}',
    '.doc-foot{margin-top:28px;display:flex;justify-content:flex-end}',
    '.doc-sign{width:190px;text-align:center}',
    '.doc-sign-img{max-width:170px;max-height:56px;object-fit:contain}',
    '.doc-sign-gap{height:56px}',
    '.doc-sign-rule{border-top:1px solid #374151;margin-top:4px}',
    '.doc-sign-name{font-size:12px;font-weight:600;margin-top:4px}',
    '.doc-sign-role{font-size:10.5px;color:#6b7280}',
    '@page{size:A4;margin:0}',
    '@media print{.doc{margin:0;box-shadow:none}}',
  ].filter(Boolean).join('');
}

/** One page of a set: the same options minus the branding they all share. */
export type BrandedSection = Omit<BrandedDocumentOptions, 'branding' | 'locale'>;

/**
 * One `<main class="doc">` — a single page on the tenant's letterhead.
 *
 * Split out of brandedDocument() in R-5 so that one page and forty pages go
 * through the same code. A separate renderer for bulk would be a second place
 * for the watermark to be forgotten, and the forty-page case is exactly the
 * one nobody checks by eye.
 */
function docSection(b: Branding, s: BrandedSection, locale: string): string {
  const watermark = safeAsset('watermarkUrl', b.watermarkUrl);
  const meta = (s.meta ?? [])
    .map((m) => `<div><b>${escapeHtml(m.label)}:</b> ${escapeHtml(m.value)}</div>`)
    .join('');

  return [
    '<main class="doc">',
    watermark ? '<div class="doc-watermark"></div>' : '',
    brandedLetterhead(b, locale),
    '<div class="doc-title-row">',
    `<h2 class="doc-title">${escapeHtml(s.title)}</h2>`,
    meta ? `<div class="doc-meta">${meta}</div>` : '',
    '</div>',
    `<div class="doc-body">${s.bodyHtml}</div>`,
    s.showSignature === false
      ? ''
      : `<footer class="doc-foot">${brandedSignature(b, s.signatureCaption)}</footer>`,
    '</main>',
  ].filter(Boolean).join('\n');
}

export interface BrandedDocumentSetOptions {
  branding: Branding;
  sections: BrandedSection[];
  locale?: string;
  /** Title of the whole page. Defaults to the first section's. */
  title?: string;
  /** Document-type CSS appended to the foundation's — see documents.ts. */
  extraCss?: string;
}

/**
 * One printable page carrying one or MANY documents.  (R-5)
 *
 * The bulk case the master plan asks for — "report cards print for a whole
 * section in one go" — is this with forty sections. Each gets its own
 * letterhead, its own watermark, its own signature block and its own printed
 * page; `documentBodyCss()` supplies the `break-before` that makes the last
 * of those true, because browsers do not break between siblings on their own.
 *
 * Self-contained by construction: inline CSS, inline assets, no network. It
 * prints identically from a print window, a saved file, or a server-side
 * renderer.
 */
export function brandedDocumentSet(o: BrandedDocumentSetOptions): string {
  const locale = o.locale ?? 'bn';
  const b = o.branding;
  const title = o.title ?? o.sections[0]?.title ?? '';

  return [
    '<!doctype html>',
    `<html lang="${locale === 'en' ? 'en' : 'bn'}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} — ${escapeHtml(brandName(b, locale))}</title>`,
    `<style>:root{--doc-primary:${escapeHtml(b.primaryColor)}}`
      + `${brandedDocumentCss(b)}${o.extraCss ?? ''}</style>`,
    '</head>',
    '<body>',
    ...o.sections.map((s) => docSection(b, s, locale)),
    '</body>',
    '</html>',
  ].filter(Boolean).join('\n');
}

/**
 * A complete, standalone, printable HTML document on the tenant's
 * letterhead. Self-contained by construction — inline CSS, inline assets —
 * so it prints identically from a print window, a saved file, or a
 * server-side renderer with no network.
 *
 * The one-document case of brandedDocumentSet(), kept as its own name because
 * most callers have exactly one.
 */
export function brandedDocument(o: BrandedDocumentOptions): string {
  return brandedDocumentSet({
    branding: o.branding,
    locale: o.locale,
    title: o.title,
    sections: [{
      title: o.title,
      bodyHtml: o.bodyHtml,
      meta: o.meta,
      showSignature: o.showSignature,
      signatureCaption: o.signatureCaption,
    }],
  });
}

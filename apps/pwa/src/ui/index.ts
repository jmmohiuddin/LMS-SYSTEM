/**
 * The component system. (UI integration plan, P2)
 *
 * One import for every screen built from P3 onward:
 *
 *     import { pageHeader, card, button, dataTable } from './ui/index.ts';
 *
 * ── What is deliberately NOT here ──────────────────────────────────────────
 *
 * **A DatePicker.** `field({ kind: 'date' })` renders `<input type="date">`,
 * which on Android opens the OS picker, is localised by the phone, works
 * offline, is keyboard-operable, and costs nothing. A hand-built calendar
 * popover would be several kilobytes on the critical path (04-UIUX §6) to
 * reproduce something the platform does better. The one case that genuinely
 * needs more — picking a range across an academic calendar — is R-4's
 * calendar screen, and it already exists.
 *
 * **A charting primitive.** 04-UIUX §6: "server-rendered inline SVG. No
 * charting library ships to the client." Nothing here draws a chart, so
 * nothing here can quietly become the reason one gets installed.
 *
 * **A theme or style prop on anything.** Every visual decision resolves to a
 * token in `app.css`. A component that accepts a colour is a component that
 * will be given a colour outside the palette, and that is how a design system
 * stops being one.
 *
 * ── The contract every builder here keeps ──────────────────────────────────
 * `(doc: Document, options) → HTMLElement`. Detached, no lifecycle, no
 * reactivity — the same shape `view-states.ts` has used since R-3, because the
 * app is framework-free by decision (D1/D3) and its views own their rendering.
 */

export { el, append, icon, lang, clear, uid, resetUid } from './dom.ts';
export type { Child, ElProps } from './dom.ts';

export { button, iconButton, buttonRow, setBusy, onClickBusy } from './button.ts';
export type { ButtonOptions, ButtonVariant, ButtonSize } from './button.ts';

export { card, statCard, statRow, avatar, initial, tintOf } from './card.ts';
export type { CardOptions, CardVariant, CardTone, StatOptions } from './card.ts';

export { pageHeader, breadcrumb, backLink, sectionHeading } from './page-header.ts';
export type { PageHeaderOptions, Crumb } from './page-header.ts';

export { badge, statusBadge, countBadge, STATUS } from './badge.ts';
export type { BadgeTone, StatusOptions } from './badge.ts';

export {
  field, searchField, setFieldError, clearFieldError, reportErrors,
} from './field.ts';
export type { Field, FieldOptions, FieldKind } from './field.ts';

export { fileUpload } from './upload.ts';
export type { UploadOptions } from './upload.ts';

export {
  dataTable, listItem, list, pagination, timeline,
} from './table.ts';
export type { Column, TableOptions, MobileRole } from './table.ts';

export {
  openOverlay, openDrawer, confirmOverlay, setOverlayBody,
} from './overlay.ts';
export type { OverlayOptions, OverlayHandle, OverlayKind } from './overlay.ts';

export { tabs, filterBar } from './filter.ts';
export type { TabItem, FilterDef } from './filter.ts';

export {
  toast, announce, inlineLoader, progress, tooltip,
  listSkeleton, permissionState, humanError, permissionMessage, serverMessage,
  permissionMessageWithContact,
  skeleton, emptyState, errorState, successNote, pageSkeleton,
} from './feedback.ts';
export type { ToastTone } from './feedback.ts';

export { childSelector, childIdentity } from './child-selector.ts';
export type { ChildOption, ChildSelectorOptions } from './child-selector.ts';

export { navFor, navPaths, crumbFor, navLabel, NAV_ROLES } from './nav.ts';
export type { NavItem, NavGroup, RoleNav } from './nav.ts';

export { ROLE_BN, roleLabel } from './roles.ts';
export { readTheme, setTheme, applyTheme, THEME_OPTIONS } from './theme.ts';
export type { ThemePref } from './theme.ts';

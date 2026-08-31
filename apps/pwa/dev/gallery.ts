/* TEMPORARY — P2 browser verification harness. Deleted after acceptance. */
import {
  el, append, button, iconButton, buttonRow, onClickBusy,
  card, statCard, statRow, avatar, pageHeader, sectionHeading, backLink,
  badge, statusBadge, countBadge, field, searchField, setFieldError,
  fileUpload, dataTable, listItem, list, pagination, timeline,
  openOverlay, confirmOverlay, openDrawer, tabs, filterBar,
  toast, inlineLoader, progress, listSkeleton, permissionState,
  emptyState, errorState, successNote, skeleton, type Column,
} from '../src/ui/index.ts';

const d = document;
const root = d.getElementById('root')!;

interface Row { id: string; name: string; roll: number; cls: string; phone: string; due: number }
const ROWS: Row[] = [
  { id: '1', name: 'সাদিয়া ইসলাম', roll: 1, cls: '৮ম — ক', phone: '01712345678', due: 1500 },
  { id: '2', name: 'মোহাম্মদ আব্দুল্লাহ আল-মামুন চৌধুরী', roll: 2, cls: '৮ম — ক', phone: '01812345678', due: 0 },
  { id: '3', name: 'ফারিয়া আক্তার', roll: 3, cls: '৮ম — খ', phone: '01912345678', due: 750 },
];
const COLS: Array<Column<Row>> = [
  { key: 'name', header: 'নাম', cell: (r) => r.name, mobile: 'title' },
  { key: 'roll', header: 'রোল', cell: (r) => String(r.roll), numeric: true, width: '80px', mobile: 'meta' },
  { key: 'cls', header: 'শ্রেণি ও শাখা', cell: (r) => r.cls, mobile: 'subtitle' },
  { key: 'phone', header: 'অভিভাবকের ফোন', cell: (r) => r.phone, mobile: 'meta' },
  { key: 'due', header: 'বকেয়া', numeric: true, mobile: 'status',
    cell: (r) => statusBadge(d, { state: r.due > 0 ? 'overdue' : 'paid',
      label: r.due > 0 ? `৳ ${r.due}` : 'পরিশোধিত' }) },
];

function section(title: string, ...kids: unknown[]): HTMLElement {
  const s = el(d, 'div', { className: 'gal-section' });
  append(s, sectionHeading(d, { title }));
  append(s, el(d, 'div', { className: 'gal-body' }, ...(kids as never[])));
  return s;
}

append(root,
  pageHeader(d, {
    title: 'উপাদান সংগ্রহ',
    subtitle: 'P2 — প্রতিটি উপাদানের সব অবস্থা এক পাতায়।',
    crumbs: [{ label: 'প্রতিষ্ঠান', path: 'institution' }, { label: 'উপাদান' }],
    badge: badge(d, { label: 'P2', tone: 'primary' }),
    actions: [button(d, { label: 'রপ্তানি', variant: 'secondary', glyph: 'upload' })],
    primary: button(d, { label: '+ নতুন', variant: 'primary' }),
  }),

  section('Buttons',
    buttonRow(d,
      button(d, { label: 'বাতিল', variant: 'secondary' }),
      button(d, { label: 'সংরক্ষণ করুন', variant: 'primary' })),
    el(d, 'div', { className: 'gal-row' },
      button(d, { label: 'প্রাথমিক', variant: 'primary' }),
      button(d, { label: 'দ্বিতীয়', variant: 'secondary' }),
      button(d, { label: 'ঘোস্ট', variant: 'ghost' }),
      button(d, { label: 'মুছুন', variant: 'danger', glyph: 'alert-triangle' }),
      button(d, { label: 'সব উপস্থিত', variant: 'success' }),
      button(d, { label: 'নিষ্ক্রিয়', variant: 'primary', disabled: true }),
      button(d, { label: 'ব্যস্ত', variant: 'primary', busy: true }),
      iconButton(d, { glyph: 'bell', label: 'নোটিশ' }),
      iconButton(d, { glyph: 'x', label: 'মুছুন', variant: 'danger' }))),

  section('Cards and stats',
    statRow(d,
      statCard(d, { label: 'মোট শিক্ষার্থী', value: '২৮৬ জন', glyph: 'users', tone: 'info' }),
      statCard(d, { label: 'আজকের হাজিরা', value: '২৪৮ জন', glyph: 'check-square', tone: 'success', note: 'এ মাসে ৯২%' }),
      statCard(d, { label: 'আজকের ক্লাস', value: '৫ টি', glyph: 'clock', tone: 'warn' }),
      statCard(d, { label: 'বকেয়া', value: '৳ ৪২,৫০০', glyph: 'wallet', tone: 'accent2' })),
    el(d, 'div', { className: 'gal-grid' },
      card(d, { title: 'সাধারণ কার্ড', subtitle: 'একটি ধারক', glyph: 'book-open', tone: 'info' },
        el(d, 'p', { text: 'কার্ডের ভেতরের বিষয়বস্তু এখানে থাকে।' })),
      card(d, { title: 'ক্লিকযোগ্য কার্ড', subtitle: 'পুরোটাই একটি বোতাম', glyph: 'check-square',
        onClick: () => toast(d, { message: 'কার্ডে ক্লিক হয়েছে' }) }),
      card(d, { title: 'অ্যাকসেন্ট কার্ড', variant: 'accent', glyph: 'star', subtitle: 'পাতায় একটিই' }))),

  section('Avatars and badges',
    el(d, 'div', { className: 'gal-row' },
      avatar(d, { name: 'সাদিয়া ইসলাম', size: 'lg' }),
      avatar(d, { name: 'ক্ষুদ্র বিদ্যালয়' }),
      avatar(d, { name: 'রাফি' }),
      avatar(d, { name: 'তাহিয়া' }),
      avatar(d, { name: 'Mohammad', size: 'sm' })),
    el(d, 'div', { className: 'gal-row' },
      badge(d, { label: 'বিজ্ঞান' }),
      badge(d, { label: 'CQ', tone: 'info' }),
      statusBadge(d, { state: 'published', label: 'প্রকাশিত' }),
      statusBadge(d, { state: 'draft', label: 'খসড়া' }),
      statusBadge(d, { state: 'due', label: 'সময় হয়েছে' }),
      statusBadge(d, { state: 'overdue', label: 'বকেয়া' }),
      statusBadge(d, { state: 'suspended', label: 'স্থগিত' }),
      countBadge(d, 3, 'নোটিশ'),
      countBadge(d, 42, 'নোটিশ'))),

  section('Tabs and filters',
    tabs(d, { label: 'ছাঁকনি', active: 'all',
      items: [{ id: 'all', label: 'সব', count: 286 }, { id: 'absent', label: 'অনুপস্থিত', count: 4 },
              { id: 'late', label: 'দেরি' }],
      onSelect: (id) => toast(d, { message: `ট্যাব: ${id}` }) }),
    filterBar(d, {
      filters: [
        { id: 'cls', label: 'শ্রেণি', value: '9',
          options: [{ value: '', label: 'সব শ্রেণি' }, { value: '9', label: 'নবম শ্রেণি' }] },
        { id: 'sec', label: 'শাখা', value: '',
          options: [{ value: '', label: 'সব শাখা' }, { value: 'a', label: 'ক শাখা' }] },
        { id: 'st', label: 'অবস্থা', value: 'due',
          options: [{ value: '', label: 'সব' }, { value: 'due', label: 'বকেয়া' }] }],
      onChange: () => {}, onClearAll: () => {} })),

  section('Table → mobile list',
    dataTable(d, { columns: COLS, rows: ROWS, rowKey: (r) => r.id,
      caption: 'শিক্ষার্থী তালিকা', onRowClick: (r) => toast(d, { message: r.name }) }),
    pagination(d, { page: 3, pageCount: 12, onGo: () => {}, summary: '৬০০ জনের মধ্যে ৫১–১০০' })),

  section('Lists and timeline',
    list(d, 'নোটিশসমূহ',
      listItem(d, { title: 'আগামীকাল স্কুল ছুটি', subtitle: 'সব শ্রেণি', meta: '১৯ মে, ২০২৬',
        glyph: 'bell', status: statusBadge(d, { state: 'published', label: 'প্রকাশিত' }),
        onClick: () => {} }),
      listItem(d, { title: 'অভিভাবক সমাবেশ', subtitle: 'নবম ও দশম', meta: '১৭ মে, ২০২৬',
        glyph: 'calendar', onClick: () => {} })),
    timeline(d, { label: 'কার্যবিবরণী', entries: [
      { when: 'আজ, ১০:৩২', title: 'ফলাফল প্রকাশিত', detail: 'অর্ধবার্ষিক — ১৬৮ জন', tone: 'success', glyph: 'award' },
      { when: 'গতকাল, ১৬:০৫', title: 'শিক্ষক যোগ করা হয়েছে', detail: 'সেলিনা আক্তার' },
      { when: '১৮ মে', title: 'ইনভয়েস তৈরি ব্যর্থ', detail: 'একই মাসে দুইবার', tone: 'danger', glyph: 'alert-triangle' }] })),

  section('Forms',
    (() => {
      const form = el(d, 'form', { className: 'gal-form' });
      const name = field(d, { label: 'শিক্ষার্থীর নাম', name: 'nameBn', required: true,
        helper: 'জন্মনিবন্ধন অনুযায়ী পূর্ণ নাম' });
      const roll = field(d, { label: 'রোল নম্বর', name: 'roll', kind: 'number', required: true });
      const phone = field(d, { label: 'অভিভাবকের ফোন', name: 'phone', kind: 'tel',
        helper: '১১ সংখ্যার মোবাইল নম্বর' });
      const cls = field(d, { label: 'শ্রেণি', name: 'cls', kind: 'select', value: '9',
        options: [{ value: '8', label: 'অষ্টম শ্রেণি' }, { value: '9', label: 'নবম শ্রেণি' }] });
      const note = field(d, { label: 'মন্তব্য', name: 'note', kind: 'textarea',
        placeholder: 'ঐচ্ছিক' });
      const dis = field(d, { label: 'নিষ্ক্রিয় ঘর', name: 'x', disabled: true, value: 'পরিবর্তন করা যাবে না' });
      append(form, name.root, roll.root, phone.root, cls.root, note.root, dis.root);
      setFieldError(phone.root, 'এই নম্বরটি ইতিমধ্যে ব্যবহৃত হয়েছে');
      (phone.input as HTMLInputElement).value = '01712345678';
      append(form,
        fileUpload(d, { label: 'CSV নির্বাচন করুন', name: 'csv', accept: '.csv',
          helper: 'সর্বোচ্চ ২ MB', maxBytes: 2 * 1024 * 1024, onFiles: () => {} }).root,
        searchField(d, { label: 'শিক্ষার্থী খুঁজুন', placeholder: 'আইডি বা নাম',
          resultNote: '১২টি ফলাফল', onSearch: () => {} }).root);
      return form;
    })()),

  section('Overlays',
    el(d, 'div', { className: 'gal-row' },
      button(d, { label: 'মডাল / শিট', variant: 'secondary', onClick: () => {
        openOverlay(d, { title: 'নতুন সেকশন', body: [
          field(d, { label: 'সেকশনের নাম', name: 's', required: true }).root,
          el(d, 'p', { className: 'ui-dialog-text', text: 'সেকশন তৈরির পর শিক্ষার্থী যোগ করা যাবে।' })],
          actions: [button(d, { label: 'বাতিল', variant: 'secondary' }),
                    button(d, { label: 'তৈরি করুন', variant: 'primary' })] });
      } }),
      button(d, { label: 'ড্রয়ার', variant: 'secondary', onClick: () => {
        openDrawer(d, { title: 'ছাঁকনি', body: el(d, 'p', { text: 'ড্রয়ারের ভেতরের বিষয়বস্তু।' }) });
      } }),
      button(d, { label: 'নিশ্চিতকরণ', variant: 'danger', onClick: () => {
        confirmOverlay(d, { title: 'ফলাফল প্রকাশ করবেন?',
          body: '১৬৮ জন শিক্ষার্থীর ফলাফল প্রকাশ হবে। প্রকাশের পর নম্বর আর পরিবর্তন করা যাবে না।',
          confirmLabel: 'প্রকাশ করুন', danger: true, onConfirm: () => {} });
      } }),
      button(d, { label: 'টোস্ট (সফল)', variant: 'ghost', onClick: () =>
        toast(d, { message: 'শিক্ষার্থী সফলভাবে যোগ হয়েছে', tone: 'success' }) }),
      button(d, { label: 'টোস্ট (ত্রুটি)', variant: 'ghost', onClick: () =>
        toast(d, { message: 'তথ্য সংরক্ষণ হয়নি', tone: 'error', action: { label: 'আবার', onClick: () => {} } }) }))),

  section('States',
    el(d, 'div', { className: 'gal-grid' },
      card(d, { title: 'Loading — skeleton' }, skeleton(d, 3)),
      card(d, { title: 'Loading — list' }, listSkeleton(d, 3)),
      card(d, { title: 'Loading — inline' }, inlineLoader(d)),
      card(d, { title: 'Progress' }, progress(d, { value: 340, max: 1000, label: '৩৪০ / ১০০০ সারি আমদানি হয়েছে' })),
      card(d, { title: 'Empty' }, emptyState(d, {
        message: 'এখনো কোনো সেকশন তৈরি করা হয়নি। প্রথমে একটি সেকশন তৈরি করুন।',
        action: { label: 'সেকশন তৈরি করুন', onClick: () => {} } })),
      card(d, { title: 'Error' }, errorState(d, 'তথ্য লোড করা যায়নি।', () => {})),
      card(d, { title: 'Permission denied' }, permissionState(d, { contact: 'প্রধান শিক্ষক' })),
      card(d, { title: 'Success' }, successNote(d, 'নোটিশ প্রকাশ হয়েছে')))),

  section('Navigation bits',
    backLink(d, 'নবম শ্রেণিতে ফিরে যান', () => {})),
);

// A live busy button, to see the spinner in a real paint.
const busyDemo = button(d, { label: 'সংরক্ষণ করুন', variant: 'primary' });
onClickBusy(busyDemo, () => new Promise((r) => setTimeout(r, 1500)));
append(root, section('Busy on click', busyDemo));

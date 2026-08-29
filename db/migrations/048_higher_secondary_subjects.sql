-- ============================================================================
-- 048 — Higher-secondary subjects  (R-7 completion)
--
-- `subject_catalogue` has covered classes 1–10 since migration 012 and nothing
-- above. The consequence was not visible until an operator onboarded a College
-- through the R-7 wizard and looked at what came out:
--
--     classes 2 · sections 2 · grading bands 7 · fee heads 6
--     class_subject_mappings 0 · subject_template_items 0
--
-- A college could be created, branded, given administrators and activated —
-- and could not take a single student. `readStudents` requires a fourth
-- subject from class 9 upwards, there were no class-11/12 subjects to name,
-- so every row of its first import was rejected with "চতুর্থ বিষয় খালি".
--
-- Two of the four institution types the product supports are affected: College
-- (classes 11–12) and the upper half of School & College (`combined`, 1–12).
--
-- This is reference data, not logic. `app.provision_tenant()` already selects
-- from this table by stream, level range and group (012 §6), so seeding these
-- rows makes a college provision correctly with no code change at all.
--
-- ── About the codes ────────────────────────────────────────────────────
-- `nctb_code` is deliberately NOT a claimed NCTB paper number here. Two
-- reasons, and the second is the one that would have caused a bug:
--
--   1. I can state the HSC subject set and its group structure accurately —
--      it is stable and well established — but not every official paper code,
--      and a wrong code printed on a transcript is worse than no code.
--
--   2. The codes already in this table are SSC papers: `101` is বাংলা ১ম পত্র
--      for classes 9–10. A `combined` institution provisions classes 1–12 and
--      would receive BOTH, and `subjects` is unique on
--      (tenant_id, nctb_code, name_en) — same code, same English name, so the
--      ON CONFLICT DO NOTHING in provisioning would silently drop one of the
--      two and the school would be short a subject with no error anywhere.
--
-- So these carry an `H`-prefixed identifier of our own. It is stable, unique
-- against the existing rows, and honest about what it is. A school that wants
-- the official code edits it on its own subjects screen.
--
-- NULL was the other option and is worse: the same unique index treats NULLs
-- as distinct, so a re-run of provisioning — which R-7 requires to be a no-op —
-- would insert a second copy of every one of these.
-- ============================================================================

BEGIN;

-- ── Compulsory for every group ─────────────────────────────────────────
INSERT INTO subject_catalogue
  (nctb_code, name_bn, name_en, short_name, stream, min_level_no, max_level_no,
   applies_to_group, is_optional, is_practical, has_cq, has_mcq, display_order)
VALUES
  ('H101', 'বাংলা ১ম পত্র', 'Bangla 1st Paper (HSC)', 'বাং১',
   'bangla_medium', 11, 12, 'none', false, false, true, true, 101),
  ('H102', 'বাংলা ২য় পত্র', 'Bangla 2nd Paper (HSC)', 'বাং২',
   'bangla_medium', 11, 12, 'none', false, false, true, true, 102),
  ('H107', 'ইংরেজি ১ম পত্র', 'English 1st Paper (HSC)', 'ইং১',
   'bangla_medium', 11, 12, 'none', false, false, true, false, 107),
  ('H108', 'ইংরেজি ২য় পত্র', 'English 2nd Paper (HSC)', 'ইং২',
   'bangla_medium', 11, 12, 'none', false, false, true, false, 108),
  ('H275', 'তথ্য ও যোগাযোগ প্রযুক্তি', 'ICT (HSC)', 'আইসিটি',
   'bangla_medium', 11, 12, 'none', false, true, true, true, 275)
ON CONFLICT DO NOTHING;

-- ── Science ────────────────────────────────────────────────────────────
-- Physics, Chemistry and Biology are two papers each and carry a practical.
-- Higher Mathematics is the group's optional/fourth subject, the same role
-- `126` plays for classes 9–10.
INSERT INTO subject_catalogue
  (nctb_code, name_bn, name_en, short_name, stream, min_level_no, max_level_no,
   applies_to_group, is_optional, is_practical, has_cq, has_mcq, display_order)
VALUES
  ('H174', 'পদার্থবিজ্ঞান ১ম পত্র', 'Physics 1st Paper (HSC)', 'পদা১',
   'bangla_medium', 11, 12, 'science', false, true, true, true, 174),
  ('H175', 'পদার্থবিজ্ঞান ২য় পত্র', 'Physics 2nd Paper (HSC)', 'পদা২',
   'bangla_medium', 11, 12, 'science', false, true, true, true, 175),
  ('H176', 'রসায়ন ১ম পত্র', 'Chemistry 1st Paper (HSC)', 'রসা১',
   'bangla_medium', 11, 12, 'science', false, true, true, true, 176),
  ('H177', 'রসায়ন ২য় পত্র', 'Chemistry 2nd Paper (HSC)', 'রসা২',
   'bangla_medium', 11, 12, 'science', false, true, true, true, 177),
  ('H178', 'জীববিজ্ঞান ১ম পত্র', 'Biology 1st Paper (HSC)', 'জীব১',
   'bangla_medium', 11, 12, 'science', false, true, true, true, 178),
  ('H179', 'জীববিজ্ঞান ২য় পত্র', 'Biology 2nd Paper (HSC)', 'জীব২',
   'bangla_medium', 11, 12, 'science', false, true, true, true, 179),
  ('H265', 'উচ্চতর গণিত ১ম পত্র', 'Higher Mathematics 1st Paper (HSC)', 'উগ১',
   'bangla_medium', 11, 12, 'science', true, false, true, true, 265),
  ('H266', 'উচ্চতর গণিত ২য় পত্র', 'Higher Mathematics 2nd Paper (HSC)', 'উগ২',
   'bangla_medium', 11, 12, 'science', true, false, true, true, 266)
ON CONFLICT DO NOTHING;

-- ── Humanities ─────────────────────────────────────────────────────────
INSERT INTO subject_catalogue
  (nctb_code, name_bn, name_en, short_name, stream, min_level_no, max_level_no,
   applies_to_group, is_optional, is_practical, has_cq, has_mcq, display_order)
VALUES
  ('H269', 'পৌরনীতি ও সুশাসন ১ম পত্র', 'Civics & Good Governance 1st Paper (HSC)', 'পৌর১',
   'bangla_medium', 11, 12, 'humanities', false, false, true, true, 269),
  ('H270', 'পৌরনীতি ও সুশাসন ২য় পত্র', 'Civics & Good Governance 2nd Paper (HSC)', 'পৌর২',
   'bangla_medium', 11, 12, 'humanities', false, false, true, true, 270),
  ('H109', 'অর্থনীতি ১ম পত্র', 'Economics 1st Paper (HSC)', 'অর্থ১',
   'bangla_medium', 11, 12, 'humanities', false, false, true, true, 109),
  ('H110', 'অর্থনীতি ২য় পত্র', 'Economics 2nd Paper (HSC)', 'অর্থ২',
   'bangla_medium', 11, 12, 'humanities', false, false, true, true, 110),
  ('H304', 'ইতিহাস ১ম পত্র', 'History 1st Paper (HSC)', 'ইতি১',
   'bangla_medium', 11, 12, 'humanities', false, false, true, true, 304),
  ('H305', 'ইতিহাস ২য় পত্র', 'History 2nd Paper (HSC)', 'ইতি২',
   'bangla_medium', 11, 12, 'humanities', false, false, true, true, 305),
  ('H121', 'যুক্তিবিদ্যা ১ম পত্র', 'Logic 1st Paper (HSC)', 'যুক্তি১',
   'bangla_medium', 11, 12, 'humanities', true, false, true, true, 121),
  ('H122', 'যুক্তিবিদ্যা ২য় পত্র', 'Logic 2nd Paper (HSC)', 'যুক্তি২',
   'bangla_medium', 11, 12, 'humanities', true, false, true, true, 122)
ON CONFLICT DO NOTHING;

-- ── Business studies ───────────────────────────────────────────────────
INSERT INTO subject_catalogue
  (nctb_code, name_bn, name_en, short_name, stream, min_level_no, max_level_no,
   applies_to_group, is_optional, is_practical, has_cq, has_mcq, display_order)
VALUES
  ('H253', 'হিসাববিজ্ঞান ১ম পত্র', 'Accounting 1st Paper (HSC)', 'হিসা১',
   'bangla_medium', 11, 12, 'business_studies', false, false, true, true, 253),
  ('H254', 'হিসাববিজ্ঞান ২য় পত্র', 'Accounting 2nd Paper (HSC)', 'হিসা২',
   'bangla_medium', 11, 12, 'business_studies', false, false, true, true, 254),
  ('H277', 'ব্যবসায় সংগঠন ও ব্যবস্থাপনা ১ম পত্র',
   'Business Organisation & Management 1st Paper (HSC)', 'ব্যব১',
   'bangla_medium', 11, 12, 'business_studies', false, false, true, true, 277),
  ('H278', 'ব্যবসায় সংগঠন ও ব্যবস্থাপনা ২য় পত্র',
   'Business Organisation & Management 2nd Paper (HSC)', 'ব্যব২',
   'bangla_medium', 11, 12, 'business_studies', false, false, true, true, 278),
  ('H292', 'ফিন্যান্স, ব্যাংকিং ও বীমা ১ম পত্র',
   'Finance, Banking & Insurance 1st Paper (HSC)', 'ফিন১',
   'bangla_medium', 11, 12, 'business_studies', true, false, true, true, 292),
  ('H293', 'ফিন্যান্স, ব্যাংকিং ও বীমা ২য় পত্র',
   'Finance, Banking & Insurance 2nd Paper (HSC)', 'ফিন২',
   'bangla_medium', 11, 12, 'business_studies', true, false, true, true, 293)
ON CONFLICT DO NOTHING;

-- ── Madrasah, আলিম ─────────────────────────────────────────────────────
-- A madrasa may run to আলিম, which is the higher-secondary stage. The
-- catalogue stopped at দাখিল (10), so an আলিম madrasa had the same problem a
-- college did. Kept deliberately small — the compulsory core only — because
-- the আলিম group structure varies by board more than the general one does,
-- and a school adds what it teaches.
INSERT INTO subject_catalogue
  (nctb_code, name_bn, name_en, short_name, stream, min_level_no, max_level_no,
   applies_to_group, is_optional, is_practical, has_cq, has_mcq, display_order)
VALUES
  ('HM01', 'কুরআন মাজিদ', 'Quran Majeed (Alim)', 'কুরআন',
   'madrasah', 11, 12, 'none', false, false, true, true, 1),
  ('HM02', 'হাদিস শরিফ', 'Hadith Sharif (Alim)', 'হাদিস',
   'madrasah', 11, 12, 'none', false, false, true, true, 2),
  ('HM03', 'আরবি সাহিত্য', 'Arabic Literature (Alim)', 'আরবি',
   'madrasah', 11, 12, 'none', false, false, true, true, 3),
  ('HM04', 'বাংলা', 'Bangla (Alim)', 'বাংলা',
   'madrasah', 11, 12, 'none', false, false, true, true, 4),
  ('HM05', 'ইংরেজি', 'English (Alim)', 'ইংরেজি',
   'madrasah', 11, 12, 'none', false, false, true, false, 5),
  ('HM06', 'তথ্য ও যোগাযোগ প্রযুক্তি', 'ICT (Alim)', 'আইসিটি',
   'madrasah', 11, 12, 'none', false, true, true, true, 6)
ON CONFLICT DO NOTHING;

COMMENT ON TABLE subject_catalogue IS
  'Platform-global NCTB subject reference. Classes 1–10 seeded by migration '
  '012; classes 11–12 by 048, whose codes are H-prefixed identifiers of our '
  'own rather than claimed NCTB paper numbers — see that migration''s header.';

COMMIT;

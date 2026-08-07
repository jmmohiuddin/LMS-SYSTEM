-- =====================================================================
-- 012_provisioning_and_reference.sql
--
-- Without this file the schema is deployed but unusable: a new tenant has
-- no grading bands (so app.compute_subject_grade returns NULL), no subject
-- catalogue, no bell schedule, no fee heads and no chart of accounts.
--
-- Provides:
--   * subject_catalogue   — platform-global NCTB subject reference
--   * app.provision_tenant() — one call turns an empty tenant into a
--     working institution
--
-- ⚠ NCTB SUBJECT CODES BELOW ARE INDICATIVE AND MUST BE VERIFIED against
--   the current board circular before production use. They are printed on
--   board registration and MPO forms; a wrong code is a real-world problem,
--   not a cosmetic one. See risk R3 in docs/05-DELIVERY-ROADMAP.md — this
--   is precisely what the curriculum specialist role exists to sign off.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Platform-global subject reference. Not tenant-scoped: the NCTB
-- curriculum is identical for every institution of a given stream.
-- ---------------------------------------------------------------------
CREATE TABLE subject_catalogue (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nctb_code         varchar(8),
  name_bn           text NOT NULL,
  name_en           text NOT NULL,
  short_name        text,
  stream            institution_stream NOT NULL,
  min_level_no      smallint NOT NULL CHECK (min_level_no BETWEEN 1 AND 12),
  max_level_no      smallint NOT NULL CHECK (max_level_no BETWEEN 1 AND 12),
  applies_to_group  academic_group NOT NULL DEFAULT 'none',
  is_optional       boolean NOT NULL DEFAULT false,
  is_practical      boolean NOT NULL DEFAULT false,
  has_cq            boolean NOT NULL DEFAULT true,
  has_mcq           boolean NOT NULL DEFAULT true,
  requires_capability text,
  -- Default NCTB mark distribution for this subject
  total_marks       smallint NOT NULL DEFAULT 100,
  cq_marks          smallint NOT NULL DEFAULT 70,
  mcq_marks         smallint NOT NULL DEFAULT 30,
  practical_marks   smallint NOT NULL DEFAULT 0,
  ca_marks          smallint NOT NULL DEFAULT 0,
  cq_pass_marks     smallint NOT NULL DEFAULT 23,
  mcq_pass_marks    smallint NOT NULL DEFAULT 10,
  periods_per_week  smallint NOT NULL DEFAULT 4,
  double_periods_per_week smallint NOT NULL DEFAULT 0,
  display_order     smallint NOT NULL DEFAULT 0,
  verified_against  text,        -- circular reference once a specialist signs off
  CHECK (max_level_no >= min_level_no),
  CHECK (cq_marks + mcq_marks + practical_marks + ca_marks = total_marks),
  UNIQUE (stream, nctb_code, name_en, min_level_no)
);
CREATE INDEX ix_subject_catalogue_pick
  ON subject_catalogue (stream, min_level_no, max_level_no, applies_to_group);

-- ── Primary (classes 1–5) ────────────────────────────────────────────
-- Primary uses continuous assessment, not CQ/MCQ.
INSERT INTO subject_catalogue
  (nctb_code,name_bn,name_en,short_name,stream,min_level_no,max_level_no,
   has_cq,has_mcq,total_marks,cq_marks,mcq_marks,ca_marks,cq_pass_marks,mcq_pass_marks,
   periods_per_week,display_order) VALUES
  (NULL,'বাংলা','Bangla','BAN','bangla_medium',1,5,false,false,100,0,0,100,0,0,6,10),
  (NULL,'ইংরেজি','English','ENG','bangla_medium',1,5,false,false,100,0,0,100,0,0,6,20),
  (NULL,'গণিত','Mathematics','MAT','bangla_medium',1,5,false,false,100,0,0,100,0,0,6,30),
  (NULL,'বাংলাদেশ ও বিশ্বপরিচয়','Bangladesh & Global Studies','BGS','bangla_medium',3,5,false,false,100,0,0,100,0,0,3,40),
  (NULL,'প্রাথমিক বিজ্ঞান','Elementary Science','SCI','bangla_medium',3,5,false,false,100,0,0,100,0,0,3,50),
  (NULL,'ধর্ম ও নৈতিক শিক্ষা','Religion & Moral Education','REL','bangla_medium',3,5,false,false,100,0,0,100,0,0,2,60);

-- ── Junior secondary (classes 6–8) ───────────────────────────────────
INSERT INTO subject_catalogue
  (nctb_code,name_bn,name_en,short_name,stream,min_level_no,max_level_no,
   total_marks,cq_marks,mcq_marks,cq_pass_marks,mcq_pass_marks,periods_per_week,display_order) VALUES
  (NULL,'বাংলা','Bangla','BAN','bangla_medium',6,8,100,70,30,23,10,6,10),
  (NULL,'ইংরেজি','English','ENG','bangla_medium',6,8,100,70,30,23,10,6,20),
  (NULL,'গণিত','Mathematics','MAT','bangla_medium',6,8,100,70,30,23,10,6,30),
  (NULL,'বিজ্ঞান','Science','SCI','bangla_medium',6,8,100,70,30,23,10,4,40),
  (NULL,'বাংলাদেশ ও বিশ্বপরিচয়','Bangladesh & Global Studies','BGS','bangla_medium',6,8,100,70,30,23,10,3,50),
  (NULL,'ধর্ম ও নৈতিক শিক্ষা','Religion & Moral Education','REL','bangla_medium',6,8,100,70,30,23,10,2,60),
  (NULL,'তথ্য ও যোগাযোগ প্রযুক্তি','ICT','ICT','bangla_medium',6,8,50,25,25,8,8,2,70),
  (NULL,'কৃষিশিক্ষা','Agriculture','AGR','bangla_medium',6,8,100,70,30,23,10,2,80);

-- ── Secondary core (classes 9–10, all groups) ────────────────────────
INSERT INTO subject_catalogue
  (nctb_code,name_bn,name_en,short_name,stream,min_level_no,max_level_no,applies_to_group,
   total_marks,cq_marks,mcq_marks,cq_pass_marks,mcq_pass_marks,periods_per_week,display_order) VALUES
  ('101','বাংলা ১ম পত্র','Bangla 1st Paper','BAN1','bangla_medium',9,10,'none',100,70,30,23,10,4,10),
  ('102','বাংলা ২য় পত্র','Bangla 2nd Paper','BAN2','bangla_medium',9,10,'none',100,70,30,23,10,3,11),
  ('107','ইংরেজি ১ম পত্র','English 1st Paper','ENG1','bangla_medium',9,10,'none',100,100,0,33,0,4,20),
  ('108','ইংরেজি ২য় পত্র','English 2nd Paper','ENG2','bangla_medium',9,10,'none',100,100,0,33,0,3,21),
  ('109','গণিত','Mathematics','MAT','bangla_medium',9,10,'none',100,70,30,23,10,5,30),
  ('111','ইসলাম ও নৈতিক শিক্ষা','Islam & Moral Education','ISL','bangla_medium',9,10,'none',100,70,30,23,10,2,40),
  ('150','বাংলাদেশ ও বিশ্বপরিচয়','Bangladesh & Global Studies','BGS','bangla_medium',9,10,'none',100,70,30,23,10,3,50);

-- ── Secondary science group (9–10) ───────────────────────────────────
INSERT INTO subject_catalogue
  (nctb_code,name_bn,name_en,short_name,stream,min_level_no,max_level_no,applies_to_group,
   is_practical,requires_capability,total_marks,cq_marks,mcq_marks,practical_marks,
   cq_pass_marks,mcq_pass_marks,periods_per_week,double_periods_per_week,display_order) VALUES
  ('136','পদার্থবিজ্ঞান','Physics','PHY','bangla_medium',9,10,'science',true,'physics_lab',100,50,25,25,17,8,5,1,60),
  ('137','রসায়ন','Chemistry','CHE','bangla_medium',9,10,'science',true,'chemistry_lab',100,50,25,25,17,8,5,1,61),
  ('138','জীববিজ্ঞান','Biology','BIO','bangla_medium',9,10,'science',true,'biology_lab',100,50,25,25,17,8,5,1,62),
  ('154','তথ্য ও যোগাযোগ প্রযুক্তি','ICT','ICT','bangla_medium',9,10,'none',true,'computer',50,25,25,0,8,8,2,0,70);

-- The 4th (optional) subject. Higher Math carries a 25-mark practical, so the
-- distribution is CQ 50 + MCQ 25 + practical 25 = 100.
INSERT INTO subject_catalogue
  (nctb_code,name_bn,name_en,short_name,stream,min_level_no,max_level_no,applies_to_group,
   is_optional,is_practical,total_marks,cq_marks,mcq_marks,practical_marks,
   cq_pass_marks,mcq_pass_marks,periods_per_week,display_order) VALUES
  ('126','উচ্চতর গণিত','Higher Mathematics','HMAT','bangla_medium',9,10,'science',
   true,true,100,50,25,25,17,8,4,80);

-- ── Secondary humanities / business (9–10) ───────────────────────────
INSERT INTO subject_catalogue
  (nctb_code,name_bn,name_en,short_name,stream,min_level_no,max_level_no,applies_to_group,
   total_marks,cq_marks,mcq_marks,cq_pass_marks,mcq_pass_marks,periods_per_week,display_order) VALUES
  ('140','পৌরনীতি ও নাগরিকতা','Civics & Citizenship','CIV','bangla_medium',9,10,'humanities',100,70,30,23,10,4,60),
  ('141','অর্থনীতি','Economics','ECO','bangla_medium',9,10,'humanities',100,70,30,23,10,4,61),
  ('110','ভূগোল ও পরিবেশ','Geography & Environment','GEO','bangla_medium',9,10,'humanities',100,70,30,23,10,4,62),
  ('146','হিসাববিজ্ঞান','Accounting','ACC','bangla_medium',9,10,'business_studies',100,70,30,23,10,4,60),
  ('143','ব্যবসায় উদ্যোগ','Business Entrepreneurship','BUS','bangla_medium',9,10,'business_studies',100,70,30,23,10,4,61),
  ('152','ফিন্যান্স ও ব্যাংকিং','Finance & Banking','FIN','bangla_medium',9,10,'business_studies',100,70,30,23,10,4,62);

-- ── Madrasah (Dakhil) additions ──────────────────────────────────────
INSERT INTO subject_catalogue
  (nctb_code,name_bn,name_en,short_name,stream,min_level_no,max_level_no,
   total_marks,cq_marks,mcq_marks,cq_pass_marks,mcq_pass_marks,periods_per_week,display_order) VALUES
  (NULL,'কুরআন মাজিদ ও তাজবিদ','Quran Majeed & Tajweed','QUR','madrasah',6,10,100,70,30,23,10,5,10),
  (NULL,'আকাইদ ও ফিকহ','Aqaid & Fiqh','AQF','madrasah',6,10,100,70,30,23,10,4,20),
  (NULL,'আরবি ১ম পত্র','Arabic 1st Paper','ARB1','madrasah',6,10,100,70,30,23,10,4,30),
  (NULL,'আরবি ২য় পত্র','Arabic 2nd Paper','ARB2','madrasah',9,10,100,70,30,23,10,3,31),
  (NULL,'হাদিস শরিফ','Hadith Sharif','HAD','madrasah',9,10,100,70,30,23,10,3,40),
  (NULL,'বাংলা','Bangla','BAN','madrasah',6,10,100,70,30,23,10,4,50),
  (NULL,'ইংরেজি','English','ENG','madrasah',6,10,100,100,0,33,0,4,60),
  (NULL,'গণিত','Mathematics','MAT','madrasah',6,10,100,70,30,23,10,4,70);

COMMENT ON TABLE subject_catalogue IS
  'Platform-global NCTB subject reference used by app.provision_tenant(). '
  'nctb_code values are INDICATIVE and must be verified against the current board '
  'circular before production; set verified_against once signed off.';

-- ---------------------------------------------------------------------
-- Default bell schedule (used when a tenant supplies none)
-- ---------------------------------------------------------------------
CREATE TABLE period_template_defaults (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift        shift_code NOT NULL,
  period_no    smallint NOT NULL,
  label_bn     text NOT NULL,
  starts_at    time NOT NULL,
  ends_at      time NOT NULL,
  kind         period_kind NOT NULL DEFAULT 'teaching',
  UNIQUE (shift, period_no)
);

INSERT INTO period_template_defaults (shift, period_no, label_bn, starts_at, ends_at, kind) VALUES
  ('day',0,'সমাবেশ','08:00','08:20','assembly'),
  ('day',1,'১ম','08:20','09:00','teaching'),
  ('day',2,'২য়','09:00','09:40','teaching'),
  ('day',3,'৩য়','09:40','10:20','teaching'),
  ('day',4,'৪র্থ','10:20','11:00','teaching'),
  ('day',5,'টিফিন','11:00','11:30','tiffin'),
  ('day',6,'৫ম','11:30','12:10','teaching'),
  ('day',7,'৬ষ্ঠ','12:10','12:50','teaching'),
  ('day',8,'জোহর','12:50','13:20','prayer'),
  ('day',9,'৭ম','13:20','14:00','teaching'),
  ('morning',0,'সমাবেশ','07:15','07:30','assembly'),
  ('morning',1,'১ম','07:30','08:05','teaching'),
  ('morning',2,'২য়','08:05','08:40','teaching'),
  ('morning',3,'৩য়','08:40','09:15','teaching'),
  ('morning',4,'৪র্থ','09:15','09:50','teaching'),
  ('morning',5,'টিফিন','09:50','10:10','tiffin'),
  ('morning',6,'৫ম','10:10','10:45','teaching'),
  ('morning',7,'৬ষ্ঠ','10:45','11:20','teaching'),
  ('morning',8,'৭ম','11:20','11:55','teaching');

-- ---------------------------------------------------------------------
-- app.provision_tenant()
--
-- Turns an existing (empty) tenant row into a working institution.
-- Idempotent: safe to re-run; every insert is ON CONFLICT DO NOTHING.
-- Must be called INSIDE a transaction that has already set
--     SET LOCAL app.tenant_id = <the tenant>;
--     SET LOCAL app.role      = 'principal';
-- because every write below passes through RLS like any other write.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.provision_tenant(
  p_tenant        uuid,
  p_year_label    text  DEFAULT to_char(CURRENT_DATE, 'YYYY'),
  p_year_start    date  DEFAULT date_trunc('year', CURRENT_DATE)::date,
  p_year_end      date  DEFAULT (date_trunc('year', CURRENT_DATE) + interval '1 year - 1 day')::date,
  p_min_level     smallint DEFAULT 1,
  p_max_level     smallint DEFAULT 10
) RETURNS TABLE (created_object text, qty integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_stream   institution_stream;
  v_shifts   shift_code[];
  v_year     uuid;
  v_scale    uuid;
  v_tmpl     uuid;
  v_shift    shift_code;
  v_class    RECORD;
  v_cat      RECORD;
  v_subject  uuid;
  n          integer;
BEGIN
  IF app.current_tenant() IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'provision_tenant must run inside the tenant''s own context '
                    '(SET LOCAL app.tenant_id = %)', p_tenant
      USING ERRCODE = '42501';
  END IF;

  SELECT t.stream, t.shifts INTO v_stream, v_shifts FROM tenants t WHERE t.id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant % not found or not visible', p_tenant USING ERRCODE = 'P0002';
  END IF;

  -- ── 1. Academic year ───────────────────────────────────────────────
  INSERT INTO academic_years (tenant_id, label, starts_on, ends_on, is_current)
  VALUES (p_tenant, p_year_label, p_year_start, p_year_end, true)
  ON CONFLICT (tenant_id, label) DO NOTHING;
  SELECT id INTO v_year FROM academic_years
   WHERE tenant_id = p_tenant AND label = p_year_label;
  created_object := 'academic_year'; qty := 1; RETURN NEXT;

  -- ── 2. Terms ───────────────────────────────────────────────────────
  INSERT INTO terms (tenant_id, academic_year_id, code, name_bn, starts_on, ends_on, sequence_no)
  VALUES
    (p_tenant, v_year, 'half_yearly', 'অর্ধবার্ষিক পরীক্ষা',
       p_year_start, p_year_start + 180, 1),
    (p_tenant, v_year, 'annual', 'বার্ষিক পরীক্ষা',
       p_year_start + 181, p_year_end, 2)
  ON CONFLICT (tenant_id, academic_year_id, code) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; created_object := 'terms'; qty := n; RETURN NEXT;

  -- ── 3. Grading scale — WITHOUT THIS, GPA COMPUTATION RETURNS NULL ──
  INSERT INTO grading_scales (tenant_id, name, effective_from, is_default)
  VALUES (p_tenant, 'Bangladesh Board Scale', p_year_start, true)
  ON CONFLICT (tenant_id, name, effective_from) DO NOTHING;
  SELECT id INTO v_scale FROM grading_scales
   WHERE tenant_id = p_tenant AND name = 'Bangladesh Board Scale'
     AND effective_from = p_year_start;

  INSERT INTO grading_bands
    (tenant_id, scale_id, min_percent, max_percent, letter, grade_point, description_bn) VALUES
    (p_tenant, v_scale, 80, 100  , 'A+', 5.00, 'অসাধারণ'),
    (p_tenant, v_scale, 70,  79.99,'A' , 4.00, 'খুব ভালো'),
    (p_tenant, v_scale, 60,  69.99,'A-', 3.50, 'ভালো'),
    (p_tenant, v_scale, 50,  59.99,'B' , 3.00, 'মোটামুটি'),
    (p_tenant, v_scale, 40,  49.99,'C' , 2.00, 'গড়'),
    (p_tenant, v_scale, 33,  39.99,'D' , 1.00, 'উত্তীর্ণ'),
    (p_tenant, v_scale,  0,  32.99,'F' , 0.00, 'অকৃতকার্য')
  ON CONFLICT (tenant_id, scale_id, letter) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; created_object := 'grading_bands'; qty := n; RETURN NEXT;

  -- ── 4. Bell schedule per shift ─────────────────────────────────────
  FOREACH v_shift IN ARRAY v_shifts LOOP
    INSERT INTO period_templates (tenant_id, name_bn, shift, effective_from)
    VALUES (p_tenant, 'নিয়মিত সময়সূচি', v_shift, p_year_start)
    ON CONFLICT (tenant_id, name_bn, shift, effective_from) DO NOTHING;

    SELECT id INTO v_tmpl FROM period_templates
     WHERE tenant_id = p_tenant AND shift = v_shift AND effective_from = p_year_start;

    INSERT INTO period_definitions
      (tenant_id, template_id, period_no, label_bn, starts_at, ends_at, kind)
    SELECT p_tenant, v_tmpl, d.period_no, d.label_bn, d.starts_at, d.ends_at, d.kind
    FROM period_template_defaults d
    WHERE d.shift = (CASE WHEN v_shift = 'single' THEN 'day' ELSE v_shift END)::shift_code
    ON CONFLICT (tenant_id, template_id, period_no) DO NOTHING;
  END LOOP;
  created_object := 'period_templates'; qty := array_length(v_shifts, 1); RETURN NEXT;

  -- ── 5. Classes ─────────────────────────────────────────────────────
  INSERT INTO classes (tenant_id, level_no, name_bn, name_en, stream, "group", display_order)
  SELECT p_tenant, lvl,
         (ARRAY['প্রথম','দ্বিতীয়','তৃতীয়','চতুর্থ','পঞ্চম','ষষ্ঠ','সপ্তম','অষ্টম',
                'নবম','দশম','একাদশ','দ্বাদশ'])[lvl] || ' শ্রেণি',
         'Class ' || lvl, v_stream,
         CASE WHEN lvl >= 9 THEN 'science'::academic_group ELSE 'none'::academic_group END,
         lvl
  FROM generate_series(p_min_level::int, p_max_level::int) AS lvl
  ON CONFLICT (tenant_id, level_no, stream, "group") DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; created_object := 'classes'; qty := n; RETURN NEXT;

  -- ── 6. Subjects + class_subjects from the catalogue ────────────────
  n := 0;
  FOR v_class IN
    SELECT * FROM classes WHERE tenant_id = p_tenant AND stream = v_stream
  LOOP
    FOR v_cat IN
      SELECT * FROM subject_catalogue sc
      WHERE sc.stream = v_stream
        AND v_class.level_no BETWEEN sc.min_level_no AND sc.max_level_no
        AND (sc.applies_to_group = 'none' OR sc.applies_to_group = v_class."group")
      ORDER BY sc.display_order
    LOOP
      INSERT INTO subjects (tenant_id, nctb_code, name_bn, name_en, short_name,
                            is_optional, is_practical, has_cq, has_mcq, requires_capability)
      VALUES (p_tenant, v_cat.nctb_code, v_cat.name_bn, v_cat.name_en, v_cat.short_name,
              v_cat.is_optional, v_cat.is_practical, v_cat.has_cq, v_cat.has_mcq,
              v_cat.requires_capability)
      ON CONFLICT (tenant_id, nctb_code, name_en) DO NOTHING;

      SELECT id INTO v_subject FROM subjects
       WHERE tenant_id = p_tenant AND name_en = v_cat.name_en
         AND nctb_code IS NOT DISTINCT FROM v_cat.nctb_code
       LIMIT 1;

      INSERT INTO class_subjects
        (tenant_id, class_id, subject_id, academic_year_id, periods_per_week,
         double_periods_per_week, total_marks, cq_marks, mcq_marks, practical_marks,
         ca_marks, cq_pass_marks, mcq_pass_marks)
      VALUES (p_tenant, v_class.id, v_subject, v_year, v_cat.periods_per_week,
              v_cat.double_periods_per_week, v_cat.total_marks, v_cat.cq_marks,
              v_cat.mcq_marks, v_cat.practical_marks, v_cat.ca_marks,
              v_cat.cq_pass_marks, v_cat.mcq_pass_marks)
      ON CONFLICT (tenant_id, class_id, subject_id, academic_year_id) DO NOTHING;
      n := n + 1;
    END LOOP;
  END LOOP;
  created_object := 'class_subject_mappings'; qty := n; RETURN NEXT;

  -- ── 7. Fee heads ───────────────────────────────────────────────────
  INSERT INTO fee_heads (tenant_id, code, name_bn, name_en, frequency, gl_account) VALUES
    (p_tenant,'ADMISSION','ভর্তি ফি','Admission Fee','one_time','4100'),
    (p_tenant,'TUITION'  ,'মাসিক বেতন','Monthly Tuition','monthly','4000'),
    (p_tenant,'EXAM'     ,'পরীক্ষার ফি','Examination Fee','exam','4200'),
    (p_tenant,'SESSION'  ,'সেশন চার্জ','Session Charge','annual','4300'),
    (p_tenant,'TRANSPORT','পরিবহন ফি','Transport Fee','monthly','4400'),
    (p_tenant,'LIBRARY'  ,'গ্রন্থাগার ফি','Library Fee','annual','4500')
  ON CONFLICT (tenant_id, code) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; created_object := 'fee_heads'; qty := n; RETURN NEXT;

  -- ── 8. Chart of accounts (double-entry ledger needs these) ─────────
  INSERT INTO ledger_accounts (tenant_id, code, name_bn, type) VALUES
    (p_tenant,'1000','নগদ','asset'),
    (p_tenant,'1010','ব্যাংক হিসাব','asset'),
    (p_tenant,'1020','এমএফএস প্রাপ্য','asset'),
    (p_tenant,'1100','শিক্ষার্থী প্রাপ্য','asset'),
    (p_tenant,'2000','অগ্রিম আদায়','liability'),
    (p_tenant,'4000','টিউশন আয়','income'),
    (p_tenant,'4100','ভর্তি আয়','income'),
    (p_tenant,'4200','পরীক্ষা আয়','income'),
    (p_tenant,'4300','সেশন আয়','income'),
    (p_tenant,'4400','পরিবহন আয়','income'),
    (p_tenant,'4500','গ্রন্থাগার আয়','income'),
    (p_tenant,'5000','বেতন ব্যয়','expense'),
    (p_tenant,'5100','গেটওয়ে চার্জ','expense'),
    (p_tenant,'5200','এসএমএস ব্যয়','expense')
  ON CONFLICT (tenant_id, code) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; created_object := 'ledger_accounts'; qty := n; RETURN NEXT;

  -- ── 9. Reference counter for invoice/receipt numbering ─────────────
  INSERT INTO event_outbox (tenant_id, event_type, aggregate_type, aggregate_id, payload)
  VALUES (p_tenant, 'tenant.provisioned.v1', 'tenant', p_tenant,
          jsonb_build_object('academicYear', p_year_label,
                             'levels', int4range(p_min_level, p_max_level, '[]')::text));
  created_object := 'provisioned_event'; qty := 1; RETURN NEXT;
END $$;

COMMENT ON FUNCTION app.provision_tenant IS
  'Idempotent. Turns an empty tenant row into a working institution: academic year, '
  'terms, BD board grading scale, bell schedule per shift, classes, subjects with NCTB '
  'mark distributions, fee heads and chart of accounts. Must run inside the tenant''s '
  'own RLS context.';

COMMIT;

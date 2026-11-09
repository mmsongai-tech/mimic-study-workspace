\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

BEGIN READ ONLY;
SET LOCAL statement_timeout = '180s';

COPY (
  WITH ranked_admissions AS (
    SELECT
      icu.subject_id,
      icu.hadm_id,
      icu.stay_id,
      icu.intime,
      admission.hospital_expire_flag,
      patient.anchor_age
        + EXTRACT(YEAR FROM icu.intime)::integer
        - patient.anchor_year AS age_years,
      patient.gender,
      ROW_NUMBER() OVER (
        PARTITION BY icu.subject_id
        ORDER BY icu.intime, icu.stay_id
      ) AS admission_rank
    FROM mimiciv_icu.icustays AS icu
    INNER JOIN mimiciv_hosp.admissions AS admission
      USING (subject_id, hadm_id)
    INNER JOIN mimiciv_hosp.patients AS patient
      USING (subject_id)
  ),
  eligible_admissions AS (
    SELECT *
    FROM ranked_admissions
    WHERE admission_rank = 1
      AND age_years >= 18
  ),
  analysis_cohort AS (
    SELECT
      eligible.subject_id,
      eligible.hospital_expire_flag,
      eligible.age_years,
      eligible.gender,
      lactate.max_lactate_first_6h,
      lactate.excluded_measurements
    FROM eligible_admissions AS eligible
    LEFT JOIN LATERAL (
      SELECT
        MAX(lab.valuenum::double precision) FILTER (
          WHERE lab.valuenum > 0 AND lab.valuenum <= 30
        ) AS max_lactate_first_6h,
        COUNT(*) FILTER (
          WHERE lab.valuenum <= 0 OR lab.valuenum > 30
        ) AS excluded_measurements
      FROM mimiciv_hosp.labevents AS lab
      WHERE lab.subject_id = eligible.subject_id
        AND lab.hadm_id = eligible.hadm_id
        AND lab.itemid IN (50813, 53154)
        AND lab.charttime >= eligible.intime
        AND lab.charttime < eligible.intime + INTERVAL '6 hours'
    ) AS lactate ON TRUE
  ),
  complete_cohort AS (
    SELECT *
    FROM analysis_cohort
    WHERE max_lactate_first_6h IS NOT NULL
  )
  SELECT
    'AUDIT' AS record_type,
    '' AS analysis_record_id,
    NULL::double precision AS max_lactate_first_6h,
    NULL::integer AS hospital_expire_flag,
    NULL::integer AS age_years,
    NULL::text AS gender,
    COUNT(*)::bigint AS eligible_first_admissions,
    COUNT(*) FILTER (WHERE max_lactate_first_6h IS NULL)::bigint AS missing_lactate,
    SUM(excluded_measurements)::bigint AS excluded_measurements
  FROM analysis_cohort
  UNION ALL
  SELECT
    'RECORD' AS record_type,
    'ROW-' || LPAD(
      ROW_NUMBER() OVER (ORDER BY subject_id)::text,
      6,
      '0'
    ) AS analysis_record_id,
    max_lactate_first_6h,
    hospital_expire_flag,
    age_years,
    gender,
    NULL::bigint AS eligible_first_admissions,
    NULL::bigint AS missing_lactate,
    NULL::bigint AS excluded_measurements
  FROM complete_cohort
  ORDER BY record_type, analysis_record_id
) TO STDOUT WITH (FORMAT CSV, HEADER TRUE);

ROLLBACK;

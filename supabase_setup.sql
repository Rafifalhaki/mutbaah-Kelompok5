-- ==========================================================================
-- SETUP LENGKAP SUPABASE — Mutaba'ah Yaumiyah Kelompok Mentoring (Kelompok 5)
-- Copy-paste seluruh isi file ini ke: Supabase Dashboard > SQL Editor > Run
-- ==========================================================================

-- 1. Buat Tabel `profiles`
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  pin TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('mentor', 'mentee'))
);

-- 2. Buat Tabel `amalan_items`
CREATE TABLE IF NOT EXISTS public.amalan_items (
  id INT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('harian', 'semester')),
  target_semester INT,
  order_num INT NOT NULL
);

-- 3. Buat Tabel `mutabaah_logs` (dimulai dari 0 catatan / kosong)
CREATE TABLE IF NOT EXISTS public.mutabaah_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amalan_id INT NOT NULL REFERENCES public.amalan_items(id) ON DELETE CASCADE,
  log_date DATE NOT NULL,
  value INT NOT NULL DEFAULT 0,
  CONSTRAINT mutabaah_logs_unique_user_amalan_date UNIQUE (user_id, amalan_id, log_date)
);

-- Index bantu untuk query cepat per user dan tanggal
CREATE INDEX IF NOT EXISTS idx_mutabaah_logs_user_date
  ON public.mutabaah_logs (user_id, log_date);

-- 4. Isi Data Awal `profiles` (1 Mentor + 10 Mentee, PIN awal: 1234)
-- User dapat mengganti PIN masing-masing lewat fitur "Ubah PIN" di dalam aplikasi.
INSERT INTO public.profiles (username, pin, full_name, role) VALUES
  ('usamah',   '1234', 'Bang Usamah', 'mentor'),
  ('fatih',    '1234', 'Fatih',       'mentee'),
  ('fahrezi',  '1234', 'Fahrezi',     'mentee'),
  ('ghazy',    '1234', 'Ghazy',       'mentee'),
  ('nawaf',    '1234', 'Nawaf',       'mentee'),
  ('autumn',   '1234', 'Autumn',      'mentee'),
  ('fachri',   '1234', 'Fachri',      'mentee'),
  ('salman',   '1234', 'Salman',      'mentee'),
  ('reza',     '1234', 'Reza',        'mentee'),
  ('shapiere', '1234', 'Shapiere',    'mentee'),
  ('rifq',     '1234', 'Rifq',        'mentee')
ON CONFLICT (username) DO NOTHING;

-- 5. Isi Data Awal `amalan_items` (7 Harian + 2 Semester)
-- Catatan: Sholawat 100x memakai id = 9 (order_num = 7) agar kompatibel dengan
-- database yang sudah terlanjur menyimpan id 7 & 8 untuk target semester.
INSERT INTO public.amalan_items (id, name, category, target_semester, order_num) VALUES
  (1, 'Sholat Subuh',                    'harian',   NULL, 1),
  (2, 'Sholat Dzuhur',                   'harian',   NULL, 2),
  (3, 'Sholat Ashar',                    'harian',   NULL, 3),
  (4, 'Sholat Maghrib',                  'harian',   NULL, 4),
  (5, 'Sholat Isya',                     'harian',   NULL, 5),
  (6, 'Istighfar 100x sehari',           'harian',   NULL, 6),
  (9, 'Sholawat 100x sehari',            'harian',   NULL, 7),
  (7, 'Amalan target 4x / semester',     'semester', 4,    8),
  (8, 'Tilawah target 3 juz / semester', 'semester', 3,    9)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  target_semester = EXCLUDED.target_semester,
  order_num = EXCLUDED.order_num;

-- 6. Nonaktifkan RLS & Beri Hak Akses ke Role `anon` (Publishable Key)
ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.amalan_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.mutabaah_logs DISABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO anon, authenticated;
GRANT SELECT ON TABLE public.amalan_items TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mutabaah_logs TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

-- 7. Fungsi RPC Leaderboard Publik (Privasi Ketat untuk Mentee)
CREATE OR REPLACE FUNCTION public.get_public_leaderboard()
RETURNS TABLE (
  user_id UUID,
  full_name TEXT,
  final_score NUMERIC,
  has_data BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_start DATE := DATE '2026-11-01';
  v_end   DATE := DATE '2027-01-31';
  v_today DATE := CURRENT_DATE;
  v_days  INT;
BEGIN
  v_days := GREATEST(1, LEAST((v_end - v_start) + 1, (v_today - v_start) + 1));

  RETURN QUERY
  WITH agg AS (
    SELECT
      p.id AS uid,
      p.full_name AS fname,
      COALESCE(SUM(CASE WHEN a.category = 'harian' AND LOWER(a.name) LIKE '%sholat%' AND LOWER(a.name) NOT LIKE '%sholawat%' AND l.value >= 1 THEN 1 ELSE 0 END), 0) AS sholat_done,
      COALESCE(SUM(CASE WHEN a.category = 'harian' AND LOWER(a.name) LIKE '%istighfar%' AND l.value >= 1 THEN 1 ELSE 0 END), 0) AS istighfar_done,
      COALESCE(SUM(CASE WHEN a.category = 'harian' AND LOWER(a.name) LIKE '%sholawat%' AND l.value >= 1 THEN 1 ELSE 0 END), 0) AS sholawat_done,
      COALESCE(SUM(CASE WHEN a.category = 'semester' AND LOWER(a.name) NOT LIKE '%tilawah%' THEN GREATEST(l.value, 0) ELSE 0 END), 0) AS amalan4x_done,
      COALESCE(SUM(CASE WHEN a.category = 'semester' AND LOWER(a.name) LIKE '%tilawah%' THEN GREATEST(l.value, 0) ELSE 0 END), 0) AS tilawah_done,
      BOOL_OR(COALESCE(l.value, 0) > 0) AS any_positive
    FROM public.profiles p
    LEFT JOIN public.mutabaah_logs l
      ON l.user_id = p.id
      AND l.log_date BETWEEN v_start AND v_end
    LEFT JOIN public.amalan_items a
      ON a.id = l.amalan_id
    WHERE p.role = 'mentee'
    GROUP BY p.id, p.full_name
  )
  SELECT
    uid AS user_id,
    fname AS full_name,
    ROUND((
      LEAST(100, (sholat_done::NUMERIC / (v_days * 5)) * 100) +
      LEAST(100, (istighfar_done::NUMERIC / v_days) * 100) +
      LEAST(100, (sholawat_done::NUMERIC / v_days) * 100) +
      LEAST(100, (amalan4x_done::NUMERIC / 4) * 100) +
      LEAST(100, (tilawah_done::NUMERIC / 3) * 100)
    ) / 5.0, 2) AS final_score,
    COALESCE(any_positive, FALSE) AS has_data
  FROM agg
  ORDER BY final_score DESC, fname ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_leaderboard() TO anon, authenticated;

-- 8. Refresh Schema Cache Supabase API agar tabel langsung terbaca
NOTIFY pgrst, 'reload schema';

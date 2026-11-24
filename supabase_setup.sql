-- ==========================================================================
-- Catatan SQL Supabase — Mutaba'ah Yaumiyah Kelompok Mentoring
-- Jalankan bagian yang diperlukan di Supabase Dashboard > SQL Editor
-- ==========================================================================

-- --------------------------------------------------------------------------
-- OPSI 1 (PALING PRAKTIS — NONAKTIFKAN RLS SEMENTARA / INTERNAL KELOMPOK)
-- Karena login menggunakan tabel `profiles` (username + PIN) tanpa Supabase Auth,
-- nonaktifkan RLS agar client anon key dapat membaca/menulis data.
-- Privasi antar mentee tetap ditegakkan ketat di sisi aplikasi frontend.
-- --------------------------------------------------------------------------
ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.amalan_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.mutabaah_logs DISABLE ROW LEVEL SECURITY;

-- --------------------------------------------------------------------------
-- OPSI 2 (JIKA RLS INGIN TETAP AKTIF dengan Policy Terbuka untuk Anon Key)
-- Gunakan ini HANYA jika Anda tidak ingin menjalankan DISABLE ROW LEVEL SECURITY.
-- --------------------------------------------------------------------------
/*
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.amalan_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mutabaah_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon read profiles" ON public.profiles
  FOR SELECT TO anon USING (true);

CREATE POLICY "Allow anon update own pin" ON public.profiles
  FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "Allow anon read amalan_items" ON public.amalan_items
  FOR SELECT TO anon USING (true);

CREATE POLICY "Allow anon manage mutabaah_logs" ON public.mutabaah_logs
  FOR ALL TO anon USING (true) WITH CHECK (true);
*/

-- --------------------------------------------------------------------------
-- OPSI 3 (OPSIONAL — RPC LEADERBOARD PUBLIK AGAR MENTEE TAK PERLU QUERY LOG MENTEE LAIN)
-- app.js otomatis mendeteksi fungsi ini jika tersedia!
-- --------------------------------------------------------------------------
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
  v_start DATE := DATE '2026-11-24';
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
      COALESCE(SUM(CASE WHEN a.category = 'harian' AND LOWER(a.name) LIKE '%sholat%' AND l.value >= 1 THEN 1 ELSE 0 END), 0) AS sholat_done,
      COALESCE(SUM(CASE WHEN a.category = 'harian' AND LOWER(a.name) LIKE '%istighfar%' AND l.value >= 1 THEN 1 ELSE 0 END), 0) AS istighfar_done,
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
      LEAST(100, (amalan4x_done::NUMERIC / 4) * 100) +
      LEAST(100, (tilawah_done::NUMERIC / 3) * 100)
    ) / 4.0, 2) AS final_score,
    COALESCE(any_positive, FALSE) AS has_data
  FROM agg
  ORDER BY final_score DESC, fname ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_leaderboard() TO anon, authenticated;

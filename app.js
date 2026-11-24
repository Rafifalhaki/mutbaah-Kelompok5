/* ==========================================================================
   Mutaba'ah Yaumiyah Kelompok Mentoring — Main Application Logic
   Stack: Vanilla JS + Bootstrap 5.3 + Chart.js + Supabase JS v2 (CDN)
   ========================================================================== */

// --------------------------------------------------------------------------
// 1. KONFIGURASI SUPABASE (WAJIB DIISI SEBELUM DEPLOY)
// --------------------------------------------------------------------------
const SUPABASE_URL = 'https://jmdtucnotifwmwzcajxc.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_HgAl4jI581c1KxHC4pUOBA_zDgggLB1';

// --------------------------------------------------------------------------
// 2. KONSTANTA PERIODE SEMESTER & APLIKASI
// --------------------------------------------------------------------------
const SEMESTER_START = '2026-11-01';
const SEMESTER_END = '2027-01-31';
const SESSION_STORAGE_KEY = 'mutabaah_mentoring_session_v1';
const GROUP_TILAWAH_TARGET_JUZ = 30; // 10 mentee x 3 juz

const DAY_NAMES_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const DAY_SHORT_ID = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const MONTH_SHORT_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

// --------------------------------------------------------------------------
// 3. STATE APLIKASI
// --------------------------------------------------------------------------
let supabaseClient = null;
let menteeTrendChartInstance = null;
let mentorGroupChartInstance = null;
let changePinModalInstance = null;
let menteeDetailModalInstance = null;

// Auto-save queue state
const pendingAutoSaves = new Map(); // key: `${log_date}__${amalan_id}` -> payload row
let autoSaveTimer = null;
let isFlushingAutoSave = false;

const state = {
  user: null, // { id, username, full_name, role }
  activeTab: null,
  amalanItems: [],
  amalanMeta: null,

  // Mentee-only state (strictly personal logs + public aggregate leaderboard)
  inputMode: 'daily', // 'daily' | 'weekly'
  selectedDate: '',
  weeklyStartDate: '', // Monday (YYYY-MM-DD) for 7-day weekly matrix
  draftValues: {}, // { [amalan_id]: number }
  myLogs: [], // ONLY current user's mutabaah_logs
  myStats: null,
  leaderboard: [], // ONLY public aggregate: { userId, fullName, finalScore, predicate, hasPositiveData, rank }

  // Mentor-only state
  mentorMentees: [], // enriched objects for all 10 mentees
  mentorFilter: 'all', // 'all' | 'low' | 'missing_today'
  mentorSearch: '',
};

// --------------------------------------------------------------------------
// 4. UTILITAS TANGGAL, ANGKA, & KEAMANAN HTML
// --------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getTodayStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseUtcDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function formatUtcDate(ms) {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function diffDays(startStr, endStr) {
  return Math.round((parseUtcDate(endStr) - parseUtcDate(startStr)) / 86400000);
}

function addDays(dateStr, delta) {
  return formatUtcDate(parseUtcDate(dateStr) + delta * 86400000);
}

function getDayOfWeek(dateStr) {
  return new Date(parseUtcDate(dateStr)).getUTCDay(); // 0=Minggu .. 5=Jumat .. 6=Sabtu
}

function getMondayOfWeek(dateStr) {
  const dow = getDayOfWeek(dateStr);
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  return addDays(dateStr, diffToMonday);
}

function formatDateLongId(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = getDayOfWeek(dateStr);
  return `${DAY_NAMES_ID[dow]}, ${d} ${MONTH_SHORT_ID[m - 1]} ${y}`;
}

function formatDateShortId(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTH_SHORT_ID[m - 1]}`;
}

function getSpecialDayInfo(dateStr) {
  const dow = getDayOfWeek(dateStr);
  if (dow === 5) {
    return {
      type: 'friday',
      badgeText: 'Jumat',
      badgeClass: 'day-badge-friday',
      bannerClass: 'banner-friday',
      icon: 'bi-stars',
      message: 'Hari Jumat Mubarak! Jangan lupa baca Surah Al-Kahfi, perbanyak shalawat & doa.',
    };
  }
  if (dow === 1) {
    return {
      type: 'sunnah',
      badgeText: 'Senin',
      badgeClass: 'day-badge-sunnah',
      bannerClass: 'banner-sunnah',
      icon: 'bi-sun-fill',
      message: 'Hari Senin — Momentum istimewa untuk amalan sunnah (puasa Senin & tilawah).',
    };
  }
  if (dow === 4) {
    return {
      type: 'sunnah',
      badgeText: 'Kamis',
      badgeClass: 'day-badge-sunnah',
      bannerClass: 'banner-sunnah',
      icon: 'bi-sun-fill',
      message: 'Hari Kamis — Hari diangkatnya amal, semangat perbanyak ibadah sunnah!',
    };
  }
  return null;
}

function getSemesterMetrics(todayStr = getTodayStr()) {
  const totalDays = Math.max(1, diffDays(SEMESTER_START, SEMESTER_END) + 1);
  const rawElapsed = diffDays(SEMESTER_START, todayStr) + 1;
  const hariBerjalan = Math.max(1, Math.min(totalDays, rawElapsed));
  const sisaHari = Math.max(0, diffDays(todayStr, SEMESTER_END));
  return { totalDays, hariBerjalan, sisaHari, todayStr };
}

function getMaxInputDate(todayStr = getTodayStr()) {
  return todayStr < SEMESTER_END ? todayStr : SEMESTER_END;
}

function isDateEditable(dateStr, todayStr = getTodayStr()) {
  if (!dateStr) return false;
  return dateStr >= SEMESTER_START && dateStr <= getMaxInputDate(todayStr);
}

function clampPct(value) {
  if (!Number.isFinite(value) || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function formatPct(value) {
  const safe = clampPct(Number(value) || 0);
  return Number.isInteger(safe) ? `${safe}%` : `${safe.toFixed(1)}%`;
}

function getInitials(fullName) {
  const parts = String(fullName || 'U').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'U';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// --------------------------------------------------------------------------
// 5. INISIALISASI SUPABASE & NOTIFIKASI UI
// --------------------------------------------------------------------------
function isSupabaseConfigured() {
  return (
    SUPABASE_URL &&
    SUPABASE_ANON_KEY &&
    !SUPABASE_URL.includes('ISI_SUPABASE_URL_ANDA') &&
    !SUPABASE_ANON_KEY.includes('ISI_SUPABASE_ANON_KEY_ANDA') &&
    SUPABASE_URL.startsWith('http')
  );
}

function initSupabase() {
  if (!isSupabaseConfigured()) {
    document.getElementById('configWarningBanner')?.classList.remove('d-none');
    return false;
  }
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    showToast('Gagal memuat library Supabase CDN. Periksa koneksi internet Anda.', 'danger');
    return false;
  }
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return true;
}

function setLoader(visible, text = 'Memuat data mutaba\'ah...') {
  const el = document.getElementById('globalLoader');
  const txt = document.getElementById('loaderText');
  if (txt) txt.textContent = text;
  if (el) el.classList.toggle('d-none', !visible);
}

function setButtonLoading(btnEl, isLoading) {
  if (!btnEl) return;
  btnEl.disabled = isLoading;
  btnEl.querySelector('.btn-label')?.classList.toggle('d-none', isLoading);
  btnEl.querySelector('.btn-spinner')?.classList.toggle('d-none', !isLoading);
}

function showToast(message, variant = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const palette = {
    success: { bg: 'bg-emerald text-white', icon: 'bi-check-circle-fill' },
    danger: { bg: 'bg-danger text-white', icon: 'bi-exclamation-octagon-fill' },
    warning: { bg: 'bg-warning text-dark', icon: 'bi-exclamation-triangle-fill' },
    info: { bg: 'bg-dark text-white', icon: 'bi-info-circle-fill' },
  };
  const style = palette[variant] || palette.info;

  const toastEl = document.createElement('div');
  toastEl.className = `toast app-toast align-items-center ${style.bg}`;
  toastEl.setAttribute('role', 'alert');
  toastEl.setAttribute('aria-live', 'assertive');
  toastEl.setAttribute('aria-atomic', 'true');
  toastEl.innerHTML = `
    <div class="d-flex align-items-center px-3 py-2.5">
      <i class="bi ${style.icon} fs-5 me-2.5 flex-shrink-0"></i>
      <div class="toast-body p-0 small fw-semibold">${escapeHtml(message)}</div>
      <button type="button" class="btn-close ${variant === 'warning' ? '' : 'btn-close-white'} ms-3 m-auto" data-bs-dismiss="toast" aria-label="Tutup"></button>
    </div>
  `;

  container.appendChild(toastEl);
  const toast = new bootstrap.Toast(toastEl, { delay: 3600 });
  toast.show();
  toastEl.addEventListener('hidden.bs.toast', () => toastEl.remove());
}

// --------------------------------------------------------------------------
// 6. KLASIFIKASI AMALAN, PERHITUNGAN SKOR, & ENGINE REKOMENDASI
// --------------------------------------------------------------------------
function getAmalanIcon(item) {
  const name = (item.name || '').toLowerCase();
  if (name.includes('sholawat') || name.includes('salawat')) return 'bi-heart-fill';
  if (name.includes('subuh')) return 'bi-sunrise-fill';
  if (name.includes('dzuhur') || name.includes('zuhur')) return 'bi-sun-fill';
  if (name.includes('ashar') || name.includes('asar')) return 'bi-cloud-sun-fill';
  if (name.includes('maghrib')) return 'bi-sunset-fill';
  if (name.includes('isya')) return 'bi-moon-stars-fill';
  if (name.includes('istighfar')) return 'bi-stars';
  if (name.includes('tilawah') || name.includes('juz')) return 'bi-book-half';
  return 'bi-patch-check-fill';
}

function classifyAmalanItems(items) {
  const sorted = [...(items || [])].sort(
    (a, b) => (Number(a.order_num) || 999) - (Number(b.order_num) || 999) || a.id - b.id
  );
  const dailyItems = sorted.filter((i) => i.category === 'harian');
  const semesterItems = sorted.filter((i) => i.category === 'semester');

  let sholatItems = dailyItems.filter(
    (i) =>
      /sholat|salat|subuh|dzuhur|zuhur|ashar|asar|maghrib|isya/i.test(i.name) &&
      !/sholawat|salawat/i.test(i.name)
  );
  if (sholatItems.length === 0) {
    sholatItems = dailyItems.slice(0, 5);
  }
  const sholatIds = new Set(sholatItems.map((i) => i.id));

  const sholawatItems = dailyItems.filter((i) => /sholawat|salawat/i.test(i.name));
  const sholawatIds = new Set(sholawatItems.map((i) => i.id));

  let istighfarItems = dailyItems.filter((i) => /istighfar/i.test(i.name));
  if (istighfarItems.length === 0) {
    istighfarItems = dailyItems.filter((i) => !sholatIds.has(i.id) && !sholawatIds.has(i.id));
  }
  const istighfarIds = new Set(istighfarItems.map((i) => i.id));

  let tilawahItem =
    semesterItems.find((i) => /tilawah|juz|qur'?an/i.test(i.name)) ||
    semesterItems.find((i) => Number(i.target_semester) === 3) ||
    semesterItems[1] ||
    null;

  let amalan4xItem =
    semesterItems.find((i) => tilawahItem && i.id !== tilawahItem.id) ||
    semesterItems.find((i) => Number(i.target_semester) === 4) ||
    semesterItems[0] ||
    null;

  return {
    all: sorted,
    dailyItems,
    semesterItems,
    sholatItems,
    sholatIds,
    istighfarItems,
    istighfarIds,
    sholawatItems,
    sholawatIds,
    amalan4xItem,
    tilawahItem,
  };
}

function getPredicateInfo(score, hasPositiveData) {
  const safe = clampPct(score);
  if (!hasPositiveData && safe === 0) {
    return {
      label: 'Belum Ada Data / Perlu Semangat',
      shortLabel: 'Belum Ada Data / Perlu Semangat',
      className: 'predicate-empty',
    };
  }
  if (safe >= 90) return { label: 'Istimewa', shortLabel: 'Istimewa', className: 'predicate-istimewa' };
  if (safe >= 75) return { label: 'Sangat Baik', shortLabel: 'Sangat Baik', className: 'predicate-sangat-baik' };
  if (safe >= 60) return { label: 'Baik', shortLabel: 'Baik', className: 'predicate-baik' };
  if (safe >= 40) return { label: 'Cukup', shortLabel: 'Cukup', className: 'predicate-cukup' };
  return { label: 'Perlu Semangat', shortLabel: 'Perlu Semangat', className: 'predicate-semangat' };
}

function computeUserStats(logs, amalanMeta, todayStr = getTodayStr()) {
  const { hariBerjalan, sisaHari, totalDays } = getSemesterMetrics(todayStr);
  const safeLogs = Array.isArray(logs) ? logs : [];

  const maxAllowedDate = getMaxInputDate(todayStr);
  const semesterLogs = safeLogs.filter(
    (l) => l.log_date && l.log_date >= SEMESTER_START && l.log_date <= maxAllowedDate
  );

  let totalSholat = 0;
  let totalIstighfar = 0;
  let totalSholawat = 0;
  let totalAmalan4x = 0;
  let totalTilawah = 0;
  let hasPositiveData = false;
  let hasLoggedToday = false;

  const dailyCompletedByAmalanId = {};
  amalanMeta.dailyItems.forEach((item) => {
    dailyCompletedByAmalanId[item.id] = 0;
  });

  // Deduplicate by (amalan_id, log_date) safely
  const uniqueMap = new Map();
  semesterLogs.forEach((log) => {
    const key = `${log.amalan_id}__${log.log_date}`;
    uniqueMap.set(key, log);
    if (log.log_date === todayStr) {
      hasLoggedToday = true;
    }
  });

  uniqueMap.forEach((log) => {
    const val = Math.max(0, Number(log.value) || 0);
    if (val > 0) hasPositiveData = true;

    if (amalanMeta.sholatIds.has(log.amalan_id)) {
      if (val >= 1) {
        totalSholat += 1;
        dailyCompletedByAmalanId[log.amalan_id] = (dailyCompletedByAmalanId[log.amalan_id] || 0) + 1;
      }
    } else if (amalanMeta.istighfarIds.has(log.amalan_id)) {
      if (val >= 1) {
        totalIstighfar += 1;
        dailyCompletedByAmalanId[log.amalan_id] = (dailyCompletedByAmalanId[log.amalan_id] || 0) + 1;
      }
    } else if (amalanMeta.sholawatIds.has(log.amalan_id)) {
      if (val >= 1) {
        totalSholawat += 1;
        dailyCompletedByAmalanId[log.amalan_id] = (dailyCompletedByAmalanId[log.amalan_id] || 0) + 1;
      }
    } else if (amalanMeta.amalan4xItem && log.amalan_id === amalanMeta.amalan4xItem.id) {
      totalAmalan4x += val;
    } else if (amalanMeta.tilawahItem && log.amalan_id === amalanMeta.tilawahItem.id) {
      totalTilawah += val;
    }
  });

  const sholatSlotsPerDay = Math.max(1, amalanMeta.sholatIds.size || 5);
  const istighfarSlotsPerDay = Math.max(1, amalanMeta.istighfarIds.size || 1);
  const hasSholawatComponent = amalanMeta.sholawatIds.size > 0;
  const sholawatSlotsPerDay = Math.max(1, amalanMeta.sholawatIds.size || 1);
  const amalanTarget = Math.max(1, Number(amalanMeta.amalan4xItem?.target_semester) || 4);
  const tilawahTarget = Math.max(1, Number(amalanMeta.tilawahItem?.target_semester) || 3);

  const sholatDenominator = Math.max(1, hariBerjalan * sholatSlotsPerDay);
  const istighfarDenominator = Math.max(1, hariBerjalan * istighfarSlotsPerDay);
  const sholawatDenominator = Math.max(1, hariBerjalan * sholawatSlotsPerDay);

  const pctSholat = clampPct((totalSholat / sholatDenominator) * 100);
  const pctIstighfar = clampPct((totalIstighfar / istighfarDenominator) * 100);
  const pctSholawat = hasSholawatComponent ? clampPct((totalSholawat / sholawatDenominator) * 100) : 0;
  const pctAmalan = clampPct((totalAmalan4x / amalanTarget) * 100);
  const pctTilawah = clampPct((totalTilawah / tilawahTarget) * 100);

  const scoreParts = hasSholawatComponent
    ? [pctSholat, pctIstighfar, pctSholawat, pctAmalan, pctTilawah]
    : [pctSholat, pctIstighfar, pctAmalan, pctTilawah];

  const finalScore = clampPct(scoreParts.reduce((a, b) => a + b, 0) / scoreParts.length);
  const predicate = getPredicateInfo(finalScore, hasPositiveData);

  return {
    hariBerjalan,
    sisaHari,
    totalDays,
    hasAnyLogRecord: uniqueMap.size > 0,
    hasPositiveData,
    hasLoggedToday,
    hasSholawatComponent,
    componentCount: scoreParts.length,

    totalSholat,
    sholatDenominator,
    pctSholat,

    totalIstighfar,
    istighfarDenominator,
    pctIstighfar,

    totalSholawat,
    sholawatDenominator,
    pctSholawat,

    totalAmalan4x,
    amalanTarget,
    pctAmalan,

    totalTilawah,
    tilawahTarget,
    pctTilawah,

    finalScore,
    predicate,
    dailyCompletedByAmalanId,
  };
}

function getFriendlyHabitTip(itemName) {
  const lower = (itemName || '').toLowerCase();
  if (lower.includes('sholawat') || lower.includes('salawat')) {
    return 'Tips ringan: baca 20x sholawat setelah setiap sholat fardhu (5 × 20 = 100x), makin utama di hari Jumat!';
  }
  if (lower.includes('subuh')) return 'Coba tidur lebih awal dan pasang alarm 15 menit sebelum adzan Subuh ya!';
  if (lower.includes('dzuhur') || lower.includes('zuhur')) return 'Jeda sejenak dari aktivitas siang dan segerakan sholat di awal waktu.';
  if (lower.includes('ashar') || lower.includes('asar')) return 'Pasang pengingat sore agar tidak terlewat di tengah kesibukan.';
  if (lower.includes('maghrib')) return 'Waktu Maghrib singkat, usahakan sudah bersiap beberapa menit sebelumnya.';
  if (lower.includes('isya')) return 'Biasakan menunaikan Isya sebelum beristirahat atau membuka gawai.';
  if (lower.includes('istighfar')) return 'Tips ringan: baca 20x istighfar setiap selesai sholat fardhu (5 × 20 = 100x)!';
  return 'Yuk mulai bangun rutinitas kecil setiap hari agar semakin istiqamah.';
}

function buildRecommendations(stats, amalanMeta) {
  const recs = [];

  // 1. Deteksi amalan harian yang paling sering kosong (value = 0)
  if (!stats.hasAnyLogRecord) {
    recs.push({
      type: 'neutral',
      icon: 'bi-rocket-takeoff-fill text-emerald',
      iconBg: 'bg-emerald-soft',
      title: 'Mulai Langkah Pertamamu Hari Ini',
      message:
        'Belum ada catatan mutaba\'ah yang masuk. Yuk isi amalan harian hari ini agar capaian ibadahmu mulai terekam dan terpantau!',
    });
  } else {
    const dailyMissed = amalanMeta.dailyItems.map((item) => {
      const done = stats.dailyCompletedByAmalanId[item.id] || 0;
      const missed = Math.max(0, stats.hariBerjalan - done);
      return { item, done, missed };
    });

    dailyMissed.sort((a, b) => b.missed - a.missed);
    const maxMissed = dailyMissed[0]?.missed || 0;

    if (maxMissed === 0) {
      recs.push({
        type: 'success',
        icon: 'bi-patch-check-fill text-emerald',
        iconBg: 'bg-emerald-soft',
        title: 'Amalan Harian Terjaga Penuh!',
        message: `MasyaAllah, seluruh ${amalanMeta.dailyItems.length} amalan harianmu konsisten 100% selama ${stats.hariBerjalan} hari berjalan. Semoga Allah terus menjaga keistiqamahanmu!`,
      });
    } else {
      const topMissed = dailyMissed.filter((d) => d.missed === maxMissed).slice(0, 2);
      const names = topMissed.map((d) => d.item.name).join(' & ');
      const tip = getFriendlyHabitTip(topMissed[0].item.name);
      recs.push({
        type: 'warning',
        icon: 'bi-exclamation-circle-fill text-gold',
        iconBg: 'bg-gold-soft',
        title: `Perhatian Ramah: ${names}`,
        message: `Amalan ini paling sering masih kosong (${maxMissed} dari ${stats.hariBerjalan} hari berjalan). ${tip}`,
      });
    }
  }

  // 2. Saran target konkret Tilawah 3 Juz vs sisa hari menuju 2027-01-31
  const sisaTilawah = Math.max(0, stats.tilawahTarget - stats.totalTilawah);
  if (sisaTilawah === 0) {
    recs.push({
      type: 'success',
      icon: 'bi-book-half text-emerald',
      iconBg: 'bg-emerald-soft',
      title: `Target Tilawah ${stats.tilawahTarget} Juz Tuntas!`,
      message: 'Alhamdulillah! Target tilawah semester sudah tercapai penuh. Terus pertahankan interaksi harian dengan Al-Qur\'an.',
    });
  } else {
    const sisaHalaman = sisaTilawah * 20; // 1 juz = 20 halaman mushaf Madinah
    if (stats.sisaHari > 0) {
      const pagesPerDay = sisaHalaman / stats.sisaHari;
      const paceText =
        pagesPerDay <= 1.15
          ? '±1 halaman per hari'
          : `±${Math.ceil(pagesPerDay)} halaman per hari`;
      recs.push({
        type: 'info',
        icon: 'bi-book-fill text-emerald',
        iconBg: 'bg-emerald-soft',
        title: `Target Tilawah (Sisa ${sisaTilawah} Juz)`,
        message: `Sisa target tilawah ${sisaTilawah} juz (${sisaHalaman} halaman) dalam ${stats.sisaHari} hari: cukup baca ${paceText} agar tuntas tepat waktu sebelum 31 Jan 2027.`,
      });
    } else {
      recs.push({
        type: 'warning',
        icon: 'bi-book-fill text-gold',
        iconBg: 'bg-gold-soft',
        title: `Target Tilawah (Sisa ${sisaTilawah} Juz)`,
        message: `Periode semester telah mencapai batas akhir (31 Jan 2027) dengan sisa ${sisaTilawah} juz. Tetap semangat menuntaskan tilawahnya!`,
      });
    }
  }

  // 3. Saran target konkret Amalan 4x vs sisa hari menuju 2027-01-31
  const sisaAmalan = Math.max(0, stats.amalanTarget - stats.totalAmalan4x);
  const amalanLabel = amalanMeta.amalan4xItem?.name || `Amalan ${stats.amalanTarget}x / Semester`;
  if (sisaAmalan === 0) {
    recs.push({
      type: 'success',
      icon: 'bi-award-fill text-emerald',
      iconBg: 'bg-emerald-soft',
      title: `${amalanLabel} Tuntas!`,
      message: `Alhamdulillah, seluruh target ${stats.amalanTarget}x amalan semester telah terlaksana dengan baik.`,
    });
  } else if (stats.sisaHari > 0) {
    const everyDays = Math.max(1, Math.floor(stats.sisaHari / sisaAmalan));
    const everyWeeks = (everyDays / 7).toFixed(1).replace(/\.0$/, '');
    recs.push({
      type: 'info',
      icon: 'bi-calendar2-heart-fill text-emerald',
      iconBg: 'bg-emerald-soft',
      title: `Target Amalan Semester (Sisa ${sisaAmalan}x)`,
      message: `Sisa target ${sisaAmalan}x dalam ${stats.sisaHari} hari menuju 31 Jan 2027: jadwalkan minimal 1x setiap ${everyDays} hari (±${everyWeeks} minggu sekali) agar tuntas nyaman.`,
    });
  } else {
    recs.push({
      type: 'warning',
      icon: 'bi-calendar2-heart-fill text-gold',
      iconBg: 'bg-gold-soft',
      title: `Target Amalan Semester (Sisa ${sisaAmalan}x)`,
      message: `Periode semester sudah selesai dengan sisa ${sisaAmalan}x dari target ${stats.amalanTarget}x.`,
    });
  }

  return recs;
}

function renderRecommendationsHtml(recs) {
  return recs
    .map(
      (r) => `
      <div class="rec-item rec-${r.type}">
        <div class="rec-icon ${r.iconBg}">
          <i class="bi ${r.icon}"></i>
        </div>
        <div>
          <div class="fw-bold small text-dark mb-0.5">${escapeHtml(r.title)}</div>
          <div class="small text-secondary lh-sm">${escapeHtml(r.message)}</div>
        </div>
      </div>
    `
    )
    .join('');
}

function renderComponentBarsHtml(stats, amalanMeta) {
  const amalanTitle = amalanMeta.amalan4xItem?.name || 'Amalan Target 4x / Semester';
  const tilawahTitle = amalanMeta.tilawahItem?.name || 'Tilawah Target 3 Juz / Semester';

  const components = [
    {
      label: 'Sholat 5 Waktu',
      pct: stats.pctSholat,
      detail: `${stats.totalSholat} / ${stats.sholatDenominator} waktu`,
      color: 'bg-emerald',
      icon: 'bi-moon-stars-fill text-emerald',
    },
    {
      label: 'Istighfar 100x Sehari',
      pct: stats.pctIstighfar,
      detail: `${stats.totalIstighfar} / ${stats.istighfarDenominator} hari`,
      color: 'bg-info',
      icon: 'bi-stars text-info',
    },
  ];

  if (stats.hasSholawatComponent) {
    components.push({
      label: amalanMeta.sholawatItems[0]?.name || 'Sholawat 100x Sehari',
      pct: stats.pctSholawat,
      detail: `${stats.totalSholawat} / ${stats.sholawatDenominator} hari`,
      color: 'bg-danger',
      icon: 'bi-heart-fill text-danger',
    });
  }

  components.push(
    {
      label: amalanTitle,
      pct: stats.pctAmalan,
      detail: `${stats.totalAmalan4x} / ${stats.amalanTarget} kali`,
      color: 'bg-gold',
      icon: 'bi-patch-check-fill text-gold',
    },
    {
      label: tilawahTitle,
      pct: stats.pctTilawah,
      detail: `${stats.totalTilawah} / ${stats.tilawahTarget} juz`,
      color: 'bg-success',
      icon: 'bi-book-half text-success',
    }
  );

  return components
    .map(
      (c) => `
      <div>
        <div class="d-flex align-items-center justify-content-between mb-1.5">
          <span class="small fw-semibold text-dark">
            <i class="bi ${c.icon} me-1.5"></i>${escapeHtml(c.label)}
          </span>
          <span class="small">
            <strong class="text-dark">${formatPct(c.pct)}</strong>
            <span class="text-muted ms-1">(${escapeHtml(c.detail)})</span>
          </span>
        </div>
        <div class="progress component-progress">
          <div class="progress-bar ${c.color}" role="progressbar" style="width: ${clampPct(c.pct).toFixed(1)}%;" aria-valuenow="${Math.round(c.pct)}" aria-valuemin="0" aria-valuemax="100"></div>
        </div>
      </div>
    `
    )
    .join('');
}

// --------------------------------------------------------------------------
// 7. AUTENTIKASI, SESI LOCALSTORAGE, & UBAH PIN
// --------------------------------------------------------------------------
function saveSession(profile) {
  const safeSession = {
    id: profile.id,
    username: profile.username,
    full_name: profile.full_name,
    role: profile.role,
  };
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(safeSession));
}

function getSavedSession() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.id && parsed.username && parsed.role) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(SESSION_STORAGE_KEY);
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const errorBox = document.getElementById('loginError');
  const submitBtn = document.getElementById('loginSubmitBtn');
  const usernameInput = document.getElementById('loginUsername');
  const pinInput = document.getElementById('loginPin');

  errorBox.classList.add('d-none');

  if (!supabaseClient) {
    errorBox.textContent = 'Konfigurasi SUPABASE_URL dan SUPABASE_ANON_KEY di app.js belum diisi.';
    errorBox.classList.remove('d-none');
    return;
  }

  const username = usernameInput.value.trim().toLowerCase();
  const pin = pinInput.value.trim();

  if (!username || !pin) {
    errorBox.textContent = 'Mohon masukkan username dan PIN Anda.';
    errorBox.classList.remove('d-none');
    return;
  }

  setButtonLoading(submitBtn, true);
  try {
    // Hanya memilih field non-sensitif (tidak mengembalikan pin ke state)
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('id, username, full_name, role')
      .ilike('username', username)
      .eq('pin', pin)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      errorBox.textContent = 'Username atau PIN tidak cocok. Silakan periksa kembali.';
      errorBox.classList.remove('d-none');
      return;
    }

    state.user = data;
    saveSession(data);
    pinInput.value = '';
    showToast(`Selamat datang, ${data.full_name}!`, 'success');
    await enterAuthenticatedApp();
  } catch (err) {
    console.error('Login error:', err);
    errorBox.textContent = `Gagal terhubung ke Supabase: ${err.message || 'Periksa koneksi atau kebijakan RLS.'}`;
    errorBox.classList.remove('d-none');
  } finally {
    setButtonLoading(submitBtn, false);
  }
}

async function handleChangePinSubmit(event) {
  event.preventDefault();
  const errorBox = document.getElementById('changePinError');
  const saveBtn = document.getElementById('btnSavePin');
  const currentPin = document.getElementById('currentPinInput').value.trim();
  const newPin = document.getElementById('newPinInput').value.trim();
  const confirmPin = document.getElementById('confirmPinInput').value.trim();

  errorBox.classList.add('d-none');

  if (!currentPin || !newPin || !confirmPin) {
    errorBox.textContent = 'Semua kolom PIN wajib diisi.';
    errorBox.classList.remove('d-none');
    return;
  }
  if (newPin.length < 4) {
    errorBox.textContent = 'PIN baru minimal 4 karakter.';
    errorBox.classList.remove('d-none');
    return;
  }
  if (newPin !== confirmPin) {
    errorBox.textContent = 'Konfirmasi PIN baru tidak cocok.';
    errorBox.classList.remove('d-none');
    return;
  }
  if (newPin === currentPin) {
    errorBox.textContent = 'PIN baru tidak boleh sama dengan PIN saat ini.';
    errorBox.classList.remove('d-none');
    return;
  }

  setButtonLoading(saveBtn, true);
  try {
    // Verifikasi PIN saat ini
    const { data: verified, error: verifyErr } = await supabaseClient
      .from('profiles')
      .select('id')
      .eq('id', state.user.id)
      .eq('pin', currentPin)
      .maybeSingle();

    if (verifyErr) throw verifyErr;
    if (!verified) {
      errorBox.textContent = 'PIN saat ini salah.';
      errorBox.classList.remove('d-none');
      return;
    }

    // Update PIN baru
    const { error: updateErr } = await supabaseClient
      .from('profiles')
      .update({ pin: newPin })
      .eq('id', state.user.id);

    if (updateErr) throw updateErr;

    document.getElementById('changePinForm').reset();
    changePinModalInstance?.hide();
    showToast('PIN berhasil diperbarui!', 'success');
  } catch (err) {
    console.error('Change PIN error:', err);
    errorBox.textContent = `Gagal mengubah PIN: ${err.message || 'Coba lagi.'}`;
    errorBox.classList.remove('d-none');
  } finally {
    setButtonLoading(saveBtn, false);
  }
}

function handleLogout() {
  clearSession();
  state.user = null;
  state.myLogs = [];
  state.myStats = null;
  state.leaderboard = [];
  state.mentorMentees = [];

  if (menteeTrendChartInstance) {
    menteeTrendChartInstance.destroy();
    menteeTrendChartInstance = null;
  }
  if (mentorGroupChartInstance) {
    mentorGroupChartInstance.destroy();
    mentorGroupChartInstance = null;
  }

  document.getElementById('appView').classList.add('d-none');
  document.getElementById('loginView').classList.remove('d-none');
  showToast('Anda telah keluar dari aplikasi.', 'info');
}

// --------------------------------------------------------------------------
// 8. NAVIGASI ROLE & PENGAMBILAN DATA SUPABASE (STRICT PRIVACY)
// --------------------------------------------------------------------------
async function enterAuthenticatedApp() {
  document.getElementById('loginView').classList.add('d-none');
  document.getElementById('appView').classList.remove('d-none');

  // Update header user profile
  const roleLabel = state.user.role === 'mentor' ? 'Mentor / Admin' : 'Mentee';
  document.getElementById('navUserAvatar').textContent = getInitials(state.user.full_name);
  document.getElementById('navUserName').textContent = state.user.full_name;
  document.getElementById('navUserRole').textContent = roleLabel;
  document.getElementById('dropdownUserName').textContent = state.user.full_name;
  document.getElementById('dropdownUserMeta').textContent = `@${state.user.username} • ${roleLabel}`;

  const isMentor = state.user.role === 'mentor';

  // Toggle role containers & navbars
  document.getElementById('menteeSection').classList.toggle('d-none', isMentor);
  document.getElementById('mentorSection').classList.toggle('d-none', !isMentor);

  const desktopMenteeNav = document.getElementById('desktopMenteeNav');
  const desktopMentorNav = document.getElementById('desktopMentorNav');
  desktopMenteeNav.className = isMentor ? 'nav-pill-group d-none' : 'nav-pill-group d-none d-md-flex';
  desktopMentorNav.className = isMentor ? 'nav-pill-group d-none d-md-flex' : 'nav-pill-group d-none';

  document.getElementById('mobileMenteeNav').classList.toggle('d-none', isMentor);
  document.getElementById('mobileMentorNav').classList.toggle('d-none', !isMentor);

  // Set initial date & week for mentee input (dibatasi maksimal hari ini)
  const maxDate = getMaxInputDate();
  state.selectedDate = getTodayStr();
  if (state.selectedDate < SEMESTER_START) state.selectedDate = SEMESTER_START;
  if (state.selectedDate > maxDate) state.selectedDate = maxDate;
  state.weeklyStartDate = getMondayOfWeek(state.selectedDate);
  state.inputMode = 'daily';
  pendingAutoSaves.clear();
  setAutoSaveStatus('idle', 'Auto-save aktif');

  await refreshAppData();
  setInputMode('daily');
  switchTab(isMentor ? 'mentor-dashboard' : 'input');
}

function switchTab(tabName) {
  state.activeTab = tabName;

  // Toggle tab sections inside active role container
  const activeRoleContainer =
    state.user.role === 'mentor'
      ? document.getElementById('mentorSection')
      : document.getElementById('menteeSection');

  activeRoleContainer.querySelectorAll('.tab-pane-section').forEach((sec) => {
    sec.classList.toggle('d-none', sec.id !== `tab-${tabName}`);
  });

  // Update desktop & mobile nav buttons
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // Ensure Chart.js resizes smoothly when tab becomes visible
  if (tabName === 'dashboard') {
    renderMenteeDashboard();
  } else if (tabName === 'leaderboard') {
    renderLeaderboard();
  } else if (tabName === 'mentor-dashboard') {
    renderMentorDashboard();
  } else if (tabName === 'mentor-monitoring') {
    renderMentorMonitoringTable();
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function fetchAmalanItems() {
  const { data, error } = await supabaseClient
    .from('amalan_items')
    .select('id, name, category, target_semester, order_num')
    .order('order_num', { ascending: true });

  if (error) throw error;
  state.amalanItems = data || [];
  state.amalanMeta = classifyAmalanItems(state.amalanItems);
}

async function refreshAppData() {
  if (!state.user || !supabaseClient) return;
  setLoader(true, 'Menyinkronkan data dari Supabase...');
  try {
    await fetchAmalanItems();

    if (state.user.role === 'mentor') {
      await loadMentorData();
      renderMentorDashboard();
      renderMentorMonitoringTable();
    } else {
      await loadMenteeData();
      renderMenteeInputView();
      renderWeeklyInputView();
      renderMenteeDashboard();
      renderLeaderboard();
    }
  } catch (err) {
    console.error('Refresh error:', err);
    showToast(`Gagal memuat data: ${err.message || 'Periksa konfigurasi Supabase.'}`, 'danger');
  } finally {
    setLoader(false);
  }
}

/**
 * STRICT PRIVACY (MENTEE):
 * 1. Log detail hanya diambil dengan filter .eq('user_id', state.user.id).
 * 2. Papan Peringkat hanya menghasilkan agregat publik (Nama, Skor %, Predikat, Rank)
 *    tanpa pernah menyimpan/menampilkan rincian log milik mentee lain.
 */
async function loadMenteeData() {
  // 1. Ambil log detail HANYA milik user yang login
  const { data: myLogs, error: myLogsErr } = await supabaseClient
    .from('mutabaah_logs')
    .select('id, user_id, amalan_id, log_date, value')
    .eq('user_id', state.user.id)
    .gte('log_date', SEMESTER_START)
    .lte('log_date', SEMESTER_END)
    .order('log_date', { ascending: false });

  if (myLogsErr) throw myLogsErr;

  state.myLogs = myLogs || [];
  state.myStats = computeUserStats(state.myLogs, state.amalanMeta);
  loadDraftForSelectedDate();

  // 2. Hitung agregat publik untuk Papan Peringkat
  state.leaderboard = await fetchPublicLeaderboard();
}

async function fetchPublicLeaderboard() {
  // Opsi A: Gunakan RPC SQL aman 'get_public_leaderboard' jika sudah dipasang di Supabase
  try {
    const { data: rpcData, error: rpcErr } = await supabaseClient.rpc('get_public_leaderboard');
    if (!rpcErr && Array.isArray(rpcData) && rpcData.length > 0) {
      const mapped = rpcData.map((row) => {
        const finalScore = clampPct(Number(row.final_score) || 0);
        const hasPositiveData = Boolean(row.has_data) || finalScore > 0;
        return {
          userId: row.user_id,
          fullName: row.full_name,
          finalScore,
          hasPositiveData,
          predicate: getPredicateInfo(finalScore, hasPositiveData),
        };
      });
      return sortAndRankLeaderboard(mapped);
    }
  } catch {
    // Abaikan jika fungsi RPC belum dibuat; lanjutkan ke agregasi standar
  }

  // Opsi B: Agregasi publik saja (tidak menyimpan detail log mentee lain ke state/DOM)
  const { data: menteeProfiles, error: profErr } = await supabaseClient
    .from('profiles')
    .select('id, full_name')
    .eq('role', 'mentee')
    .order('full_name', { ascending: true });

  if (profErr) throw profErr;

  const { data: aggLogs, error: logErr } = await supabaseClient
    .from('mutabaah_logs')
    .select('user_id, amalan_id, log_date, value')
    .gte('log_date', SEMESTER_START)
    .lte('log_date', SEMESTER_END);

  if (logErr) throw logErr;

  const groupedLogs = new Map();
  (aggLogs || []).forEach((row) => {
    if (!groupedLogs.has(row.user_id)) groupedLogs.set(row.user_id, []);
    groupedLogs.get(row.user_id).push(row);
  });

  // Ekstrak HANYA atribut publik (Nama Lengkap, Skor Akhir %, Predikat)
  const publicEntries = (menteeProfiles || []).map((p) => {
    const computed = computeUserStats(groupedLogs.get(p.id) || [], state.amalanMeta);
    return {
      userId: p.id,
      fullName: p.full_name,
      finalScore: computed.finalScore,
      hasPositiveData: computed.hasPositiveData,
      predicate: computed.predicate,
    };
  });

  return sortAndRankLeaderboard(publicEntries);
}

function sortAndRankLeaderboard(entries) {
  const sorted = [...entries].sort((a, b) => {
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
    return a.fullName.localeCompare(b.fullName, 'id');
  });

  return sorted.map((entry, idx) => ({
    ...entry,
    rank: idx + 1,
  }));
}

/**
 * MENTOR FULL ACCESS (Bang Usamah):
 * Mengambil seluruh ringkasan dan riwayat harian 10 mentee.
 */
async function loadMentorData() {
  if (state.user?.role !== 'mentor') return;

  const { data: mentees, error: mErr } = await supabaseClient
    .from('profiles')
    .select('id, username, full_name, role')
    .eq('role', 'mentee')
    .order('full_name', { ascending: true });

  if (mErr) throw mErr;

  const { data: allLogs, error: lErr } = await supabaseClient
    .from('mutabaah_logs')
    .select('id, user_id, amalan_id, log_date, value')
    .gte('log_date', SEMESTER_START)
    .lte('log_date', SEMESTER_END)
    .order('log_date', { ascending: false });

  if (lErr) throw lErr;

  const logsByUser = new Map();
  (allLogs || []).forEach((row) => {
    if (!logsByUser.has(row.user_id)) logsByUser.set(row.user_id, []);
    logsByUser.get(row.user_id).push(row);
  });

  const enriched = (mentees || []).map((m) => {
    const userLogs = logsByUser.get(m.id) || [];
    const stats = computeUserStats(userLogs, state.amalanMeta);
    const recommendations = buildRecommendations(stats, state.amalanMeta);
    return {
      ...m,
      logs: userLogs,
      stats,
      recommendations,
    };
  });

  enriched.sort((a, b) => {
    if (b.stats.finalScore !== a.stats.finalScore) return b.stats.finalScore - a.stats.finalScore;
    return a.full_name.localeCompare(b.full_name, 'id');
  });

  state.mentorMentees = enriched.map((item, idx) => ({ ...item, rank: idx + 1 }));
}

// --------------------------------------------------------------------------
// 9. AUTO-SAVE ENGINE & HALAMAN MENTEE — TAB 1: INPUT HARIAN & SEMINGGU
// --------------------------------------------------------------------------
function setAutoSaveStatus(status, text) {
  const el = document.getElementById('autoSaveBadge');
  if (!el) return;
  const map = {
    idle: { cls: 'autosave-idle', icon: '<i class="bi bi-cloud-check-fill"></i>' },
    saving: { cls: 'autosave-saving', icon: '<span class="spinner-border spinner-border-sm" style="width:0.75rem;height:0.75rem;"></span>' },
    saved: { cls: 'autosave-saved', icon: '<i class="bi bi-check-circle-fill"></i>' },
    error: { cls: 'autosave-error', icon: '<i class="bi bi-exclamation-triangle-fill"></i>' },
  };
  const cfg = map[status] || map.idle;
  el.className = `autosave-pill ${cfg.cls}`;
  el.innerHTML = `${cfg.icon}<span>${escapeHtml(text)}</span>`;
}

function getLocalLogValue(dateStr, amalanId) {
  const found = state.myLogs.find((l) => l.log_date === dateStr && l.amalan_id === amalanId);
  return found ? Math.max(0, Number(found.value) || 0) : 0;
}

function upsertLocalLog(dateStr, amalanId, value) {
  const safeVal = Math.max(0, Number(value) || 0);
  const existing = state.myLogs.find((l) => l.log_date === dateStr && l.amalan_id === amalanId);
  if (existing) {
    existing.value = safeVal;
  } else {
    state.myLogs.push({
      user_id: state.user.id,
      amalan_id: amalanId,
      log_date: dateStr,
      value: safeVal,
    });
  }
  if (dateStr === state.selectedDate) {
    state.draftValues[amalanId] = safeVal;
  }
  state.myStats = computeUserStats(state.myLogs, state.amalanMeta);
}

function queueAutoSave(dateStr, amalanId, value) {
  if (!state.user || state.user.role !== 'mentee' || !supabaseClient) return;
  if (!isDateEditable(dateStr)) {
    showToast('Tanggal yang akan datang belum bisa diisi.', 'warning');
    return;
  }

  const safeVal = Math.max(0, Number(value) || 0);
  upsertLocalLog(dateStr, amalanId, safeVal);

  const key = `${dateStr}__${amalanId}`;
  pendingAutoSaves.set(key, {
    user_id: state.user.id,
    amalan_id: amalanId,
    log_date: dateStr,
    value: safeVal,
  });

  setAutoSaveStatus('saving', 'Menyimpan otomatis...');

  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    flushAutoSaveQueue();
  }, 450);
}

async function flushAutoSaveQueue() {
  if (isFlushingAutoSave || pendingAutoSaves.size === 0 || !supabaseClient || !state.user) return;

  isFlushingAutoSave = true;
  const entries = Array.from(pendingAutoSaves.entries());
  const batch = entries.map(([, row]) => row);
  entries.forEach(([k]) => pendingAutoSaves.delete(k));

  setAutoSaveStatus('saving', 'Menyimpan otomatis...');

  try {
    const { error } = await supabaseClient
      .from('mutabaah_logs')
      .upsert(batch, { onConflict: 'user_id,amalan_id,log_date' });

    if (error) throw error;

    if (pendingAutoSaves.size > 0) {
      isFlushingAutoSave = false;
      await flushAutoSaveQueue();
      return;
    }

    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    setAutoSaveStatus('saved', `Tersimpan otomatis • ${hh}:${mm}`);

    // Update indikator 7-day strip & leaderboard di background
    renderSevenDayStrip();
    fetchPublicLeaderboard()
      .then((lb) => {
        state.leaderboard = lb;
      })
      .catch(() => {});
  } catch (err) {
    console.error('Auto-save error:', err);
    entries.forEach(([k, row]) => {
      if (!pendingAutoSaves.has(k)) pendingAutoSaves.set(k, row);
    });
    setAutoSaveStatus('error', 'Gagal auto-save — cek koneksi');
    showToast(`Auto-save gagal: ${err.message || 'Periksa koneksi internet.'}`, 'danger');
  } finally {
    isFlushingAutoSave = false;
  }
}

function setInputMode(mode) {
  state.inputMode = mode === 'weekly' ? 'weekly' : 'daily';

  document.getElementById('dailyInputModePanel')?.classList.toggle('d-none', state.inputMode !== 'daily');
  document.getElementById('weeklyInputModePanel')?.classList.toggle('d-none', state.inputMode !== 'weekly');

  document.querySelectorAll('[data-input-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.inputMode === state.inputMode);
  });

  if (state.inputMode === 'weekly') {
    if (!state.weeklyStartDate) state.weeklyStartDate = getMondayOfWeek(state.selectedDate || getTodayStr());
    renderWeeklyInputView();
  } else {
    loadDraftForSelectedDate();
    renderMenteeInputView();
  }
}

function renderWeeklyInputView() {
  const headEl = document.getElementById('weeklyGridHead');
  const bodyEl = document.getElementById('weeklyGridBody');
  const rangeEl = document.getElementById('weeklyRangeLabel');
  if (!headEl || !bodyEl || !state.amalanMeta) return;

  if (!state.weeklyStartDate) {
    state.weeklyStartDate = getMondayOfWeek(state.selectedDate || getTodayStr());
  }

  const todayStr = getTodayStr();
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(state.weeklyStartDate, i));
  const firstDay = weekDates[0];
  const lastDay = weekDates[6];

  if (rangeEl) {
    rangeEl.textContent = `${formatDateLongId(firstDay)} – ${formatDateLongId(lastDay)}`;
  }

  // Disable prev/next buttons if adjacent week is outside [SEMESTER_START, today]
  const maxEditable = getMaxInputDate(todayStr);
  const prevWeekEnd = addDays(firstDay, -1);
  const nextWeekStart = addDays(lastDay, 1);
  const btnPrev = document.getElementById('btnPrevWeek');
  const btnNext = document.getElementById('btnNextWeek');
  if (btnPrev) btnPrev.disabled = prevWeekEnd < SEMESTER_START;
  if (btnNext) btnNext.disabled = nextWeekStart > maxEditable;

  const dailyItems = state.amalanMeta.dailyItems || [];
  const semesterItems = state.amalanMeta.semesterItems || [];

  // Header row (Amalan + 7 days with Jumat/Senin-Kamis badge + 1-click "Semua" toggle)
  const dayHeadersHtml = weekDates
    .map((dateStr) => {
      const dow = getDayOfWeek(dateStr);
      const dayNum = Number(dateStr.split('-')[2]);
      const monthLabel = MONTH_SHORT_ID[Number(dateStr.split('-')[1]) - 1];
      const special = getSpecialDayInfo(dateStr);
      const isToday = dateStr === todayStr;
      const isFuture = dateStr > maxEditable;
      const isOut = !isDateEditable(dateStr, todayStr);

      const doneInDay = dailyItems.filter((item) => getLocalLogValue(dateStr, item.id) >= 1).length;
      const allDone = dailyItems.length > 0 && doneInDay === dailyItems.length;

      return `
        <th class="weekly-day-th ${isToday ? 'is-today' : ''} ${isOut ? 'is-out' : ''}">
          <div class="small fw-bold text-uppercase ${isToday ? 'text-emerald' : 'text-muted'}" style="font-size:0.7rem;">
            ${DAY_SHORT_ID[dow]}
          </div>
          <div class="fw-bold text-dark" style="font-size:0.9rem;">${dayNum} ${monthLabel}</div>
          <div style="min-height:19px;">
            ${
              special
                ? `<span class="day-special-badge ${special.badgeClass}">${special.badgeText}</span>`
                : isToday
                ? '<span class="day-special-badge bg-emerald-soft text-emerald">Hari Ini</span>'
                : ''
            }
          </div>
          <button
            type="button"
            class="weekly-check-all-btn ${allDone ? 'all-done' : ''}"
            data-week-all-date="${dateStr}"
            ${isOut ? 'disabled' : ''}
            title="${
              isFuture
                ? 'Belum waktunya — tanggal besok/masa depan terkunci'
                : allDone
                ? 'Batalkan semua amalan harian tanggal ini'
                : 'Centang semua amalan harian tanggal ini'
            }"
          >
            ${isFuture ? '<i class="bi bi-lock-fill"></i>' : allDone ? '✓ Penuh' : `${doneInDay}/${dailyItems.length}`}
          </button>
        </th>
      `;
    })
    .join('');

  headEl.innerHTML = `
    <tr>
      <th class="sticky-col">
        <div class="fw-bold text-dark small">Daftar Amalan</div>
        <div class="text-muted" style="font-size:0.72rem;">Ketuk kotak untuk centang</div>
      </th>
      ${dayHeadersHtml}
    </tr>
  `;

  // Body rows: Section 1 — Daily items
  const dailyRowsHtml = dailyItems
    .map((item) => {
      const icon = getAmalanIcon(item);
      const cellsHtml = weekDates
        .map((dateStr) => {
          const isFuture = dateStr > maxEditable;
          const isOut = !isDateEditable(dateStr, todayStr);
          const checked = !isFuture && getLocalLogValue(dateStr, item.id) >= 1;
          return `
            <td>
              <button
                type="button"
                class="weekly-check-btn ${checked ? 'checked' : ''}"
                data-week-daily-date="${dateStr}"
                data-week-amalan-id="${item.id}"
                aria-pressed="${checked}"
                ${isOut ? 'disabled' : ''}
                title="${
                  isFuture
                    ? 'Tanggal masa depan terkunci'
                    : `${escapeHtml(item.name)} — ${escapeHtml(formatDateShortId(dateStr))}`
                }"
              >
                <i class="bi ${isFuture ? 'bi-lock-fill text-muted' : 'bi-check-lg'}"></i>
              </button>
            </td>
          `;
        })
        .join('');

      return `
        <tr>
          <td class="sticky-col">
            <div class="d-flex align-items-center gap-2">
              <i class="bi ${icon} text-emerald flex-shrink-0"></i>
              <span class="fw-semibold small text-dark">${escapeHtml(item.name)}</span>
            </div>
          </td>
          ${cellsHtml}
        </tr>
      `;
    })
    .join('');

  // Body rows: Section 2 — Semester items
  const semesterRowsHtml = semesterItems
    .map((item) => {
      const icon = getAmalanIcon(item);
      const target = Number(item.target_semester) || 1;
      const isTilawah = state.amalanMeta?.tilawahItem?.id === item.id;
      const unitLabel = isTilawah ? 'juz' : 'kali';
      const totalSemester = state.myLogs
        .filter((l) => l.amalan_id === item.id && l.log_date >= SEMESTER_START && l.log_date <= maxEditable)
        .reduce((sum, l) => sum + Math.max(0, Number(l.value) || 0), 0);

      const cellsHtml = weekDates
        .map((dateStr) => {
          const isFuture = dateStr > maxEditable;
          const isOut = !isDateEditable(dateStr, todayStr);
          const val = isFuture ? 0 : getLocalLogValue(dateStr, item.id);
          return `
            <td>
              <div class="weekly-stepper">
                <button
                  type="button"
                  class="weekly-step-btn minus"
                  data-week-step-date="${dateStr}"
                  data-week-step-id="${item.id}"
                  data-delta="-1"
                  ${isOut || val <= 0 ? 'disabled' : ''}
                  aria-label="Kurangi"
                >-</button>
                <span class="weekly-step-val">${val}</span>
                <button
                  type="button"
                  class="weekly-step-btn plus"
                  data-week-step-date="${dateStr}"
                  data-week-step-id="${item.id}"
                  data-delta="1"
                  ${isOut ? 'disabled' : ''}
                  aria-label="Tambah"
                >+</button>
              </div>
            </td>
          `;
        })
        .join('');

      return `
        <tr>
          <td class="sticky-col">
            <div class="d-flex align-items-center gap-2">
              <i class="bi ${icon} text-gold flex-shrink-0"></i>
              <div>
                <div class="fw-semibold small text-dark lh-sm">${escapeHtml(item.name)}</div>
                <div class="text-emerald fw-bold" style="font-size:0.7rem;">Total: ${totalSemester}/${target} ${unitLabel}</div>
              </div>
            </div>
          </td>
          ${cellsHtml}
        </tr>
      `;
    })
    .join('');

  bodyEl.innerHTML = `
    <tr class="weekly-section-row">
      <td colspan="8">Amalan Harian (${dailyItems.length} Item)</td>
    </tr>
    ${dailyRowsHtml}
    <tr class="weekly-section-row">
      <td colspan="8">Capaian Target Semester (${semesterItems.length} Item)</td>
    </tr>
    ${semesterRowsHtml}
  `;

  // Event listeners for weekly checkboxes
  bodyEl.querySelectorAll('[data-week-daily-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dateStr = btn.dataset.weekDailyDate;
      const amalanId = Number(btn.dataset.weekAmalanId);
      const nextVal = getLocalLogValue(dateStr, amalanId) >= 1 ? 0 : 1;
      queueAutoSave(dateStr, amalanId, nextVal);
      renderWeeklyInputView();
    });
  });

  // Event listeners for 1-click "Centang Semua" per day column
  headEl.querySelectorAll('[data-week-all-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dateStr = btn.dataset.weekAllDate;
      const allDone = dailyItems.every((item) => getLocalLogValue(dateStr, item.id) >= 1);
      const targetVal = allDone ? 0 : 1;
      dailyItems.forEach((item) => {
        queueAutoSave(dateStr, item.id, targetVal);
      });
      renderWeeklyInputView();
    });
  });

  // Event listeners for weekly semester steppers
  bodyEl.querySelectorAll('[data-week-step-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dateStr = btn.dataset.weekStepDate;
      const amalanId = Number(btn.dataset.weekStepId);
      const delta = Number(btn.dataset.delta);
      const current = getLocalLogValue(dateStr, amalanId);
      const nextVal = Math.max(0, Math.min(20, current + delta));
      queueAutoSave(dateStr, amalanId, nextVal);
      renderWeeklyInputView();
    });
  });
}
function loadDraftForSelectedDate() {
  const draft = {};
  state.amalanItems.forEach((item) => {
    draft[item.id] = 0;
  });

  state.myLogs
    .filter((l) => l.log_date === state.selectedDate)
    .forEach((l) => {
      draft[l.amalan_id] = Math.max(0, Number(l.value) || 0);
    });

  state.draftValues = draft;
}

function getCumulativeSemesterExcludingSelected(amalanId) {
  const maxEditable = getMaxInputDate();
  return state.myLogs
    .filter(
      (l) =>
        l.amalan_id === amalanId &&
        l.log_date >= SEMESTER_START &&
        l.log_date <= maxEditable &&
        l.log_date !== state.selectedDate
    )
    .reduce((sum, l) => sum + Math.max(0, Number(l.value) || 0), 0);
}

function renderMenteeInputView() {
  const datePicker = document.getElementById('inputDatePicker');
  const dateLabel = document.getElementById('selectedDateLabel');
  const specialBanner = document.getElementById('selectedDateSpecialBanner');
  const maxEditable = getMaxInputDate();

  if (state.selectedDate > maxEditable) {
    state.selectedDate = maxEditable;
    loadDraftForSelectedDate();
  }

  datePicker.min = SEMESTER_START;
  datePicker.max = maxEditable;
  datePicker.value = state.selectedDate;

  const isToday = state.selectedDate === getTodayStr();
  dateLabel.innerHTML = `Mengisi untuk: <strong class="text-dark">${escapeHtml(formatDateLongId(state.selectedDate))}</strong> ${isToday ? '<span class="badge rounded-pill bg-emerald-soft text-emerald ms-1">Hari Ini</span>' : ''
    }`;

  const special = getSpecialDayInfo(state.selectedDate);
  if (special) {
    specialBanner.className = `special-day-banner ${special.bannerClass} mb-3`;
    specialBanner.innerHTML = `<i class="bi ${special.icon} fs-5 flex-shrink-0"></i><span>${escapeHtml(special.message)}</span>`;
  } else {
    specialBanner.className = 'mb-3 d-none';
    specialBanner.innerHTML = '';
  }

  renderSevenDayStrip();
  renderDailyToggleCards();
  renderSemesterStepperCards();
}

function renderSevenDayStrip() {
  const container = document.getElementById('sevenDayStrip');
  const todayStr = getTodayStr();

  // Hitung tanggal mana yang sudah punya minimal 1 catatan positif
  const datesWithLogs = new Set(
    state.myLogs.filter((l) => Number(l.value) > 0).map((l) => l.log_date)
  );

  // 7 hari terakhir berujung hari ini
  const days = [];
  for (let offset = -6; offset <= 0; offset++) {
    days.push(addDays(todayStr, offset));
  }

  container.innerHTML = days
    .map((dateStr) => {
      const dow = getDayOfWeek(dateStr);
      const dayNum = Number(dateStr.split('-')[2]);
      const special = getSpecialDayInfo(dateStr);
      const isSelected = dateStr === state.selectedDate;
      const hasData = datesWithLogs.has(dateStr);
      const isOutOfRange = !isDateEditable(dateStr, todayStr);

      return `
        <button
          type="button"
          class="day-pill ${isSelected ? 'selected' : ''} ${isOutOfRange ? 'out-of-range' : ''}"
          data-strip-date="${dateStr}"
          aria-pressed="${isSelected}"
          title="${isOutOfRange ? 'Tanggal belum bisa diisi / di luar periode' : escapeHtml(formatDateLongId(dateStr))}"
        >
          <span class="day-pill-name">${DAY_SHORT_ID[dow]}</span>
          <span class="day-pill-num">${dayNum}</span>
          ${special
          ? `<span class="day-special-badge ${special.badgeClass}">${special.badgeText}</span>`
          : `<span class="day-special-badge opacity-0">-</span>`
        }
          <span class="day-dot-status ${hasData ? 'has-data' : ''}" title="${hasData ? 'Sudah ada catatan' : 'Belum diisi'}"></span>
        </button>
      `;
    })
    .join('');

  container.querySelectorAll('[data-strip-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const picked = btn.dataset.stripDate;
      if (!isDateEditable(picked)) {
        showToast('Hanya bisa mengisi mulai 1 Nov 2026 hingga hari ini (tidak bisa tanggal besok).', 'warning');
        return;
      }
      state.selectedDate = picked;
      loadDraftForSelectedDate();
      renderMenteeInputView();
    });
  });
}

function renderDailyToggleCards() {
  const grid = document.getElementById('dailyAmalanGrid');
  const countBadge = document.getElementById('dailyQuickCount');
  const titleEl = document.getElementById('dailySectionTitle');
  const dailyItems = state.amalanMeta?.dailyItems || [];

  if (titleEl) {
    titleEl.textContent = `Amalan Harian (${dailyItems.length} Item)`;
  }

  let doneCount = 0;

  grid.innerHTML = dailyItems
    .map((item) => {
      const checked = Number(state.draftValues[item.id] || 0) >= 1;
      if (checked) doneCount += 1;
      const icon = getAmalanIcon(item);

      return `
        <div class="col-12 col-sm-6 col-lg-4">
          <div
            class="amalan-toggle-card ${checked ? 'checked' : ''}"
            data-daily-id="${item.id}"
            role="checkbox"
            aria-checked="${checked}"
            tabindex="0"
          >
            <div class="d-flex align-items-center gap-3 min-w-0">
              <div class="amalan-icon-box">
                <i class="bi ${icon}"></i>
              </div>
              <div class="min-w-0">
                <div class="fw-bold text-dark text-truncate">${escapeHtml(item.name)}</div>
                <div class="small ${checked ? 'text-emerald fw-semibold' : 'text-muted'}">
                  ${checked ? 'Selesai dilaksanakan' : 'Ketuk untuk menandai'}
                </div>
              </div>
            </div>
            <div class="amalan-check-indicator">
              <i class="bi bi-check-lg fw-bold"></i>
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  countBadge.textContent = `${doneCount} / ${dailyItems.length} Selesai`;

  const toggleHandler = (card) => {
    const id = Number(card.dataset.dailyId);
    const nextVal = Number(state.draftValues[id] || 0) >= 1 ? 0 : 1;
    state.draftValues[id] = nextVal;
    queueAutoSave(state.selectedDate, id, nextVal);
    renderDailyToggleCards();
  };

  grid.querySelectorAll('[data-daily-id]').forEach((card) => {
    card.addEventListener('click', () => toggleHandler(card));
    card.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        toggleHandler(card);
      }
    });
  });
}

function renderSemesterStepperCards() {
  const grid = document.getElementById('semesterAmalanGrid');
  const semesterItems = state.amalanMeta?.semesterItems || [];

  grid.innerHTML = semesterItems
    .map((item) => {
      const todayVal = Math.max(0, Number(state.draftValues[item.id] || 0));
      const otherDaysTotal = getCumulativeSemesterExcludingSelected(item.id);
      const liveTotal = otherDaysTotal + todayVal;
      const target = Number(item.target_semester) || 1;
      const pct = clampPct((liveTotal / target) * 100);
      const isTilawah = state.amalanMeta?.tilawahItem?.id === item.id;
      const unitLabel = isTilawah ? 'juz' : 'kali';
      const icon = getAmalanIcon(item);

      return `
        <div class="col-12 col-md-6">
          <div class="semester-stepper-card">
            <div class="d-flex align-items-start justify-content-between gap-3">
              <div class="d-flex align-items-center gap-3">
                <div class="amalan-icon-box bg-gold-soft text-gold">
                  <i class="bi ${icon}"></i>
                </div>
                <div>
                  <div class="fw-bold text-dark">${escapeHtml(item.name)}</div>
                  <div class="small text-muted">Target semester: ${target} ${unitLabel}</div>
                </div>
              </div>
              <span class="badge rounded-pill bg-emerald-soft text-emerald fw-bold px-2.5 py-1.5">
                Total: ${liveTotal} / ${target} ${unitLabel}
              </span>
            </div>

            <div>
              <div class="progress component-progress mb-3">
                <div class="progress-bar bg-gold" role="progressbar" style="width: ${pct.toFixed(1)}%;"></div>
              </div>
              <div class="d-flex align-items-center justify-content-between gap-2">
                <div class="small text-muted">
                  Capaian tanggal <strong class="text-dark">${escapeHtml(formatDateShortId(state.selectedDate))}</strong>:
                </div>
                <div class="stepper-control">
                  <button
                    type="button"
                    class="stepper-btn btn-minus"
                    data-stepper-id="${item.id}"
                    data-delta="-1"
                    ${todayVal <= 0 ? 'disabled' : ''}
                    aria-label="Kurangi capaian ${escapeHtml(item.name)}"
                  >
                    <i class="bi bi-dash-lg"></i>
                  </button>
                  <span class="stepper-value">${todayVal}</span>
                  <button
                    type="button"
                    class="stepper-btn btn-plus"
                    data-stepper-id="${item.id}"
                    data-delta="1"
                    aria-label="Tambah capaian ${escapeHtml(item.name)}"
                  >
                    <i class="bi bi-plus-lg"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  grid.querySelectorAll('[data-stepper-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.stepperId);
      const delta = Number(btn.dataset.delta);
      const current = Math.max(0, Number(state.draftValues[id] || 0));
      const nextVal = Math.max(0, Math.min(20, current + delta));
      state.draftValues[id] = nextVal;
      queueAutoSave(state.selectedDate, id, nextVal);
      renderSemesterStepperCards();
    });
  });
}

async function handleSaveMutabaah() {
  if (!state.user || state.user.role !== 'mentee' || !supabaseClient) return;
  if (!isDateEditable(state.selectedDate)) {
    showToast('Tidak dapat menyimpan tanggal yang akan datang.', 'warning');
    return;
  }

  const saveBtn = document.getElementById('btnSaveMutabaah');
  setButtonLoading(saveBtn, true);

  try {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    await flushAutoSaveQueue();

    const payload = state.amalanItems.map((item) => ({
      user_id: state.user.id,
      amalan_id: item.id,
      log_date: state.selectedDate,
      value: Math.max(0, Number(state.draftValues[item.id] || 0)),
    }));

    const { error } = await supabaseClient
      .from('mutabaah_logs')
      .upsert(payload, { onConflict: 'user_id,amalan_id,log_date' });

    if (error) throw error;

    setAutoSaveStatus('saved', 'Tersimpan & tersinkron ✓');
    showToast(`Alhamdulillah! Mutaba'ah tanggal ${formatDateShortId(state.selectedDate)} berhasil disimpan.`, 'success');

    // Muat ulang data agar dashboard, 7-day strip, & peringkat langsung terupdate
    await loadMenteeData();
    renderMenteeInputView();
    renderWeeklyInputView();
    renderMenteeDashboard();
    renderLeaderboard();
  } catch (err) {
    console.error('Save mutabaah error:', err);
    setAutoSaveStatus('error', 'Gagal menyimpan');
    showToast(`Gagal menyimpan mutaba'ah: ${err.message || 'Coba lagi.'}`, 'danger');
  } finally {
    setButtonLoading(saveBtn, false);
  }
}

// --------------------------------------------------------------------------
// 10. HALAMAN MENTEE — TAB 2: DASHBOARD SAYA
// --------------------------------------------------------------------------
function renderMenteeDashboard() {
  if (!state.myStats || !state.amalanMeta) return;
  const stats = state.myStats;

  // Hero Score Card
  document.getElementById('dashHeroName').textContent = state.user.full_name;
  document.getElementById('dashHeroScore').textContent = formatPct(stats.finalScore);
  document.getElementById('dashSemesterProgress').textContent = `Hari ke-${stats.hariBerjalan} dari ${stats.totalDays} hari semester`;
  document.getElementById('dashDaysRemaining').innerHTML = `<i class="bi bi-hourglass-split me-1"></i>${stats.sisaHari} hari menuju 31 Jan 2027`;

  const predBadge = document.getElementById('dashHeroPredicate');
  predBadge.textContent = stats.predicate.label;
  predBadge.className = `predicate-badge ${stats.predicate.className}`;

  const subtitle = !stats.hasPositiveData
    ? 'Belum ada catatan mutaba\'ah yang masuk. Yuk isi amalan harian pertamamu hari ini!'
    : stats.finalScore >= 75
      ? 'Performa ibadahmu luar biasa! Terus jaga keistiqamahan hingga akhir semester.'
      : 'Terus tingkatkan konsistensi harian & cicil target semester secara bertahap ya!';
  document.getElementById('dashHeroSubtitle').textContent = subtitle;

  // Animate SVG Score Ring (circumference = 2 * PI * 52 ≈ 326.73)
  const circumference = 2 * Math.PI * 52;
  const ring = document.getElementById('dashScoreRing');
  if (ring) {
    const offset = circumference - (clampPct(stats.finalScore) / 100) * circumference;
    ring.style.strokeDasharray = `${circumference.toFixed(2)}`;
    ring.style.strokeDashoffset = `${offset.toFixed(2)}`;
  }

  // Component Progress Bars (4 or 5 components)
  const compCount = stats.componentCount || 4;
  const compWeight = Math.round(100 / compCount);
  const headingEl = document.getElementById('dashComponentsHeading');
  const weightEl = document.getElementById('dashComponentsWeight');
  const trendSubEl = document.getElementById('trendSubtitle');
  if (headingEl) headingEl.textContent = `${compCount} Komponen Penilaian`;
  if (weightEl) weightEl.textContent = `Bobot setara (${compWeight}%)`;
  if (trendSubEl) {
    trendSubEl.textContent = `Persentase penyelesaian ${state.amalanMeta.dailyItems.length} amalan harian per hari`;
  }
  document.getElementById('dashComponentsList').innerHTML = renderComponentBarsHtml(stats, state.amalanMeta);

  // Automatic Recommendations
  const recs = buildRecommendations(stats, state.amalanMeta);
  document.getElementById('menteeRecommendationsList').innerHTML = renderRecommendationsHtml(recs);

  // 14-Day Trend Chart (Chart.js)
  renderMenteeTrendChart();
}

function renderMenteeTrendChart() {
  const canvas = document.getElementById('menteeTrendChart');
  const emptyHint = document.getElementById('menteeTrendEmptyHint');
  if (!canvas) return;

  const todayStr = getTodayStr();
  const dailyIds = new Set((state.amalanMeta?.dailyItems || []).map((i) => i.id));
  const dailyTotalItems = Math.max(1, dailyIds.size);

  const labels = [];
  const dataPct = [];
  const rawCounts = [];

  // Map jumlah amalan harian selesai per tanggal
  const countByDate = new Map();
  state.myLogs.forEach((l) => {
    if (dailyIds.has(l.amalan_id) && Number(l.value) >= 1) {
      countByDate.set(l.log_date, (countByDate.get(l.log_date) || 0) + 1);
    }
  });

  for (let offset = -13; offset <= 0; offset++) {
    const dStr = addDays(todayStr, offset);
    labels.push(formatDateShortId(dStr));
    const count = Math.min(dailyTotalItems, countByDate.get(dStr) || 0);
    rawCounts.push(count);
    dataPct.push(Math.round((count / dailyTotalItems) * 100));
  }

  const hasAnyPoint = rawCounts.some((c) => c > 0);
  emptyHint?.classList.toggle('d-none', hasAnyPoint);

  if (menteeTrendChartInstance) {
    menteeTrendChartInstance.destroy();
  }

  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 260);
  gradient.addColorStop(0, 'rgba(5, 150, 105, 0.28)');
  gradient.addColorStop(1, 'rgba(5, 150, 105, 0.01)');

  menteeTrendChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Penyelesaian Harian (%)',
          data: dataPct,
          borderColor: '#059669',
          backgroundColor: gradient,
          borderWidth: 3,
          fill: true,
          tension: 0.35,
          pointBackgroundColor: '#ffffff',
          pointBorderColor: '#059669',
          pointBorderWidth: 2.5,
          pointRadius: 4,
          pointHoverRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f172a',
          padding: 10,
          cornerRadius: 10,
          callbacks: {
            label: (ctxItem) => {
              const idx = ctxItem.dataIndex;
              return ` ${ctxItem.parsed.y}% (${rawCounts[idx]} / ${dailyTotalItems} amalan harian)`;
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          max: 100,
          ticks: {
            stepSize: 25,
            callback: (val) => `${val}%`,
            color: '#64748b',
            font: { size: 11 },
          },
          grid: { color: '#f1f5f9' },
        },
        x: {
          ticks: { color: '#64748b', font: { size: 11 } },
          grid: { display: false },
        },
      },
    },
  });
}

// --------------------------------------------------------------------------
// 11. HALAMAN MENTEE — TAB 3: PERINGKAT (LEADERBOARD PUBLIK)
// --------------------------------------------------------------------------
function renderLeaderboard() {
  const podiumEl = document.getElementById('leaderboardPodium');
  const tbody = document.getElementById('leaderboardTableBody');
  const list = state.leaderboard || [];

  if (list.length === 0) {
    podiumEl.innerHTML = `<div class="app-card p-4 text-center text-muted small">Belum ada data mentee terdaftar.</div>`;
    tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted py-4">Belum ada data peringkat.</td></tr>`;
    return;
  }

  // Podium Top 3 (Emas, Perak, Perunggu)
  const top3 = list.slice(0, 3);
  const medalTitles = ['Juara 1 • Emas', 'Juara 2 • Perak', 'Juara 3 • Perunggu'];
  const medalIcons = ['bi-trophy-fill', 'bi-award-fill', 'bi-patch-check-fill'];

  podiumEl.innerHTML = top3
    .map((entry, idx) => {
      const isMe = entry.userId === state.user?.id;
      return `
        <div class="podium-card rank-${idx + 1}">
          <div class="podium-medal">
            <i class="bi ${medalIcons[idx]}"></i>
          </div>
          <div class="small fw-bold text-muted mb-1">${medalTitles[idx]}</div>
          <div class="fw-bold text-dark fs-6 mb-1 text-truncate">
            ${escapeHtml(entry.fullName)}
            ${isMe ? '<span class="badge rounded-pill bg-emerald-soft text-emerald ms-1" style="font-size:0.68rem;">Anda</span>' : ''}
          </div>
          <div class="podium-score mb-2">${formatPct(entry.finalScore)}</div>
          <span class="predicate-badge ${entry.predicate.className}">${escapeHtml(entry.predicate.label)}</span>
        </div>
      `;
    })
    .join('');

  // Tabel Peringkat 1–10 (HANYA Rank, Nama, Skor %, Predikat — Privasi Ketat!)
  tbody.innerHTML = list
    .map((entry) => {
      const isMe = entry.userId === state.user?.id;
      const rankBadge =
        entry.rank === 1
          ? '<span class="badge rounded-pill bg-warning text-dark fw-bold px-2.5">#1</span>'
          : entry.rank === 2
            ? '<span class="badge rounded-pill bg-secondary text-white fw-bold px-2.5">#2</span>'
            : entry.rank === 3
              ? '<span class="badge rounded-pill fw-bold px-2.5 text-white" style="background:#c2410c;">#3</span>'
              : `<span class="fw-bold text-muted">#${entry.rank}</span>`;

      return `
        <tr class="${isMe ? 'row-highlight-me' : ''}">
          <td class="ps-4">${rankBadge}</td>
          <td>
            <div class="d-flex align-items-center gap-2.5">
              <span class="user-avatar-circle" style="width:30px;height:30px;font-size:0.75rem;">${getInitials(entry.fullName)}</span>
              <div>
                <span class="fw-semibold text-dark">${escapeHtml(entry.fullName)}</span>
                ${isMe ? '<span class="badge rounded-pill bg-emerald text-white ms-1.5" style="font-size:0.68rem;">Anda</span>' : ''}
              </div>
            </div>
          </td>
          <td class="text-end fw-bold text-dark">${formatPct(entry.finalScore)}</td>
          <td class="pe-4 text-end">
            <span class="predicate-badge ${entry.predicate.className}">${escapeHtml(entry.predicate.label)}</span>
          </td>
        </tr>
      `;
    })
    .join('');
}

// --------------------------------------------------------------------------
// 12. HALAMAN MENTOR / ADMIN (BANG USAMAH)
// --------------------------------------------------------------------------
function renderMentorDashboard() {
  if (state.user?.role !== 'mentor') return;
  const mentees = state.mentorMentees || [];
  const { hariBerjalan, sisaHari, todayStr } = getSemesterMetrics();

  document.getElementById('mentorSemesterInfo').textContent = `Hari ke-${hariBerjalan} • Sisa ${sisaHari} hari menuju 31 Jan 2027`;

  // KPI 1: Rata-rata Skor Kelompok
  const avgScore =
    mentees.length > 0
      ? mentees.reduce((acc, m) => acc + m.stats.finalScore, 0) / mentees.length
      : 0;
  const anyGroupData = mentees.some((m) => m.stats.hasPositiveData);
  const groupPredicate = getPredicateInfo(avgScore, anyGroupData);

  document.getElementById('kpiGroupAvg').textContent = formatPct(avgScore);
  document.getElementById('kpiGroupPredicate').innerHTML = `<span class="predicate-badge ${groupPredicate.className}">${escapeHtml(groupPredicate.label)}</span>`;

  // KPI 2: Mentee Terbaik
  const topMentee = mentees.find((m) => m.stats.hasPositiveData) || null;
  if (topMentee) {
    document.getElementById('kpiTopMenteeName').textContent = topMentee.full_name;
    document.getElementById('kpiTopMenteeScore').textContent = `Skor: ${formatPct(topMentee.stats.finalScore)} (${topMentee.stats.predicate.label})`;
  } else {
    document.getElementById('kpiTopMenteeName').textContent = 'Belum Ada Data';
    document.getElementById('kpiTopMenteeScore').textContent = 'Menunggu input mentee';
  }

  // KPI 3: Total Juz Tilawah Kelompok dari target 30 juz
  const totalTilawahGroup = mentees.reduce((acc, m) => acc + m.stats.totalTilawah, 0);
  const tilawahPct = clampPct((totalTilawahGroup / GROUP_TILAWAH_TARGET_JUZ) * 100);
  document.getElementById('kpiTotalTilawah').textContent = totalTilawahGroup;
  document.getElementById('kpiTilawahBar').style.width = `${tilawahPct.toFixed(1)}%`;

  // KPI 4: Partisipasi Hari Ini
  const loggedTodayCount = mentees.filter((m) => m.stats.hasLoggedToday).length;
  document.getElementById('kpiTodayActive').textContent = loggedTodayCount;
  document.getElementById('kpiTodaySub').textContent = formatDateLongId(todayStr);

  // Perhatian Cepat Mentor
  const lowCount = mentees.filter((m) => m.stats.finalScore < 40).length;
  const missingTodayCount = mentees.length - loggedTodayCount;

  const highlightsEl = document.getElementById('mentorGroupHighlights');
  highlightsEl.innerHTML = `
    <div class="rec-item ${missingTodayCount > 0 ? 'rec-warning' : 'rec-success'}">
      <div class="rec-icon ${missingTodayCount > 0 ? 'bg-gold-soft text-gold' : 'bg-emerald-soft text-emerald'}">
        <i class="bi ${missingTodayCount > 0 ? 'bi-clock-fill' : 'bi-check-circle-fill'}"></i>
      </div>
      <div>
        <div class="fw-bold small text-dark">${missingTodayCount} Mentee Belum Isi Hari Ini</div>
        <div class="small text-secondary">${missingTodayCount > 0
      ? 'Gunakan filter "Belum Isi Hari Ini" di tab Monitoring untuk menyapa mereka.'
      : 'Alhamdulillah, seluruh mentee sudah mencatat mutaba\'ah hari ini!'
    }</div>
      </div>
    </div>

    <div class="rec-item ${lowCount > 0 ? 'rec-warning' : 'rec-success'}">
      <div class="rec-icon ${lowCount > 0 ? 'bg-gold-soft text-gold' : 'bg-emerald-soft text-emerald'}">
        <i class="bi bi-heart-pulse-fill"></i>
      </div>
      <div>
        <div class="fw-bold small text-dark">${lowCount} Mentee dengan Skor &lt;40%</div>
        <div class="small text-secondary">${lowCount > 0
      ? 'Perlu dorongan semangat & pendampingan pribadi dari mentor.'
      : 'Semua mentee berada di atas ambang skor 40%.'
    }</div>
      </div>
    </div>

    <div class="rec-item rec-info">
      <div class="rec-icon bg-emerald-soft text-emerald">
        <i class="bi bi-book-half"></i>
      </div>
      <div>
        <div class="fw-bold small text-dark">Progres Tilawah Kolektif: ${formatPct(tilawahPct)}</div>
        <div class="small text-secondary">Terkumpul ${totalTilawahGroup} dari target ${GROUP_TILAWAH_TARGET_JUZ} juz kelompok dalam sisa ${sisaHari} hari.</div>
      </div>
    </div>
  `;

  renderMentorGroupChart(mentees);
}

function renderMentorGroupChart(mentees) {
  const canvas = document.getElementById('mentorGroupChart');
  if (!canvas) return;

  if (mentorGroupChartInstance) {
    mentorGroupChartInstance.destroy();
  }

  const labels = mentees.map((m) => m.full_name);
  const scores = mentees.map((m) => Number(m.stats.finalScore.toFixed(1)));
  const barColors = scores.map((s) => {
    if (s >= 75) return '#059669';
    if (s >= 40) return '#d97706';
    return '#ef4444';
  });

  mentorGroupChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Skor Akhir (%)',
          data: scores,
          backgroundColor: barColors,
          borderRadius: 8,
          maxBarThickness: 36,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f172a',
          padding: 10,
          cornerRadius: 10,
          callbacks: {
            label: (ctx) => ` Skor Akhir: ${ctx.parsed.y}%`,
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          max: 100,
          ticks: {
            stepSize: 20,
            callback: (v) => `${v}%`,
            color: '#64748b',
          },
          grid: { color: '#f1f5f9' },
        },
        x: {
          ticks: { color: '#334155', font: { weight: 600, size: 11 } },
          grid: { display: false },
        },
      },
    },
  });
}

function renderMentorMonitoringTable() {
  if (state.user?.role !== 'mentor') return;
  const allMentees = state.mentorMentees || [];

  // Update badge counters on filters
  const lowList = allMentees.filter((m) => m.stats.finalScore < 40);
  const missingList = allMentees.filter((m) => !m.stats.hasLoggedToday);

  document.getElementById('countFilterAll').textContent = allMentees.length;
  document.getElementById('countFilterLow').textContent = lowList.length;
  document.getElementById('countFilterMissing').textContent = missingList.length;

  // Apply filter & search
  let filtered = allMentees;
  if (state.mentorFilter === 'low') {
    filtered = lowList;
  } else if (state.mentorFilter === 'missing_today') {
    filtered = missingList;
  }

  const query = state.mentorSearch.trim().toLowerCase();
  if (query) {
    filtered = filtered.filter(
      (m) =>
        m.full_name.toLowerCase().includes(query) ||
        m.username.toLowerCase().includes(query)
    );
  }

  const tbody = document.getElementById('mentorTableBody');
  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="11" class="text-center text-muted py-5">
          <i class="bi bi-inbox fs-3 d-block mb-2 opacity-50"></i>
          Tidak ada mentee yang cocok dengan filter saat ini.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered
    .map((m) => {
      const s = m.stats;
      const todayBadge = s.hasLoggedToday
        ? '<span class="status-pill done"><i class="bi bi-check-circle-fill"></i>Sudah</span>'
        : '<span class="status-pill missing"><i class="bi bi-clock-fill"></i>Belum</span>';

      return `
        <tr>
          <td class="ps-4 fw-bold text-muted">#${m.rank}</td>
          <td>
            <div class="fw-bold text-dark">${escapeHtml(m.full_name)}</div>
            <div class="small text-muted">@${escapeHtml(m.username)}</div>
          </td>
          <td>${todayBadge}</td>
          <td class="text-end fw-medium">${formatPct(s.pctSholat)}</td>
          <td class="text-end fw-medium">${formatPct(s.pctIstighfar)}</td>
          <td class="text-end fw-medium">${s.hasSholawatComponent ? formatPct(s.pctSholawat) : '-'}</td>
          <td class="text-end fw-medium">${s.totalAmalan4x}/${s.amalanTarget}</td>
          <td class="text-end fw-medium">${s.totalTilawah}/${s.tilawahTarget} J</td>
          <td class="text-end fw-bold text-dark">${formatPct(s.finalScore)}</td>
          <td>
            <span class="predicate-badge ${s.predicate.className}">${escapeHtml(s.predicate.label)}</span>
          </td>
          <td class="pe-4 text-end">
            <button type="button" class="btn btn-sm btn-emerald-soft fw-semibold rounded-3 px-3" data-detail-id="${m.id}">
              <i class="bi bi-eye me-1"></i>Detail
            </button>
          </td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('[data-detail-id]').forEach((btn) => {
    btn.addEventListener('click', () => openMenteeDetailModal(btn.dataset.detailId));
  });
}

function openMenteeDetailModal(menteeId) {
  if (state.user?.role !== 'mentor') return;
  const mentee = state.mentorMentees.find((m) => m.id === menteeId);
  if (!mentee) return;

  const s = mentee.stats;
  document.getElementById('modalMenteeName').textContent = mentee.full_name;
  document.getElementById('modalMenteeMeta').textContent = `@${mentee.username} • Peringkat #${mentee.rank} • ${s.hasLoggedToday ? 'Sudah isi hari ini' : 'Belum isi hari ini'
    }`;

  // Summary + 4 Progress Bars
  document.getElementById('modalMenteeSummary').innerHTML = `
    <div class="row g-3">
      <div class="col-12 col-lg-4">
        <div class="app-card p-3.5 h-100 d-flex flex-column justify-content-center text-center">
          <div class="small fw-semibold text-muted mb-1">Skor Akhir Semester</div>
          <div class="display-5 fw-bold text-emerald mb-2">${formatPct(s.finalScore)}</div>
          <div>
            <span class="predicate-badge ${s.predicate.className}">${escapeHtml(s.predicate.label)}</span>
          </div>
          <div class="small text-muted mt-2">Hari ke-${s.hariBerjalan} • Sisa ${s.sisaHari} hari</div>
        </div>
      </div>
      <div class="col-12 col-lg-8">
        <div class="app-card p-3.5 h-100 d-flex flex-column gap-3">
          ${renderComponentBarsHtml(s, state.amalanMeta)}
        </div>
      </div>
    </div>
  `;

  // Recommendations & Weakness Analysis
  document.getElementById('modalMenteeRecommendations').innerHTML = renderRecommendationsHtml(
    mentee.recommendations
  );

  // Daily History Table
  const historyHead = document.getElementById('modalMenteeHistoryHead');
  const historyBody = document.getElementById('modalMenteeHistoryBody');
  const dailyOrdered = state.amalanMeta.dailyItems || [];
  const totalCols = dailyOrdered.length + 3;

  const shortColName = (name) => {
    const lower = (name || '').toLowerCase();
    if (lower.includes('subuh')) return 'Subuh';
    if (lower.includes('dzuhur') || lower.includes('zuhur')) return 'Dzuhur';
    if (lower.includes('ashar') || lower.includes('asar')) return 'Ashar';
    if (lower.includes('maghrib')) return 'Maghrib';
    if (lower.includes('isya')) return 'Isya';
    if (lower.includes('istighfar')) return 'Istighfar';
    if (lower.includes('sholawat') || lower.includes('salawat')) return 'Sholawat';
    return name;
  };

  if (historyHead) {
    historyHead.innerHTML = `
      <tr>
        <th class="ps-3">Tanggal</th>
        ${dailyOrdered.map((item) => `<th class="text-center">${escapeHtml(shortColName(item.name))}</th>`).join('')}
        <th class="text-center">Amalan 4x</th>
        <th class="text-center pe-3">Tilawah</th>
      </tr>
    `;
  }

  const byDate = new Map();
  mentee.logs.forEach((l) => {
    if (!byDate.has(l.log_date)) byDate.set(l.log_date, {});
    byDate.get(l.log_date)[l.amalan_id] = Number(l.value) || 0;
  });

  const sortedDates = Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a));
  document.getElementById('modalHistoryCount').textContent = `${sortedDates.length} hari tercatat`;

  if (sortedDates.length === 0) {
    historyBody.innerHTML = `
      <tr>
        <td colspan="${totalCols}" class="text-center text-muted py-4">
          Belum ada riwayat pengisian mutaba'ah untuk mentee ini.
        </td>
      </tr>
    `;
  } else {
    const amalan4xId = state.amalanMeta.amalan4xItem?.id;
    const tilawahId = state.amalanMeta.tilawahItem?.id;

    const renderBoolCell = (val) =>
      val >= 1
        ? '<i class="bi bi-check-circle-fill text-emerald fs-6" title="Selesai"></i>'
        : '<i class="bi bi-dash-circle text-muted opacity-50" title="Belum"></i>';

    historyBody.innerHTML = sortedDates
      .map((dateStr) => {
        const map = byDate.get(dateStr);
        const dailyCols = dailyOrdered
          .map((item) => `<td class="text-center">${renderBoolCell(map[item.id] || 0)}</td>`)
          .join('');
        const amalanVal = amalan4xId ? map[amalan4xId] || 0 : 0;
        const tilawahVal = tilawahId ? map[tilawahId] || 0 : 0;

        return `
          <tr>
            <td class="ps-3 fw-semibold text-dark text-nowrap">${escapeHtml(formatDateLongId(dateStr))}</td>
            ${dailyCols}
            <td class="text-center fw-semibold ${amalanVal > 0 ? 'text-gold' : 'text-muted'}">${amalanVal}</td>
            <td class="text-center pe-3 fw-semibold ${tilawahVal > 0 ? 'text-emerald' : 'text-muted'}">${tilawahVal}</td>
          </tr>
        `;
      })
      .join('');
  }

  menteeDetailModalInstance?.show();
}

function handleExportCsv() {
  if (state.user?.role !== 'mentor') return;
  const mentees = state.mentorMentees || [];

  const headers = [
    'Rank',
    'Nama Lengkap',
    'Username',
    'Status Hari Ini',
    'Sholat 5 Waktu (%)',
    'Istighfar 100x (%)',
    'Sholawat 100x (%)',
    'Amalan 4x (Capaian)',
    'Amalan 4x (%)',
    'Tilawah (Juz)',
    'Tilawah (%)',
    'Skor Akhir (%)',
    'Predikat',
  ];

  const escapeCsv = (val) => {
    const str = String(val ?? '');
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  };

  const rows = mentees.map((m) => {
    const s = m.stats;
    return [
      m.rank,
      m.full_name,
      m.username,
      s.hasLoggedToday ? 'Sudah Isi' : 'Belum Isi',
      s.pctSholat.toFixed(1),
      s.pctIstighfar.toFixed(1),
      s.hasSholawatComponent ? s.pctSholawat.toFixed(1) : '-',
      `${s.totalAmalan4x}/${s.amalanTarget}`,
      s.pctAmalan.toFixed(1),
      `${s.totalTilawah}/${s.tilawahTarget}`,
      s.pctTilawah.toFixed(1),
      s.finalScore.toFixed(1),
      s.predicate.label,
    ].map(escapeCsv);
  });

  const csvContent = '\uFEFF' + [headers.map(escapeCsv).join(','), ...rows.map((r) => r.join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `rekap-mutabaah-kelompok-${getTodayStr()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  showToast('File CSV rekap kelompok berhasil diunduh.', 'success');
}

// --------------------------------------------------------------------------
// 13. EVENT LISTENERS & BOOTSTRAP INITIALIZATION
// --------------------------------------------------------------------------
function bindEvents() {
  // Login Form
  document.getElementById('loginForm')?.addEventListener('submit', handleLoginSubmit);

  // Show/Hide PIN Toggle
  document.getElementById('toggleLoginPinBtn')?.addEventListener('click', () => {
    const input = document.getElementById('loginPin');
    const icon = document.querySelector('#toggleLoginPinBtn i');
    const isPass = input.type === 'password';
    input.type = isPass ? 'text' : 'password';
    icon.className = isPass ? 'bi bi-eye-slash' : 'bi bi-eye';
  });

  // Navigation Tabs (Desktop & Mobile)
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Refresh Button
  document.getElementById('btnRefreshData')?.addEventListener('click', async () => {
    await refreshAppData();
    showToast('Data terbaru telah dimuat.', 'info');
  });

  // Change PIN Modal & Form
  document.getElementById('btnOpenPinModal')?.addEventListener('click', () => {
    document.getElementById('changePinForm')?.reset();
    document.getElementById('changePinError')?.classList.add('d-none');
    changePinModalInstance?.show();
  });
  document.getElementById('changePinForm')?.addEventListener('submit', handleChangePinSubmit);

  // Logout
  document.getElementById('btnLogout')?.addEventListener('click', handleLogout);

  // Mentee Date Picker & Jump Today (maksimal hari ini — anti isi besok)
  document.getElementById('inputDatePicker')?.addEventListener('change', (e) => {
    const val = e.target.value;
    if (!val) return;
    if (!isDateEditable(val)) {
      const msg =
        val > getMaxInputDate()
          ? 'Tanggal besok/masa depan terkunci agar pengisian tetap jujur.'
          : `Pilih tanggal mulai ${SEMESTER_START} hingga hari ini.`;
      showToast(msg, 'warning');
      e.target.value = state.selectedDate;
      return;
    }
    state.selectedDate = val;
    loadDraftForSelectedDate();
    renderMenteeInputView();
  });

  document.getElementById('btnJumpToday')?.addEventListener('click', () => {
    let target = getTodayStr();
    const maxDate = getMaxInputDate();
    if (target < SEMESTER_START) target = SEMESTER_START;
    if (target > maxDate) target = maxDate;
    state.selectedDate = target;
    loadDraftForSelectedDate();
    renderMenteeInputView();
  });

  // Mentee Save Button
  document.getElementById('btnSaveMutabaah')?.addEventListener('click', handleSaveMutabaah);

  // Input Mode Switcher (Harian vs Isi Seminggu)
  document.querySelectorAll('[data-input-mode]').forEach((btn) => {
    btn.addEventListener('click', () => setInputMode(btn.dataset.inputMode));
  });

  // Weekly Navigation Controls
  document.getElementById('btnPrevWeek')?.addEventListener('click', () => {
    state.weeklyStartDate = addDays(state.weeklyStartDate || getMondayOfWeek(getTodayStr()), -7);
    renderWeeklyInputView();
  });

  document.getElementById('btnThisWeek')?.addEventListener('click', () => {
    let target = getTodayStr();
    if (target < SEMESTER_START) target = SEMESTER_START;
    if (target > SEMESTER_END) target = SEMESTER_END;
    state.weeklyStartDate = getMondayOfWeek(target);
    renderWeeklyInputView();
  });

  document.getElementById('btnNextWeek')?.addEventListener('click', () => {
    state.weeklyStartDate = addDays(state.weeklyStartDate || getMondayOfWeek(getTodayStr()), 7);
    renderWeeklyInputView();
  });

  // Flush pending auto-saves if user closes/switches tab
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pendingAutoSaves.size > 0) {
      flushAutoSaveQueue();
    }
  });

  // Mentor Filter Buttons
  document.querySelectorAll('#mentorFilterGroup [data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.mentorFilter = btn.dataset.filter;
      document.querySelectorAll('#mentorFilterGroup [data-filter]').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      renderMentorMonitoringTable();
    });
  });

  // Mentor Search Input
  document.getElementById('mentorSearchInput')?.addEventListener('input', (e) => {
    state.mentorSearch = e.target.value || '';
    renderMentorMonitoringTable();
  });

  // Mentor CSV Export
  document.getElementById('btnExportCsv')?.addEventListener('click', handleExportCsv);
}

async function bootstrapApp() {
  changePinModalInstance = new bootstrap.Modal(document.getElementById('changePinModal'));
  menteeDetailModalInstance = new bootstrap.Modal(document.getElementById('menteeDetailModal'));

  bindEvents();

  const ready = initSupabase();
  if (!ready) return;

  // Cek sesi tersimpan di localStorage
  const saved = getSavedSession();
  if (saved) {
    setLoader(true, 'Memulihkan sesi Anda...');
    try {
      const { data, error } = await supabaseClient
        .from('profiles')
        .select('id, username, full_name, role')
        .eq('id', saved.id)
        .maybeSingle();

      if (!error && data) {
        state.user = data;
        saveSession(data);
        await enterAuthenticatedApp();
      } else {
        clearSession();
      }
    } catch (err) {
      console.error('Session restore error:', err);
      clearSession();
    } finally {
      setLoader(false);
    }
  }
}

document.addEventListener('DOMContentLoaded', bootstrapApp);

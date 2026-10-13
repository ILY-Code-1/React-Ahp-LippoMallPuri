# Enerlyze — Smart Energy Analysis & AHP Decision Engine

Aplikasi web untuk **Lippo Mall Puri** yang menentukan **prioritas area** yang
paling perlu dioptimalkan penggunaan energinya, menggunakan metode
**Analytical Hierarchy Process (AHP)**.

Area dengan skor prioritas tinggi = area yang konsumsi energinya **belum optimal /
masih boros** dan perlu ditindaklanjuti.

---

## ✨ Overview

- **Frontend only** — React + Vite, berkomunikasi langsung dengan Firebase Firestore
  (tanpa backend terpisah).
- **AHP Decision Engine** — menghitung bobot kriteria dari penilaian berpasangan 2–3
  narasumber (rata-rata geometrik), Consistency Ratio (CR), dan skor prioritas tiap area.
- **2 role** — `admin` & `staff`, dengan menu dan hak akses berbeda.
- **Tema** — minimalist monochrome (hitam/putih/abu), font Inter.

---

## 🧱 Tech Stack

| Layer        | Teknologi                                   |
| ------------ | ------------------------------------------- |
| Framework    | React 19 + Vite                             |
| Styling      | Tailwind CSS v4                             |
| Routing      | React Router v7                             |
| State        | Zustand (+ persist)                         |
| Database     | Firebase Firestore (client SDK)             |
| Charts       | Recharts                                    |
| Encryption   | crypto-js (AES-256 + PBKDF2)                |
| Session      | js-cookie                                   |
| PDF Export   | jsPDF + html2canvas                         |
| Icons        | lucide-react                                |

---

## 🔐 Konfigurasi Environment

Aplikasi **hanya** memakai **satu** environment variable: `SECRET`.

`SECRET` berisi **JSON config Firebase yang dienkripsi (AES-256)**. Saat runtime,
aplikasi men-decrypt `SECRET` untuk menginisialisasi Firebase.

Generate nilainya dengan:

```bash
npm run encrypt-env -- firebase-config.json
```

Detail lengkap ada di **[SETUP.md](./SETUP.md)**.

---

## 👥 Fitur per Role

### Admin

| Menu                | Kemampuan                                                                 |
| ------------------- | ------------------------------------------------------------------------- |
| Dashboard           | KPI cards + grafik skor AHP per area antar bulan (filter 3–20 bulan, mulai dari **bulan sebelumnya**). **Klik bar/titik** → panel detail skor, ranking & data input area tsb. |
| Data                | Lihat data semua area per bulan, **Run / Re-run AHP**, **View Detail**.    |
| Master ▸ AHP        | Lihat 4 kriteria (fixed), kelola **penilaian narasumber** (maks 3): 6 perbandingan berpasangan skala Saaty, CR langsung, simpan draft/final (final hanya bila CR < 0,1), panel hasil gabungan. |
| Master ▸ Area       | CRUD area + assign user penanggung jawab. Delete dicek pemakaian data.     |
| Master ▸ User       | CRUD user, **reset password** (→ `Test1234@`). Delete dicek kepemilikan area. |
| View Detail         | Laporan AHP lengkap (pairwise matrix, ranking, rekomendasi) + **Unduh PDF**. |

### Staff

| Menu       | Kemampuan                                                                        |
| ---------- | -------------------------------------------------------------------------------- |
| Dashboard  | Sama seperti admin (read-only KPI + grafik).                                     |
| Data       | Input/Edit/Hapus data energi **hanya untuk area yang di-assign** ke staff tsb.   |

### Semua Role

- **Change Password** lewat dropdown avatar (kanan atas).
- **Notifikasi** otomatis di-generate saat login, dihapus saat logout.

---

## 🧮 Algoritma AHP

Tahapan yang diimplementasikan (`src/lib/ahp.js`). Penjelasan lengkap beserta contoh
perhitungan ada di **[docs/ahp_algorithm.md](./docs/ahp_algorithm.md)**.

1. **Pairwise matrix kriteria** — tiap narasumber mengisi 6 perbandingan berpasangan
   (skala Saaty 1/9..9) di Master ▸ AHP; matriks resiprokal dibentuk oleh
   `buildMatrixFromPairs()`. Saat Run AHP, penilaian berstatus **final** (minimal 2,
   maksimal 3) digabung dengan **rata-rata geometrik** per sel.
2. **Bobot kriteria** — eigenvector via normalisasi kolom + rata-rata baris.
3. **Consistency Ratio** — `λmax → CI = (λmax−n)/(n−1) → CR = CI/RI`.
   Untuk `n = 4`, `RI = 0.90`. **CR < 0.1 = valid & konsisten.** Penilaian narasumber
   dengan CR ≥ 0.1 hanya bisa disimpan sebagai draft; Run AHP ditolak bila narasumber
   final < 2 atau CR gabungan ≥ 0.1.
4. **Local priority alternatif (area)** — per kriteria, dari data input bulanan:
   - Konsumsi Energi, Biaya Listrik, Durasi Operasional → **nilai lebih tinggi =
     lebih boros = prioritas lebih tinggi**.
   - Frekuensi Maintenance → **dibalik**: frekuensi lebih rendah = area kurang
     terawat = prioritas optimasi lebih tinggi.
5. **Skor akhir area** = Σ (bobot kriteria × local priority area pada kriteria itu).
6. Hasil disimpan ke `ahp_results_enerlyze`. Pairwise matrix diserialisasi ke bentuk
   `{ rows: [{ cells: [...] }] }` lewat `serializeMatrix()` karena Firestore **tidak
   mendukung nested array** (array of arrays); dibaca kembali via `deserializeMatrix()`.

Kriteria (tetap; bobotnya berasal dari penilaian narasumber):

| Kode | Kriteria                  |
| ---- | ------------------------- |
| KE   | Konsumsi Energi (kWh)     |
| BL   | Biaya Listrik (Rp)        |
| DO   | Durasi Operasional (jam)  |
| FM   | Frekuensi Maintenance     |

---

## 🗂️ Struktur Firestore

Semua koleksi berakhiran **`_enerlyze`**.

### `users_enerlyze`
| Field        | Tipe      | Keterangan                          |
| ------------ | --------- | ----------------------------------- |
| name         | string    | Nama lengkap                        |
| email        | string    | Identifier login (unik)             |
| password     | string    | `salt:hash` (PBKDF2)                |
| role         | string    | `admin` \| `staff`                  |
| created_at   | timestamp |                                     |
| updated_at   | timestamp |                                     |

### `areas_enerlyze`
| Field        | Tipe      | Keterangan                          |
| ------------ | --------- | ----------------------------------- |
| name         | string    | Nama area                           |
| description  | string    | Detail (mis. "Lobby, Food Court")   |
| user_id      | string    | Ref ke `users_enerlyze` (PIC)       |
| created_at / updated_at | timestamp |                          |

### `criteria_enerlyze` (doc id = `key`) — LEGACY
Tidak lagi dibaca aplikasi; 4 kriteria kini tetap di `src/constants/criteria.js`.
Koleksi dibiarkan untuk data lama.

| Field | Tipe   | Keterangan                    |
| ----- | ------ | ----------------------------- |
| key   | string | `energy`/`cost`/`duration`/`maintenance` |
| code  | string | `KE`/`BL`/`DO`/`FM`           |
| name  | string | Nama kriteria                 |
| rank  | number | 1–4, unik — legacy, tidak lagi dipakai untuk bobot |

### `data_enerlyze`
| Field          | Tipe      | Keterangan                       |
| -------------- | --------- | -------------------------------- |
| area_id        | string    | Ref ke `areas_enerlyze`          |
| month          | string    | `YYYY-MM`                        |
| energy         | number    | Konsumsi energi (kWh)            |
| energy_area_m2 | number    | Luasan area (m²) — keterangan    |
| cost           | number    | Biaya listrik (Rp)               |
| duration       | number    | Durasi operasional (jam)         |
| maintenance    | number    | Frekuensi maintenance (x/bulan)  |
| created_by     | string    | Ref user                         |
| created_at / updated_at | timestamp |                         |

### `ahp_judgments_enerlyze` (doc id = auto, satu per narasumber, maks 3)
| Field            | Tipe      | Keterangan                              |
| ---------------- | --------- | --------------------------------------- |
| expert_name      | string    | Nama narasumber (wajib)                 |
| expert_position  | string    | Jabatan narasumber (wajib)              |
| criteria_codes   | array     | Urutan matriks `["KE","BL","DO","FM"]`  |
| pairs            | array     | 6 × `{a, b, value}`; `value` = n bila `a` lebih penting, 1/n bila `b` |
| matrix           | map       | Matriks resiprokal `{ rows: [{ cells: [...] }] }` |
| weights          | array     | Bobot kriteria narasumber               |
| lambda_max / ci / cr | number | Konsistensi matriks narasumber        |
| status           | string    | `draft` \| `final` (final hanya bila CR < 0.1) |
| created_by       | string    | Nama/email admin                        |
| created_at / updated_at | timestamp |                                  |

### `ahp_results_enerlyze` (doc id = `month`)
| Field            | Tipe      | Keterangan                              |
| ---------------- | --------- | --------------------------------------- |
| month            | string    | `YYYY-MM`                               |
| ahp_id           | string    | `AHP-YYYY-MM`                           |
| weight_source    | string    | `expert_pairwise`; tidak ada pada hasil lama (bobot dari rank) |
| experts          | array     | Snapshot narasumber final yang dipakai `{id, expert_name, expert_position, cr}` |
| criteria         | array     | `{key, code, name, weight}` (hasil lama juga memuat `rank`) |
| criteria_matrix  | map       | Pairwise matrix gabungan (rata-rata geometrik) — bentuk `{ rows: [{ cells: [...] }] }` (Firestore-safe, bukan nested array) |
| criteria_weights | array     | Bobot kriteria (array 1D)               |
| consistency      | map       | `{lambdaMax, ci, cr, isConsistent}`     |
| ranking          | array     | `{area_id, area_name, score, breakdown, rank}` (`rank` = peringkat area) |
| created_by       | string    | Penyusun                                |
| created_at       | timestamp |                                         |

### `notifications_enerlyze`
| Field      | Tipe      | Keterangan                         |
| ---------- | --------- | ---------------------------------- |
| user_id    | string    | Pemilik notifikasi                 |
| message    | string    | Isi notifikasi                     |
| type       | string    | `missing-data` \| `ahp-pending`    |
| link       | string    | Tujuan navigasi saat diklik        |
| created_at | timestamp |                                    |

---

## 🔔 Notifikasi

- Di-generate **setiap login**, dihapus **setiap logout**.
- Hanya melacak **3 bulan terakhir** dan hanya konteks data AHP.
- **Staff** → notif bila ada bulan yang belum diinput pada area yang di-assign.
- **Admin** → notif bila semua area sudah mengisi data tapi AHP belum dijalankan.
- Klik 1 notif → notif terhapus + navigasi ke halaman terkait.
- "Tandai sudah dibaca semua" → hapus semua notifikasi user.
- Muncul otomatis di ikon lonceng **segera setelah login** (tanpa reload) dan
  di-fetch ulang tiap dropdown dibuka — disinkronkan lewat `stores/notificationStore.js`.

---

## 🚀 Menjalankan

```bash
npm install
npm run dev      # development
npm run build    # production build
npm run preview  # preview hasil build
```

Sebelum run, pastikan `.env` sudah berisi `SECRET`. Lihat **[SETUP.md](./SETUP.md)**.

### Seed & utilitas data

Semua script membaca `SECRET` dari `.env` dan menulis langsung ke Firestore
(kecuali `npm test`).

| Command               | Fungsi                                                                          |
| --------------------- | ------------------------------------------------------------------------------- |
| `npm run seed`        | Seed 4 kriteria AHP (koleksi legacy) + user admin awal.                         |
| `npm run seed:dummy`  | Isi data energi dummy 3 bulan terakhir untuk semua area (idempotent, bertren).  |
| `npm run ahp`         | Jalankan & simpan hasil AHP 3 bulan terakhir. `npm run ahp -- 2026-02` per bulan. **Butuh minimal 2 narasumber final** dengan CR gabungan < 0.1 di `ahp_judgments_enerlyze`; jika tidak, script berhenti. |
| `node scripts/seed-sample-judgments.mjs` | ⚠️ **Data contoh — jangan dijalankan di produksi.** Membuat 3 narasumber contoh berstatus final (batal bila total > 3). |
| `node scripts/seed-may-data.mjs` | Data contoh Mei 2026 (2 narasumber "(contoh)" + 1 record per area). Default dry-run; `--write` menulis dokumen yang belum ada; `--verify` hanya membaca. Tidak menjalankan AHP. |
| `npm test`            | Unit test fungsi murni `src/lib/ahp.js` (`node:test`, tanpa Firestore).         |

---

## 🖼️ Screenshots

> **TODO:** screenshot belum tersedia di repo. Rencana: Halaman Login, Dashboard,
> Data + Run AHP, Laporan AHP / View Detail, Master ▸ AHP (penilaian narasumber),
> Master Area.

---

## 📁 Struktur Proyek

```
src/
├── components/      # UI, layout, auth, data, dashboard components
├── config/          # Inisialisasi Firebase dari SECRET
├── constants/       # Nama koleksi & definisi kriteria
├── lib/             # crypto, ahp, recommendations, format
├── layouts/         # MainLayout (staff) & AdminLayout
├── pages/           # Halaman per route
├── router/          # Definisi route
├── services/        # Akses Firestore (auth, user, area, data, ahp, ahpJudgment, notif)
└── stores/          # Zustand stores (auth, toast, notification)
scripts/
├── encrypt-env.mjs             # CLI enkripsi config → SECRET
├── seed.mjs                    # Seed kriteria (legacy) + admin awal
├── seed-dummy-data.mjs         # Seed data energi dummy 3 bulan (semua area)
├── seed-sample-judgments.mjs   # 3 narasumber contoh — data contoh, jangan di produksi
├── seed-may-data.mjs           # Data contoh Mei 2026 (dry-run / --write / --verify)
└── run-ahp.mjs                 # Hitung & simpan hasil AHP 3 bulan terakhir (butuh narasumber)
tests/
└── ahp.test.js                 # Unit test lib/ahp.js (npm test)
docs/
└── ahp_algorithm.md            # Rujukan cara kerja AHP + contoh perhitungan
```

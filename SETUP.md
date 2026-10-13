# Enerlyze — Panduan Setup Pertama Kali

Dokumen ini menjelaskan langkah-langkah dari **nol** sampai aplikasi bisa
dijalankan dan di-login.

---

## 0. Prerequisites

- **Node.js** ≥ 18 (disarankan 20 LTS) — cek dengan `node -v`
- **npm** ≥ 9
- Akun **Google** untuk membuat project Firebase

---

## 1. Install Dependencies

```bash
npm install
```

---

## 2. Buat Project Firebase & Aktifkan Firestore

1. Buka <https://console.firebase.google.com> → **Add project**.
2. Beri nama (mis. `enerlyze-lippomallpuri`), selesaikan wizard.
3. Di sidebar, pilih **Build ▸ Firestore Database** → **Create database**.
   - Pilih lokasi (mis. `asia-southeast2`).
   - Mulai dengan **Production mode** (rules diatur di langkah 5).
4. Tambahkan **Web App**: ⚙️ **Project settings ▸ General ▸ Your apps ▸ Web (`</>`)**.
   - Daftarkan app, lalu salin objek **`firebaseConfig`**.

Contoh `firebaseConfig`:

```json
{
  "apiKey": "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXX",
  "authDomain": "enerlyze-lippomallpuri.firebaseapp.com",
  "projectId": "enerlyze-lippomallpuri",
  "storageBucket": "enerlyze-lippomallpuri.appspot.com",
  "messagingSenderId": "1234567890",
  "appId": "1:1234567890:web:abcdef123456"
}
```

---

## 3. Generate `SECRET` Environment Variable

Aplikasi **hanya** memakai satu env var: `SECRET` — yaitu `firebaseConfig` yang
sudah **dienkripsi (AES-256)**.

1. Simpan `firebaseConfig` di atas ke sebuah file JSON, mis. `firebase-config.json`,
   **di root project** (file ini tidak akan ikut ter-commit selama tidak di-track).
2. Jalankan:

   ```bash
   npm run encrypt-env -- firebase-config.json
   ```

   atau tanpa argumen lalu paste JSON-nya secara manual:

   ```bash
   npm run encrypt-env
   ```

3. Output berupa satu baris `SECRET=...`. **Salin baris tersebut.**

4. Buat file **`.env`** di root (boleh menyalin dari `.env.example`) dan isi:

   ```env
   SECRET=U2FsdGVkX1.....(hasil enkripsi).....
   ```

> `.env` sudah masuk `.gitignore` — jangan commit nilai `SECRET` asli.
> `firebase-config.json` boleh dihapus setelah `SECRET` dibuat.

---

## 4. Seed Data Awal (Kriteria + Admin Pertama)

Jalankan script seed — ia membaca `SECRET` dari `.env`:

```bash
# Pakai default: admin@enerlyze.com / Admin1234@
npm run seed

# atau tentukan sendiri: <email> <nama> <password>
npm run seed -- admin@lippomall.com "Administrator" PasswordKuat123
```

Script ini:

- Mengisi **4 kriteria AHP** ke `criteria_enerlyze` (rank default 1–4). Koleksi ini
  kini **legacy**: aplikasi tidak lagi membaca `rank`; bobot kriteria berasal dari
  penilaian narasumber di Master ▸ AHP.
- Membuat **user admin pertama** di `users_enerlyze` (password sudah di-hash).

> Jika lebih suka manual, lihat **Lampiran A** di bawah.

---

## 5. Set Firestore Security Rules

Di **Firebase Console ▸ Firestore ▸ Rules**, tempel isi file
[`firestore.rules`](./firestore.rules) lalu **Publish**.

> ⚠️ **Catatan keamanan.** Enerlyze memakai autentikasi **custom** (koleksi
> `users_enerlyze`), bukan Firebase Authentication, sehingga rules tidak dapat
> memvalidasi `request.auth`. Rules bawaan membatasi akses hanya ke koleksi
> `*_enerlyze`. Untuk produksi yang lebih ketat, migrasikan login ke Firebase
> Auth lalu perketat rules berdasarkan `request.auth.uid`.

---

## 6. Jalankan Aplikasi

```bash
npm run dev       # http://localhost:5173
```

Login dengan akun admin hasil seed. Build produksi:

```bash
npm run build
npm run preview
```

---

## ✅ Yang Perlu Anda Lakukan Manual

- [ ] Buat project Firebase & aktifkan Firestore.
- [ ] Salin `firebaseConfig`, generate `SECRET`, isi `.env`.
- [ ] Jalankan `npm run seed` (atau buat kriteria + admin manual — Lampiran A).
- [ ] Publish `firestore.rules` di Firebase Console.
- [ ] Login sebagai admin → buat **User staff**, **Area**, lalu assign area ke staff.
- [ ] Staff login → input data energi bulanan.
- [ ] Admin → **Master ▸ AHP** → input penilaian **minimal 2 narasumber** (maks 3) dan
      simpan sebagai **final** (hanya bisa bila CR < 0,1); pastikan panel Hasil Gabungan
      menunjukkan "Siap untuk Run AHP".
- [ ] Admin → **Run AHP** setelah semua area terisi, lalu **View Detail**.

---

## Lampiran A — Seed Manual via Firebase Console

Jika tidak memakai `npm run seed`:

### A.1 Kriteria (`criteria_enerlyze`) — legacy

Koleksi ini tidak lagi dibaca aplikasi (kriteria tetap ada di `src/constants/criteria.js`),
jadi langkah ini opsional. Bila tetap ingin dibuat, buat 4 dokumen, **Document ID = key**
(kolom `rank` adalah legacy dan tidak dipakai untuk bobot):

| Document ID   | key           | code | name                       | rank (legacy) |
| ------------- | ------------- | ---- | -------------------------- | ---- |
| `energy`      | `energy`      | `KE` | Konsumsi Energi (kWh)      | 1    |
| `cost`        | `cost`        | `BL` | Biaya Listrik (Rp)         | 2    |
| `duration`    | `duration`    | `DO` | Durasi Operasional (jam)   | 3    |
| `maintenance` | `maintenance` | `FM` | Frekuensi Maintenance      | 4    |

### A.2 Admin Pertama (`users_enerlyze`)

Password **wajib** disimpan dalam bentuk hash `salt:hash`. Generate dengan:

```bash
node -e "import('./src/lib/crypto.js').then(m=>console.log(m.hashPassword('Admin1234@')))"
```

Lalu buat 1 dokumen `users_enerlyze`:

| Field      | Value                          |
| ---------- | ------------------------------ |
| name       | `Administrator`                |
| email      | `admin@enerlyze.com`           |
| password   | _(hasil hash di atas)_         |
| role       | `admin`                        |
| created_at | _(timestamp sekarang)_         |
| updated_at | _(timestamp sekarang)_         |

---

## Troubleshooting

| Masalah                                   | Solusi                                                            |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `Failed to load Firebase config from SECRET` | `.env` kosong / `SECRET` salah. Generate ulang via `encrypt-env`. |
| Login selalu gagal                         | Pastikan user ada di `users_enerlyze` & password berupa hash.     |
| `Missing or insufficient permissions`      | Firestore Rules belum di-publish (langkah 5).                     |
| Data tidak muncul                          | Cek nama koleksi harus berakhiran `_enerlyze`.                    |

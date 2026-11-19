# Panduan Backup & Migrasi Firestore Enerlyze

Panduan ini memindahkan dokumen Firestore dari project Firebase lama ke project
baru menggunakan Admin SDK. Script membuat **satu file JSON backup** dan menjaga
ID dokumen serta tipe Firestore yang umum dipakai (Timestamp, GeoPoint, bytes,
DocumentReference, dan nilai angka khusus).

## Analisis project dan collection

Project ini adalah aplikasi React + Vite yang terhubung langsung ke Firestore
melalui Firebase Web SDK. Config di `firebase-config.json` menunjukkan project ID
**`ilycode2`**; konfigurasi web/API key bukan kredensial Admin dan tidak cukup
untuk membaca seluruh database.

Kode project mendefinisikan tujuh collection root:

| Collection | Catatan |
| --- | --- |
| `users_enerlyze` | User aplikasi Enerlyze; autentikasi aplikasi memakai data sendiri di Firestore, bukan Firebase Authentication. |
| `areas_enerlyze` | Master area dan penanggung jawab. |
| `criteria_enerlyze` | Kriteria AHP lama/legacy; masih dapat berisi data. |
| `data_enerlyze` | Data energi bulanan. |
| `ahp_results_enerlyze` | Hasil AHP per bulan. |
| `ahp_judgments_enerlyze` | Penilaian berpasangan narasumber. |
| `notifications_enerlyze` | Notifikasi aplikasi. |

Daftar tersebut berasal dari kode, **bukan hasil pemeriksaan live database**.
Saya tidak memiliki kredensial Admin Firebase untuk membaca akun Anda dari
lingkungan ini. Saat dijalankan dengan kredensial sumber, script akan menemukan
collection yang benar-benar ada dan mencetak jumlah dokumen per collection.
Script juga menelusuri subcollection di bawah dokumen yang ditemukan.

## Cakupan dan batasan

- Isi Firestore, termasuk subcollection yang dapat ditemukan melalui dokumen,
  dimasukkan ke file backup. ID dan path dokumen dipertahankan.
- Data Firestore yang cocok, seperti Timestamp dan referensi, diubah kembali ke
  tipe Firestore saat restore.
- Collection/doc yang tidak ada pada backup tidak dihapus dari database tujuan.
  Untuk hasil salinan yang bersih, gunakan Firestore tujuan yang kosong.
- Firebase Authentication users, Cloud Storage files, Firestore Rules, indexes,
  Cloud Functions, Hosting, dan konfigurasi Firebase lainnya **tidak** termasuk
  backup ini. `users_enerlyze` adalah collection Firestore dan ikut dipindahkan;
  Firebase Auth (jika ada) adalah layanan terpisah.
- Subcollection yatim yang parent document-nya sudah tidak ada tidak dapat
  ditemukan melalui penelusuran collection/document biasa. Untuk kasus itu,
  gunakan export terkelola dari Google Cloud Firestore yang mencakup database.
- Admin SDK bekerja dengan hak IAM dan tidak dibatasi oleh Firestore Security
  Rules. Jaga kredensial service account dan file backup seperti data sensitif.

## 1. Siapkan project Firebase tujuan

1. Buat project Firebase baru dan buat database Firestore.
2. Pilih lokasi database dengan hati-hati. Lokasi Firestore yang sudah dibuat
   tidak dapat diubah.
3. Buat service account untuk migrasi pada project sumber dan project tujuan.
   Berikan hak IAM minimum yang diperlukan untuk membaca Firestore di sumber dan
   membaca/menulis Firestore di tujuan.
4. Unduh file JSON service account untuk masing-masing project. Simpan **di luar
   repository** dan jangan kirim/commit file tersebut.
5. Pastikan Firestore tujuan sudah aktif. Restore tidak membuat database,
   Security Rules, atau index untuk Anda.

## 2. Backup dari project lama

Di PowerShell, dari folder project:

```powershell
$env:SOURCE_SERVICE_ACCOUNT = "C:\secure\firebase-source-service-account.json"
node scripts/firestore-migrate.mjs backup --output firestore-backup.json
```

Atau gunakan perintah npm (variabel environment tetap perlu diatur):

```powershell
npm run firestore:backup -- --output firestore-backup.json
```

Script mencetak project sumber, nama collection, dan jumlah dokumen. Periksa
laporan tersebut, lalu simpan `firestore-backup.json` dengan aman. Jika file
tujuan sudah ada, script berhenti agar backup sebelumnya tidak tertimpa. Gunakan
nama file baru atau tambahkan `--overwrite` bila memang ingin menggantinya.

> `SOURCE_SERVICE_ACCOUNT` dapat dihilangkan jika Google Cloud Application
> Default Credentials sudah disiapkan dengan akses ke project sumber.

## 3. Periksa tujuan lalu restore

Atur service account tujuan. Ganti `PROJECT_ID_TUJUAN` dengan project ID yang
tertera pada file service account tujuan. Jalankan dry-run terlebih dahulu:

```powershell
$env:TARGET_SERVICE_ACCOUNT = "C:\secure\firebase-target-service-account.json"
node scripts/firestore-migrate.mjs restore `
  --input firestore-backup.json `
  --confirm-project PROJECT_ID_TUJUAN `
  --dry-run
```

Pastikan project tujuan dan jumlah collection/dokumen pada laporan sudah benar.
Kemudian jalankan restore sebenarnya dengan perintah sama tanpa `--dry-run`:

```powershell
node scripts/firestore-migrate.mjs restore `
  --input firestore-backup.json `
  --confirm-project PROJECT_ID_TUJUAN
```

Untuk memanggil melalui npm, gunakan:

```powershell
npm run firestore:restore -- --input firestore-backup.json --confirm-project PROJECT_ID_TUJUAN --dry-run
```

Restore menggunakan `set` pada path yang sama: dokumen dengan ID sama di tujuan
akan **ditimpa** dengan data backup. Dokumen lain di tujuan tidak dihapus.
Firestore membatasi jumlah operasi per batch; script menulis maksimum 400 dokumen
per batch.

## 4. Verifikasi dan alihkan aplikasi

1. Buka Firebase Console project tujuan → Firestore Database, lalu bandingkan
   nama collection dan jumlah dokumen dengan ringkasan backup.
2. Uji login dan alur aplikasi pada project tujuan. Admin aplikasi tersimpan
   sebagai dokumen di `users_enerlyze`; password hash dokumen tetap dipindahkan.
3. Publish ulang `firestore.rules` dari repository pada project tujuan. Rules
   file saat ini membuka operasi untuk collection yang berakhiran `_enerlyze`;
   evaluasi ulang rules sebelum digunakan di production.
4. Daftarkan Web App di project tujuan, ambil `firebaseConfig` yang baru, lalu
   ikuti [SETUP.md](./SETUP.md) untuk membuat ulang `SECRET` dan memperbarui
   environment lokal/hosting (misalnya Vercel).
5. Hentikan sementara penulisan data sebelum backup final, lakukan backup dan
   restore final, lalu alihkan aplikasi ke project baru. Ini mencegah perubahan
   baru di project lama tertinggal.
6. Jangan hapus project lama atau file backup sampai aplikasi baru tervalidasi
   dan Anda yakin tidak perlu rollback.

## Pemecahan masalah

- **`PERMISSION_DENIED` / `Missing or insufficient permissions`**: periksa
  project ID service account dan hak IAM Firestore-nya.
- **Project ID tujuan tidak cocok**: cocokkan nilai `--confirm-project` dengan
  `project_id` di service account tujuan.
- **Data backup terlalu besar**: JSON satu-file dapat memerlukan ruang disk besar.
  Pertimbangkan export/import terkelola Firestore untuk database besar.
- **Angka jumlah tidak cocok setelah restore**: cek apakah aplikasi masih
  menerima penulisan di database sumber selama proses backup, dan periksa apakah
  ada dokumen yang sudah lebih dulu ada di tujuan.

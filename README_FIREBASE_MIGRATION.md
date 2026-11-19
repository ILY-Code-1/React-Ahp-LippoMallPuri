# Panduan Backup & Migrasi Firestore Enerlyze

Panduan ini memindahkan dokumen Firestore dari project Firebase lama ke project
baru menggunakan Admin SDK. Script membuat **satu file JSON backup** dan menjaga
ID dokumen serta tipe Firestore yang umum dipakai (Timestamp, GeoPoint, bytes,
DocumentReference, dan nilai angka khusus).

## Analisis project dan collection

Project ini adalah aplikasi React + Vite yang terhubung langsung ke Firestore
melalui Firebase Web SDK. File lokal `firebase-config.json` yang diperiksa
menunjukkan project ID **`ilycode2`**. Namun, aplikasi runtime mengambil config
dari `SECRET` terenkripsi, jadi pastikan project ID aktif sebelum membuat
kredensial sumber. Keduanya adalah konfigurasi web/API key, bukan kredensial
Admin dan tidak cukup untuk membaca seluruh database.

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

Untuk melihat Project ID yang benar-benar dipakai `.env` lokal tanpa mencetak
nilai `SECRET`, jalankan dari root project di PowerShell:

```powershell
$line = Get-Content .env | Where-Object { $_ -match '^SECRET=' } | Select-Object -First 1
$env:SECRET = $line.Substring('SECRET='.Length)
node --input-type=module -e "import { decryptConfig } from './src/lib/crypto.js'; console.log(decryptConfig(process.env.SECRET).projectId)"
Remove-Item Env:SECRET
```

Jika hasilnya berbeda dari `ilycode2`, gunakan Project ID hasil command itu
sebagai project sumber.

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

## `firebase-config.json` cukup atau perlu service account?

Project ini memang sudah memiliki `firebase-config.json`, tetapi file itu berisi
**konfigurasi aplikasi web** seperti `apiKey`, `authDomain`, `projectId`,
`appId`, dan `storageBucket`. Nilai `projectId` saat ini adalah `ilycode2`.
Konfigurasi tersebut memberi tahu Firebase Web SDK project mana yang dipakai
aplikasi; ia **bukan** password, private key, atau identitas Admin.

Karena itu, config web saja tidak cukup untuk script migrasi yang harus membaca
semua collection dan menulis ke project lain. Client SDK hanya dapat melakukan
operasi yang diizinkan oleh Firestore Security Rules dan tidak dapat melakukan
administrasi IAM. Script ini memakai **Firebase Admin SDK** dengan kredensial
service account terpisah:

| File | Dipakai untuk | Hak akses |
| --- | --- | --- |
| `firebase-source-service-account.json` | Membaca Firestore lama | Read-only pada database sumber |
| `firebase-target-service-account.json` | Menulis Firestore baru | Baca/tulis data pada database tujuan |
| `firebase-config.json` | Menjalankan aplikasi web setelah cutover | Konfigurasi client; bukan kredensial Admin |

> Walaupun API key web biasanya bukan rahasia, jangan menganggapnya sebagai
> pengganti Rules yang aman. Di project ini `firestore.rules` mengizinkan akses
> tanpa Firebase Authentication ke collection yang namanya berakhiran
> `_enerlyze`. Jangan memakai akses client tersebut untuk backup. Admin SDK
> melewati Security Rules dan aksesnya ditentukan IAM.

## 1. Siapkan project Firebase tujuan

1. Buka <https://console.firebase.google.com>, pilih **Add project**, lalu buat
   project baru (atau pilih project tujuan yang memang sudah ada).
2. Catat **Project ID** tujuan. Gunakan Project ID, bukan nama tampilan project.
3. Masuk ke **Build → Firestore Database → Create database**. Pilih mode
   Production dan lokasi yang sesuai. Lokasi database tidak dapat diubah setelah
   dibuat.
4. Jangan jalankan seed aplikasi pada database tujuan sebelum restore kecuali
   memang ingin dokumen seed tersebut tetap ada. Restore tidak menghapus dokumen
   tujuan yang tidak ada di backup.

## 2. Buat service account dan kunci JSON

Cara yang disarankan adalah membuat **service account khusus migrasi** dengan
hak minimal, bukan membagikan kredensial akun Google pribadi.

Lakukan langkah berikut dua kali: sekali di project sumber (Project ID aktif
yang sudah diverifikasi) dan sekali di project tujuan. Pastikan project yang
sedang dipilih di Google Cloud Console benar sebelum membuat akun:

1. Buka <https://console.cloud.google.com/iam-admin/serviceaccounts>.
2. Di pemilih project bagian atas, pilih project yang benar:
   - sumber: Project ID aktif yang sudah diverifikasi di atas (kemungkinan
     `ilycode2`);
   - tujuan: Project ID baru yang Anda catat di langkah sebelumnya.
3. Klik **Create service account**.
4. Isi nama yang mudah dikenali:
   - di sumber: `firestore-backup-source`;
   - di tujuan: `firestore-migration-target`.
   Klik **Create and continue**.
5. Berikan role yang sesuai. Jika halaman pembuatan akun tidak menampilkan
   pemberian role, lanjutkan pembuatan, lalu tambahkan role dari halaman IAM
   project seperti langkah 6.
   - akun sumber: **Cloud Datastore Viewer**
     (`roles/datastore.viewer`) — membaca dokumen/collection;
   - akun tujuan: **Cloud Datastore User** (`roles/datastore.user`) —
     membaca dan menulis dokumen.
6. Bila role belum diberikan saat pembuatan:
   - buka **IAM & Admin → IAM** pada project yang sama;
   - klik **Grant access**;
   - isi email service account yang baru dibuat (berakhiran
     `iam.gserviceaccount.com`);
   - pilih role yang sesuai dari tabel di langkah 5, lalu simpan.
7. Kembali ke **IAM & Admin → Service Accounts**, klik service account tersebut,
   buka tab **Keys → Add key → Create new key → JSON → Create**.
8. Browser mengunduh file private key JSON. Simpan sebagai:
   - `C:\secure\firebase-source-service-account.json`;
   - `C:\secure\firebase-target-service-account.json`.

   Buat folder `C:\secure` terlebih dahulu bila belum ada. Nama file boleh
   berbeda, tetapi sesuaikan command berikutnya.
9. **Jangan** mengubah isi JSON, mengirimkannya ke chat/email, menaruhnya di
   `src/`, atau commit ke Git. Siapa pun yang memegang private key dan hak IAM
   tersebut dapat mengakses data project. File backup juga berisi data asli,
   jadi jaga file itu dengan tingkat keamanan yang sama.

Jika organisasi Anda melarang download service-account key, gunakan autentikasi
Application Default Credentials (ADC) yang disetujui administrator Google Cloud.
Untuk panduan ini, file service account JSON adalah cara paling langsung dan
script memeriksa `project_id` di dalamnya.

## 3. Backup dari project lama

Di PowerShell, dari folder project:

```powershell
$env:SOURCE_SERVICE_ACCOUNT = "C:\secure\firebase-source-service-account.json"
node scripts/firestore-migrate.mjs backup --output firestore-backup.json
```

Atau gunakan perintah npm (variabel environment tetap perlu diatur):

```powershell
npm run firestore:backup -- --output firestore-backup.json
```

Script mencetak project sumber, nama collection, dan jumlah dokumen. Pastikan
project yang tercetak adalah project lama yang benar, lalu simpan
`firestore-backup.json` dengan aman. Jika file tujuan sudah ada, script berhenti
agar backup sebelumnya tidak tertimpa. Gunakan nama file baru atau tambahkan
`--overwrite` bila memang ingin menggantinya.

> Untuk backup, `SOURCE_SERVICE_ACCOUNT` dapat dihilangkan jika ADC sudah
> disiapkan pada komputer tersebut dengan akses ke project sumber. Untuk
> restore, gunakan service account JSON tujuan agar script dapat mencocokkan
> project ID tujuan dengan `--confirm-project`.

## 4. Periksa tujuan lalu restore

Atur service account tujuan. Periksa project ID dalam file kunci tanpa
menampilkan private key:

```powershell
(Get-Content "C:\secure\firebase-target-service-account.json" -Raw | ConvertFrom-Json).project_id
```

Ganti `PROJECT_ID_TUJUAN` di bawah dengan hasil tersebut. Jalankan dry-run
terlebih dahulu; dry-run hanya membaca file backup dan mencetak ringkasan:

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

## 5. Verifikasi dan alihkan aplikasi

1. Buka Firebase Console project tujuan → Firestore Database, lalu bandingkan
   nama collection dan jumlah dokumen dengan ringkasan backup.
2. Uji login dan alur aplikasi pada project tujuan. Admin aplikasi tersimpan
   sebagai dokumen di `users_enerlyze`; password hash dokumen tetap dipindahkan.
3. Publish ulang `firestore.rules` dari repository pada project tujuan. Rules
   file saat ini membuka operasi untuk collection yang berakhiran `_enerlyze`;
   evaluasi ulang rules sebelum digunakan di production.
4. Setelah data berhasil diverifikasi, daftarkan Web App pada project tujuan:
   **Project settings (ikon gear) → General → Your apps → Add app → Web (`</>`)**.
   Beri nama aplikasi, lalu salin objek `firebaseConfig` yang ditampilkan.
5. Ganti isi `firebase-config.json` lokal dengan config Web App **project tujuan**
   (config ini bukan service-account JSON). Jalankan:

   ```powershell
   npm run encrypt-env -- firebase-config.json
   ```

   Salin nilai `SECRET=...` yang dihasilkan ke `.env` lokal. Untuk deployment,
   perbarui environment variable `SECRET` di platform hosting (misalnya Vercel)
   dan deploy ulang. Jangan memasukkan service account JSON ke `SECRET`.
6. Hentikan sementara penulisan data sebelum backup final, lakukan backup dan
   restore final, lalu alihkan aplikasi ke project baru. Ini mencegah perubahan
   baru di project lama tertinggal.
7. Jangan hapus project lama atau file backup sampai aplikasi baru tervalidasi
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

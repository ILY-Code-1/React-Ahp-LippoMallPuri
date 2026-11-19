import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app'
import { getFirestore, GeoPoint, Timestamp } from 'firebase-admin/firestore'

const marker = '__firestore_migration_type__'
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const args = process.argv.slice(2)
const action = args[0]

function option(name, fallback) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

function hasOption(name) {
  return args.includes(name)
}

function usage() {
  console.log(`Usage:
  node scripts/firestore-migrate.mjs backup [--output firestore-backup.json] [--overwrite]
  node scripts/firestore-migrate.mjs restore --input firestore-backup.json --confirm-project TARGET_PROJECT_ID [--dry-run]

Environment:
  SOURCE_SERVICE_ACCOUNT  Path to source project's service account JSON (backup)
  TARGET_SERVICE_ACCOUNT  Path to target project's service account JSON (restore)

If the relevant service-account variable is omitted, Application Default Credentials
are used. Grant only the minimum required Firestore access and keep keys private.`)
}

function fail(message) {
  console.error(`Error: ${message}`)
  process.exitCode = 1
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function createFirestore(envName) {
  const keyFile = process.env[envName]
  const appName = `firestore-migration-${envName.toLowerCase()}`

  if (keyFile) {
    const resolvedKeyFile = path.resolve(keyFile)
    const serviceAccount = await readJson(resolvedKeyFile)
    const app = initializeApp({ credential: cert(serviceAccount) }, appName)
    return { db: getFirestore(app), projectId: serviceAccount.project_id }
  }

  const app = initializeApp({ credential: applicationDefault() }, appName)
  return { db: getFirestore(app), projectId: app.options.projectId }
}

function encode(value) {
  if (value instanceof Timestamp) {
    return { [marker]: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds }
  }
  if (value instanceof GeoPoint) {
    return { [marker]: 'geoPoint', latitude: value.latitude, longitude: value.longitude }
  }
  if (value?._firestore && typeof value.path === 'string') {
    return { [marker]: 'reference', path: value.path }
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { [marker]: 'bytes', base64: Buffer.from(value).toString('base64') }
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { [marker]: 'number', value: String(value) }
  }
  if (Array.isArray(value)) return value.map(encode)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encode(child)]))
  }
  return value
}

function decode(value, db) {
  if (Array.isArray(value)) return value.map((child) => decode(child, db))
  if (value && typeof value === 'object') {
    switch (value[marker]) {
      case 'timestamp':
        return new Timestamp(value.seconds, value.nanoseconds)
      case 'geoPoint':
        return new GeoPoint(value.latitude, value.longitude)
      case 'reference':
        return db.doc(value.path)
      case 'bytes':
        return Buffer.from(value.base64, 'base64')
      case 'number':
        if (value.value === 'NaN') return Number.NaN
        if (value.value === 'Infinity') return Number.POSITIVE_INFINITY
        if (value.value === '-Infinity') return Number.NEGATIVE_INFINITY
        throw new Error(`Nilai angka khusus tidak dikenal: ${value.value}`)
      default:
        return Object.fromEntries(
          Object.entries(value).map(([key, child]) => [key, decode(child, db)]),
        )
    }
  }
  return value
}

async function exportCollection(collectionRef, backup) {
  backup.collections.push(collectionRef.path)
  const snapshot = await collectionRef.get()

  for (const doc of snapshot.docs) {
    backup.documents.push({ path: doc.ref.path, data: encode(doc.data()) })
    const childCollections = await doc.ref.listCollections()
    for (const childCollection of childCollections) {
      await exportCollection(childCollection, backup)
    }
  }
}

function summarize(backup) {
  const counts = new Map()
  for (const document of backup.documents) {
    const parts = document.path.split('/')
    const collectionPath = parts.slice(0, -1).join('/')
    counts.set(collectionPath, (counts.get(collectionPath) ?? 0) + 1)
  }
  return [...backup.collections]
    .sort()
    .map((collectionPath) => `${collectionPath}: ${counts.get(collectionPath) ?? 0} dokumen`)
}

function isValidDocumentPath(documentPath) {
  const parts = documentPath.split('/')
  return parts.length >= 2 && parts.length % 2 === 0 && parts.every(Boolean)
}

async function backup() {
  const { db, projectId } = await createFirestore('SOURCE_SERVICE_ACCOUNT')
  const output = path.resolve(projectRoot, option('--output', 'firestore-backup.json'))
  const backupData = {
    format: 'enerlyze-firestore-backup',
    formatVersion: 1,
    sourceProjectId: projectId ?? null,
    exportedAt: new Date().toISOString(),
    collections: [],
    documents: [],
  }

  for (const collectionRef of await db.listCollections()) {
    await exportCollection(collectionRef, backupData)
  }

  if (await fileExists(output) && !hasOption('--overwrite')) {
    throw new Error(`File sudah ada: ${output}. Pilih --output lain atau tambahkan --overwrite.`)
  }

  await writeFile(output, `${JSON.stringify(backupData, null, 2)}\n`, { flag: 'w' })
  console.log(`Backup selesai dari project: ${projectId ?? '(ADC)'}`)
  console.log(`File: ${output}`)
  console.log(`Total dokumen: ${backupData.documents.length}`)
  console.log(summarize(backupData).join('\n') || '(tidak ada collection/dokumen)')
}

async function restore() {
  const input = path.resolve(projectRoot, option('--input', 'firestore-backup.json'))
  const confirmProjectId = option('--confirm-project')
  if (!confirmProjectId) {
    throw new Error('Wajib isi --confirm-project dengan project ID tujuan untuk mencegah salah tulis.')
  }

  const backupData = await readJson(input)
  if (backupData.format !== 'enerlyze-firestore-backup' || backupData.formatVersion !== 1) {
    throw new Error('Format backup tidak dikenal atau versinya tidak didukung.')
  }
  if (!Array.isArray(backupData.documents) || !Array.isArray(backupData.collections)) {
    throw new Error('File backup tidak memiliki daftar collections/documents yang valid.')
  }
  for (const document of backupData.documents) {
    if (!isValidDocumentPath(document.path)) {
      throw new Error(`Path dokumen tidak valid dalam backup: ${document.path}`)
    }
  }

  const { db, projectId } = await createFirestore('TARGET_SERVICE_ACCOUNT')
  if (projectId && projectId !== confirmProjectId) {
    throw new Error(
      `Project ID service account tujuan (${projectId}) tidak cocok dengan konfirmasi (${confirmProjectId}).`,
    )
  }
  if (!projectId) {
    throw new Error(
      'Project ID tujuan tidak terdeteksi dari Application Default Credentials. Gunakan service account JSON.',
    )
  }

  console.log(`Sumber backup: ${backupData.sourceProjectId ?? '(tidak diketahui)'}`)
  console.log(`Tujuan: ${projectId}`)
  console.log(`Total dokumen: ${backupData.documents.length}`)
  console.log(summarize(backupData).join('\n') || '(tidak ada collection/dokumen)')

  if (hasOption('--dry-run')) {
    console.log('Dry-run: tidak ada data yang ditulis.')
    return
  }

  const batchSize = 400
  for (let offset = 0; offset < backupData.documents.length; offset += batchSize) {
    const batch = db.batch()
    const page = backupData.documents.slice(offset, offset + batchSize)
    for (const document of page) {
      batch.set(db.doc(document.path), decode(document.data, db))
    }
    await batch.commit()
    console.log(`Ditulis ${Math.min(offset + page.length, backupData.documents.length)}/${backupData.documents.length}`)
  }
  console.log('Restore selesai. Dokumen dengan ID sama ditimpa; dokumen lain yang sudah ada tidak dihapus.')
}

async function fileExists(filePath) {
  try {
    await readFile(filePath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

try {
  if (action === 'backup') await backup()
  else if (action === 'restore') await restore()
  else usage()
} catch (error) {
  fail(error.message)
}

/**
 * Seed SAMPLE data for May 2026: (A) 2 expert judgments and (B) one energy
 * record per area for "2026-05". It never runs AHP and never touches
 * `ahp_results_enerlyze`.
 *
 *   node scripts/seed-may-data.mjs            → dry run (read-only, prints the plan)
 *   node scripts/seed-may-data.mjs --write    → writes missing documents only
 *   node scripts/seed-may-data.mjs --verify   → read-only check after writing
 *
 * Idempotent: existing documents are never overwritten or deleted.
 *   - judgment skipped when a judgment with the same expert_name exists;
 *   - data record skipped when (area_id, month) already exists.
 *
 * Document shapes mirror the app exactly:
 *   data_enerlyze           ← dataService.createData (created_by = staff user id)
 *   ahp_judgments_enerlyze  ← ahpJudgmentService.createJudgment (toJudgmentFields)
 *
 * Firebase config is read from the SECRET line in `.env`; only the project id
 * is printed.
 */
import { readFileSync } from 'node:fs'
import { initializeApp } from 'firebase/app'
import {
  getFirestore, collection, getDocs, addDoc, query, where, serverTimestamp,
} from 'firebase/firestore'
import { decryptConfig } from '../src/lib/crypto.js'
import { COLLECTIONS } from '../src/constants/collections.js'
import { CRITERIA_CODES, MAX_EXPERTS, CR_THRESHOLD } from '../src/constants/criteria.js'
import { toJudgmentFields, aggregateFinalJudgments, expertWeightsBlocker } from '../src/lib/ahp.js'

const MONTH = '2026-05'
const MODE = process.argv.includes('--write') ? 'write' : process.argv.includes('--verify') ? 'verify' : 'dry-run'

const readSecret = () => {
  let env
  try {
    env = readFileSync('.env', 'utf8')
  } catch {
    console.error('✗ .env file not found.')
    process.exit(1)
  }
  const line = env.split(/\r?\n/).find((l) => l.trim().startsWith('SECRET='))
  if (!line) {
    console.error('✗ SECRET= not found in .env.')
    process.exit(1)
  }
  return line.slice(line.indexOf('=') + 1).trim()
}

/* ── (A) Sample experts ───────────────────────────────────────────────────
 * Stored convention: value for pair (a, b) = n when a is more important,
 * 1/n when b is more important.                                          */
const pairsOf = ([keBl, keDo, keFm, blDo, blFm, doFm]) => [
  { a: 'KE', b: 'BL', value: keBl },
  { a: 'KE', b: 'DO', value: keDo },
  { a: 'KE', b: 'FM', value: keFm },
  { a: 'BL', b: 'DO', value: blDo },
  { a: 'BL', b: 'FM', value: blFm },
  { a: 'DO', b: 'FM', value: doFm },
]

const EXPERTS = [
  {
    expert_name: 'Narasumber Contoh 1 (contoh)',
    expert_position: 'Chief Engineering (contoh)',
    pairs: pairsOf([2, 4, 6, 2, 4, 2]),
  },
  {
    expert_name: 'Narasumber Contoh 2 (contoh)',
    expert_position: 'Kepala Operasional (contoh)',
    pairs: pairsOf([1 / 2, 3, 5, 5, 7, 2]), // KE vs BL: BL lebih penting 2 → 1/2
  },
]

/* ── (B) Energy data generator — same logic as scripts/seed-dummy-data.mjs ──
 * (copied: that script runs main() on import). May is generated as the
 * "newest" month of a 3-month window (m = 2), seeded by the "2026-05" key. */
const AREA_DEFS = [
  { code: 'BS', name: 'Basement' },
  { code: 'LG', name: 'Lower Ground' },
  { code: 'GF', name: 'Ground Floor' },
  { code: 'UG', name: 'Upper Ground' },
  { code: '1F', name: 'Lantai 1' },
  { code: '2F', name: 'Lantai 2' },
]
const PROFILES = {
  BS: { trend: 'stable',    baseKwh: 85000,  area: 15000, hours: 720, maint: [4, 4, 3], kwh: [75000, 95000],   cost: [110e6, 140e6] },
  LG: { trend: 'worsening', baseKwh: 125000, area: 8500,  hours: 375, maint: [4, 3, 2], kwh: [120000, 160000], cost: [180e6, 240e6] },
  GF: { trend: 'improving', baseKwh: 122000, area: 7000,  hours: 345, maint: [3, 4, 5], kwh: [95000, 125000],  cost: [140e6, 185e6] },
  UG: { trend: 'improving', baseKwh: 108000, area: 6500,  hours: 345, maint: [2, 3, 4], kwh: [85000, 110000],  cost: [125e6, 165e6] },
  '1F': { trend: 'stable',  baseKwh: 115000, area: 7500,  hours: 345, maint: [3, 2, 3], kwh: [100000, 135000], cost: [150e6, 200e6] },
  '2F': { trend: 'worsening', baseKwh: 135000, area: 9000, hours: 378, maint: [3, 2, 1], kwh: [130000, 175000], cost: [195e6, 260e6] },
}
const NAME_TO_CODE = Object.fromEntries(AREA_DEFS.map((a) => [a.name, a.code]))
const PROFILE_CODES = Object.keys(PROFILES)
const RATE = { improving: -0.06, worsening: 0.07, stable: 0 }
const SEASONAL = [1.0, 1.04, 1.0]
const M = 2

const seededUnit = (str) => {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10000) / 10000 * 2 - 1
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const roundTo = (v, step) => Math.round(v / step) * step

const buildValues = (code, areaName, month, m) => {
  const p = PROFILES[code]
  const trendFactor = Math.pow(1 + RATE[p.trend], m)
  const kwhJitter = 1 + seededUnit(`${areaName}|${month}|kwh`) * 0.02
  let energy = p.baseKwh * trendFactor * SEASONAL[m] * kwhJitter
  // Profile clamp, then the requested sane range 80.000–160.000 kWh.
  energy = clamp(clamp(roundTo(energy, 100), p.kwh[0], p.kwh[1]), 80000, 160000)

  const costJitter = 1 + seededUnit(`${areaName}|${month}|cost`) * 0.08
  let cost = energy * 1500 * costJitter
  cost = clamp(roundTo(cost, 1000), p.cost[0], p.cost[1])

  const duration = code === 'BS'
    ? 720
    : clamp(Math.round(p.hours + seededUnit(`${areaName}|${month}|dur`) * 12), 300, 400)

  return {
    energy: Math.round(energy),
    energy_area_m2: p.area,
    cost: Math.round(cost),
    duration,
    maintenance: clamp(p.maint[m], 1, 6),
  }
}

const fmt = (n) => Number(n).toLocaleString('id-ID')

const main = async () => {
  const config = decryptConfig(readSecret())
  const app = initializeApp(config)
  const db = getFirestore(app)

  console.log(`Mode: ${MODE.toUpperCase()}`)
  console.log(`Project ID: ${config.projectId}`)
  console.log(`Bulan target: ${MONTH}\n`)

  const [userSnap, areaSnap, judgSnap, maySnap] = await Promise.all([
    getDocs(collection(db, COLLECTIONS.USERS)),
    getDocs(collection(db, COLLECTIONS.AREAS)),
    getDocs(collection(db, COLLECTIONS.AHP_JUDGMENTS)),
    getDocs(query(collection(db, COLLECTIONS.DATA), where('month', '==', MONTH))),
  ])
  // Never keep password hashes around.
  const users = userSnap.docs.map((d) => {
    const { name, email, role } = d.data()
    return { id: d.id, name, email, role }
  })
  const userById = Object.fromEntries(users.map((u) => [u.id, u]))
  const areas = areaSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  const judgments = judgSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
  const mayRecords = maySnap.docs.map((d) => ({ id: d.id, ...d.data() }))

  if (MODE === 'verify') return verify({ areas, userById, judgments, mayRecords })

  const warnings = []

  /* ── (A) experts ──────────────────────────────────────────────────── */
  const admins = users.filter((u) => u.role === 'admin').sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  const createdByAdmin = admins[0] ? admins[0].name || admins[0].email : 'Seed Script'

  const expertPlan = EXPERTS.map((e) => {
    const fields = toJudgmentFields({ ...e, status: 'draft' }, CRITERIA_CODES) // compute without the final gate
    const exists = judgments.find((j) => j.expert_name === fields.expert_name)
    return { fields, exists }
  })

  console.log(`── (A) Narasumber — sudah ada di ahp_judgments_enerlyze: ${judgments.length}`)
  for (const j of judgments) {
    console.log(`   • ${j.expert_name} (${j.expert_position}) — ${j.status}, CR=${Number(j.cr).toFixed(4)}`)
  }
  console.log(`   created_by untuk narasumber baru: ${createdByAdmin}\n`)
  console.log('| Narasumber | Jabatan | CR | λmax | CI | Bobot KE / BL / DO / FM | Aksi |')
  console.log('|---|---|---|---|---|---|---|')
  for (const { fields, exists } of expertPlan) {
    console.log(
      `| ${fields.expert_name} | ${fields.expert_position} | ${fields.cr.toFixed(4)} | ${fields.lambda_max.toFixed(4)} | ${fields.ci.toFixed(4)} | ` +
      `${fields.weights.map((w) => w.toFixed(4)).join(' / ')} | ${exists ? `LEWATI (sudah ada: ${exists.id})` : 'BUAT'} |`,
    )
  }

  const badCr = expertPlan.filter(({ fields }) => fields.cr >= CR_THRESHOLD)
  if (badCr.length) {
    console.error(`\n✗ CR ≥ ${CR_THRESHOLD}: ${badCr.map((x) => x.fields.expert_name).join(', ')}. Berhenti.`)
    process.exit(1)
  }
  const toCreate = expertPlan.filter((x) => !x.exists)
  if (judgments.length + toCreate.length > MAX_EXPERTS) {
    warnings.push(
      `Total narasumber akan menjadi ${judgments.length + toCreate.length} (> MAX_EXPERTS ${MAX_EXPERTS}). --write akan dibatalkan.`,
    )
  }

  // Readiness preview with existing finals + planned ones.
  const preview = aggregateFinalJudgments(
    [...judgments, ...toCreate.map((x) => ({ ...x.fields, status: 'final' }))],
    CRITERIA_CODES,
  )
  if (preview.combined) {
    console.log(
      `\n   Pratinjau gabungan (${preview.experts.length} final): CR=${preview.combined.cr.toFixed(4)} · bobot ` +
      CRITERIA_CODES.map((c, i) => `${c}=${preview.combined.weights[i].toFixed(4)}`).join(', '),
    )
  }

  /* ── (B) May data ─────────────────────────────────────────────────── */
  const dataPlan = areas.map((area, ai) => {
    const code = PROFILES[area.name]
      ? area.name
      : (NAME_TO_CODE[area.name] || PROFILE_CODES[ai % PROFILE_CODES.length])
    const pic = area.user_id ? userById[area.user_id] : null
    const existing = mayRecords.filter((r) => r.area_id === area.id)
    let action = 'BUAT'
    if (!area.user_id) {
      action = 'LEWATI (tanpa user)'
      warnings.push(`Area "${area.name}" tidak punya user penanggung jawab — tidak dibuatkan record.`)
    } else if (!pic) {
      action = 'LEWATI (user tidak ditemukan)'
      warnings.push(`Area "${area.name}": user_id ${area.user_id} tidak ada di users_enerlyze — tidak dibuatkan record.`)
    } else if (existing.length) {
      action = `LEWATI (sudah ada: ${existing.map((r) => r.id).join(', ')})`
      warnings.push(`Area "${area.name}" sudah punya ${existing.length} record ${MONTH}.`)
    }
    if (pic && pic.role !== 'staff') {
      warnings.push(`Area "${area.name}": penanggung jawab ${pic.name} ber-role "${pic.role}", bukan staff.`)
    }
    return { area, code, pic, values: buildValues(code, area.name, MONTH, M), action }
  })

  console.log(`\n── (B) Data ${MONTH} — area terdaftar: ${areas.length}, record ${MONTH} yang sudah ada: ${mayRecords.length}\n`)
  console.log('| Area | Profil | User penanggung jawab | kWh | Biaya (Rp) | Durasi (jam) | Maintenance (x) | Luas (m²) | Aksi |')
  console.log('|---|---|---|---|---|---|---|---|---|')
  for (const p of dataPlan) {
    const v = p.values
    console.log(
      `| ${p.area.name} | ${p.code} | ${p.pic ? `${p.pic.name} (${p.pic.role})` : '—'} | ${fmt(v.energy)} | ${fmt(v.cost)} | ${v.duration} | ${v.maintenance} | ${fmt(v.energy_area_m2)} | ${p.action} |`,
    )
  }
  console.log('\n   Catatan: skema areas_enerlyze hanya menyimpan satu user_id per area, jadi kasus "lebih dari 1 user" tidak mungkin terjadi.')

  console.log(`\n── Peringatan (${warnings.length})`)
  warnings.forEach((w) => console.log(`   ⚠ ${w}`))
  if (!warnings.length) console.log('   (tidak ada)')

  if (MODE !== 'write') {
    console.log('\nDRY RUN — tidak ada yang ditulis. Jalankan dengan --write untuk menulis.')
    process.exit(0)
  }

  /* ── WRITE (only missing docs; never overwrite) ───────────────────── */
  if (judgments.length + toCreate.length > MAX_EXPERTS) {
    console.error(`\n✗ Dibatalkan: total narasumber akan melebihi ${MAX_EXPERTS}. Tidak ada yang ditulis.`)
    process.exit(1)
  }

  console.log('\n── Menulis...')
  for (const { fields, exists } of expertPlan) {
    if (exists) {
      console.log(`   • [SKIP] narasumber "${fields.expert_name}" sudah ada (${exists.id})`)
      continue
    }
    const final = toJudgmentFields({ ...fields, status: 'final' }, CRITERIA_CODES) // enforces CR < 0.1
    const ref = await addDoc(collection(db, COLLECTIONS.AHP_JUDGMENTS), {
      ...final,
      created_by: createdByAdmin,
      updated_at: serverTimestamp(),
      created_at: serverTimestamp(),
    })
    console.log(`   ✓ [INSERT] ahp_judgments_enerlyze/${ref.id} — ${final.expert_name}`)
  }

  for (const p of dataPlan) {
    if (p.action !== 'BUAT') {
      console.log(`   • [SKIP] ${p.area.name}: ${p.action}`)
      continue
    }
    // Re-check right before writing: one record per (area, month).
    const dup = await getDocs(
      query(collection(db, COLLECTIONS.DATA), where('area_id', '==', p.area.id), where('month', '==', MONTH)),
    )
    if (!dup.empty) {
      console.log(`   • [SKIP] ${p.area.name}: record ${MONTH} sudah ada (${dup.docs[0].id})`)
      continue
    }
    const ref = await addDoc(collection(db, COLLECTIONS.DATA), {
      area_id: p.area.id,
      month: MONTH,
      energy: p.values.energy,
      energy_area_m2: p.values.energy_area_m2,
      cost: p.values.cost,
      duration: p.values.duration,
      maintenance: p.values.maintenance,
      created_by: p.pic.id,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    })
    console.log(`   ✓ [INSERT] data_enerlyze/${ref.id} — ${p.area.name}`)
  }

  console.log('\n✓ Selesai. AHP TIDAK dijalankan; ahp_results_enerlyze tidak disentuh.')
  process.exit(0)
}

/** Read-only verification after --write. */
const verify = ({ areas, userById, judgments, mayRecords }) => {
  let ok = true
  console.log(`── Data ${MONTH}`)
  console.log('| Area | Record | created_by | Sesuai PIC | kWh | Biaya | Durasi | Maint |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const area of areas) {
    const recs = mayRecords.filter((r) => r.area_id === area.id)
    const r = recs[0]
    const match = r && r.created_by === area.user_id
    if (recs.length !== 1 || !match) ok = false
    console.log(
      `| ${area.name} | ${recs.length} | ${r ? userById[r.created_by]?.name || r.created_by : '—'} | ${match ? 'ya' : 'TIDAK'} | ` +
      `${r ? fmt(r.energy) : '—'} | ${r ? fmt(r.cost) : '—'} | ${r?.duration ?? '—'} | ${r?.maintenance ?? '—'} |`,
    )
  }
  const orphan = mayRecords.filter((r) => !areas.some((a) => a.id === r.area_id))
  if (orphan.length) console.log(`   ⚠ ${orphan.length} record ${MONTH} merujuk area yang tidak ada.`)

  console.log('\n── Narasumber')
  for (const j of judgments) {
    let cr = NaN
    try {
      cr = toJudgmentFields({ ...j, status: 'draft' }, CRITERIA_CODES).cr // recomputed from pairs
    } catch (e) {
      console.log(`   ✗ ${j.expert_name}: pairs tidak valid (${e.message})`)
    }
    console.log(
      `   • ${j.id} — ${j.expert_name} | status=${j.status} | CR tersimpan=${Number(j.cr).toFixed(4)} | CR hitung ulang=${cr.toFixed(4)} | bobot ${(j.weights || []).map((w) => w.toFixed(4)).join(' / ')}`,
    )
  }

  const aggregate = aggregateFinalJudgments(judgments, CRITERIA_CODES)
  const blocker = expertWeightsBlocker(aggregate)
  console.log(
    `\n── Kesiapan Run AHP (bobot): ${blocker ? `TIDAK SIAP — ${blocker}` : 'SIAP'}` +
    (aggregate.combined ? ` · CR gabungan=${aggregate.combined.cr.toFixed(4)} · bobot ${CRITERIA_CODES.map((c, i) => `${c}=${aggregate.combined.weights[i].toFixed(4)}`).join(', ')}` : ''),
  )
  console.log(`── Data ${MONTH}: ${ok ? 'semua area punya tepat 1 record dengan created_by = PIC' : 'ADA YANG TIDAK SESUAI (lihat tabel)'}`)
  process.exit(0)
}

main().catch((err) => {
  console.error('\n✗ Seed Mei gagal:', err.message)
  process.exit(1)
})

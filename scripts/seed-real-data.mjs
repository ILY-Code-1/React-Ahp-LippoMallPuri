/**
 * Input REAL client data: (A) monthly energy data May–Sep 2026 for the 6 areas and
 * (B) 3 expert (narasumber) questionnaire judgments. It never runs AHP and never
 * touches `ahp_results_enerlyze`.
 *
 *   node scripts/seed-real-data.mjs            → dry run (read-only, prints the plan)
 *   node scripts/seed-real-data.mjs --write    → writes missing documents only
 *   node scripts/seed-real-data.mjs --verify   → read-only check against the tables below
 *
 * Never overwrites or deletes: an existing (area, month) record or an expert with the
 * same name is skipped and reported. Experts are only written when all of them fit
 * under MAX_EXPERTS; otherwise part (B) is refused and nothing is written for it.
 *
 * Document shapes mirror the app exactly:
 *   data_enerlyze           ← dataService.createData (created_by = PIC user id)
 *   ahp_judgments_enerlyze  ← ahpJudgmentService.createJudgment (toJudgmentFields)
 *
 * Firebase config is read from the SECRET line in `.env`; only the project id is printed.
 */
import { readFileSync } from 'node:fs'
import { initializeApp } from 'firebase/app'
import {
  getFirestore, collection, doc, getDocs, query, where, serverTimestamp, writeBatch,
} from 'firebase/firestore'
import { decryptConfig } from '../src/lib/crypto.js'
import { COLLECTIONS } from '../src/constants/collections.js'
import { CRITERIA_CODES, MAX_EXPERTS, MIN_EXPERTS, CR_THRESHOLD } from '../src/constants/criteria.js'
import {
  toJudgmentFields, aggregateFinalJudgments, expertWeightsBlocker,
  geometricMeanMatrix, analyzeMatrix, deserializeMatrix,
} from '../src/lib/ahp.js'

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

/* ── (A) Energy data, exactly as given (kWh | Rp | Luas m² | Durasi jam/bulan | FM x/bulan) ── */
const RAW = {
  '2026-05': {
    BS: ['38881.89', '88118539', '58900', '372', '2'],
    LG: ['403087.32', '795500371.6', '63400', '372', '3'],
    GF: ['484818.3', '780120731.7', '47600', '465', '3'],
    UG: ['192705.62', '438670440', '47700', '372', '2'],
    '1F': ['480597.8', '876874557.2', '46600', '372', '2'],
    '2F': ['368992.2', '794857810', '43700', '372', '3'],
  },
  '2026-06': {
    // Corrected by the user (2026-10-22): was 2051.96 kWh / Rp88,734,498.
    BS: ['37109.26', '84084768', '58900', '360', '2'],
    LG: ['426787.67', '845347794', '63400', '360', '3'],
    GF: ['525995.35', '858485084', '47600', '450', '4'],
    UG: ['192298.05', '437661660', '47700', '360', '2'],
    '1F': ['508535.38', '927150205', '46600', '360', '3'],
    '2F': ['380654.4', '818906820', '43700', '360', '2'],
  },
  '2026-07': {
    BS: ['37998.41', '86104406', '58900', '372', '2'],
    LG: ['417435.81', '827379841.28', '63400', '372', '2'],
    GF: ['503941.65', '812904663.44', '47600', '465', '3'],
    UG: ['186854.88', '425391250', '47700', '372', '3'],
    '1F': ['517745.56', '947712196.6', '46600', '372', '2'],
    '2F': ['363532.23', '784365587.36', '43700', '372', '3'],
  },
  '2026-08': {
    BS: ['38995.15', '88363015', '58900', '372', '3'],
    LG: ['443732.49', '883739418.02', '63400', '372', '3'],
    GF: ['481958.59', '807797601.2', '47600', '465', '3'],
    UG: ['193989.21', '439657160', '47700', '372', '2'],
    '1F': ['538862.56', '983968010', '46600', '372', '2'],
    '2F': ['373700.79', '803876080', '43700', '372', '3'],
  },
  '2026-09': {
    BS: ['41596.45', '94257561', '58900', '360', '2'],
    LG: ['442942.17', '881618786', '63400', '360', '3'],
    GF: ['597747.85', '819204900', '47600', '450', '2'],
    UG: ['198363.18', '448941730', '47700', '360', '2'],
    '1F': ['524541.69', '961355140', '46600', '360', '3'],
    '2F': ['370357.61', '794112240', '43700', '360', '2'],
  },
}
const MONTHS = Object.keys(RAW)

/*
 * Deletions approved by the user (2026-10-22): the sample data created by
 * scripts/seed-may-data.mjs. Only these exact ids are ever deleted, and only when
 * they still look like the sample docs (checked before anything is written).
 */
const DELETE_JUDGMENT_IDS = ['CWFLcuVlJiCHxUOwAIdm', 'Do4oM9eiWhqS0MaNIbi1'] // "(contoh)" experts
const DELETE_DATA_IDS = [ // data_enerlyze, month 2026-05, one per area
  'JYerwKHJ8Wi5oHNogJS3', 'UD5PPrwHT9hK5Wl6ClqS', 'VUh60KARCITxbubUW0Dk',
  'lwY58cgsuPrNyCDmXHD8', '4ZXGzqjVKikbLYlr29pz', 'o6di8qO5tpYvxlW2knjx',
]
const DELETE_DATA_MONTH = '2026-05'
const AREA_CODES = ['BS', 'LG', 'GF', 'UG', '1F', '2F']
const AREA_NAMES = { BS: 'Basement', LG: 'Lower Ground', GF: 'Ground Floor', UG: 'Upper Ground', '1F': 'Lantai 1', '2F': 'Lantai 2' }
const FIELDS = ['energy', 'cost', 'energy_area_m2', 'duration', 'maintenance']

/** Half-up rounding on the decimal string itself (no float surprises), values are ≥ 0. */
const roundHalfUp = (s) => {
  const [int, frac = ''] = s.split('.')
  return Number(int) + (frac.length && Number(frac[0]) >= 5 ? 1 : 0)
}

/* ── (B) Experts — questionnaire codes: A n = left criterion more important (n), B n = right (1/n) ── */
const PAIR_ORDER = [['KE', 'BL'], ['KE', 'DO'], ['KE', 'FM'], ['BL', 'DO'], ['BL', 'FM'], ['DO', 'FM']]
const fromCode = (c) => (c[0] === 'A' ? Number(c.slice(1)) : 1 / Number(c.slice(1)))
const EXPERTS = [
  { expert_name: 'Ahmad Sopian', expert_position: 'Assistant Manager', codes: ['B3', 'A3', 'A2', 'A7', 'A5', 'B2'],
    expect: { lambdaMax: 4.01925, cr: 0.0071, w: [0.2180, 0.5860, 0.0725, 0.1236] } },
  { expert_name: 'Anggie Kusworo', expert_position: 'Chief Engginering', codes: ['B2', 'A5', 'A3', 'A7', 'A5', 'B2'],
    expect: { lambdaMax: 4.02014, cr: 0.0075, w: [0.3009, 0.5254, 0.0634, 0.1104] } },
  { expert_name: 'Agus Setiyanto', expert_position: 'Supervisor Engineering', codes: ['B4', 'A4', 'A2', 'A9', 'A5', 'B3'],
    expect: { lambdaMax: 4.06182, cr: 0.0229, w: [0.2023, 0.6164, 0.0534, 0.1279] } },
]
const EXPECT_COMBINED = { cr: 0.0113, w: [0.2379, 0.5782, 0.0629, 0.1209] }
const pairsOf = (codes) => PAIR_ORDER.map(([a, b], i) => ({ a, b, value: fromCode(codes[i]) }))
// Matches when equal at the precision the expectation was given with.
const sameAt = (actual, expected) => {
  const d = (String(expected).split('.')[1] || '').length
  return actual.toFixed(d) === expected.toFixed(d)
}

const fmtN = (n) => Number(n).toLocaleString('id-ID')

const main = async () => {
  const config = decryptConfig(readSecret())
  const db = getFirestore(initializeApp(config))
  console.log(`Mode: ${MODE.toUpperCase()}`)
  console.log(`Firebase project ID: ${config.projectId}`)
  console.log(`Bulan: ${MONTHS.join(', ')}\n`)

  const [userSnap, areaSnap, judgSnap, dataSnap] = await Promise.all([
    getDocs(collection(db, COLLECTIONS.USERS)),
    getDocs(collection(db, COLLECTIONS.AREAS)),
    getDocs(collection(db, COLLECTIONS.AHP_JUDGMENTS)),
    getDocs(query(collection(db, COLLECTIONS.DATA), where('month', 'in', MONTHS))),
  ])
  const users = userSnap.docs.map((d) => { const { name, email, role } = d.data(); return { id: d.id, name, email, role } })
  const userById = Object.fromEntries(users.map((u) => [u.id, u]))
  const areas = areaSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
  let judgments = judgSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
  let records = dataSnap.docs.map((d) => ({ id: d.id, ...d.data() }))

  /* ── Area ↔ code mapping (stop on any doubt) ── */
  const problems = []
  const areaByCode = {}
  for (const code of AREA_CODES) {
    const hits = areas.filter((a) => {
      const n = (a.name || '').trim().toLowerCase()
      return n === code.toLowerCase() || n === AREA_NAMES[code].toLowerCase()
    })
    if (hits.length !== 1) problems.push(`Kode ${code}: ${hits.length} area cocok (${hits.map((h) => h.name).join(', ') || '—'})`)
    else areaByCode[code] = hits[0]
  }
  const unmapped = areas.filter((a) => !Object.values(areaByCode).includes(a))
  if (unmapped.length) problems.push(`Area di Firestore tanpa kode: ${unmapped.map((a) => a.name).join(', ')}`)
  for (const [code, a] of Object.entries(areaByCode)) {
    if (!a.user_id) problems.push(`Area ${code} tidak punya penanggung jawab`)
    else if (!userById[a.user_id]) problems.push(`Area ${code}: user_id tidak ditemukan di users_enerlyze`)
  }

  console.log('── Pemetaan area → penanggung jawab')
  console.log('| Kode | Area di Firestore | Deskripsi | Penanggung jawab (role) |')
  console.log('|---|---|---|---|')
  for (const code of AREA_CODES) {
    const a = areaByCode[code]
    const u = a && userById[a.user_id]
    console.log(`| ${code} | ${a ? a.name : '—'} | ${a ? (a.description || '').slice(0, 60) : '—'} | ${u ? `${u.name} (${u.role})` : '—'} |`)
  }
  if (problems.length) {
    console.error(`\n✗ Pemetaan tidak pasti — BERHENTI:\n  - ${problems.join('\n  - ')}`)
    process.exit(1)
  }

  if (MODE === 'verify') return verify({ areaByCode, userById, records, judgments })

  /* ── Deletion plan (exact ids only) + safety checks ── */
  const delProblems = []
  const delJudg = DELETE_JUDGMENT_IDS.map((id) => judgments.find((j) => j.id === id) || { id, missing: true })
  const delData = DELETE_DATA_IDS.map((id) => records.find((r) => r.id === id) || { id, missing: true })
  for (const j of delJudg) {
    if (j.missing) delProblems.push(`narasumber ${j.id} tidak ditemukan`)
    else if (!/\(contoh\)\s*$/.test(j.expert_name || '')) delProblems.push(`${j.id} bukan narasumber contoh ("${j.expert_name}")`)
  }
  for (const r of delData) {
    if (r.missing) delProblems.push(`record ${r.id} tidak ditemukan di bulan ${MONTHS.join('/')}`)
    else if (r.month !== DELETE_DATA_MONTH) delProblems.push(`record ${r.id} bukan bulan ${DELETE_DATA_MONTH} (${r.month})`)
  }
  const delAreas = delData.filter((r) => !r.missing).map((r) => r.area_id)
  if (new Set(delAreas).size !== AREA_CODES.length || !AREA_CODES.every((c) => delAreas.includes(areaByCode[c].id))) {
    delProblems.push('record yang akan dihapus tidak tepat satu per area')
  }
  const otherMay = records.filter((r) => r.month === DELETE_DATA_MONTH && !DELETE_DATA_IDS.includes(r.id))
  if (otherMay.length) delProblems.push(`ada ${otherMay.length} record ${DELETE_DATA_MONTH} lain di luar daftar hapus: ${otherMay.map((r) => r.id).join(', ')}`)

  const codeOf = (areaId) => AREA_CODES.find((c) => areaByCode[c].id === areaId) || areaId
  console.log('\n── DIHAPUS — ahp_judgments_enerlyze')
  for (const j of delJudg) console.log(`   ${j.id} — ${j.missing ? 'TIDAK DITEMUKAN' : `${j.expert_name} (${j.expert_position}), ${j.status}, CR=${Number(j.cr).toFixed(4)}`}`)
  console.log(`── DIHAPUS — data_enerlyze (bulan ${DELETE_DATA_MONTH})`)
  for (const r of delData) {
    console.log(`   ${r.id} — ${r.missing ? 'TIDAK DITEMUKAN' : `${codeOf(r.area_id)} ${r.month}: kWh ${fmtN(r.energy)}, Rp ${fmtN(r.cost)}, luas ${fmtN(r.energy_area_m2)}, durasi ${r.duration}, FM ${r.maintenance}, oleh ${userById[r.created_by]?.name || r.created_by}`}`)
  }
  console.log(`── Pemeriksaan hapus: ${delProblems.length ? delProblems.join(' | ') : 'OK (tepat 2 narasumber contoh + 6 record Mei, satu per area)'}`)

  // From here on, plan against the state AFTER the approved deletions.
  const deleted = new Set([...DELETE_JUDGMENT_IDS, ...DELETE_DATA_IDS])
  const allRecords = records
  const allJudgments = judgments
  records = allRecords.filter((r) => !deleted.has(r.id))
  judgments = allJudgments.filter((j) => !deleted.has(j.id))

  /* ── (A) plan ── */
  const plan = []
  for (const month of MONTHS) {
    for (const code of AREA_CODES) {
      const area = areaByCode[code]
      const raw = RAW[month][code]
      const vals = Object.fromEntries(FIELDS.map((f, i) => [f, roundHalfUp(raw[i])]))
      const existing = records.filter((r) => r.area_id === area.id && r.month === month)
      let action = 'BUAT'
      let diff = ''
      if (existing.length) {
        action = `LEWATI (sudah ada: ${existing.map((r) => r.id).join(', ')})`
        const e = existing[0]
        const d = FIELDS.filter((f) => Number(e[f]) !== vals[f])
        diff = d.length ? `BERBEDA: ${d.map((f) => `${f} tersimpan ${fmtN(e[f])} ≠ tabel ${fmtN(vals[f])}`).join('; ')}` : 'sama dengan tabel'
      }
      plan.push({ month, code, area, pic: userById[area.user_id], raw, vals, action, diff })
    }
  }

  console.log('\n── (A) Data energi (nilai asli → disimpan, dibulatkan half-up)')
  for (const month of MONTHS) {
    console.log(`\n${month}`)
    console.log('| Area | kWh | Biaya (Rp) | Luas (m²) | Durasi (jam/bln) | FM (x/bln) | Pengisi | Aksi |')
    console.log('|---|---|---|---|---|---|---|---|')
    for (const p of plan.filter((x) => x.month === month)) {
      const cell = (i) => (p.raw[i].includes('.') ? `${p.raw[i]} → ${fmtN(p.vals[FIELDS[i]])}` : fmtN(p.vals[FIELDS[i]]))
      console.log(`| ${p.code} | ${cell(0)} | ${cell(1)} | ${cell(2)} | ${cell(3)} | ${cell(4)} | ${p.pic.name} | ${p.action}${p.diff ? ` — ${p.diff}` : ''} |`)
    }
  }
  const toCreate = plan.filter((p) => p.action === 'BUAT')
  console.log(`\nRingkasan (A): ${toCreate.length} dibuat, ${plan.length - toCreate.length} dilewati dari ${plan.length}.`)
  for (const m of MONTHS) {
    const c = plan.filter((p) => p.month === m)
    console.log(`  ${m}: buat ${c.filter((p) => p.action === 'BUAT').length}, lewati ${c.filter((p) => p.action !== 'BUAT').length}`)
  }
  const outside = records.filter((r) => !MONTHS.includes(r.month))
  if (outside.length) console.log(`  (catatan: ${outside.length} record di luar Mei–Sep tidak disentuh)`)

  /* ── (B) plan ── */
  console.log(`\n── (B) Narasumber — tersisa setelah hapus: ${judgments.length} (maks ${MAX_EXPERTS})`)
  for (const j of judgments) console.log(`   • ${j.id} — ${j.expert_name} (${j.expert_position}) — ${j.status}, CR=${Number(j.cr).toFixed(4)}`)
  const bPlan = EXPERTS.map((e) => {
    const fields = toJudgmentFields({ ...e, pairs: pairsOf(e.codes), status: 'draft' }, CRITERIA_CODES) // compute without the final gate
    const exists = judgments.find((j) => (j.expert_name || '').trim() === e.expert_name)
    const checks = [sameAt(fields.lambda_max, e.expect.lambdaMax), sameAt(fields.cr, e.expect.cr), ...fields.weights.map((w, i) => sameAt(w, e.expect.w[i]))]
    return { e, fields, exists, matches: checks.every(Boolean), status: fields.cr < CR_THRESHOLD ? 'final' : 'draft' }
  })
  console.log('\n| Narasumber | Jabatan | Pasangan (KE-BL, KE-DO, KE-FM, BL-DO, BL-FM, DO-FM) | λmax | CI | CR | Bobot KE / BL / DO / FM | Status | Cocok harapan | Aksi |')
  console.log('|---|---|---|---|---|---|---|---|---|---|')
  for (const b of bPlan) {
    const f = b.fields
    console.log(
      `| ${f.expert_name} | ${f.expert_position} | ${b.e.codes.join(' ')} | ${f.lambda_max.toFixed(5)} | ${f.ci.toFixed(5)} | ${f.cr.toFixed(4)} | ` +
      `${f.weights.map((w) => w.toFixed(4)).join(' / ')} | ${b.status} | ${b.matches ? 'ya' : 'TIDAK'} | ${b.exists ? `LEWATI (sudah ada: ${b.exists.id})` : 'BUAT'} |`,
    )
  }
  const combined = analyzeMatrix(geometricMeanMatrix(bPlan.map((b) => deserializeMatrix(b.fields.matrix))))
  const combinedOk = sameAt(combined.cr, EXPECT_COMBINED.cr) && combined.weights.every((w, i) => sameAt(w, EXPECT_COMBINED.w[i]))
  console.log(
    `\n   Cek gabungan 3 narasumber (tidak disimpan): λmax=${combined.lambdaMax.toFixed(5)} CI=${combined.ci.toFixed(5)} CR=${combined.cr.toFixed(4)} · bobot ` +
    `${CRITERIA_CODES.map((c, i) => `${c}=${combined.weights[i].toFixed(4)}`).join(', ')} · cocok harapan: ${combinedOk ? 'ya' : 'TIDAK'}`,
  )

  const bBlockers = []
  if (bPlan.some((b) => !b.matches) || !combinedOk) bBlockers.push('Ada nilai yang tidak cocok dengan perhitungan independen — kemungkinan bug/konvensi terbalik.')
  if (bPlan.some((b) => b.status !== 'final')) bBlockers.push(`Ada narasumber dengan CR ≥ ${CR_THRESHOLD}.`)
  const bNew = bPlan.filter((b) => !b.exists)
  if (judgments.length + bNew.length > MAX_EXPERTS) {
    bBlockers.push(
      `Kapasitas penuh: sudah ada ${judgments.length} narasumber, ditambah ${bNew.length} baru = ${judgments.length + bNew.length} > MAX_EXPERTS (${MAX_EXPERTS}). ` +
      'Narasumber lama harus dihapus dulu (perlu keputusan Anda).',
    )
  }
  console.log(`\n── Pemblokir (B): ${bBlockers.length ? '' : 'tidak ada'}`)
  bBlockers.forEach((x) => console.log(`   ⚠ ${x}`))

  /* ── Readiness per month (report only; never runs AHP) ── */
  const readiness = (label, judgs, recs) => {
    const agg = aggregateFinalJudgments(judgs, CRITERIA_CODES)
    const blocker = expertWeightsBlocker(agg, { min: MIN_EXPERTS, max: MAX_EXPERTS })
    console.log(`\n── Kesiapan Run AHP — ${label} (hanya laporan)`)
    console.log(`   Narasumber final: ${agg.experts.length}${agg.combined ? `, CR gabungan ${agg.combined.cr.toFixed(4)}` : ''} → ${blocker ? `TIDAK SIAP: ${blocker}` : 'bobot siap'}`)
    for (const m of MONTHS) {
      const filled = AREA_CODES.filter((c) => recs.some((r) => r.area_id === areaByCode[c].id && r.month === m)).length
      console.log(`   ${m}: area terisi ${filled}/6 → ${!blocker && filled === 6 && areas.length === 6 ? 'SIAP' : 'TIDAK SIAP'}`)
    }
  }
  readiness('kondisi saat ini (sebelum hapus)', allJudgments, allRecords)
  const afterJudg = bBlockers.length ? judgments : [...judgments, ...bNew.map((b) => ({ ...b.fields, status: 'final' }))]
  readiness(`setelah --write${bBlockers.length ? ' (B tidak ditulis karena pemblokir)' : ''}`, afterJudg,
    [...records, ...toCreate.map((p) => ({ area_id: p.area.id, month: p.month }))])

  /* ── Anomalies (report only — values are written as given) ── */
  console.log('\n── Anomali (dilaporkan, tidak dikoreksi)')
  for (const p of plan) {
    const rpPerKwh = p.vals.cost / p.vals.energy
    // Median of the area's other months (robust against the outlier itself).
    const others = plan.filter((q) => q.code === p.code && q.month !== p.month).map((q) => q.vals.cost / q.vals.energy).sort((x, y) => x - y)
    const mid = others.length / 2
    const median = others.length % 2 ? others[Math.floor(mid)] : (others[mid - 1] + others[mid]) / 2
    if (rpPerKwh > median * 3 || rpPerKwh < median / 3) {
      console.log(`   ⚠ ${p.code} ${p.month}: Rp/kWh ≈ ${fmtN(Math.round(rpPerKwh))} (median bulan lain ≈ ${fmtN(Math.round(median))}) — perlu dikonfirmasi ke client`)
    }
  }
  console.log('   ⚠ Kolom terakhir (FM) di Excel tidak berjudul — diasumsikan Frekuensi Maintenance (kali/bulan).')

  /* ── Gate: exact counts approved by the user ── */
  const EXPECT = { delJudg: 2, delData: 6, newData: 30, newJudg: 3 }
  const counts = { delJudg: delJudg.length, delData: delData.length, newData: toCreate.length, newJudg: bNew.length }
  const gate = [
    ...delProblems,
    ...bBlockers,
    ...Object.keys(EXPECT).filter((k) => counts[k] !== EXPECT[k]).map((k) => `jumlah ${k} = ${counts[k]}, seharusnya ${EXPECT[k]}`),
  ]
  console.log(`\n── Rencana: hapus ${counts.delJudg} narasumber + ${counts.delData} record · tulis ${counts.newData} record + ${counts.newJudg} narasumber`)
  console.log(`── Gerbang: ${gate.length ? `GAGAL — ${gate.join(' | ')}` : 'OK (sesuai keputusan: hapus 2 + 6, tulis 30 + 3)'}`)

  if (MODE !== 'write') {
    console.log('\nDRY RUN — tidak ada yang ditulis. Jalankan dengan --write setelah dikonfirmasi.')
    process.exit(0)
  }
  if (gate.length) {
    console.error('\n✗ --write DIBATALKAN: gerbang gagal. Tidak ada yang dihapus atau ditulis.')
    process.exit(1)
  }

  /* ── WRITE: one atomic batch (all deletes + all creates, or nothing) ── */
  const admins = users.filter((u) => u.role === 'admin').sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  const createdBy = admins[0] ? admins[0].name || admins[0].email : 'Seed Script'
  const batch = writeBatch(db)
  for (const id of DELETE_JUDGMENT_IDS) batch.delete(doc(db, COLLECTIONS.AHP_JUDGMENTS, id))
  for (const id of DELETE_DATA_IDS) batch.delete(doc(db, COLLECTIONS.DATA, id))
  const created = []
  for (const p of toCreate) {
    const ref = doc(collection(db, COLLECTIONS.DATA))
    batch.set(ref, {
      area_id: p.area.id,
      month: p.month,
      energy: p.vals.energy,
      energy_area_m2: p.vals.energy_area_m2,
      cost: p.vals.cost,
      duration: p.vals.duration,
      maintenance: p.vals.maintenance,
      created_by: p.pic.id,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    })
    created.push(`data_enerlyze/${ref.id} — ${p.month} ${p.code}`)
  }
  for (const b of bNew) {
    const final = toJudgmentFields({ ...b.e, pairs: pairsOf(b.e.codes), status: 'final' }, CRITERIA_CODES) // enforces CR < 0.1
    const ref = doc(collection(db, COLLECTIONS.AHP_JUDGMENTS))
    batch.set(ref, { ...final, created_by: createdBy, updated_at: serverTimestamp(), created_at: serverTimestamp() })
    created.push(`ahp_judgments_enerlyze/${ref.id} — ${final.expert_name} (created_by: ${createdBy})`)
  }
  await batch.commit()
  console.log('\n── Batch berhasil (atomik)')
  DELETE_JUDGMENT_IDS.forEach((id) => console.log(`   ✗ [DELETE] ahp_judgments_enerlyze/${id}`))
  DELETE_DATA_IDS.forEach((id) => console.log(`   ✗ [DELETE] data_enerlyze/${id}`))
  created.forEach((c) => console.log(`   ✓ [INSERT] ${c}`))
  console.log('\n✓ Selesai. AHP TIDAK dijalankan; ahp_results_enerlyze tidak disentuh.')
  process.exit(0)
}

/** Read-only verification against the tables in this file. */
const verify = ({ areaByCode, userById, records, judgments }) => {
  let ok = true
  console.log('\n── Verifikasi data energi')
  console.log('| Bulan | Area | Record | Nilai = tabel | Pengisi = PIC |')
  console.log('|---|---|---|---|---|')
  for (const m of MONTHS) {
    for (const code of AREA_CODES) {
      const area = areaByCode[code]
      const recs = records.filter((r) => r.area_id === area.id && r.month === m)
      const r = recs[0]
      const vals = Object.fromEntries(FIELDS.map((f, i) => [f, roundHalfUp(RAW[m][code][i])]))
      const same = r && FIELDS.every((f) => Number(r[f]) === vals[f])
      const byPic = r && r.created_by === area.user_id
      if (recs.length !== 1 || !same || !byPic) ok = false
      console.log(`| ${m} | ${code} | ${recs.length} | ${same ? 'ya' : 'TIDAK'} | ${byPic ? userById[r.created_by]?.name : 'TIDAK'} |`)
    }
  }
  console.log('\n── Verifikasi narasumber')
  for (const e of EXPERTS) {
    const j = judgments.find((x) => (x.expert_name || '').trim() === e.expert_name)
    if (!j) { ok = false; console.log(`   ✗ ${e.expert_name}: tidak ditemukan`); continue }
    const re = toJudgmentFields({ ...j, status: 'draft' }, CRITERIA_CODES)
    const pairsOk = pairsOf(e.codes).every((p, i) => Math.abs(j.pairs[i].value - p.value) < 1e-12 && j.pairs[i].a === p.a && j.pairs[i].b === p.b)
    const good = pairsOk && j.status === 'final' && j.cr < CR_THRESHOLD && j.expert_position === e.expert_position && Math.abs(re.cr - j.cr) < 1e-12
    if (!good) ok = false
    console.log(`   ${good ? '✓' : '✗'} ${j.id} — ${j.expert_name} (${j.expert_position}) status=${j.status} CR=${Number(j.cr).toFixed(4)} λmax=${Number(j.lambda_max).toFixed(5)} pasangan sesuai=${pairsOk}`)
  }
  const agg = aggregateFinalJudgments(judgments, CRITERIA_CODES)
  const blocker = expertWeightsBlocker(agg)
  console.log(`\n── Kesiapan bobot: ${blocker ? `TIDAK SIAP — ${blocker}` : 'SIAP'}${agg.combined ? ` · ${agg.experts.length} final, CR gabungan ${agg.combined.cr.toFixed(4)}` : ''}`)
  console.log(`── Hasil verifikasi: ${ok ? 'SEMUA SESUAI' : 'ADA YANG TIDAK SESUAI'}`)
  process.exit(0)
}

main().catch((err) => {
  console.error('\n✗ Seed data nyata gagal:', err.message)
  process.exit(1)
})

/**
 * Run AHP for the last 3 completed months and persist results to Firestore.
 *
 *   npm run ahp           → runs the last 3 completed months
 *   npm run ahp -- 2026-02 → runs only the given month(s)
 *
 * Mirrors src/services/ahpService.runAndSaveAHP but uses a Node-initialized
 * Firebase (the app's config module reads import.meta.env, unavailable here).
 * All AHP logic comes from src/lib/ahp.js:
 *   - criteria weights from the FINAL expert judgments in `ahp_judgments_enerlyze`
 *     (geometric mean), refused when < MIN_EXPERTS or combined CR ≥ 0.1;
 *   - the stored payload is built by toAhpResultPayload() (Firestore-safe matrix).
 *
 * It overwrites any existing result for a month (deletes first, then writes).
 */
import { readFileSync } from 'node:fs'
import { initializeApp } from 'firebase/app'
import {
  getFirestore, collection, doc, getDocs, setDoc, deleteDoc,
  query, where, serverTimestamp,
} from 'firebase/firestore'
import { decryptConfig } from '../src/lib/crypto.js'
import { COLLECTIONS } from '../src/constants/collections.js'
import { CRITERIA, CRITERIA_CODES } from '../src/constants/criteria.js'
import {
  runAHP, aggregateFinalJudgments, expertWeightsBlocker, toAhpResultPayload,
} from '../src/lib/ahp.js'
import { prevMonthKey, monthKeyRange, formatMonthKey } from '../src/lib/format.js'

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

const ahpIdOf = (month) => `AHP-${month}`

const main = async () => {
  const config = decryptConfig(readSecret())
  const app = initializeApp(config)
  const db = getFirestore(app)

  const months = process.argv.slice(2).length
    ? process.argv.slice(2)
    : monthKeyRange(prevMonthKey(), 3)

  /* Criteria weights — final expert judgments, combined by geometric mean. */
  const judgSnap = await getDocs(collection(db, COLLECTIONS.AHP_JUDGMENTS))
  const judgments = judgSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
  const aggregate = aggregateFinalJudgments(judgments, CRITERIA_CODES)
  const blocker = expertWeightsBlocker(aggregate)
  if (blocker) {
    console.error(`✗ ${blocker}`)
    process.exit(1)
  }

  /* Areas — sorted by name, like areaService.getAreas() (same tie-break as the app). */
  const areaSnap = await getDocs(collection(db, COLLECTIONS.AREAS))
  const areas = areaSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))

  console.log(
    `→ Narasumber final: ${aggregate.experts.length} · CR gabungan: ${aggregate.combined.cr.toFixed(4)} · Area: ${areas.length}`,
  )
  console.log(`→ Menjalankan AHP untuk: ${months.map(formatMonthKey).join(', ')}\n`)

  let ok = 0
  for (const month of months) {
    const dataSnap = await getDocs(
      query(collection(db, COLLECTIONS.DATA), where('month', '==', month)),
    )
    const data = dataSnap.docs.map((d) => ({ id: d.id, ...d.data() }))

    const filled = new Set(data.map((d) => d.area_id))
    const missing = areas.filter((a) => !filled.has(a.id))
    if (areas.length === 0 || missing.length > 0) {
      console.log(`  ⚠ [SKIP] ${month}: data belum lengkap (${areas.length - missing.length}/${areas.length} area terisi).`)
      continue
    }

    const dataByArea = {}
    for (const row of data) dataByArea[row.area_id] = row
    const result = runAHP({
      criteria: CRITERIA,
      criteriaMatrix: aggregate.combined.matrix,
      areas,
      dataByArea,
    })

    const payload = toAhpResultPayload({
      month,
      ahpId: ahpIdOf(month),
      experts: aggregate.experts,
      result,
      createdBy: 'Seed Script',
      createdAt: serverTimestamp(),
    })

    // Overwrite cleanly: drop any half-written doc, then write fresh.
    await deleteDoc(doc(db, COLLECTIONS.AHP_RESULTS, month)).catch(() => {})
    await setDoc(doc(db, COLLECTIONS.AHP_RESULTS, month), payload)
    ok++

    console.log(`  ✓ [OK] ${month} (${ahpIdOf(month)}) — setDoc berhasil. CR=${result.consistency.cr.toFixed(4)}`)
    result.ranking.forEach((r) => {
      console.log(`        #${r.rank} ${String(r.area_name).padEnd(14)} skor=${r.score.toFixed(4)}`)
    })
    console.log('')
  }

  console.log(`✓ Selesai. AHP berhasil disimpan untuk ${ok}/${months.length} bulan.`)
  process.exit(0)
}

main().catch((err) => {
  console.error('\n✗ Run AHP gagal:', err.message)
  process.exit(1)
})

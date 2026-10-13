/**
 * Sample expert judgments — writes 3 EXAMPLE narasumber (status 'final') to
 * `ahp_judgments_enerlyze` so Run AHP can be tried end-to-end.
 *
 *   node scripts/seed-sample-judgments.mjs
 *
 * ⚠ The names and values below are illustrative sample data, NOT real expert
 * interviews. Replace them with the real judgments via Master > AHP.
 *
 * Behaviour:
 *   - Uses fixed doc ids (sample-expert-1..3) → re-running overwrites them.
 *   - Aborts when other (non-sample) judgments exist and the total would exceed
 *     MAX_EXPERTS, so real data is never pushed out or mixed beyond the limit.
 *   - Every judgment is validated with src/lib/ahp.js (CR < 0.1) before writing.
 *
 * Firebase config is read from the SECRET line in `.env` (same as seed.mjs).
 */
import { readFileSync } from 'node:fs'
import { initializeApp } from 'firebase/app'
import {
  getFirestore, collection, doc, getDocs, setDoc, serverTimestamp,
} from 'firebase/firestore'
import { decryptConfig } from '../src/lib/crypto.js'
import { COLLECTIONS } from '../src/constants/collections.js'
import { CRITERIA_CODES, MAX_EXPERTS } from '../src/constants/criteria.js'
import { toJudgmentFields, aggregateFinalJudgments, expertWeightsBlocker } from '../src/lib/ahp.js'

const readSecret = () => {
  let env
  try {
    env = readFileSync('.env', 'utf8')
  } catch {
    console.error('✗ .env file not found. Create it first (see .env.example).')
    process.exit(1)
  }
  const line = env.split(/\r?\n/).find((l) => l.trim().startsWith('SECRET='))
  if (!line) {
    console.error('✗ SECRET= not found in .env.')
    process.exit(1)
  }
  return line.slice(line.indexOf('=') + 1).trim()
}

/** Pairs for KE,BL,DO,FM from the 6 upper-triangle values (value > 1 → first is more important). */
const pairsOf = ([keBl, keDo, keFm, blDo, blFm, doFm]) => [
  { a: 'KE', b: 'BL', value: keBl },
  { a: 'KE', b: 'DO', value: keDo },
  { a: 'KE', b: 'FM', value: keFm },
  { a: 'BL', b: 'DO', value: blDo },
  { a: 'BL', b: 'FM', value: blFm },
  { a: 'DO', b: 'FM', value: doFm },
]

// Same values as tests/ahp.test.js (case e). Individual CR ≈ 0.018 / 0.021 / 0.021;
// combined (geometric mean) CR ≈ 0.003, weights KE 0.446 · BL 0.333 · DO 0.119 · FM 0.102.
const SAMPLES = [
  { id: 'sample-expert-1', expert_name: 'Contoh Narasumber 1', expert_position: 'Chief Engineer',
    pairs: pairsOf([2, 4, 5, 3, 4, 2]) },
  { id: 'sample-expert-2', expert_name: 'Contoh Narasumber 2', expert_position: 'Energy Officer',
    pairs: pairsOf([3, 5, 4, 2, 2, 1 / 2]) },
  { id: 'sample-expert-3', expert_name: 'Contoh Narasumber 3', expert_position: 'Building Manager',
    pairs: pairsOf([1 / 2, 3, 3, 4, 5, 2]) },
]

const main = async () => {
  // Validate before touching Firestore (throws when CR ≥ 0.1).
  const docs = SAMPLES.map((s) => ({ id: s.id, ...toJudgmentFields({ ...s, status: 'final' }, CRITERIA_CODES) }))
  const aggregate = aggregateFinalJudgments(docs, CRITERIA_CODES)
  const blocker = expertWeightsBlocker(aggregate)
  if (blocker) throw new Error(`Data contoh tidak valid: ${blocker}`)

  const config = decryptConfig(readSecret())
  const app = initializeApp(config)
  const db = getFirestore(app)
  const col = collection(db, COLLECTIONS.AHP_JUDGMENTS)

  const existing = await getDocs(col)
  const sampleIds = new Set(SAMPLES.map((s) => s.id))
  const others = existing.docs.filter((d) => !sampleIds.has(d.id))
  if (others.length + SAMPLES.length > MAX_EXPERTS) {
    console.error(
      `✗ Sudah ada ${others.length} narasumber lain; menambah ${SAMPLES.length} contoh melebihi batas ${MAX_EXPERTS}. Dibatalkan.`,
    )
    process.exit(1)
  }

  for (const d of docs) {
    const { id, ...fields } = d
    await setDoc(doc(db, COLLECTIONS.AHP_JUDGMENTS, id), {
      ...fields,
      created_by: 'Seed Script',
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    })
    console.log(`  ✓ ${fields.expert_name} (${fields.expert_position}) — CR=${fields.cr.toFixed(4)}`)
  }
  console.log(
    `\n✓ Selesai. CR gabungan=${aggregate.combined.cr.toFixed(4)} · bobot ${CRITERIA_CODES.map((c, i) => `${c}=${aggregate.combined.weights[i].toFixed(3)}`).join(', ')}`,
  )
  process.exit(0)
}

main().catch((err) => {
  console.error('\n✗ Seed contoh narasumber gagal:', err.message)
  process.exit(1)
})

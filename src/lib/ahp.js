/**
 * Analytical Hierarchy Process (AHP) engine for Enerlyze.
 *
 * Goal: rank mall areas by how badly they need energy optimisation.
 * A higher final score = a more wasteful / higher-priority area.
 *
 * Pipeline:
 *   1. Criteria pairwise matrix      ← expert judgments (Saaty 1/9..9), one per
 *                                       narasumber, combined by geometric mean
 *   2. Criteria weights              ← eigenvector (normalised row averages)
 *   3. Consistency Ratio (CR)        ← λmax → CI → CR (RI = 0.90 for n=4)
 *   4. Alternative local priorities  ← per-criterion, from monthly input data
 *   5. Final score per area          ← Σ (criterion weight × local priority)
 */
import { RANDOM_INDEX, CR_THRESHOLD, MIN_EXPERTS, MAX_EXPERTS } from '../constants/criteria.js'

/** Where the criteria weights of an AHP result came from. */
export const WEIGHT_SOURCE_EXPERT = 'expert_pairwise'

/* ─────────────────────────── Saaty scale (1/9..9) ─────────────────────────── */

/** Every valid pairwise value: 1/9 … 1/2, 1, 2 … 9. */
export const SAATY_VALUES = [
  ...[9, 8, 7, 6, 5, 4, 3, 2].map((v) => 1 / v),
  1,
  2, 3, 4, 5, 6, 7, 8, 9,
]

const EPS = 1e-9

/** True when `v` is one of the 17 Saaty scale values (float-tolerant for 1/x). */
export const isSaatyValue = (v) =>
  typeof v === 'number' && Number.isFinite(v) && SAATY_VALUES.some((s) => Math.abs(s - v) < EPS)

/** The Saaty scale value closest to `v` (compared on a log scale). */
export const nearestSaatyValue = (v) => {
  if (!(v > 0)) return 1
  let best = 1
  for (const s of SAATY_VALUES) {
    if (Math.abs(Math.log(s) - Math.log(v)) < Math.abs(Math.log(best) - Math.log(v))) best = s
  }
  return best
}

/** All criterion pairs (i < j) in matrix order, e.g. KE–BL, KE–DO, … DO–FM. */
export const criterionPairs = (codes) => {
  const pairs = []
  for (let i = 0; i < codes.length; i++)
    for (let j = i + 1; j < codes.length; j++) pairs.push({ a: codes[i], b: codes[j] })
  return pairs
}

/**
 * Build the n×n reciprocal matrix from one value per pair.
 *
 * @param {string[]} criteriaCodes  matrix order, e.g. ['KE', 'BL', 'DO', 'FM']
 * @param {Array}    pairs          [{ a, b, value }] — "a compared with b".
 *   value > 1 → a is more important than b; value < 1 → b is more important.
 *   A pair may be given in either orientation (b, a); it is inverted as needed.
 * @throws when a pair is missing, duplicated, unknown, or not a Saaty value.
 */
export const buildMatrixFromPairs = (criteriaCodes, pairs = []) => {
  const n = criteriaCodes.length
  const index = Object.fromEntries(criteriaCodes.map((c, i) => [c, i]))
  const matrix = Array.from({ length: n }, () => Array(n).fill(1))
  const seen = new Set()

  for (const p of pairs) {
    const i = index[p?.a]
    const j = index[p?.b]
    if (i === undefined || j === undefined || i === j) {
      throw new Error(`Pasangan kriteria tidak valid: ${p?.a} – ${p?.b}.`)
    }
    const value = Number(p.value)
    if (!isSaatyValue(value)) {
      throw new Error(`Nilai ${p.a} – ${p.b} harus pada skala Saaty 1/9..9.`)
    }
    const [lo, hi, v] = i < j ? [i, j, value] : [j, i, 1 / value]
    const key = `${lo}-${hi}`
    if (seen.has(key)) throw new Error(`Pasangan ${p.a} – ${p.b} diisi lebih dari sekali.`)
    seen.add(key)
    matrix[lo][hi] = v
    matrix[hi][lo] = 1 / v
  }

  const expected = (n * (n - 1)) / 2
  if (seen.size !== expected) {
    throw new Error(`Perbandingan belum lengkap: ${seen.size} dari ${expected} pasangan terisi.`)
  }
  return matrix
}

/**
 * Element-wise geometric mean of several pairwise matrices (aggregation of
 * individual judgments, AIJ). The upper triangle is averaged and the lower
 * triangle set to its exact reciprocal, so the result stays reciprocal.
 */
export const geometricMeanMatrix = (matrices = []) => {
  if (!matrices.length) return []
  const n = matrices[0].length
  if (matrices.some((m) => m.length !== n)) throw new Error('Ukuran matriks narasumber berbeda.')
  const k = matrices.length
  const out = Array.from({ length: n }, () => Array(n).fill(1))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Mean of logs = log of the geometric mean (avoids overflow on products).
      const logSum = matrices.reduce((acc, m) => acc + Math.log(m[i][j]), 0)
      out[i][j] = Math.exp(logSum / k)
      out[j][i] = 1 / out[i][j]
    }
  }
  return out
}

/* ─────────────────────────── Matrix serialisation ─────────────────────────── */

/**
 * Firestore does not support nested arrays (array of arrays). A 2D matrix is
 * serialized into a map-of-rows shape before persisting, and restored on read.
 *   [[1, 0.5], [2, 1]]  <->  { rows: [{ cells: [1, 0.5] }, { cells: [2, 1] }] }
 */
export const serializeMatrix = (matrix2D = []) => ({
  rows: (matrix2D || []).map((row) => ({ cells: [...row] })),
})

/** Restore a 2D matrix from the stored shape (tolerates legacy raw 2D arrays). */
export const deserializeMatrix = (stored) => {
  if (!stored) return []
  if (Array.isArray(stored)) return stored // legacy: persisted as a raw 2D array
  if (Array.isArray(stored.rows)) return stored.rows.map((r) => r?.cells ?? [])
  return []
}

/* ───────────────────── Legacy rank-based matrix (deprecated) ───────────────────── */

/**
 * @deprecated Weights now come from expert pairwise judgments. Kept only so old
 * reports (`ahp_results_enerlyze` written before `weight_source` existed) can
 * still be rendered. Do not use for new calculations.
 *
 * Map a rank difference to a Saaty intensity.
 * diff 0 → 1 (equal), 1 → 3, 2 → 5, 3 → 7  (clamped to the 1–9 scale).
 */
export const saatyFromRankDiff = (diff) => {
  const abs = Math.abs(diff)
  const value = 1 + abs * 2
  return Math.min(9, value)
}

/**
 * @deprecated See saatyFromRankDiff. Builds the old n×n criteria matrix from
 * criteria ranks; only used to render legacy reports that lack a stored matrix.
 */
export const buildCriteriaMatrix = (criteria) => {
  const n = criteria.length
  const matrix = Array.from({ length: n }, () => Array(n).fill(1))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        matrix[i][j] = 1
        continue
      }
      // Smaller rank = higher priority. If criterion i outranks j, i dominates.
      const diff = criteria[j].rank - criteria[i].rank
      const saaty = saatyFromRankDiff(diff)
      matrix[i][j] = diff >= 0 ? saaty : 1 / saaty
    }
  }
  return matrix
}

/* ──────────────────────── Weights & consistency ──────────────────────── */

/** Priority vector (eigenvector approx.) via column-normalisation + row average. */
export const priorityVector = (matrix) => {
  const n = matrix.length
  const colSums = Array(n).fill(0)
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) colSums[j] += matrix[i][j]

  const weights = Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    let rowSum = 0
    for (let j = 0; j < n; j++) rowSum += matrix[i][j] / colSums[j]
    weights[i] = rowSum / n
  }
  return weights
}

/** Consistency metrics for a pairwise matrix given its priority vector. */
export const consistency = (matrix, weights) => {
  const n = matrix.length
  if (n < 3) return { lambdaMax: n, ci: 0, cr: 0 } // n<3 is always consistent

  // Weighted-sum vector = matrix · weights
  const weightedSum = matrix.map((row) =>
    row.reduce((acc, val, j) => acc + val * weights[j], 0),
  )
  const lambdas = weightedSum.map((ws, i) => ws / weights[i])
  const lambdaMax = lambdas.reduce((a, b) => a + b, 0) / n
  const ci = (lambdaMax - n) / (n - 1)
  const ri = RANDOM_INDEX[n] ?? 1.12
  const cr = ri === 0 ? 0 : ci / ri
  return { lambdaMax, ci, cr }
}

/** Weights + consistency of one pairwise matrix. */
export const analyzeMatrix = (matrix) => {
  const weights = priorityVector(matrix)
  const { lambdaMax, ci, cr } = consistency(matrix, weights)
  return { matrix, weights, lambdaMax, ci, cr, isConsistent: cr < CR_THRESHOLD }
}

/**
 * Pairs ordered from least to most consistent, to hint which judgment to revise
 * when CR ≥ 0.1. For each pair (i < j) the judgment a_ij is compared with the
 * ratio implied by the weights, w_i / w_j. Deviation is measured on a log scale
 * (|ln a_ij − ln(w_i/w_j)|) so 1/3-vs-3 and 3-vs-1/3 count equally.
 *
 * @returns [{ a, b, i, j, value, implied, suggested, deviation }] — worst first.
 *   `suggested` is the Saaty value closest to `implied`.
 */
export const inconsistentPairs = (matrix, weights, codes) => {
  const out = []
  const n = matrix.length
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const implied = weights[i] / weights[j]
      out.push({
        a: codes?.[i] ?? i,
        b: codes?.[j] ?? j,
        i,
        j,
        value: matrix[i][j],
        implied,
        suggested: nearestSaatyValue(implied),
        deviation: Math.abs(Math.log(matrix[i][j]) - Math.log(implied)),
      })
    }
  }
  return out.sort((x, y) => y.deviation - x.deviation)
}

/* ───────────────────────── Expert judgments ───────────────────────── */

/** Matrix + weights + CR of one expert's pairs. */
export const analyzeJudgment = (criteriaCodes, pairs) =>
  analyzeMatrix(buildMatrixFromPairs(criteriaCodes, pairs))

/**
 * Validated, derived fields of an `ahp_judgments_enerlyze` document (without
 * created_by / timestamps). Shared by ahpJudgmentService and the seed script.
 * @throws on missing name/position, invalid pairs, or 'final' with CR ≥ 0.1.
 */
export const toJudgmentFields = (
  { expert_name, expert_position, pairs, status },
  criteriaCodes,
) => {
  const name = (expert_name || '').trim()
  const position = (expert_position || '').trim()
  if (!name) throw new Error('Nama narasumber wajib diisi.')
  if (!position) throw new Error('Jabatan narasumber wajib diisi.')
  if (status !== 'draft' && status !== 'final') throw new Error('Status penilaian tidak valid.')

  const cleanPairs = (pairs || []).map((p) => ({ a: p.a, b: p.b, value: Number(p.value) }))
  const a = analyzeJudgment(criteriaCodes, cleanPairs)
  if (status === 'final' && !a.isConsistent) {
    throw new Error(
      `CR ${a.cr.toFixed(3)} ≥ ${CR_THRESHOLD}: penilaian hanya dapat disimpan sebagai draft.`,
    )
  }

  return {
    expert_name: name,
    expert_position: position,
    criteria_codes: [...criteriaCodes],
    pairs: cleanPairs, // flat objects — Firestore-safe
    matrix: serializeMatrix(a.matrix),
    weights: a.weights,
    lambda_max: a.lambdaMax,
    ci: a.ci,
    cr: a.cr,
    status,
  }
}

/**
 * Combine the FINAL expert judgments into one criteria matrix.
 *
 * @param {Array}    judgments      judgment docs ({ id, expert_name, expert_position, pairs, status })
 * @param {string[]} criteriaCodes  matrix order
 * @returns {{ experts: Array, combined: Object|null }}
 *   `experts` — final judgments with their own recomputed CR / weights.
 *   `combined` — analyzeMatrix() of the geometric-mean matrix, or null when no
 *   final judgment exists.
 */
export const aggregateFinalJudgments = (judgments = [], criteriaCodes) => {
  const experts = judgments
    .filter((j) => j.status === 'final')
    .map((j) => {
      const a = analyzeJudgment(criteriaCodes, j.pairs)
      return {
        id: j.id ?? null,
        expert_name: j.expert_name || '',
        expert_position: j.expert_position || '',
        matrix: a.matrix,
        weights: a.weights,
        cr: a.cr,
      }
    })
  const combined = experts.length
    ? analyzeMatrix(geometricMeanMatrix(experts.map((e) => e.matrix)))
    : null
  return { experts, combined }
}

/**
 * Reason why AHP may not run with this aggregate, or null when it may.
 * Messages point the admin to Master > AHP, where judgments are managed.
 */
export const expertWeightsBlocker = (
  { experts, combined },
  { min = MIN_EXPERTS, max = MAX_EXPERTS } = {},
) => {
  if (experts.length < min) {
    return `Run AHP ditolak: baru ${experts.length} narasumber berstatus final (minimal ${min}). Lengkapi penilaian di menu Master > AHP.`
  }
  if (experts.length > max) {
    return `Run AHP ditolak: terdapat ${experts.length} narasumber final (maksimal ${max}). Hapus narasumber berlebih di menu Master > AHP.`
  }
  if (!combined.isConsistent) {
    return `Run AHP ditolak: CR gabungan ${combined.cr.toFixed(3)} ≥ ${CR_THRESHOLD}. Tinjau ulang penilaian narasumber di menu Master > AHP.`
  }
  return null
}

/* ─────────────────────────── Alternatives & run ─────────────────────────── */

/**
 * Per-criterion "priority value" for one area's raw input.
 * For benefit-of-priority criteria a higher value → higher pv.
 * Maintenance is inverted: a lower frequency → higher pv (less cared for).
 */
const priorityValue = (rawValue, higherIsWorse) => {
  const v = Number(rawValue) || 0
  if (higherIsWorse) return v
  return 1 / (v > 0 ? v : 0.5)
}

/**
 * Run the full AHP analysis.
 *
 * @param {Array}  criteria        [{ key, code, name, higherIsWorse }] in matrix order
 * @param {Array}  criteriaMatrix  n×n pairwise matrix (e.g. the expert geometric mean)
 * @param {Array}  areas           [{ id, name, description }]
 * @param {Object} dataByArea      { [areaId]: { energy, cost, duration, maintenance } }
 * @returns full result object ready to persist in `ahp_results_enerlyze`.
 */
export const runAHP = ({ criteria, criteriaMatrix, areas, dataByArea }) => {
  if (!Array.isArray(criteriaMatrix) || criteriaMatrix.length !== criteria.length) {
    throw new Error('Matriks kriteria tidak sesuai dengan jumlah kriteria.')
  }

  // ── 1 & 2: criteria weights from the given matrix ────────────────────────
  const { weights: criteriaWeights, lambdaMax, ci, cr, isConsistent } = analyzeMatrix(criteriaMatrix)

  const weightByKey = {}
  criteria.forEach((c, i) => (weightByKey[c.key] = criteriaWeights[i]))

  // ── 4: local priorities of each area per criterion ───────────────────────
  // localPriority[criterionKey][areaId]
  const localPriority = {}
  for (const c of criteria) {
    const pvByArea = {}
    let total = 0
    for (const area of areas) {
      const raw = dataByArea[area.id]?.[c.key]
      const pv = priorityValue(raw, c.higherIsWorse)
      pvByArea[area.id] = pv
      total += pv
    }
    localPriority[c.key] = {}
    for (const area of areas) {
      localPriority[c.key][area.id] =
        total > 0 ? pvByArea[area.id] / total : 1 / areas.length
    }
  }

  // ── 5: final score + per-criterion contribution breakdown ────────────────
  const results = areas.map((area) => {
    const breakdown = {}
    let score = 0
    for (const c of criteria) {
      const contribution = weightByKey[c.key] * localPriority[c.key][area.id]
      breakdown[c.key] = contribution
      score += contribution
    }
    return {
      area_id: area.id,
      area_name: area.name,
      area_description: area.description || '',
      score,
      breakdown,
    }
  })

  results.sort((a, b) => b.score - a.score)
  results.forEach((r, i) => (r.rank = i + 1))

  return {
    criteria: criteria.map((c) => ({
      key: c.key,
      code: c.code,
      name: c.name,
      weight: weightByKey[c.key],
    })),
    criteriaMatrix,
    criteriaWeights,
    consistency: { lambdaMax, ci, cr, isConsistent },
    ranking: results,
  }
}

/**
 * Firestore payload for `ahp_results_enerlyze` (doc id = month). Shared by the
 * app (ahpService) and scripts/run-ahp.mjs so both persist the same shape.
 * `createdAt` is passed in (serverTimestamp()) to keep this module Firebase-free.
 */
export const toAhpResultPayload = ({ month, ahpId, experts, result, createdBy, createdAt }) => ({
  month,
  ahp_id: ahpId,
  weight_source: WEIGHT_SOURCE_EXPERT,
  experts: experts.map((e) => ({
    id: e.id,
    expert_name: e.expert_name,
    expert_position: e.expert_position,
    cr: e.cr,
  })),
  criteria: result.criteria,
  criteria_matrix: serializeMatrix(result.criteriaMatrix),
  criteria_weights: result.criteriaWeights,
  consistency: result.consistency,
  ranking: result.ranking,
  created_by: createdBy,
  created_at: createdAt,
})

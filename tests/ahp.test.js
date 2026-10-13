/**
 * Unit tests for the pure AHP engine (src/lib/ahp.js). No Firebase involved.
 *   npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMatrixFromPairs, geometricMeanMatrix, analyzeMatrix, analyzeJudgment,
  inconsistentPairs, aggregateFinalJudgments, expertWeightsBlocker,
  buildCriteriaMatrix, isSaatyValue, runAHP, toJudgmentFields,
} from '../src/lib/ahp.js'
import { CRITERIA, CRITERIA_CODES } from '../src/constants/criteria.js'

const TOL = 1e-4
const near = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) < TOL, `${msg ?? ''} expected ${expected}, got ${actual}`)

const assertReciprocal = (m) => {
  for (let i = 0; i < m.length; i++) {
    assert.equal(m[i][i], 1, `diagonal [${i}][${i}]`)
    for (let j = 0; j < m.length; j++) near(m[i][j] * m[j][i], 1, `a[${i}][${j}]·a[${j}][${i}]`)
  }
}

/** Pairs [{a, b, value}] for KE,BL,DO,FM from the 6 upper-triangle values. */
const pairsOf = ([keBl, keDo, keFm, blDo, blFm, doFm]) => [
  { a: 'KE', b: 'BL', value: keBl },
  { a: 'KE', b: 'DO', value: keDo },
  { a: 'KE', b: 'FM', value: keFm },
  { a: 'BL', b: 'DO', value: blDo },
  { a: 'BL', b: 'FM', value: blFm },
  { a: 'DO', b: 'FM', value: doFm },
]

// Same values as scripts/seed-sample-judgments.mjs.
const SAMPLE = [
  pairsOf([2, 4, 5, 3, 4, 2]),
  pairsOf([3, 5, 4, 2, 2, 1 / 2]),
  pairsOf([1 / 2, 3, 3, 4, 5, 2]),
]

test('a. regression: old rank matrix [1,2,3,4] through the new path', () => {
  const pairs = pairsOf([3, 5, 7, 3, 5, 3])
  const m = buildMatrixFromPairs(CRITERIA_CODES, pairs)
  const expected = [
    [1, 3, 5, 7],
    [1 / 3, 1, 3, 5],
    [1 / 5, 1 / 3, 1, 3],
    [1 / 7, 1 / 5, 1 / 3, 1],
  ]
  m.forEach((row, i) => row.forEach((v, j) => near(v, expected[i][j], `cell ${i},${j}`)))

  // Identical to the deprecated rank-based builder.
  const legacy = buildCriteriaMatrix(CRITERIA.map((c) => ({ ...c, rank: c.defaultRank })))
  m.forEach((row, i) => row.forEach((v, j) => near(v, legacy[i][j], `legacy ${i},${j}`)))

  const a = analyzeMatrix(m)
  ;[0.55789, 0.26335, 0.12187, 0.05689].forEach((w, i) => near(a.weights[i], w, `w${i}`))
  near(a.lambdaMax, 4.11847, 'lambdaMax')
  near(a.ci, 0.03949, 'CI')
  near(a.cr, 0.04388, 'CR')
  assert.equal(a.isConsistent, true)
})

test('b. buildMatrixFromPairs: reciprocal, diagonal 1, either orientation', () => {
  const m = buildMatrixFromPairs(CRITERIA_CODES, pairsOf([2, 1 / 4, 9, 1, 1 / 9, 6]))
  assertReciprocal(m)
  near(m[0][2], 1 / 4)
  near(m[2][0], 4)

  // Pair given as (FM, KE) is inverted into the upper triangle.
  const flipped = pairsOf([2, 1 / 4, 9, 1, 1 / 9, 6])
  flipped[2] = { a: 'FM', b: 'KE', value: 1 / 9 }
  assert.deepEqual(buildMatrixFromPairs(CRITERIA_CODES, flipped), m)
})

test('b. buildMatrixFromPairs: rejects invalid input', () => {
  const ok = pairsOf([1, 1, 1, 1, 1, 1])
  assert.throws(() => buildMatrixFromPairs(CRITERIA_CODES, ok.slice(0, 5)), /belum lengkap/)
  assert.throws(() => buildMatrixFromPairs(CRITERIA_CODES, [...ok, ok[0]]), /lebih dari sekali/)
  for (const bad of [0, 10, 1 / 10, 2.5, -3, NaN]) {
    assert.throws(() => buildMatrixFromPairs(CRITERIA_CODES, pairsOf([bad, 1, 1, 1, 1, 1])), /skala Saaty/)
  }
  assert.throws(
    () => buildMatrixFromPairs(CRITERIA_CODES, [{ a: 'KE', b: 'XX', value: 1 }, ...ok.slice(1)]),
    /tidak valid/,
  )
  assert.ok(isSaatyValue(1 / 3) && isSaatyValue(9) && !isSaatyValue(1.5))
})

test('c. geometricMeanMatrix: 2 and 3 matrices, reciprocal result', () => {
  const [m1, m2, m3] = SAMPLE.map((p) => buildMatrixFromPairs(CRITERIA_CODES, p))

  const g2 = geometricMeanMatrix([m1, m2])
  assertReciprocal(g2)
  near(g2[0][1], Math.sqrt(2 * 3), 'KE–BL of 2 experts')
  near(g2[2][3], Math.sqrt(2 * 0.5), 'DO–FM of 2 experts')

  const g3 = geometricMeanMatrix([m1, m2, m3])
  assertReciprocal(g3)
  near(g3[0][1], Math.cbrt(2 * 3 * 0.5), 'KE–BL of 3 experts')
  near(g3[1][3], Math.cbrt(4 * 2 * 5), 'BL–FM of 3 experts')

  // One matrix → itself.
  geometricMeanMatrix([m1]).forEach((row, i) => row.forEach((v, j) => near(v, m1[i][j])))
})

test('d. inconsistent matrix → CR ≥ 0.1 and the culprit pair is reported first', () => {
  // Perfectly consistent from weights 8:4:2:1 …
  const consistent = analyzeJudgment(CRITERIA_CODES, pairsOf([2, 4, 8, 2, 4, 2]))
  near(consistent.cr, 0, 'consistent CR')

  // … then KE–FM is reversed (8 → 1/8).
  const bad = analyzeJudgment(CRITERIA_CODES, pairsOf([2, 4, 1 / 8, 2, 4, 2]))
  assert.ok(bad.cr >= 0.1, `CR should be ≥ 0.1, got ${bad.cr}`)
  assert.equal(bad.isConsistent, false)

  const worst = inconsistentPairs(bad.matrix, bad.weights, CRITERIA_CODES)
  assert.equal(worst.length, 6)
  assert.deepEqual([worst[0].a, worst[0].b], ['KE', 'FM'])
  // The suggestion moves the judgment away from 1/8, back toward KE.
  assert.ok(worst[0].suggested > worst[0].value, 'suggestion points back toward KE')
  for (let k = 1; k < worst.length; k++) assert.ok(worst[k - 1].deviation >= worst[k].deviation)
})

test('e. 3 valid experts → combined CR computed on the geometric-mean matrix', () => {
  const judgments = SAMPLE.map((pairs, i) => ({
    id: `e${i + 1}`, expert_name: `Narasumber ${i + 1}`, expert_position: 'Contoh', pairs, status: 'final',
  }))
  judgments.forEach((j) => assert.ok(analyzeJudgment(CRITERIA_CODES, j.pairs).cr < 0.1, j.id))

  // Drafts are ignored.
  const withDraft = [...judgments, { id: 'd', pairs: pairsOf([9, 9, 9, 9, 9, 9]), status: 'draft' }]
  const { experts, combined } = aggregateFinalJudgments(withDraft, CRITERIA_CODES)
  assert.equal(experts.length, 3)

  // Independent recomputation of the combined matrix + metrics.
  const ms = SAMPLE.map((p) => buildMatrixFromPairs(CRITERIA_CODES, p))
  const n = 4
  const g = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => Math.cbrt(ms[0][i][j] * ms[1][i][j] * ms[2][i][j])))
  const colSum = g[0].map((_, j) => g.reduce((s, r) => s + r[j], 0))
  const w = g.map((r) => r.reduce((s, v, j) => s + v / colSum[j], 0) / n)
  const lambdaMax = g.reduce((s, r, i) => s + r.reduce((t, v, j) => t + v * w[j], 0) / w[i], 0) / n
  const cr = (lambdaMax - n) / (n - 1) / 0.9

  w.forEach((x, i) => near(combined.weights[i], x, `combined w${i}`))
  near(combined.weights.reduce((a, b) => a + b, 0), 1, 'weights sum')
  near(combined.lambdaMax, lambdaMax, 'combined lambdaMax')
  near(combined.cr, cr, 'combined CR')
  assert.ok(combined.cr < 0.1)
  assert.equal(expertWeightsBlocker({ experts, combined }), null)
})

test('expertWeightsBlocker: too few final experts / inconsistent combination', () => {
  const one = aggregateFinalJudgments([{ pairs: SAMPLE[0], status: 'final' }], CRITERIA_CODES)
  assert.match(expertWeightsBlocker(one), /minimal 2.*Master > AHP/)

  const bad = pairsOf([2, 4, 1 / 8, 2, 4, 2])
  const twoBad = aggregateFinalJudgments(
    [{ pairs: bad, status: 'final' }, { pairs: bad, status: 'final' }], CRITERIA_CODES,
  )
  assert.match(expertWeightsBlocker(twoBad), /CR gabungan.*Master > AHP/)
})

test('toJudgmentFields: final only when CR < 0.1, draft always allowed', () => {
  const base = { expert_name: ' Ahli ', expert_position: 'Engineer' }
  const bad = pairsOf([2, 4, 1 / 8, 2, 4, 2])
  assert.throws(() => toJudgmentFields({ ...base, pairs: bad, status: 'final' }, CRITERIA_CODES), /draft/)

  const draft = toJudgmentFields({ ...base, pairs: bad, status: 'draft' }, CRITERIA_CODES)
  assert.equal(draft.status, 'draft')
  assert.equal(draft.expert_name, 'Ahli')
  assert.ok(draft.cr >= 0.1)
  // Firestore-safe: matrix as { rows: [{ cells }] }, no nested arrays anywhere.
  assert.equal(draft.matrix.rows.length, 4)
  assert.ok(!Object.values(draft).some((v) => Array.isArray(v) && v.some(Array.isArray)))

  assert.equal(toJudgmentFields({ ...base, pairs: SAMPLE[0], status: 'final' }, CRITERIA_CODES).status, 'final')
  assert.throws(() => toJudgmentFields({ ...base, expert_name: ' ', pairs: SAMPLE[0], status: 'final' }, CRITERIA_CODES), /Nama/)
})

test('runAHP: uses the given matrix; local priorities & score unchanged', () => {
  const areas = [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }]
  const dataByArea = {
    A: { energy: 300, cost: 100, duration: 10, maintenance: 1 },
    B: { energy: 100, cost: 100, duration: 30, maintenance: 4 },
  }
  const m = buildMatrixFromPairs(CRITERIA_CODES, pairsOf([3, 5, 7, 3, 5, 3]))
  const r = runAHP({ criteria: CRITERIA, criteriaMatrix: m, areas, dataByArea })
  const [wKE, wBL, wDO, wFM] = r.criteriaWeights
  // A: KE 0.75, BL 0.5, DO 0.25, FM (1/1)/(1/1+1/4) = 0.8
  near(r.ranking.find((x) => x.area_id === 'A').score, wKE * 0.75 + wBL * 0.5 + wDO * 0.25 + wFM * 0.8)
  near(r.ranking.reduce((s, x) => s + x.score, 0), 1, 'scores sum to 1')
  assert.equal(r.ranking[0].rank, 1)
  assert.throws(() => runAHP({ criteria: CRITERIA, criteriaMatrix: [[1]], areas, dataByArea }), /tidak sesuai/)
})

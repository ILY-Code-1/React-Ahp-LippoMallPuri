import {
  collection, doc, getDoc, getDocs, setDoc, deleteDoc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../config/firebase'
import { COLLECTIONS } from '../constants/collections'
import { CRITERIA } from '../constants/criteria'
import { runAHP, expertWeightsBlocker, toAhpResultPayload } from '../lib/ahp'
import { getAggregatedJudgments } from './ahpJudgmentService'
import { getAreas } from './areaService'
import { getDataByMonth } from './dataService'

const col = collection(db, COLLECTIONS.AHP_RESULTS)

/** `error.code` of a refused Run AHP (the message is meant for the admin). */
export const AHP_RUN_REJECTED = 'ahp/run-rejected'

/** Human-readable AHP id, e.g. month "2026-04" → "AHP-2026-04". */
export const ahpIdOf = (month) => `AHP-${month}`

/** The stored AHP result for a month, or null if it has not been run. */
export const getAhpResult = async (month) => {
  const snap = await getDoc(doc(db, COLLECTIONS.AHP_RESULTS, month))
  return snap.exists() ? { id: snap.id, ...snap.data() } : null
}

/** All AHP results (for the dashboard chart). */
export const getAllAhpResults = async () => {
  const snap = await getDocs(col)
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

/**
 * Check how complete a month is: which registered areas still miss input.
 * @returns { areas, data, missing: Area[], complete: boolean }
 */
export const getMonthCompleteness = async (month) => {
  const [areas, data] = await Promise.all([getAreas(), getDataByMonth(month)])
  const filledAreaIds = new Set(data.map((d) => d.area_id))
  const missing = areas.filter((a) => !filledAreaIds.has(a.id))
  return { areas, data, missing, complete: areas.length > 0 && missing.length === 0 }
}

/** Error for a Run AHP request that is refused (preconditions not met). */
const rejected = (message) => Object.assign(new Error(message), { code: AHP_RUN_REJECTED })

/**
 * Run AHP for `month` and persist the result (doc id = month).
 * Re-running simply overwrites the previous result.
 *
 * Criteria weights come from the FINAL expert judgments (Master > AHP),
 * combined by geometric mean. Refused (error.code === AHP_RUN_REJECTED) when
 * there are too few final experts, the combined CR ≥ 0.1, or areas lack data.
 */
export const runAndSaveAHP = async (month, createdBy) => {
  const aggregate = await getAggregatedJudgments()
  const blocker = expertWeightsBlocker(aggregate)
  if (blocker) throw rejected(blocker)

  const { areas, data, complete } = await getMonthCompleteness(month)
  if (!complete) {
    throw rejected('Data belum lengkap di semua area untuk bulan ini.')
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
    createdBy: createdBy?.name || createdBy?.email || 'Admin',
    createdAt: serverTimestamp(),
  })
  await setDoc(doc(db, COLLECTIONS.AHP_RESULTS, month), payload)
  return payload
}

/** Delete only the AHP result for a month — input data is left untouched. */
export const deleteAhpResult = async (month) => {
  await deleteDoc(doc(db, COLLECTIONS.AHP_RESULTS, month))
}

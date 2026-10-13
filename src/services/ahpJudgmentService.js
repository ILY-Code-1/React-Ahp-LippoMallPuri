import {
  collection, doc, getDocs, addDoc, updateDoc, deleteDoc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../config/firebase'
import { COLLECTIONS } from '../constants/collections'
import { CRITERIA_CODES, MAX_EXPERTS } from '../constants/criteria'
import { aggregateFinalJudgments, toJudgmentFields } from '../lib/ahp'

/**
 * Expert (narasumber) pairwise judgments for the AHP criteria — one document
 * per expert in `ahp_judgments_enerlyze`. Weights are global (not per month).
 *
 * Doc shape:
 *   { expert_name, expert_position, criteria_codes, pairs: [{ a, b, value }],
 *     matrix: { rows: [{ cells }] }, weights, lambda_max, ci, cr,
 *     status: 'draft' | 'final', created_by, created_at, updated_at }
 *
 * `pairs` is the source of truth; matrix/weights/CR are derived and stored for
 * display. A judgment can only be 'final' when its CR < 0.1.
 */
const col = collection(db, COLLECTIONS.AHP_JUDGMENTS)

const mapDocs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }))

/** All judgments, ordered by expert name. */
export const getJudgments = async () =>
  mapDocs(await getDocs(col)).sort((a, b) =>
    (a.expert_name || '').localeCompare(b.expert_name || ''),
  )

/**
 * Final judgments combined by geometric mean.
 * @returns {{ experts, combined }} — see aggregateFinalJudgments().
 */
export const getAggregatedJudgments = async () =>
  aggregateFinalJudgments(await getJudgments(), CRITERIA_CODES)

/** Validate + derive the stored fields from the submitted form (throws on invalid input). */
const buildPayload = (form, user) => ({
  ...toJudgmentFields(form, CRITERIA_CODES),
  created_by: user?.name || user?.email || 'Admin',
  updated_at: serverTimestamp(),
})

export const createJudgment = async (form, user) => {
  const payload = buildPayload(form, user)
  const existing = await getDocs(col)
  if (existing.size >= MAX_EXPERTS) {
    throw new Error(`Maksimal ${MAX_EXPERTS} narasumber. Hapus salah satu terlebih dahulu.`)
  }
  const ref = await addDoc(col, { ...payload, created_at: serverTimestamp() })
  return ref.id
}

export const updateJudgment = async (id, form, user) => {
  await updateDoc(doc(db, COLLECTIONS.AHP_JUDGMENTS, id), buildPayload(form, user))
}

/** Delete one expert's judgment. Stored AHP results keep their own snapshot. */
export const deleteJudgment = async (id) => {
  await deleteDoc(doc(db, COLLECTIONS.AHP_JUDGMENTS, id))
}

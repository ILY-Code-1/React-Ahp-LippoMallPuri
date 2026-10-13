import {
  collection, doc, getDocs, writeBatch,
} from 'firebase/firestore'
import { db } from '../config/firebase'
import { COLLECTIONS } from '../constants/collections'
import { CRITERIA } from '../constants/criteria'

/*
 * LEGACY. Criteria ranks no longer drive the AHP weights — those come from
 * expert pairwise judgments (see ahpJudgmentService). Nothing in the app calls
 * these functions anymore; they are kept (and `criteria_enerlyze` is left
 * untouched) only for old data / `npm run seed`.
 */
const col = collection(db, COLLECTIONS.CRITERIA)

/** Merge a stored criterion doc with its fixed metadata from constants. */
const hydrate = (stored) => {
  const meta = CRITERIA.find((c) => c.key === stored.key)
  return { ...meta, ...stored }
}

/**
 * @deprecated Use CRITERIA from constants/criteria; weights come from experts.
 * Fetch the four AHP criteria, ordered by rank.
 * Falls back to the in-code defaults if the collection has not been seeded.
 */
export const getCriteria = async () => {
  const snap = await getDocs(col)
  if (snap.empty) {
    return [...CRITERIA]
      .map((c) => ({ key: c.key, code: c.code, name: c.name, rank: c.defaultRank, higherIsWorse: c.higherIsWorse }))
      .sort((a, b) => a.rank - b.rank)
  }
  return snap.docs
    .map((d) => hydrate({ id: d.id, ...d.data() }))
    .sort((a, b) => a.rank - b.rank)
}

/** Seed the criteria collection with defaults (id = criterion key). */
export const seedCriteria = async () => {
  const batch = writeBatch(db)
  for (const c of CRITERIA) {
    batch.set(doc(db, COLLECTIONS.CRITERIA, c.key), {
      key: c.key,
      code: c.code,
      name: c.name,
      rank: c.defaultRank,
    })
  }
  await batch.commit()
}

/**
 * @deprecated Ranks are no longer used for the AHP weights.
 * Edit a criterion's rank. Ranks must stay unique (1–4), so the criterion that
 * currently holds `newRank` is swapped into the editing criterion's old rank.
 */
export const updateCriterionRank = async (key, newRank) => {
  const criteria = await getCriteria()
  const target = criteria.find((c) => c.key === key)
  if (!target) throw new Error('Kriteria tidak ditemukan.')
  if (target.rank === newRank) return

  const occupant = criteria.find((c) => c.rank === newRank && c.key !== key)
  const batch = writeBatch(db)
  batch.set(doc(db, COLLECTIONS.CRITERIA, key), { rank: newRank }, { merge: true })
  if (occupant) {
    batch.set(doc(db, COLLECTIONS.CRITERIA, occupant.key), { rank: target.rank }, { merge: true })
  }
  await batch.commit()
}

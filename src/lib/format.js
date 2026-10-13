/** Formatting & month-key helpers shared across the app. */

export const MONTH_NAMES = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
]

export const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun',
  'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des',
]

/** A month key is `YYYY-MM` (e.g. "2026-04"). */
export const toMonthKey = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`

/** Previous month relative to `date`. */
export const prevMonthKey = (date = new Date()) => {
  const d = new Date(date.getFullYear(), date.getMonth() - 1, 1)
  return toMonthKey(d)
}

/** Shift a month key by `n` months (negative = past). */
export const shiftMonthKey = (monthKey, n) => {
  const [y, m] = monthKey.split('-').map(Number)
  const d = new Date(y, m - 1 + n, 1)
  return toMonthKey(d)
}

/** List of month keys, oldest → newest, ending at `endKey`. */
export const monthKeyRange = (endKey, count) => {
  const keys = []
  for (let i = count - 1; i >= 0; i--) keys.push(shiftMonthKey(endKey, -i))
  return keys
}

/** "2026-04" → "April 2026" */
export const formatMonthKey = (monthKey) => {
  if (!monthKey) return '-'
  const [y, m] = monthKey.split('-').map(Number)
  return `${MONTH_NAMES[m - 1]} ${y}`
}

/** "2026-04" → "Apr 2026" */
export const formatMonthShort = (monthKey) => {
  if (!monthKey) return '-'
  const [y, m] = monthKey.split('-').map(Number)
  return `${MONTH_SHORT[m - 1]} ${y}`
}

/** Number of days in the month described by a month key. */
export const daysInMonthKey = (monthKey) => {
  const [y, m] = monthKey.split('-').map(Number)
  return new Date(y, m, 0).getDate()
}

/** First & last day of a month key, formatted "01 Apr — 30 Apr 2026". */
export const formatMonthRange = (monthKey) => {
  if (!monthKey) return '-'
  const [y, m] = monthKey.split('-').map(Number)
  const last = daysInMonthKey(monthKey)
  return `01 ${MONTH_SHORT[m - 1]} — ${last} ${MONTH_SHORT[m - 1]} ${y}`
}

export const formatRupiah = (value) => {
  const n = Number(value) || 0
  return 'Rp ' + n.toLocaleString('id-ID')
}

/** Compact rupiah, e.g. 8_400_000 → "Rp 8,4 Jt". */
export const formatRupiahCompact = (value) => {
  const n = Number(value) || 0
  if (n >= 1_000_000_000) return `Rp ${(n / 1_000_000_000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} M`
  if (n >= 1_000_000) return `Rp ${(n / 1_000_000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} Jt`
  if (n >= 1_000) return `Rp ${(n / 1_000).toLocaleString('id-ID', { maximumFractionDigits: 0 })} Rb`
  return `Rp ${n.toLocaleString('id-ID')}`
}

export const formatNumber = (value) => (Number(value) || 0).toLocaleString('id-ID')

/** Parse a localised numeric string ("100.000" / "100,000") to a Number. */
export const parseNumber = (str) => {
  if (typeof str === 'number') return str
  if (!str) return 0
  return Number(String(str).replace(/[^\d.-]/g, '')) || 0
}

/**
 * A pairwise-matrix value: whole Saaty values as "3" / "1/5", non-integers
 * (e.g. a geometric mean of several experts) as decimals "2.47" / "0.41".
 */
export const formatSaaty = (v, digits = 2) => {
  if (!(v > 0)) return '-'
  if (Math.abs(v - Math.round(v)) < 1e-6) return String(Math.round(v))
  const inv = 1 / v
  if (Math.abs(inv - Math.round(inv)) < 1e-6) return `1/${Math.round(inv)}`
  return v.toFixed(digits)
}

/** Format a Firestore Timestamp / Date / ISO string as "02 Mei 2026 · 09:42 WIB". */
export const formatTimestamp = (value) => {
  if (!value) return '-'
  let d
  if (typeof value?.toDate === 'function') d = value.toDate()
  else d = new Date(value)
  if (Number.isNaN(d.getTime())) return '-'
  const day = String(d.getDate()).padStart(2, '0')
  const month = MONTH_SHORT[d.getMonth()]
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${day} ${month} ${d.getFullYear()} · ${hh}.${mm} WIB`
}

export const formatDate = (value) => {
  if (!value) return '-'
  let d
  if (typeof value?.toDate === 'function') d = value.toDate()
  else d = new Date(value)
  if (Number.isNaN(d.getTime())) return '-'
  return `${String(d.getDate()).padStart(2, '0')} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`
}

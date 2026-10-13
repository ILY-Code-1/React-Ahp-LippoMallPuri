/**
 * Fixed AHP criteria. These four are immutable (no add / delete). Their
 * weights come from expert pairwise judgments entered in Master Data > AHP
 * (`ahp_judgments_enerlyze`). The array order below is the row/column order of
 * every pairwise matrix.
 *
 * `key`   — stable identifier, also the field name used in `data_enerlyze`.
 * `code`  — short code shown in the pairwise matrix (KE / BL / DO / FM).
 * `defaultRank` — LEGACY. Only used by the old rank-based weighting, kept so
 *   `npm run seed` and old reports keep working. No longer used for weights.
 * `higherIsWorse` — true when a higher input value means a more wasteful (and
 *   therefore higher-priority) area. Frequency of maintenance is inverted:
 *   a LOWER maintenance frequency = less cared-for = higher optimisation priority.
 */
export const CRITERIA = [
  {
    key: 'energy',
    code: 'KE',
    name: 'Konsumsi Energi (kWh)',
    shortName: 'Energi',
    unit: 'kWh',
    defaultRank: 1,
    higherIsWorse: true,
    description:
      'Total daya listrik yang terpakai pada setiap area, diukur dalam kilowatt-hour. Semakin tinggi konsumsi, semakin besar prioritas area tersebut untuk dioptimalkan.',
  },
  {
    key: 'cost',
    code: 'BL',
    name: 'Biaya Listrik (Rp)',
    shortName: 'Biaya',
    unit: 'Rp',
    defaultRank: 2,
    higherIsWorse: true,
    description:
      'Nilai rupiah yang dikeluarkan dari pemakaian listrik per area. Indikator langsung beban finansial dan area mana yang paling layak diprioritaskan penghematannya.',
  },
  {
    key: 'duration',
    code: 'DO',
    name: 'Durasi Operasional (jam)',
    shortName: 'Efisiensi',
    unit: 'jam',
    defaultRank: 3,
    higherIsWorse: true,
    description:
      'Lamanya peralatan beroperasi setiap harinya. Durasi yang panjang berpotensi meningkatkan konsumsi energi dan mempercepat penurunan performa peralatan.',
  },
  {
    key: 'maintenance',
    code: 'FM',
    name: 'Frekuensi Maintenance',
    shortName: 'Perawatan',
    unit: 'x/bulan',
    defaultRank: 4,
    higherIsWorse: false,
    description:
      'Seberapa sering perawatan dilakukan pada peralatan di setiap area. Frekuensi yang rendah menandakan area kurang terawat sehingga berpotensi lebih boros.',
  },
]

/** Random Index for the Consistency Ratio. For n = 4 criteria, RI = 0.90. */
export const RANDOM_INDEX = { 1: 0, 2: 0, 3: 0.58, 4: 0.9, 5: 1.12 }

/** A pairwise matrix is acceptable when CR < CR_THRESHOLD. */
export const CR_THRESHOLD = 0.1

/** Expert (narasumber) limits for the pairwise judgments. */
export const MIN_EXPERTS = 2 // final judgments required before Run AHP
export const MAX_EXPERTS = 3 // judgments (draft + final) that may exist

/** Criterion codes in matrix order: ['KE', 'BL', 'DO', 'FM']. */
export const CRITERIA_CODES = CRITERIA.map((c) => c.code)

export const getCriterion = (key) => CRITERIA.find((c) => c.key === key)

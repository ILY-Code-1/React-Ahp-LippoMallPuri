import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Trash2, Download } from 'lucide-react'
import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import { getAhpResult, deleteAhpResult, ahpIdOf } from '../../services/ahpService'
import { getAreas } from '../../services/areaService'
import { getDataByMonth } from '../../services/dataService'
import { buildRecommendation } from '../../lib/recommendations'
import { deserializeMatrix } from '../../lib/ahp'
import {
  formatMonthKey, formatMonthRange, formatTimestamp, daysInMonthKey,
  formatNumber, formatRupiah,
} from '../../lib/format'
import { toast } from '../../stores/toastStore'

/* Grayscale shades for the per-criterion contribution bar (section 04). */
const CRIT_SHADE = { cost: '#18181b', energy: '#52525b', duration: '#a1a1aa', maintenance: '#d4d4d8' }
const CRIT_LABEL = { cost: 'Biaya', energy: 'Energi', duration: 'Efisiensi', maintenance: 'Perawatan' }
const LEGEND = ['cost', 'energy', 'duration', 'maintenance']

/** A Saaty matrix value rendered as an integer or a 1/x fraction. */
const saatyLabel = (v) => {
  if (v >= 1) return String(Math.round(v))
  return `1/${Math.round(1 / v)}`
}

const DetailReportPage = () => {
  const { month } = useParams()
  const [ahp, setAhp] = useState(null)
  const [areas, setAreas] = useState([])
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const reportRef = useRef(null)

  const load = async () => {
    setLoading(true)
    try {
      const [result, a, d] = await Promise.all([
        getAhpResult(month),
        getAreas(),
        getDataByMonth(month),
      ])
      setAhp(result)
      setAreas(a)
      setData(d)
    } catch (err) {
      toast.error(err.message || 'Gagal memuat laporan.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    document.title = `Laporan AHP · ${formatMonthKey(month)}`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month])

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteAhpResult(month)
      toast.success('Hasil AHP dihapus. Data input tetap tersimpan.')
      setConfirmDelete(false)
      setAhp(null)
    } catch (err) {
      toast.error(err.message || 'Gagal menghapus laporan.')
    } finally {
      setDeleting(false)
    }
  }

  const handleDownloadPdf = async () => {
    if (!reportRef.current) return
    toast.info('Menyiapkan PDF...')
    try {
      const canvas = await html2canvas(reportRef.current, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true,
        scrollX: 0,
        scrollY: -window.scrollY,
        windowWidth: reportRef.current.scrollWidth,
      })
      const imgData = canvas.toDataURL('image/png')
      // Single page sized to the full content height (A4 width, proportional
      // height) so no card/section is ever split across a page break.
      const pageW = 210 // A4 width in mm
      const margin = 8
      const contentW = pageW - margin * 2
      const contentH = (canvas.height * contentW) / canvas.width
      const pdf = new jsPDF({
        orientation: 'p',
        unit: 'mm',
        format: [pageW, contentH + margin * 2],
      })
      pdf.addImage(imgData, 'PNG', margin, margin, contentW, contentH, undefined, 'FAST')
      pdf.save(`Laporan-AHP-${month}.pdf`)
    } catch {
      toast.error('Gagal membuat PDF.')
    }
  }

  if (loading) {
    return (
      <div style={S.shell}>
        <div style={{ padding: 80, textAlign: 'center', color: '#71717a' }}>Memuat laporan…</div>
      </div>
    )
  }

  const dataByArea = {}
  data.forEach((d) => (dataByArea[d.area_id] = d))

  return (
    <div style={S.shell}>
      <div ref={reportRef} style={S.page}>
        {/* ── Header ─────────────────────────────────────────── */}
        <div style={S.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <div style={S.logoBox}>
              <div style={S.logoBrand}>
                <span style={{ fontWeight: 900 }}>LIPPO</span>
                <span style={{ fontWeight: 300 }}>MALL</span>
              </div>
              <div style={S.logoSub}>PURI</div>
            </div>
            <div>
              <div style={{ fontSize: 26, fontWeight: 700, color: '#18181b', lineHeight: 1.1 }}>
                Enerlyze
              </div>
              <div style={{ fontSize: 14, color: '#52525b', fontWeight: 500 }}>
                Smart Energy Analysis &amp; AHP Decision Engine
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12 }} data-html2canvas-ignore>
            {ahp && (
              <button type="button" onClick={() => setConfirmDelete(true)} style={S.btnDanger}>
                <Trash2 size={16} />
                Hapus Laporan
              </button>
            )}
            <button type="button" onClick={handleDownloadPdf} style={S.btnDark}>
              <Download size={16} />
              Unduh PDF
            </button>
          </div>
        </div>

        <div style={S.rule} />

        {ahp ? (
          <FullReport ahp={ahp} month={month} />
        ) : (
          <InputOnly month={month} areas={areas} dataByArea={dataByArea} />
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
        loading={deleting}
        title="Hapus Laporan AHP"
        description={`Hasil analisis AHP untuk ${formatMonthKey(month)} akan dihapus. Data input bulanan tetap tersimpan dan AHP dapat dijalankan ulang.`}
        confirmText="Hapus Laporan"
        variant="danger"
        icon={Trash2}
      />
    </div>
  )
}

/* ───────────────────────── Full report (AHP done) ───────────────────────── */
const FullReport = ({ ahp, month }) => {
  const ranking = ahp.ranking || []
  const top4 = ranking.slice(0, 4)
  const top2 = ranking.slice(0, 2)
  const maxScore = Math.max(...ranking.map((r) => r.score), 0.0001)
  const cr = ahp.consistency?.cr ?? 0
  const crOk = cr < 0.1
  // Firestore-safe matrix is stored as { rows: [{ cells: [...] }] }.
  const matrix = deserializeMatrix(ahp.criteria_matrix)

  return (
    <>
      {/* Meta badges */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 28 }}>
        <span style={S.badge}>PERIODE {formatMonthKey(month).toUpperCase()}</span>
        <span style={{ ...S.badge, ...(crOk ? S.badgeGreen : S.badgeAmber) }}>
          ● CR {cr.toFixed(3)} — {crOk ? 'VALID & KONSISTEN' : 'PERLU TINJAU'}
        </span>
        <span style={S.badge}>{ahp.ahp_id || ahpIdOf(month)}</span>
      </div>

      <h1 style={S.bigTitle}>Laporan Optimasi Energi · {formatMonthKey(month)}</h1>
      <p style={S.lead}>
        Hasil analisis Analytical Hierarchy Process untuk menentukan prioritas area Lippo Mall Puri
        yang paling potensial dioptimasi penggunaan energinya, berdasarkan data input selama{' '}
        {formatMonthKey(month)}.
      </p>

      {/* Info grid */}
      <div style={S.infoGrid}>
        <Info label="Lokasi" value="Lippo Mall Puri" />
        <Info label="Periode Data" value={formatMonthRange(month)} />
        <Info label="Input" value={`${daysInMonthKey(month)} hari · ${ranking.length} area`} />
        <Info label="Penyusun" value={ahp.created_by || 'Admin'} />
        <Info label="Dibuat" value={formatTimestamp(ahp.created_at)} last />
      </div>

      {/* Top ranking cards */}
      <div style={S.cardRow}>
        {top4.map((r, i) => (
          <div key={r.area_id} style={{ ...S.rankCard, ...(i === 0 ? S.rankCardTop : {}) }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={S.rankNo}>#{String(r.rank).padStart(2, '0')}</span>
              {i === 0 && <span style={S.recoBadge}>REKOMENDASI</span>}
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, color: '#18181b', marginTop: 10 }}>
              {r.area_name}
            </div>
            <div style={{ fontSize: 12, color: '#71717a', marginTop: 3, minHeight: 16 }}>
              {r.area_description || '—'}
            </div>
            <div style={S.cardRule} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={S.tinyLabel}>SKOR</span>
              <span style={{ fontSize: 22, fontWeight: 700, color: '#18181b', fontFamily: 'monospace' }}>
                {r.score.toFixed(3)}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Section 03 & 04 side by side */}
      <div style={{ display: 'flex', gap: 40, marginTop: 48, flexWrap: 'wrap' }}>
        {/* 03 Pairwise Matrix */}
        <div style={{ flex: '1 1 320px' }}>
          <SectionTitle no="03" title="Pairwise Matrix" sub="Skala Saaty 1–9" />
          <table style={S.matrix}>
            <thead>
              <tr>
                <th style={S.matrixCorner} />
                {ahp.criteria.map((c) => (
                  <th key={c.key} style={S.matrixHead}>{c.code}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ahp.criteria.map((rowC, i) => (
                <tr key={rowC.key}>
                  <th style={S.matrixHead}>{rowC.code}</th>
                  {ahp.criteria.map((_, j) => (
                    <td key={j} style={{ ...S.matrixCell, ...(i === j ? S.matrixDiag : {}) }}>
                      {saatyLabel(matrix[i][j])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {ahp.criteria.map((c) => (
              <div key={c.key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: '#52525b' }}>
                  {c.code} · {c.name}
                </span>
                <span style={{ color: '#18181b', fontWeight: 600, fontFamily: 'monospace' }}>
                  bobot {c.weight.toFixed(3)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* 04 Ranking Alternatif */}
        <div style={{ flex: '2 1 460px' }}>
          <SectionTitle no="04" title="Ranking Alternatif" sub="Skor agregat & kontribusi per kriteria" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {ranking.map((r) => (
              <div key={r.area_id} style={S.rankRow}>
                <span style={S.rankRowNo}>{String(r.rank).padStart(2, '0')}</span>
                <div style={{ width: 150, minWidth: 150 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#18181b' }}>{r.area_name}</div>
                  <div style={{ fontSize: 11, color: '#a1a1aa' }}>{r.area_description || '—'}</div>
                </div>
                <div style={S.stackBar}>
                  {LEGEND.map((k) => {
                    const w = ((r.breakdown[k] || 0) / maxScore) * 100
                    return (
                      <div
                        key={k}
                        style={{ width: `${w}%`, background: CRIT_SHADE[k], height: '100%' }}
                        title={`${CRIT_LABEL[k]}: ${(r.breakdown[k] || 0).toFixed(3)}`}
                      />
                    )
                  })}
                </div>
                <span style={{ fontSize: 15, fontWeight: 700, color: '#18181b', fontFamily: 'monospace', width: 56, textAlign: 'right' }}>
                  {r.score.toFixed(3)}
                </span>
              </div>
            ))}
          </div>
          {/* Legend */}
          <div style={{ display: 'flex', gap: 18, marginTop: 14 }}>
            {LEGEND.map((k) => (
              <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#71717a' }}>
                <span style={{ width: 10, height: 10, background: CRIT_SHADE[k], borderRadius: 2 }} />
                {CRIT_LABEL[k]}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Section 05 Recommendations */}
      <div style={{ marginTop: 48 }}>
        <SectionTitle no="05" title="Rekomendasi Tindakan" sub="Aksi prioritas pada 2 area teratas" />
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          {top2.map((r) => {
            const reco = buildRecommendation(r)
            return (
              <div key={r.area_id} style={S.recoCard}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#18181b' }}>
                    <span style={{ color: '#a1a1aa', marginRight: 8, fontFamily: 'monospace' }}>
                      {String(r.rank).padStart(2, '0')}
                    </span>
                    {r.area_name}
                  </div>
                  <span style={{ fontSize: 12, color: '#71717a', fontFamily: 'monospace' }}>
                    skor {r.score.toFixed(3)}
                  </span>
                </div>
                <div style={S.cardRule} />
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {reco.actions.map((a, idx) => (
                    <li key={idx} style={{ display: 'flex', gap: 8, fontSize: 12.5, color: '#3f3f46' }}>
                      <span style={{ color: '#a1a1aa' }}>•</span>
                      <span>{a}</span>
                    </li>
                  ))}
                </ul>
                <div style={{ ...S.cardRule, marginTop: 14 }} />
                <div style={{ fontSize: 12, color: '#71717a' }}>
                  → Potensi penghematan {reco.saving}.
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Footer */}
      <div style={S.footer}>
        <span>{ahp.ahp_id || ahpIdOf(month)} · v1.0</span>
        <span>Generated by Enerlyze AHP Engine · {formatTimestamp(ahp.created_at)}</span>
      </div>
    </>
  )
}

/* ──────────────────── Input-only view (AHP not run) ─────────────────────── */
const InputOnly = ({ month, areas, dataByArea }) => (
  <>
    <div style={{ display: 'flex', gap: 10, marginTop: 28 }}>
      <span style={S.badge}>PERIODE {formatMonthKey(month).toUpperCase()}</span>
      <span style={{ ...S.badge, ...S.badgeAmber }}>● AHP BELUM DIJALANKAN</span>
    </div>
    <h1 style={S.bigTitle}>Data Input Energi · {formatMonthKey(month)}</h1>
    <p style={S.lead}>
      AHP belum dijalankan untuk periode ini. Berikut data input mentah per area. Jalankan AHP dari
      menu Data untuk melihat ranking prioritas, pairwise matrix, dan rekomendasi.
    </p>

    <table style={S.dataTable}>
      <thead>
        <tr>
          {['No', 'Area', 'kWh', 'Biaya', 'Durasi (jam)', 'Maintenance'].map((c) => (
            <th key={c} style={S.dataTh}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {areas.map((a, i) => {
          const d = dataByArea[a.id]
          return (
            <tr key={a.id}>
              <td style={S.dataTd}>{i + 1}</td>
              <td style={{ ...S.dataTd, fontWeight: 600, color: '#18181b' }}>{a.name}</td>
              <td style={S.dataTd}>{d ? formatNumber(d.energy) : '—'}</td>
              <td style={S.dataTd}>{d ? formatRupiah(d.cost) : '—'}</td>
              <td style={S.dataTd}>{d ? formatNumber(d.duration) : '—'}</td>
              <td style={S.dataTd}>{d ? `${formatNumber(d.maintenance)}x` : '—'}</td>
            </tr>
          )
        })}
        {areas.length === 0 && (
          <tr>
            <td colSpan={6} style={{ ...S.dataTd, textAlign: 'center', color: '#a1a1aa' }}>
              Belum ada area terdaftar.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  </>
)

/* ───────────────────────────── Small parts ──────────────────────────────── */
const Info = ({ label, value, last }) => (
  <div style={{ flex: 1, paddingRight: 16, borderRight: last ? 'none' : '1px solid #e4e4e7' }}>
    <div style={S.tinyLabel}>{label.toUpperCase()}</div>
    <div style={{ fontSize: 13, color: '#18181b', fontWeight: 600, marginTop: 4 }}>{value}</div>
  </div>
)

const SectionTitle = ({ no, title, sub }) => (
  <div style={{ marginBottom: 18 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 11, color: '#a1a1aa', fontFamily: 'monospace' }}>{no}</span>
      <span style={{ fontSize: 16, fontWeight: 700, color: '#18181b' }}>{title}</span>
    </div>
    {sub && <div style={{ fontSize: 12, color: '#a1a1aa', marginTop: 2 }}>{sub}</div>}
  </div>
)

/* ──────────────────────────────── Styles ────────────────────────────────── */
const S = {
  shell: {
    minHeight: '100vh',
    background: '#f4f4f5',
    padding: '32px 16px',
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  page: {
    maxWidth: 1080,
    margin: '0 auto',
    background: '#ffffff',
    border: '1px solid #e4e4e7',
    borderRadius: 16,
    padding: '40px 48px',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, flexWrap: 'wrap' },
  logoBox: {
    background: '#18181b',
    color: '#ffffff',
    padding: '16px 20px',
    borderRadius: 4,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    lineHeight: 1,
    userSelect: 'none',
    position: 'relative',
  },
  logoBrand: { fontSize: 28, letterSpacing: '-0.02em', display: 'flex', alignItems: 'baseline' },
  logoSub: { fontSize: 11, letterSpacing: '0.5em', fontWeight: 300, color: 'rgba(255,255,255,0.6)', marginTop: 6, paddingLeft: 8 },
  rule: { height: 1, background: '#e4e4e7', marginTop: 28 },
  cardRule: { height: 1, background: '#e4e4e7', margin: '14px 0' },
  btnDanger: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '11px 18px',
    border: '1.5px solid #ef4444', color: '#ef4444', background: '#ffffff',
    borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
  btnDark: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '11px 18px',
    background: '#18181b', color: '#ffffff', border: 'none',
    borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
  badge: {
    fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: '#52525b',
    background: '#f4f4f5', border: '1px solid #e4e4e7', borderRadius: 99,
    padding: '5px 12px',
  },
  badgeGreen: { background: '#ecfdf5', borderColor: '#a7f3d0', color: '#059669' },
  badgeAmber: { background: '#fffbeb', borderColor: '#fde68a', color: '#b45309' },
  bigTitle: { fontSize: 32, fontWeight: 700, color: '#18181b', margin: '20px 0 12px', letterSpacing: -0.5 },
  lead: { fontSize: 13.5, color: '#52525b', lineHeight: 1.6, maxWidth: 620, margin: 0 },
  infoGrid: {
    display: 'flex', gap: 16, marginTop: 28, paddingTop: 22,
    borderTop: '1px solid #e4e4e7', flexWrap: 'wrap',
  },
  tinyLabel: { fontSize: 10, fontWeight: 700, letterSpacing: 0.8, color: '#a1a1aa' },
  cardRow: { display: 'flex', gap: 16, marginTop: 32, flexWrap: 'wrap' },
  rankCard: {
    flex: '1 1 200px', border: '1px solid #e4e4e7', borderRadius: 12, padding: 18,
    background: '#ffffff',
  },
  rankCardTop: { borderColor: '#18181b', borderWidth: 1.5, background: '#fafafa' },
  rankNo: { fontSize: 12, fontFamily: 'monospace', color: '#a1a1aa', fontWeight: 600 },
  recoBadge: {
    fontSize: 9, fontWeight: 700, letterSpacing: 0.8, color: '#18181b',
    border: '1px solid #d4d4d8', borderRadius: 99, padding: '3px 9px',
  },
  matrix: { borderCollapse: 'collapse', width: '100%', fontSize: 13 },
  matrixCorner: { background: '#fafafa', border: '1px solid #e4e4e7', padding: 10, width: 48 },
  matrixHead: {
    background: '#fafafa', border: '1px solid #e4e4e7', padding: '10px 12px',
    fontSize: 11, fontWeight: 700, color: '#52525b',
  },
  matrixCell: {
    border: '1px solid #e4e4e7', padding: '10px 12px', textAlign: 'center',
    color: '#3f3f46', fontFamily: 'monospace',
  },
  matrixDiag: { background: '#fafafa', fontWeight: 700, color: '#18181b' },
  rankRow: {
    display: 'flex', alignItems: 'center', gap: 14, border: '1px solid #e4e4e7',
    borderRadius: 10, padding: '12px 16px',
  },
  rankRowNo: { fontSize: 13, fontFamily: 'monospace', color: '#a1a1aa', fontWeight: 700, width: 22 },
  stackBar: {
    flex: 1, height: 16, borderRadius: 4, overflow: 'hidden', display: 'flex',
    background: '#f4f4f5',
  },
  recoCard: { flex: '1 1 340px', border: '1px solid #e4e4e7', borderRadius: 12, padding: 20 },
  footer: {
    display: 'flex', justifyContent: 'space-between', marginTop: 44, paddingTop: 20,
    borderTop: '1px solid #e4e4e7', fontSize: 11, color: '#a1a1aa', fontFamily: 'monospace',
    flexWrap: 'wrap', gap: 8,
  },
  dataTable: { borderCollapse: 'collapse', width: '100%', marginTop: 28, fontSize: 13 },
  dataTh: {
    background: '#fafafa', border: '1px solid #e4e4e7', padding: '11px 14px',
    textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#52525b',
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  dataTd: { border: '1px solid #e4e4e7', padding: '11px 14px', color: '#3f3f46' },
}

export default DetailReportPage

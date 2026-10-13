import { useEffect, useMemo, useState } from 'react'
import {
  Zap, Banknote, Clock, Wrench, Pencil, Trash2, Plus, UserRound, AlertTriangle, CheckCircle2,
} from 'lucide-react'
import PageHeader from '../../../components/ui/PageHeader'
import Spinner from '../../../components/ui/Spinner'
import Modal from '../../../components/ui/Modal'
import ConfirmDialog from '../../../components/ui/ConfirmDialog'
import Button from '../../../components/ui/Button'
import { TextField, SelectField } from '../../../components/ui/Field'
import {
  CRITERIA, CRITERIA_CODES, CR_THRESHOLD, MIN_EXPERTS, MAX_EXPERTS,
} from '../../../constants/criteria'
import {
  criterionPairs, buildMatrixFromPairs, analyzeJudgment, inconsistentPairs,
  aggregateFinalJudgments, expertWeightsBlocker,
} from '../../../lib/ahp'
import { formatSaaty, formatDate } from '../../../lib/format'
import {
  getJudgments, createJudgment, updateJudgment, deleteJudgment,
} from '../../../services/ahpJudgmentService'
import useAuthStore from '../../../stores/authStore'
import { toast } from '../../../stores/toastStore'

const ICONS = { energy: Zap, cost: Banknote, duration: Clock, maintenance: Wrench }

/** The 6 pairs (KE–BL … DO–FM) asked to every expert. */
const PAIRS = criterionPairs(CRITERIA_CODES)
const pairKey = (p) => `${p.a}|${p.b}`

/* Saaty verbal scale. Even values are intermediate judgments. */
const SCALE_WORD = {
  3: 'sedikit lebih penting dari',
  5: 'lebih penting dari',
  7: 'sangat lebih penting dari',
  9: 'mutlak lebih penting dari',
}
const word = (v) => SCALE_WORD[v] || 'lebih penting dari'
const tail = (v) => (SCALE_WORD[v] ? '' : ' (nilai antara)')

/** Select options for "a vs b": a dominant 9..2, equal, then b dominant 2..9. */
const pairOptions = ({ a, b }) => [
  ...[9, 8, 7, 6, 5, 4, 3, 2].map((v) => ({
    value: String(v),
    label: `${v} — ${a} ${word(v)} ${b}${tail(v)}`,
  })),
  { value: '1', label: `1 — ${a} sama penting dengan ${b}` },
  ...[2, 3, 4, 5, 6, 7, 8, 9].map((v) => ({
    value: `1/${v}`,
    label: `${v} — ${b} ${word(v)} ${a}${tail(v)}`,
  })),
]

const parseOption = (s) => (s.startsWith('1/') ? 1 / Number(s.slice(2)) : Number(s))

const defaultValues = () => Object.fromEntries(PAIRS.map((p) => [pairKey(p), 1]))

/** Upper-triangle values of a stored judgment (tolerates either pair orientation). */
const valuesOf = (judgment) => {
  try {
    const m = buildMatrixFromPairs(CRITERIA_CODES, judgment.pairs)
    const idx = (c) => CRITERIA_CODES.indexOf(c)
    return Object.fromEntries(PAIRS.map((p) => [pairKey(p), m[idx(p.a)][idx(p.b)]]))
  } catch {
    return defaultValues()
  }
}

const toPairs = (values) => PAIRS.map((p) => ({ a: p.a, b: p.b, value: values[pairKey(p)] }))

const nameOf = (code) => CRITERIA.find((c) => c.code === code)?.name || code

const AHPPage = () => {
  const user = useAuthStore((s) => s.user)
  const [judgments, setJudgments] = useState([])
  const [loading, setLoading] = useState(true)

  const [form, setForm] = useState(null) // { id, expert_name, expert_position, values }
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(null) // 'draft' | 'final' | null

  const [deleting, setDeleting] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      setJudgments(await getJudgments())
    } catch (err) {
      toast.error(err.message || 'Gagal memuat penilaian narasumber.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const aggregate = useMemo(() => {
    try {
      return aggregateFinalJudgments(judgments, CRITERIA_CODES)
    } catch {
      return { experts: [], combined: null }
    }
  }, [judgments])
  const blocker = expertWeightsBlocker(aggregate)

  // Live analysis of the judgment being edited.
  const live = useMemo(
    () => (form ? analyzeJudgment(CRITERIA_CODES, toPairs(form.values)) : null),
    [form],
  )
  const liveWorst = useMemo(
    () => (live && !live.isConsistent
      ? inconsistentPairs(live.matrix, live.weights, CRITERIA_CODES).slice(0, 2)
      : []),
    [live],
  )

  const atMax = judgments.length >= MAX_EXPERTS

  const openCreate = () => {
    setForm({ id: null, expert_name: '', expert_position: '', values: defaultValues() })
    setErrors({})
  }

  const openEdit = (j) => {
    setForm({
      id: j.id,
      expert_name: j.expert_name || '',
      expert_position: j.expert_position || '',
      values: valuesOf(j),
    })
    setErrors({})
  }

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))
  const setPair = (p) => (e) =>
    setForm((f) => ({ ...f, values: { ...f.values, [pairKey(p)]: parseOption(e.target.value) } }))

  const validate = () => {
    const e = {}
    if (!form.expert_name.trim()) e.expert_name = 'Nama narasumber wajib diisi.'
    if (!form.expert_position.trim()) e.expert_position = 'Jabatan wajib diisi.'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const save = async (status) => {
    if (!validate()) return
    setSaving(status)
    try {
      const payload = {
        expert_name: form.expert_name,
        expert_position: form.expert_position,
        pairs: toPairs(form.values),
        status,
      }
      if (form.id) await updateJudgment(form.id, payload, user)
      else await createJudgment(payload, user)
      toast.success(status === 'final' ? 'Penilaian disimpan sebagai final.' : 'Penilaian disimpan sebagai draft.')
      setForm(null)
      await load()
    } catch (err) {
      toast.error(err.message || 'Gagal menyimpan penilaian.')
    } finally {
      setSaving(null)
    }
  }

  const confirmDelete = async () => {
    setBusy(true)
    try {
      await deleteJudgment(deleting.id)
      toast.success('Narasumber dihapus.')
      setDeleting(null)
      await load()
    } catch (err) {
      toast.error(err.message || 'Gagal menghapus narasumber.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-10">
      <PageHeader
        title="Master AHP — Kriteria"
        subtitle={`Bobot kriteria dari perbandingan berpasangan (skala Saaty 1/9–9) oleh ${MIN_EXPERTS}–${MAX_EXPERTS} narasumber, digabung dengan rata-rata geometrik.`}
        actions={
          <Button
            variant="primary"
            onClick={openCreate}
            disabled={atMax || loading}
            title={atMax ? `Maksimal ${MAX_EXPERTS} narasumber` : undefined}
            className="disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus size={14} strokeWidth={2.5} />
            Tambah Narasumber
          </Button>
        }
      />

      {/* Criteria description cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {CRITERIA.map(({ key, code, name, description }) => {
          const Icon = ICONS[key]
          return (
            <div
              key={key}
              className="bg-[#111111] border border-white/6 rounded-2xl p-7 hover:border-white/10 transition-colors"
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center">
                  <Icon size={17} className="text-white/70" strokeWidth={2} />
                </div>
                <h3 className="text-white font-semibold text-sm">{name}</h3>
                <span className="ml-auto text-white/50 text-xs font-mono bg-white/5 px-2 py-1 rounded">
                  {code}
                </span>
              </div>
              <p className="text-white/50 text-[13px] leading-relaxed">{description}</p>
            </div>
          )
        })}
      </div>

      {/* Experts */}
      <div className="space-y-4">
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <h2 className="text-white font-semibold text-base">Narasumber</h2>
          <p className="text-white/40 text-xs">
            {judgments.length}/{MAX_EXPERTS} narasumber · minimal {MIN_EXPERTS} berstatus final untuk Run AHP
          </p>
        </div>
        <div className="bg-[#111111] border border-white/6 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-white/2 border-b border-white/6">
                  {['Narasumber', 'Status', 'CR', `Bobot (${CRITERIA_CODES.join(' / ')})`, 'Diperbarui', 'Action'].map((c) => (
                    <th
                      key={c}
                      className="py-4 px-6 text-white/40 font-semibold text-[11px] uppercase tracking-wider text-left whitespace-nowrap"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={6}>
                      <Spinner />
                    </td>
                  </tr>
                ) : judgments.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-white/35 text-sm">
                      Belum ada narasumber. Klik "Tambah Narasumber" untuk mulai.
                    </td>
                  </tr>
                ) : (
                  judgments.map((j) => (
                    <tr key={j.id} className="border-b border-white/4 last:border-0 hover:bg-white/2">
                      <td className="py-4 px-6">
                        <p className="text-white text-sm font-medium">{j.expert_name}</p>
                        <p className="text-white/40 text-xs">{j.expert_position}</p>
                      </td>
                      <td className="py-4 px-6">
                        <StatusBadge status={j.status} />
                      </td>
                      <td className="py-4 px-6">
                        <CrText cr={j.cr} />
                      </td>
                      <td className="py-4 px-6 text-white/60 text-xs font-mono whitespace-nowrap">
                        {(j.weights || []).map((w) => w.toFixed(3)).join(' / ')}
                      </td>
                      <td className="py-4 px-6 text-white/50 text-sm whitespace-nowrap">
                        {formatDate(j.updated_at)}
                      </td>
                      <td className="py-4 px-6">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openEdit(j)}
                            className="inline-flex items-center gap-1.5 text-white/55 hover:text-white text-xs font-medium bg-white/5 hover:bg-white/10 px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
                          >
                            <Pencil size={13} />
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleting(j)}
                            className="inline-flex items-center gap-1.5 text-red-400/80 hover:text-red-400 text-xs font-medium bg-red-500/5 hover:bg-red-500/10 px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
                          >
                            <Trash2 size={13} />
                            Hapus
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Combined result (read-only) */}
      {!loading && (
        <div className="bg-[#111111] border border-white/6 rounded-2xl p-7 space-y-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h2 className="text-white font-semibold text-base">Hasil Gabungan</h2>
              <p className="text-white/40 text-xs mt-1">
                Rata-rata geometrik dari {aggregate.experts.length} narasumber final. Bobot ini berlaku
                global dan dipakai pada Run / Re-run AHP berikutnya; hasil AHP yang sudah tersimpan tidak berubah.
              </p>
            </div>
            {blocker ? (
              <span className="flex items-center gap-1.5 text-amber-400 bg-amber-400/10 px-3 py-1.5 rounded-lg text-xs font-medium">
                <AlertTriangle size={13} />
                Belum dapat Run AHP
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-emerald-400 bg-emerald-400/10 px-3 py-1.5 rounded-lg text-xs font-medium">
                <CheckCircle2 size={13} />
                Siap untuk Run AHP
              </span>
            )}
          </div>

          {blocker && <p className="text-amber-300/80 text-sm">{blocker}</p>}

          {aggregate.combined && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              <div className="space-y-4">
                <MatrixTable matrix={aggregate.combined.matrix} />
                <Metrics analysis={aggregate.combined} />
              </div>
              <WeightList weights={aggregate.combined.weights} />
            </div>
          )}
        </div>
      )}

      {/* Add / edit judgment */}
      <Modal
        open={Boolean(form)}
        onClose={() => !saving && setForm(null)}
        loading={Boolean(saving)}
        title={form?.id ? 'Edit Penilaian Narasumber' : 'Tambah Narasumber'}
        description="Bandingkan kepentingan setiap pasangan kriteria untuk menentukan prioritas optimasi energi."
        icon={UserRound}
        maxWidth="max-w-5xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setForm(null)} disabled={Boolean(saving)}>
              Batal
            </Button>
            <Button variant="secondary" onClick={() => save('draft')} disabled={Boolean(saving)}>
              {saving === 'draft' ? 'Menyimpan...' : 'Simpan draft'}
            </Button>
            <Button
              variant="primary"
              onClick={() => save('final')}
              disabled={Boolean(saving) || !live?.isConsistent}
              title={live?.isConsistent ? undefined : `CR harus < ${CR_THRESHOLD} untuk simpan final`}
              className="disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving === 'final' ? 'Menyimpan...' : 'Simpan final'}
            </Button>
          </>
        }
      >
        {form && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <TextField
                label="Nama Narasumber"
                value={form.expert_name}
                onChange={setField('expert_name')}
                error={errors.expert_name}
                placeholder="mis. Nama lengkap"
              />
              <TextField
                label="Jabatan"
                value={form.expert_position}
                onChange={setField('expert_position')}
                error={errors.expert_position}
                placeholder="mis. Chief Engineer"
              />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              <div className="space-y-4">
                <p className="text-white/45 text-xs leading-relaxed">
                  1 = sama penting · 3 = sedikit lebih penting · 5 = lebih penting · 7 = sangat lebih
                  penting · 9 = mutlak lebih penting · 2, 4, 6, 8 = nilai antara.
                </p>
                {PAIRS.map((p) => (
                  <SelectField
                    key={pairKey(p)}
                    label={`${p.a} vs ${p.b}`}
                    hint={`${nameOf(p.a)} dibanding ${nameOf(p.b)}`}
                    value={formatSaaty(form.values[pairKey(p)])}
                    onChange={setPair(p)}
                    options={pairOptions(p)}
                  />
                ))}
              </div>

              <div className="space-y-5">
                <MatrixTable matrix={live.matrix} />
                <Metrics analysis={live} />
                {!live.isConsistent && (
                  <div className="border border-amber-500/25 bg-amber-500/8 rounded-xl p-4 space-y-2">
                    <p className="flex items-center gap-2 text-amber-300 text-sm font-semibold">
                      <AlertTriangle size={15} />
                      CR {live.cr.toFixed(3)} ≥ {CR_THRESHOLD}: penilaian belum konsisten
                    </p>
                    <p className="text-white/60 text-xs">
                      Hanya dapat disimpan sebagai draft. Pasangan yang paling menyimpang dari bobot:
                    </p>
                    <ul className="space-y-1">
                      {liveWorst.map((w) => (
                        <li key={`${w.a}|${w.b}`} className="text-white/75 text-xs">
                          • <span className="font-mono">{w.a} vs {w.b}</span>: saat ini{' '}
                          <span className="font-mono">{formatSaaty(w.value)}</span>, yang selaras dengan
                          bobot ≈ <span className="font-mono">{formatSaaty(w.suggested)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <WeightList weights={live.weights} />
              </div>
            </div>
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => !busy && setDeleting(null)}
        onConfirm={confirmDelete}
        loading={busy}
        title="Hapus Narasumber"
        description={
          deleting
            ? `Penilaian "${deleting.expert_name}" akan dihapus. Hasil AHP yang sudah tersimpan tidak berubah.`
            : ''
        }
        confirmText="Hapus"
        variant="danger"
        icon={Trash2}
      />
    </div>
  )
}

/* ───────────────────────────── Small parts ──────────────────────────────── */

const StatusBadge = ({ status }) =>
  status === 'final' ? (
    <span className="text-emerald-400 bg-emerald-400/10 px-2.5 py-1 rounded-md text-xs font-semibold">
      Final
    </span>
  ) : (
    <span className="text-white/50 bg-white/5 px-2.5 py-1 rounded-md text-xs font-semibold">Draft</span>
  )

const CrText = ({ cr }) =>
  typeof cr === 'number' ? (
    <span className={`text-sm font-mono ${cr < CR_THRESHOLD ? 'text-emerald-400' : 'text-amber-400'}`}>
      {cr.toFixed(3)}
    </span>
  ) : (
    <span className="text-white/30">—</span>
  )

const MatrixTable = ({ matrix }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr>
          <th className="border border-white/8 bg-white/3 p-2 w-12" />
          {CRITERIA_CODES.map((c) => (
            <th key={c} className="border border-white/8 bg-white/3 p-2 text-white/50 text-[11px] font-semibold">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {CRITERIA_CODES.map((rowC, i) => (
          <tr key={rowC}>
            <th className="border border-white/8 bg-white/3 p-2 text-white/50 text-[11px] font-semibold">{rowC}</th>
            {CRITERIA_CODES.map((_, j) => (
              <td
                key={j}
                className={`border border-white/8 p-2 text-center font-mono ${
                  i === j ? 'bg-white/3 text-white' : 'text-white/75'
                }`}
              >
                {formatSaaty(matrix[i][j])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

const Metrics = ({ analysis }) => (
  <div className="grid grid-cols-3 gap-3">
    {[
      ['λ max', analysis.lambdaMax.toFixed(4)],
      ['CI', analysis.ci.toFixed(4)],
      ['CR', analysis.cr.toFixed(4)],
    ].map(([label, value]) => (
      <div key={label} className="bg-white/3 border border-white/6 rounded-xl px-3 py-2.5">
        <p className="text-white/40 text-[10px] font-semibold uppercase tracking-wider">{label}</p>
        <p
          className={`font-mono text-sm mt-0.5 ${
            label === 'CR' ? (analysis.isConsistent ? 'text-emerald-400' : 'text-amber-400') : 'text-white'
          }`}
        >
          {value}
        </p>
      </div>
    ))}
  </div>
)

const WeightList = ({ weights }) => {
  const max = Math.max(...weights, 0.0001)
  return (
    <div className="space-y-3">
      <p className="text-white/40 text-[11px] font-semibold uppercase tracking-wider">Bobot kriteria</p>
      {CRITERIA.map((c, i) => (
        <div key={c.key} className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-white/65">
              <span className="font-mono text-white/40 mr-1.5">{c.code}</span>
              {c.name}
            </span>
            <span className="font-mono text-white">{weights[i].toFixed(3)}</span>
          </div>
          <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
            <div className="h-full bg-white/70 rounded-full" style={{ width: `${(weights[i] / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export default AHPPage

import { useEffect, useMemo, useState } from 'react'
import { Play, Eye, RefreshCw, CheckCircle2 } from 'lucide-react'
import PageHeader from '../../components/ui/PageHeader'
import Spinner from '../../components/ui/Spinner'
import Button from '../../components/ui/Button'
import MonthSelect from '../../components/ui/MonthSelect'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import useAuthStore from '../../stores/authStore'
import { getAreas } from '../../services/areaService'
import { getDataByMonth } from '../../services/dataService'
import { getAhpResult, runAndSaveAHP, AHP_RUN_REJECTED } from '../../services/ahpService'
import { generateNotifications } from '../../services/notificationService'
import { formatNumber, formatRupiah, formatMonthKey, prevMonthKey } from '../../lib/format'
import { toast } from '../../stores/toastStore'

const COLS = ['No', 'Area', 'kWh', 'Biaya', 'Jam', 'Maintenance', 'Status', 'Priority']

const DataAdminPage = () => {
  const user = useAuthStore((s) => s.user)
  const [month, setMonth] = useState(prevMonthKey())
  const [areas, setAreas] = useState([])
  const [data, setData] = useState([])
  const [ahp, setAhp] = useState(null)
  const [loading, setLoading] = useState(true)
  const [confirmRun, setConfirmRun] = useState(false)
  const [running, setRunning] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const [a, d, result] = await Promise.all([
        getAreas(),
        getDataByMonth(month),
        getAhpResult(month),
      ])
      setAreas(a)
      setData(d)
      setAhp(result)
    } catch (err) {
      toast.error(err.message || 'Gagal memuat data.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month])

  const dataByArea = useMemo(() => {
    const map = {}
    data.forEach((d) => (map[d.area_id] = d))
    return map
  }, [data])

  const rankByArea = useMemo(() => {
    const map = {}
    ahp?.ranking?.forEach((r) => (map[r.area_id] = r))
    return map
  }, [ahp])

  const filledCount = useMemo(
    () => areas.filter((a) => dataByArea[a.id]).length,
    [areas, dataByArea],
  )
  const isComplete = areas.length > 0 && filledCount === areas.length

  const handleRun = async () => {
    setRunning(true)
    try {
      await runAndSaveAHP(month, user)
      toast.success(`AHP berhasil dijalankan untuk ${formatMonthKey(month)}.`)
      setConfirmRun(false)
      generateNotifications(user).catch(() => {})
      await load()
    } catch (err) {
      // Refused runs (e.g. not enough final experts, combined CR ≥ 0.1) carry a
      // message telling the admin what to fix in Master > AHP — close the dialog.
      if (err.code === AHP_RUN_REJECTED) setConfirmRun(false)
      toast.error(err.message || 'Gagal menjalankan AHP.')
    } finally {
      setRunning(false)
    }
  }

  const openDetail = () => {
    window.open(`/admin/detail/${month}`, '_blank', 'noopener')
  }

  return (
    <div className="space-y-10">
      <PageHeader
        title="Data"
        subtitle="Data konsumsi energi seluruh area & hasil analisis AHP"
        actions={<MonthSelect value={month} onChange={setMonth} />}
      />

      {/* Action bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative group">
          <Button
            variant="primary"
            onClick={() => setConfirmRun(true)}
            disabled={!isComplete || running}
          >
            {ahp ? <RefreshCw size={14} strokeWidth={2.5} /> : <Play size={14} strokeWidth={2.5} />}
            {ahp ? 'Re-run AHP' : 'Run AHP'}
          </Button>
          {!isComplete && (
            <div className="absolute left-0 top-full mt-2 hidden group-hover:block z-10">
              <div className="bg-[#161616] border border-white/10 rounded-lg px-3 py-2 text-[11px] text-white/70 whitespace-nowrap shadow-xl">
                Data belum lengkap di semua area
              </div>
            </div>
          )}
        </div>

        <Button variant="secondary" onClick={openDetail}>
          <Eye size={14} strokeWidth={2.5} />
          View Detail
        </Button>

        <div className="ml-auto flex items-center gap-2 text-xs">
          {ahp ? (
            <span className="flex items-center gap-1.5 text-emerald-400 bg-emerald-400/10 px-3 py-1.5 rounded-lg font-medium">
              <CheckCircle2 size={13} />
              AHP sudah dijalankan
            </span>
          ) : (
            <span className="text-white/40 bg-white/5 px-3 py-1.5 rounded-lg font-medium">
              {filledCount}/{areas.length} area terisi
            </span>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="bg-[#111111] border border-white/6 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-white/2 border-b border-white/6">
                {COLS.map((c) => (
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
                  <td colSpan={COLS.length}>
                    <Spinner />
                  </td>
                </tr>
              ) : areas.length === 0 ? (
                <tr>
                  <td colSpan={COLS.length} className="py-16 text-center text-white/40 text-sm">
                    Belum ada area terdaftar.
                  </td>
                </tr>
              ) : (
                // When AHP has run, order rows by priority rank.
                [...areas]
                  .sort((a, b) => {
                    const ra = rankByArea[a.id]?.rank ?? 99
                    const rb = rankByArea[b.id]?.rank ?? 99
                    return ra - rb
                  })
                  .map((area, i) => {
                    const d = dataByArea[area.id]
                    const r = rankByArea[area.id]
                    return (
                      <tr key={area.id} className="border-b border-white/4 last:border-0 hover:bg-white/2">
                        <td className="py-4 px-6 text-white/40 text-sm">{i + 1}</td>
                        <td className="py-4 px-6 text-white text-sm font-medium">{area.name}</td>
                        <td className="py-4 px-6 text-white/70 text-sm">
                          {d ? formatNumber(d.energy) : '—'}
                        </td>
                        <td className="py-4 px-6 text-white/70 text-sm">
                          {d ? formatRupiah(d.cost) : '—'}
                        </td>
                        <td className="py-4 px-6 text-white/70 text-sm">
                          {d ? formatNumber(d.duration) : '—'}
                        </td>
                        <td className="py-4 px-6 text-white/70 text-sm">
                          {d ? `${formatNumber(d.maintenance)}x` : '—'}
                        </td>
                        <td className="py-4 px-6">
                          {d ? (
                            <span className="text-[11px] font-semibold text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded">
                              Terisi
                            </span>
                          ) : (
                            <span className="text-[11px] font-semibold text-amber-400 bg-amber-400/10 px-2 py-1 rounded">
                              Belum input
                            </span>
                          )}
                        </td>
                        <td className="py-4 px-6">
                          {r ? (
                            <div className="flex items-center gap-2">
                              <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-white text-black text-xs font-bold">
                                {r.rank}
                              </span>
                              <span className="text-white/70 text-sm font-mono">
                                {r.score.toFixed(3)}
                              </span>
                            </div>
                          ) : (
                            <span className="text-white/30 text-sm">—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDialog
        open={confirmRun}
        onClose={() => setConfirmRun(false)}
        onConfirm={handleRun}
        loading={running}
        title={ahp ? 'Jalankan Ulang AHP' : 'Jalankan AHP'}
        description={
          ahp
            ? `Hasil AHP ${formatMonthKey(month)} akan dihitung ulang berdasarkan data terbaru. Lanjutkan?`
            : `Sistem akan menghitung prioritas optimasi energi untuk ${formatMonthKey(month)}. Lanjutkan?`
        }
        confirmText={ahp ? 'Re-run AHP' : 'Run AHP'}
        variant="primary"
        icon={Play}
      />
    </div>
  )
}

export default DataAdminPage

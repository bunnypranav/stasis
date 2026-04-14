'use client'

import { useState, useEffect, useCallback } from 'react'

interface Stats {
  totalParticipants: number
  totalCompleted: number
  totalClaimed: number
  totalShipped: number
  totalGraceDays: number
  eventStart: string
  eventEnd: string
  streakGoal: number
}

interface Completer {
  userId: string
  name: string | null
  email: string
  slackId: string | null
  timezone: string | null
  completedAt: string
  claimed: boolean
  shipped: boolean
}

interface UserResult {
  id: string
  name: string | null
  email: string
  slackId: string | null
  timezone: string | null
  bestStreak: number
  currentStreak: number
  challengeComplete: boolean
  totalJournaledDays: number
  totalSessions: number
  graceDays: number
  reward: { completedAt: string; claimed: boolean; shipped: boolean } | null
  days: { date: string; completed: boolean; isGraceDay: boolean }[]
}

function StatCard({ label, value }: Readonly<{ label: string; value: string | number }>) {
  return (
    <div className="bg-brown-800 border-2 border-cream-500/20 p-4">
      <p className="text-cream-200 text-xs uppercase tracking-wide">{label}</p>
      <p className="text-cream-50 text-2xl mt-1">{value}</p>
    </div>
  )
}

function DayDot({ completed, isGraceDay }: Readonly<{ completed: boolean; isGraceDay: boolean }>) {
  if (isGraceDay) return <span className="inline-block w-3 h-3 bg-yellow-500/50 rounded-sm" title="Grace day" />
  if (completed) return <span className="inline-block w-3 h-3 bg-green-500 rounded-sm" title="Completed" />
  return <span className="inline-block w-3 h-3 bg-cream-500/20 rounded-sm" title="Missed" />
}

export default function AdminTamagotchiPage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [completers, setCompleters] = useState<Completer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<UserResult[]>([])
  const [searching, setSearching] = useState(false)

  const [recomputing, setRecomputing] = useState(false)
  const [recomputeResult, setRecomputeResult] = useState<string | null>(null)

  const fetchStats = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/tamagotchi/stats')
      if (!res.ok) throw new Error('Failed to load stats')
      const data = await res.json()
      setStats(data.stats)
      setCompleters(data.completers)
    } catch {
      setError('Failed to load tamagotchi stats.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchStats() }, [fetchStats])

  const handleSearch = useCallback(async () => {
    const q = searchQuery.trim()
    if (q.length < 2) { setSearchResults([]); return }
    setSearching(true)
    try {
      const res = await fetch(`/api/admin/tamagotchi/user-search?q=${encodeURIComponent(q)}`)
      if (res.ok) {
        const data = await res.json()
        setSearchResults(data.users)
      }
    } catch { /* ignore */ } finally {
      setSearching(false)
    }
  }, [searchQuery])

  const handleRecompute = async () => {
    if (!confirm('Recompute streak rewards for all users who may have completed but have no StreakReward? This is safe to run multiple times.')) return
    setRecomputing(true)
    setRecomputeResult(null)
    try {
      const res = await fetch('/api/admin/tamagotchi/recompute-rewards', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        setRecomputeResult(`Checked ${data.candidatesChecked} candidates, created ${data.rewardsCreated} new rewards.`)
        fetchStats()
      } else {
        setRecomputeResult('Failed to recompute.')
      }
    } catch {
      setRecomputeResult('Network error.')
    } finally {
      setRecomputing(false)
    }
  }

  const exportCsv = () => {
    const header = 'name,email,slackId,timezone,completedAt,claimed,shipped'
    const rows = completers.map((c) =>
      [
        `"${(c.name ?? '').replace(/"/g, '""')}"`,
        c.email,
        c.slackId ?? '',
        c.timezone ?? '',
        c.completedAt,
        c.claimed,
        c.shipped,
      ].join(',')
    )
    const csv = [header, ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `tamagotchi-completers-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return (
      <div className="p-8 text-center">
        <div className="flex items-center justify-center"><div className="loader" /></div>
      </div>
    )
  }

  if (error || !stats) {
    return (
      <div className="p-8 text-center">
        <p className="text-red-600 text-sm">{error ?? 'Unknown error'}</p>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-orange-500 text-2xl uppercase tracking-wide">Tamagotchi Streak Challenge</h1>
        <p className="text-cream-200 text-sm mt-1">
          {stats.eventStart} &mdash; {stats.eventEnd} &middot; {stats.streakGoal}-day streak goal
        </p>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard label="Participants" value={stats.totalParticipants} />
        <StatCard label="Completed" value={stats.totalCompleted} />
        <StatCard label="Claimed" value={stats.totalClaimed} />
        <StatCard label="Shipped" value={stats.totalShipped} />
        <StatCard label="Grace days granted" value={stats.totalGraceDays} />
      </div>

      {/* Recompute + Export */}
      <div className="flex flex-wrap gap-3 items-center">
        <button
          onClick={handleRecompute}
          disabled={recomputing}
          className="bg-brown-800 border-2 border-cream-500/20 hover:border-orange-500 text-cream-50 px-4 py-2 text-sm uppercase tracking-wider transition-colors cursor-pointer disabled:opacity-50"
        >
          {recomputing ? 'Recomputing...' : 'Recompute missing rewards'}
        </button>
        <button
          onClick={exportCsv}
          disabled={completers.length === 0}
          className="bg-orange-500 hover:bg-orange-400 text-white px-4 py-2 text-sm uppercase tracking-wider transition-colors cursor-pointer disabled:opacity-50"
        >
          Export completers CSV
        </button>
        {recomputeResult && <p className="text-cream-200 text-sm">{recomputeResult}</p>}
      </div>

      {/* User search */}
      <div className="bg-brown-800 border-2 border-cream-500/20 p-6">
        <h2 className="text-cream-50 text-lg uppercase tracking-wide mb-3">User lookup</h2>
        <form
          onSubmit={(e) => { e.preventDefault(); handleSearch() }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by name, email, or Slack ID..."
            className="flex-1 bg-brown-900 border border-cream-500/20 text-cream-50 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={searching || searchQuery.trim().length < 2}
            className="bg-orange-500 hover:bg-orange-400 text-white px-4 py-2 text-sm uppercase tracking-wider transition-colors cursor-pointer disabled:opacity-50"
          >
            {searching ? '...' : 'Search'}
          </button>
        </form>

        {searchResults.length > 0 && (
          <div className="mt-4 space-y-3">
            {searchResults.map((user) => (
              <div key={user.id} className="bg-brown-900 border border-cream-500/20 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                  <div>
                    <p className="text-cream-50 font-medium">{user.name ?? 'No name'}</p>
                    <p className="text-cream-200 text-xs">{user.email}{user.slackId ? ` \u00b7 ${user.slackId}` : ''}</p>
                  </div>
                  <div className="text-right">
                    {user.challengeComplete ? (
                      <span className="text-green-500 text-xs uppercase font-bold">Completed</span>
                    ) : (
                      <span className="text-cream-200 text-xs uppercase">Not completed</span>
                    )}
                    {user.reward && (
                      <p className="text-cream-200 text-xs">
                        {user.reward.claimed ? 'Claimed' : 'Unclaimed'}
                        {user.reward.shipped ? ' \u00b7 Shipped' : ''}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-cream-200 mb-2">
                  <span>Best streak: <span className="text-cream-50">{user.bestStreak}</span></span>
                  <span>Current streak: <span className="text-cream-50">{user.currentStreak}</span></span>
                  <span>Journaled days: <span className="text-cream-50">{user.totalJournaledDays}</span></span>
                  <span>Sessions: <span className="text-cream-50">{user.totalSessions}</span></span>
                  {user.graceDays > 0 && <span>Grace days: <span className="text-cream-50">{user.graceDays}</span></span>}
                  {user.timezone && <span>TZ: <span className="text-cream-50">{user.timezone}</span></span>}
                </div>
                <div className="flex gap-1 items-center flex-wrap">
                  {user.days.map((d) => (
                    <DayDot key={d.date} completed={d.completed} isGraceDay={d.isGraceDay} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Completers table */}
      <div className="bg-brown-800 border-2 border-cream-500/20 overflow-x-auto">
        <div className="px-4 py-3 border-b-2 border-cream-500/20">
          <h2 className="text-cream-50 text-lg uppercase tracking-wide">
            Completers ({completers.length})
          </h2>
        </div>
        {completers.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-cream-200 text-sm">No completers yet.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-cream-500/20">
                <th className="text-left text-cream-200 text-xs uppercase px-4 py-3">Name</th>
                <th className="text-left text-cream-200 text-xs uppercase px-4 py-3">Email</th>
                <th className="text-left text-cream-200 text-xs uppercase px-4 py-3">Slack ID</th>
                <th className="text-left text-cream-200 text-xs uppercase px-4 py-3">TZ</th>
                <th className="text-left text-cream-200 text-xs uppercase px-4 py-3">Completed</th>
                <th className="text-left text-cream-200 text-xs uppercase px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {completers.map((c) => (
                <tr key={c.userId} className="border-b border-cream-500/10 last:border-b-0 hover:bg-brown-900/50">
                  <td className="px-4 py-3 text-cream-50">{c.name ?? '—'}</td>
                  <td className="px-4 py-3 text-cream-200 text-xs">{c.email}</td>
                  <td className="px-4 py-3 text-cream-200 text-xs font-mono">{c.slackId ?? '—'}</td>
                  <td className="px-4 py-3 text-cream-200 text-xs">{c.timezone ?? '—'}</td>
                  <td className="px-4 py-3 text-cream-200 text-xs whitespace-nowrap">
                    {new Date(c.completedAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    {c.shipped ? (
                      <span className="text-green-500 text-xs uppercase">Shipped</span>
                    ) : c.claimed ? (
                      <span className="text-orange-500 text-xs uppercase">Claimed</span>
                    ) : (
                      <span className="text-cream-200 text-xs uppercase">Unclaimed</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

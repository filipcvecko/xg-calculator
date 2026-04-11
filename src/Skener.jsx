import { useState, useEffect, useRef } from 'react'
import { supabase } from './supabase'
import {
  calcOverUnder, calcOU30,
  blendLambda, fairOdds, plattCalibrate,
  dynamicRho, timeDecayBlend, extractLastXStats,
  fmt2, fmt3, fmtPct, fmtSign,
} from './math'

// ─── constants ────────────────────────────────────────────────────────────────
const COMM        = 0.05
const XG_SCALER   = 0.90
const ALPHA       = 0.70
const SHRINKAGE   = 0.15
const FORM_WEIGHT = 0.40
const FORM_WINDOW = 5
const EV_MIN     = 0.08   // 8% — threshold for Telegram notification
const WATCH_INTERVAL_MS = 30_000

// ─── math helpers (identical to App.jsx) ─────────────────────────────────────
function calcBackEV(prob, odds, comm = COMM) {
  if (!prob || !odds || odds <= 1) return null
  return prob * (odds - 1) * (1 - comm) - (1 - prob)
}

function blendWithGoals(xgH, xgA, xgaH, xgaA, gfH, gaH, gfA, gaA, alpha) {
  const a = alpha
  const lH = Math.sqrt((a * xgH + (1 - a) * gfH) * (a * xgaA + (1 - a) * gaA))
  const lA = Math.sqrt((a * xgA + (1 - a) * gfA) * (a * xgaH + (1 - a) * gaH))
  return { lH, lA }
}

function applyShrinkage(lH, lA, lgAvgH, lgAvgA) {
  const rawTotal  = lH + lA
  const lgTotal   = lgAvgH + lgAvgA
  if (rawTotal <= 0) return { lH, lA }
  const ratio = ((1 - SHRINKAGE) * rawTotal + SHRINKAGE * lgTotal) / rawTotal
  return { lH: lH * ratio, lA: lA * ratio }
}

function extractTeamStats(team) {
  const s = team?.stats || team || {}
  const get = (...keys) => {
    for (const k of keys) {
      if (s[k] != null && s[k] !== '') return s[k]
    }
    return null
  }
  const xgH  = get('xg_for_avg_home',     'xg_for_avg',     'seasonXG_home',    'xGFor_home',    'xg_for_avg_overall')
  const xgA  = get('xg_for_avg_away',                        'seasonXG_away',    'xGFor_away',    'xg_for_avg_overall')
  const xgaH = get('xg_against_avg_home', 'xg_against_avg', 'seasonXGC_home',   'xGAgainst_home','xg_against_avg_overall')
  const xgaA = get('xg_against_avg_away',                    'seasonXGC_away',   'xGAgainst_away','xg_against_avg_overall')
  const gfH  = get('seasonScoredAVG_home',   'scored_home',   'seasonGoals_home')
  const gfA  = get('seasonScoredAVG_away',   'scored_away',   'seasonGoals_away')
  const gaH  = get('seasonConcededAVG_home', 'conceded_home', 'seasonConceded_home')
  const gaA  = get('seasonConcededAVG_away', 'conceded_away', 'seasonConceded_away')
  return {
    xgH:  xgH  != null ? +parseFloat(xgH).toFixed(2)  : null,
    xgA:  xgA  != null ? +parseFloat(xgA).toFixed(2)  : null,
    xgaH: xgaH != null ? +parseFloat(xgaH).toFixed(2) : null,
    xgaA: xgaA != null ? +parseFloat(xgaA).toFixed(2) : null,
    gfH:  gfH  != null ? +parseFloat(gfH).toFixed(2)  : null,
    gfA:  gfA  != null ? +parseFloat(gfA).toFixed(2)  : null,
    gaH:  gaH  != null ? +parseFloat(gaH).toFixed(2)  : null,
    gaA:  gaA  != null ? +parseFloat(gaA).toFixed(2)  : null,
    mp_h: +(s.seasonMatchesPlayed_home || 0),
    mp_a: +(s.seasonMatchesPlayed_away || 0),
  }
}

function calcMatchFromStats(homeRaw, awayRaw, lgAvg, homeLastXRaw = null, awayLastXRaw = null, _homeId = null, _awayId = null, _label = null) {
  const hs  = extractTeamStats(homeRaw)
  const as_ = extractTeamStats(awayRaw)

  const h  = (hs.xgH  ?? hs.gfH  ?? 0) * XG_SCALER
  const a  = (as_.xgA ?? as_.gfA ?? 0) * XG_SCALER
  if (!h || !a) return null

  const ha = (hs.xgaH ?? hs.gaH ?? 0) * XG_SCALER
  const aa = (as_.xgaA ?? as_.gaA ?? 0) * XG_SCALER

  const gfHv = hs.gfH ?? 0, gaHv = hs.gaH ?? 0
  const gfAv = as_.gfA ?? 0, gaAv = as_.gaA ?? 0

  const hasGoals = gfHv > 0 && gaHv > 0 && gfAv > 0 && gaAv > 0
  const hasXGA   = ha > 0 && aa > 0

  let lH, lA
  if (hasGoals && hasXGA) {
    const r = blendWithGoals(h, a, ha, aa, gfHv, gaHv, gfAv, gaAv, ALPHA)
    lH = r.lH; lA = r.lA
  } else if (hasGoals) {
    const r = blendWithGoals(h, a, h, a, gfHv, gaHv, gfAv, gaAv, ALPHA)
    lH = r.lH; lA = r.lA
  } else if (hasXGA) {
    lH = blendLambda(h, aa); lA = blendLambda(a, ha)
  } else {
    lH = h; lA = a
  }

  const lH_blend = lH, lA_blend = lA

  // form blend — identical to App.jsx handleCalc
  const homeForm = homeLastXRaw ? extractLastXStats(homeLastXRaw, FORM_WINDOW) : null
  const awayForm = awayLastXRaw ? extractLastXStats(awayLastXRaw, FORM_WINDOW) : null
  let formLH = null, formLA = null
  if (homeForm || awayForm) {
    if (homeForm) {
      const fxgH  = homeForm.xgH ?? homeForm.gfH ?? null
      const fxgaA = awayForm?.xgaA ?? awayForm?.gaA ?? null
      if (fxgH != null) {
        formLH = fxgaA != null ? Math.sqrt(fxgH * fxgaA) : fxgH
        lH = timeDecayBlend(lH, formLH, FORM_WEIGHT)
      }
    }
    if (awayForm) {
      const fxgA  = awayForm.xgA ?? awayForm.gfA ?? null
      const fxgaH = homeForm?.xgaH ?? homeForm?.gaH ?? null
      if (fxgA != null) {
        formLA = fxgaH != null ? Math.sqrt(fxgA * fxgaH) : fxgA
        lA = timeDecayBlend(lA, formLA, FORM_WEIGHT)
      }
    }
  }

  const lH_form = lH, lA_form = lA

  const lgH = lgAvg?.avgHome ?? 0
  const lgA = lgAvg?.avgAway ?? 0
  if (lgH > 0 && lgA > 0) {
    const r = applyShrinkage(lH, lA, lgH, lgA)
    lH = r.lH; lA = r.lA
  }

  const rhoVal = (lgH > 0 && lgA > 0) ? dynamicRho(lgH, lgA) : -0.10
  const { pOver: pOverRaw, pUnder: pUnderRaw } = calcOverUnder(lH, lA, rhoVal)
  const ou30       = calcOU30(lH, lA, rhoVal)
  const pOver      = plattCalibrate(pOverRaw)
  const pUnder     = plattCalibrate(pUnderRaw)

  if (_label) {
    const hxRaw = homeLastXRaw?.data?.[0]?.stats
    const axRaw = awayLastXRaw?.data?.[0]?.stats
    console.log(`[Skener:calc] ${_label}
  teamIDs: home=${_homeId} away=${_awayId}
  lastX loaded: home=${!!homeLastXRaw} away=${!!awayLastXRaw}
  lastX raw home xg_for_avg_home=${hxRaw?.xg_for_avg_home} xg_against_avg_away=${hxRaw?.xg_against_avg_away}
  lastX raw away xg_for_avg_away=${axRaw?.xg_for_avg_away} xg_against_avg_home=${axRaw?.xg_against_avg_home}
  homeForm: xgH=${homeForm?.xgH} xgaH=${homeForm?.xgaH} gfH=${homeForm?.gfH} gaH=${homeForm?.gaH}
  awayForm: xgA=${awayForm?.xgA} xgaA=${awayForm?.xgaA} gfA=${awayForm?.gfA} gaA=${awayForm?.gaA}
  formLH=${formLH?.toFixed(4)}  formLA=${formLA?.toFixed(4)}
  xgH=${hs.xgH}  xgA=${as_.xgA}  xgaH=${hs.xgaH}  xgaA=${as_.xgaA}
  gfH=${gfHv}  gaH=${gaHv}  gfA=${gfAv}  gaA=${gaAv}
  h=${h.toFixed(4)}  a=${a.toFixed(4)}  ha=${ha.toFixed(4)}  aa=${aa.toFixed(4)}
  hasGoals=${hasGoals}  hasXGA=${hasXGA}
  lH_blend=${lH_blend.toFixed(4)}  lA_blend=${lA_blend.toFixed(4)}
  lH_form=${lH_form.toFixed(4)}  lA_form=${lA_form.toFixed(4)}
  lgH=${lgH}  lgA=${lgA}
  lH_shrink=${lH.toFixed(4)}  lA_shrink=${lA.toFixed(4)}
  rho=${rhoVal.toFixed(4)}  pOverRaw=${pOverRaw.toFixed(4)}  pOver(platt)=${pOver.toFixed(4)}`)
  }

  return {
    lH, lA, rhoVal,
    pOver, pUnder,
    ferOver:  fairOdds(pOver),
    ferUnder: fairOdds(pUnder),
    ou30,
    modelType: hasGoals ? (hasXGA ? 'full' : 'goals') : (hasXGA ? 'xga' : 'basic'),
    mp_h: hs.mp_h, mp_a: as_.mp_a,
  }
}

// ─── API fetchers ─────────────────────────────────────────────────────────────

// fetch all teams for a season via league-teams (same as App.jsx fetchTeamNamesForSeason)
// returns cache entries: `${teamId}_${seasonId}` → statsRaw (t.stats || t)
async function fetchLeagueTeams(seasonId) {
  try {
    const res  = await fetch(`/api/footystats?endpoint=league-teams&season_id=${seasonId}&include=stats`)
    if (!res.ok) return {}
    const json = await res.json()
    const teams = json?.data ?? []
    const map = {}
    for (const t of teams) {
      const tid = String(t.id)
      map[`${tid}_${seasonId}`] = t.stats || t
    }
    return map
  } catch { return {} }
}

async function fetchLastX(teamId) {
  try {
    const res  = await fetch(`/api/footystats?endpoint=lastx&team_id=${teamId}`)
    if (!res.ok) return null
    const json = await res.json()
    return json || null
  } catch { return null }
}

// fetch lastX for all unique team IDs, return cache map: teamId → lastX data
async function fetchAllLastX(matches, batchSize = 20) {
  const ids  = [...new Set(
    matches.flatMap(m => [m.homeID, m.awayID]).filter(Boolean).map(String)
  )]
  const cache = {}
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch   = ids.slice(i, i + batchSize)
    const results = await Promise.all(batch.map(id => fetchLastX(id)))
    batch.forEach((id, j) => { if (results[j]) cache[id] = results[j] })
  }
  return cache
}

// fetch stats for all teams in all seasons — one league-teams call per unique season
async function fetchAllTeamStats(matches) {
  const seasonIds = [...new Set(matches.map(m => m.competition_id).filter(Boolean))]
  const results   = await Promise.all(seasonIds.map(sid => fetchLeagueTeams(sid)))
  return Object.assign({}, ...results)
}

async function fetchTodaysMatches(dateStr) {
  try {
    const base = '/api/footystats?endpoint=todays-matches&chosen_leagues_only=true&max_per_page=300'
      + (dateStr ? `&date=${dateStr}` : '')
    const res  = await fetch(base + '&page=1')
    if (!res.ok) return []
    const json = await res.json()
    const maxPage = json?.pager?.max_page ?? 1
    let data = json?.data ?? []
    if (maxPage > 1) {
      const pages   = Array.from({ length: maxPage - 1 }, (_, i) => i + 2)
      const results = await Promise.all(pages.map(p => fetch(base + `&page=${p}`).then(r => r.ok ? r.json() : null)))
      for (const r of results) if (r?.data) data = data.concat(r.data)
    }
    return data
  } catch { return [] }
}


async function fetchLeagueAvg(seasonId) {
  try {
    const res  = await fetch(`/api/footystats?endpoint=league-season&season_id=${seasonId}&stats=true`)
    if (!res.ok) return null
    const json = await res.json()
    const data = json?.data
    console.log(`[fetchLeagueAvg] seasonId=${seasonId} json keys:`, Object.keys(json ?? {}), '| data keys:', Object.keys(data ?? {}), '| data sample:', JSON.stringify(data).slice(0, 300))
    if (!data) return null
    const avgHome = data.seasonAVG_home ?? data.avg_goals_home ?? data.avgGoalsPerMatch_home ?? null
    const avgAway = data.seasonAVG_away ?? data.avg_goals_away ?? data.avgGoalsPerMatch_away ?? null
    const name = data.name ?? data.league_name ?? data.competition_name ?? null
    const avg = (avgHome && avgAway) ? { avgHome: +avgHome, avgAway: +avgAway } : null
    return { avg, name }
  } catch { return null }
}

async function fetchBetfairUpcoming() {
  try {
    const res  = await fetch('/api/betsapi?endpoint=betfair%2Fupcoming&sport_id=1')
    if (!res.ok) return []
    const json = await res.json()
    return json?.results ?? []
  } catch { return [] }
}

async function fetchBetfairEvent(eventId) {
  try {
    const res  = await fetch(`/api/betsapi?endpoint=betfair%2Fevent&event_id=${eventId}`)
    if (!res.ok) return null
    const json = await res.json()
    return json?.results ?? null
  } catch { return null }
}

function extractOU25Odds(eventData) {
  // event may be an object with markets array, or array of markets
  const markets = Array.isArray(eventData)
    ? eventData
    : (eventData?.markets ?? eventData?.mc ?? [])
  const ouMarket = markets.find(m =>
    String(m.marketName ?? m.marketCatalogue?.marketName ?? '').toLowerCase().includes('2.5')
  )
  if (!ouMarket) return null
  const runners   = ouMarket.runnerDetails ?? ouMarket.runners ?? []
  const backOver  = +(runners[0]?.runnerOdds?.decimalDisplayOdds?.decimalOdds ?? 0)
  const backUnder = +(runners[1]?.runnerOdds?.decimalDisplayOdds?.decimalOdds ?? 0)
  return {
    backOver:  backOver  > 1 ? backOver  : null,
    backUnder: backUnder > 1 ? backUnder : null,
  }
}

async function sendTelegram(message) {
  try {
    await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    })
  } catch {}
}

function buildTelegramMsg(match, calc, bfOdds, evOver, evUnder) {
  const home = match.home_name ?? match.homeName ?? '?'
  const away = match.away_name ?? match.awayName ?? '?'
  const league = match.competition_name ?? match.league_name ?? ''
  const lines = [`<b>${home} vs ${away}</b>`]
  if (league) lines.push(`<i>${league}</i>`)
  lines.push(`λH: ${fmt3(calc.lH)} | λA: ${fmt3(calc.lA)}`)
  if (evOver != null && evOver >= EV_MIN) {
    lines.push(`🟢 BACK OVER 2.5 @ ${fmt2(bfOdds.backOver)} | EV: <b>${fmtSign(evOver * 100)}%</b>`)
    lines.push(`P(Over): ${fmtPct(calc.pOver * 100)} | Fair: ${calc.ferOver ? fmt2(calc.ferOver) : '—'}`)
  }
  if (evUnder != null && evUnder >= EV_MIN) {
    lines.push(`🔵 BACK UNDER 2.5 @ ${fmt2(bfOdds.backUnder)} | EV: <b>${fmtSign(evUnder * 100)}%</b>`)
    lines.push(`P(Under): ${fmtPct(calc.pUnder * 100)} | Fair: ${calc.ferUnder ? fmt2(calc.ferUnder) : '—'}`)
  }
  return lines.join('\n')
}

// ─── localStorage cache ───────────────────────────────────────────────────────
function cacheKey(date) { return `skener_cache_${date}` }

function loadCache(date) {
  try {
    const raw = localStorage.getItem(cacheKey(date))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.matches || !parsed?.results) return null
    return parsed
  } catch { return null }
}

function saveCache(date, matches, results, lgNameMap) {
  try {
    localStorage.setItem(cacheKey(date), JSON.stringify({ matches, results, lgNameMap }))
  } catch {}
}

function clearCache(date) {
  try { localStorage.removeItem(cacheKey(date)) } catch {}
}

// ─── utils ────────────────────────────────────────────────────────────────────
function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtKO(unix) {
  if (!unix) return '—'
  return new Date(unix * 1000).toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' })
}

function evColor(ev) {
  if (ev == null) return 'var(--text3)'
  if (ev >= EV_MIN) return 'var(--green)'
  if (ev >= 0.04)   return '#fdcb6e'
  if (ev >= 0)      return 'var(--text2)'
  return 'var(--red)'
}

// ─── sub-components ───────────────────────────────────────────────────────────
function ModelBadge({ type }) {
  const map = { full: ['FULL', 'var(--accent2)'], goals: ['GF/GA', 'var(--green)'], xga: ['xGA', '#fdcb6e'], basic: ['BASIC', 'var(--text3)'] }
  const [label, color] = map[type] ?? map.basic
  return (
    <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, border: `1px solid ${color}`, color, fontFamily: 'var(--mono)', letterSpacing: '0.08em', marginLeft: 6 }}>
      {label}
    </span>
  )
}

function EVRow({ label, ev, odds, p, fairO }) {
  const color = evColor(ev)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--bg3)', borderRadius: 6, borderLeft: `3px solid ${color}` }}>
      <div style={{ minWidth: 80, fontSize: 11, fontWeight: 700, color: 'var(--text2)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--display)', fontSize: 20, fontWeight: 800, color }}>
        {ev != null ? fmtSign(ev * 100) + '%' : '—'}
      </div>
      <div style={{ flex: 1, fontSize: 10, color: 'var(--text3)', lineHeight: 1.5 }}>
        <div>@ <b style={{ color: 'var(--text2)' }}>{odds ? fmt2(odds) : '—'}</b></div>
        <div>P: {fmtPct(p * 100)} · fair {fairO ? fmt2(fairO) : '—'}</div>
      </div>
      {ev != null && ev >= EV_MIN && (
        <div style={{ fontSize: 10, padding: '3px 8px', borderRadius: 4, background: 'rgba(0,184,148,0.15)', color: 'var(--green)', fontWeight: 700, whiteSpace: 'nowrap' }}>
          EV ✓
        </div>
      )}
    </div>
  )
}

function MatchCard({ match, calc, bfOdds, evOver, evUnder, isWatched, isSaving, onWatch, onBack, leagueName }) {
  const [expanded,     setExpanded]     = useState(false)
  const [manualOver,   setManualOver]   = useState('')
  const [manualUnder,  setManualUnder]  = useState('')
  const [pinnOpen,     setPinnOpen]     = useState('')

  const pf = v => { const n = parseFloat(v); return n > 1 ? n : null }
  const mOver  = pf(manualOver)
  const mUnder = pf(manualUnder)
  const mEvOver  = calc && mOver  ? calcBackEV(calc.pOver,  mOver,  COMM) : null
  const mEvUnder = calc && mUnder ? calcBackEV(calc.pUnder, mUnder, COMM) : null
  const homeName = match.home_name ?? match.homeName ?? '?'
  const awayName = match.away_name ?? match.awayName ?? '?'
  const koTime   = fmtKO(match.date_unix)
  const hasEV    = (evOver != null && evOver >= EV_MIN) || (evUnder != null && evUnder >= EV_MIN)

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', borderLeft: hasEV ? '3px solid var(--green)' : undefined }}>
      {/* header row */}
      <div
        style={{ padding: '12px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}
        onClick={() => setExpanded(e => !e)}
      >
        <div style={{ fontSize: 10, color: 'var(--text3)', minWidth: 32, fontFamily: 'var(--mono)' }}>{koTime}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {homeName} <span style={{ color: 'var(--text3)' }}>vs</span> {awayName}
            {isWatched && <span style={{ fontSize: 9, marginLeft: 8, color: '#fdcb6e', fontFamily: 'var(--mono)' }}>● LIVE</span>}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
            {leagueName ?? match.competition_name ?? match.league_name ?? match.league?.name ?? ''}
            {calc && <ModelBadge type={calc.modelType} />}
          </div>
        </div>

        {/* quick stats */}
        {!calc && <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>načítavam…</div>}
        {calc && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 9, color: 'var(--text3)' }}>O2.5</div>
              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--accent2)', fontFamily: 'var(--display)' }}>{fmtPct(calc.pOver * 100)}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 9, color: 'var(--text3)' }}>O3.0</div>
              <div style={{ fontSize: 13, fontWeight: 800, color: '#a29bfe', fontFamily: 'var(--display)' }}>{fmtPct(calc.ou30.pOver3 * 100)}</div>
            </div>
            {evOver != null && (
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 9, color: 'var(--text3)' }}>EV▲</div>
                <div style={{ fontSize: 13, fontWeight: 800, color: evColor(evOver), fontFamily: 'var(--display)' }}>{fmtSign(evOver * 100)}%</div>
              </div>
            )}
            <div style={{ color: 'var(--text3)', fontSize: 12 }}>{expanded ? '▲' : '▼'}</div>
          </div>
        )}
      </div>

      {/* expanded detail */}
      {expanded && calc && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* lambdas */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ flex: 1, background: 'var(--bg3)', borderRadius: 6, padding: '8px 12px', textAlign: 'center' }}>
              <div style={{ fontSize: 9, color: 'var(--text3)', letterSpacing: '0.1em' }}>λ HOME</div>
              <div style={{ fontSize: 18, fontWeight: 800, fontFamily: 'var(--display)' }}>{fmt3(calc.lH)}</div>
              {calc.mp_h > 0 && <div style={{ fontSize: 9, color: 'var(--text3)' }}>{calc.mp_h} záp.</div>}
            </div>
            <div style={{ fontSize: 14, color: 'var(--text3)', fontWeight: 700 }}>vs</div>
            <div style={{ flex: 1, background: 'var(--bg3)', borderRadius: 6, padding: '8px 12px', textAlign: 'center' }}>
              <div style={{ fontSize: 9, color: 'var(--text3)', letterSpacing: '0.1em' }}>λ AWAY</div>
              <div style={{ fontSize: 18, fontWeight: 800, fontFamily: 'var(--display)' }}>{fmt3(calc.lA)}</div>
              {calc.mp_a > 0 && <div style={{ fontSize: 9, color: 'var(--text3)' }}>{calc.mp_a} záp.</div>}
            </div>
            <div style={{ background: 'var(--bg3)', borderRadius: 6, padding: '8px 10px', textAlign: 'center' }}>
              <div style={{ fontSize: 9, color: 'var(--text3)' }}>ρ</div>
              <div style={{ fontSize: 12, fontWeight: 700, fontFamily: 'var(--mono)' }}>{fmt3(calc.rhoVal)}</div>
            </div>
          </div>

          {/* O/U 2.5 probs */}
          <div>
            <div style={{ fontSize: 9, color: 'var(--text3)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 6 }}>Over / Under 2.5</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div style={{ background: 'var(--bg3)', borderRadius: 6, padding: '10px 12px', borderTop: '2px solid var(--accent)' }}>
                <div style={{ fontSize: 9, color: 'var(--text3)', letterSpacing: '0.1em' }}>OVER 2.5</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--accent2)', fontFamily: 'var(--display)' }}>{fmtPct(calc.pOver * 100)}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>fair {calc.ferOver ? fmt2(calc.ferOver) : '—'}</div>
              </div>
              <div style={{ background: 'var(--bg3)', borderRadius: 6, padding: '10px 12px', borderTop: '2px solid var(--green)' }}>
                <div style={{ fontSize: 9, color: 'var(--text3)', letterSpacing: '0.1em' }}>UNDER 2.5</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--green)', fontFamily: 'var(--display)' }}>{fmtPct(calc.pUnder * 100)}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>fair {calc.ferUnder ? fmt2(calc.ferUnder) : '—'}</div>
              </div>
            </div>
          </div>

          {/* O/U 3.0 probs */}
          <div>
            <div style={{ fontSize: 9, color: 'var(--text3)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 6 }}>Over / Under 3.0 (s push)</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div style={{ background: 'var(--bg3)', borderRadius: 6, padding: '10px 12px', borderTop: '2px solid #a29bfe' }}>
                <div style={{ fontSize: 9, color: 'var(--text3)', letterSpacing: '0.1em' }}>OVER 3.0</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#a29bfe', fontFamily: 'var(--display)' }}>{fmtPct(calc.ou30.pOver3 * 100)}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                  fair {calc.ou30.fairOver ? fmt2(calc.ou30.fairOver) : '—'}
                  <span style={{ marginLeft: 6, opacity: 0.6 }}>push {fmtPct(calc.ou30.pExact3 * 100)}</span>
                </div>
              </div>
              <div style={{ background: 'var(--bg3)', borderRadius: 6, padding: '10px 12px', borderTop: '2px solid #00b894' }}>
                <div style={{ fontSize: 9, color: 'var(--text3)', letterSpacing: '0.1em' }}>UNDER 3.0</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#00b894', fontFamily: 'var(--display)' }}>{fmtPct(calc.ou30.pUnder2 * 100)}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                  fair {calc.ou30.fairUnder ? fmt2(calc.ou30.fairUnder) : '—'}
                  <span style={{ marginLeft: 6, opacity: 0.6 }}>push {fmtPct(calc.ou30.pExact3 * 100)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Betfair EV sekcia */}
          <div>
            <div style={{ fontSize: 9, color: 'var(--text3)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 6 }}>
              Betfair O/U 2.5 — EV (Back, 5% comm)
              {!bfOdds && <span style={{ marginLeft: 8, opacity: 0.5 }}>kurzy nedostupné</span>}
            </div>
            {bfOdds && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <EVRow
                  label="Back Over"
                  ev={evOver}
                  odds={bfOdds.backOver}
                  p={calc.pOver}
                  fairO={calc.ferOver}
                />
                <EVRow
                  label="Back Under"
                  ev={evUnder}
                  odds={bfOdds.backUnder}
                  p={calc.pUnder}
                  fairO={calc.ferUnder}
                />
              </div>
            )}
          </div>

          {/* manuálny vstup kurzov */}
          <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 9, color: 'var(--text3)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 2 }}>
              Manuálne kurzy
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <div>
                <div style={{ fontSize: 9, color: 'var(--text3)', marginBottom: 3 }}>Betfair Back Over 2.5</div>
                <input
                  className="inp inp-sm"
                  type="number" step="0.01" placeholder="napr. 2.10"
                  value={manualOver}
                  onChange={e => setManualOver(e.target.value)}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <div style={{ fontSize: 9, color: 'var(--text3)', marginBottom: 3 }}>Betfair Back Under 2.5</div>
                <input
                  className="inp inp-sm"
                  type="number" step="0.01" placeholder="napr. 1.85"
                  value={manualUnder}
                  onChange={e => setManualUnder(e.target.value)}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <div style={{ fontSize: 9, color: 'var(--text3)', marginBottom: 3 }}>Pinnacle Open (voliteľné)</div>
                <input
                  className="inp inp-sm"
                  type="number" step="0.001" placeholder="napr. 2.050"
                  value={pinnOpen}
                  onChange={e => setPinnOpen(e.target.value)}
                  style={{ width: '100%' }}
                />
                {(() => {
                  const pp = pf(pinnOpen)
                  if (!pp) return null
                  const lines = []
                  if (mOver) {
                    const clv = (mOver / pp - 1) * 100
                    lines.push({ label: 'CLV Over', clv })
                  }
                  if (mUnder) {
                    const clv = (mUnder / pp - 1) * 100
                    lines.push({ label: 'CLV Under', clv })
                  }
                  if (lines.length === 0) return null
                  return (
                    <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {lines.map(({ label, clv }) => (
                        <div key={label} style={{ fontSize: 10, fontWeight: 700, color: clv >= 0 ? 'var(--green)' : 'var(--red)' }}>
                          {label}: {clv >= 0 ? '+' : ''}{clv.toFixed(1)}%
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </div>
            </div>

            {(mOver || mUnder) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                {mOver && (
                  <EVRow
                    label="Back Over 2.5"
                    ev={mEvOver}
                    odds={mOver}
                    p={calc.pOver}
                    fairO={calc.ferOver}
                  />
                )}
                {mUnder && (
                  <EVRow
                    label="Back Under 2.5"
                    ev={mEvUnder}
                    odds={mUnder}
                    p={calc.pUnder}
                    fairO={calc.ferUnder}
                  />
                )}
              </div>
            )}
          </div>

          {/* akčné tlačidlá */}
          <div style={{ display: 'flex', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
            <button
              className="btn-ghost"
              style={{ fontSize: 10, padding: '7px 14px', color: isWatched ? '#fdcb6e' : 'var(--text2)', borderColor: isWatched ? 'rgba(253,203,110,0.5)' : undefined }}
              onClick={() => onWatch(match.id)}
            >
              {isWatched ? '■ Stop sledovanie' : '▶ Sledovať (30s)'}
            </button>

            {bfOdds?.backOver && (
              <button
                className="btn-save-back"
                style={{ fontSize: 10, padding: '7px 14px', opacity: isSaving === 'over' ? 0.5 : 1 }}
                disabled={isSaving != null}
                onClick={() => onBack(match, calc, bfOdds.backOver, true, null)}
              >
                {isSaving === 'over' ? '…' : `+ Back Over @ ${fmt2(bfOdds.backOver)}`}
              </button>
            )}
            {bfOdds?.backUnder && (
              <button
                className="btn-save-back"
                style={{ fontSize: 10, padding: '7px 14px', opacity: isSaving === 'under' ? 0.5 : 1 }}
                disabled={isSaving != null}
                onClick={() => onBack(match, calc, bfOdds.backUnder, false, null)}
              >
                {isSaving === 'under' ? '…' : `+ Back Under @ ${fmt2(bfOdds.backUnder)}`}
              </button>
            )}
            {mOver && (
              <button
                className="btn-save-back"
                style={{ fontSize: 10, padding: '7px 14px', opacity: isSaving === 'over' ? 0.5 : 1,
                  background: mEvOver != null && mEvOver >= EV_MIN ? undefined : 'rgba(108,92,231,0.3)' }}
                disabled={isSaving != null}
                onClick={() => onBack(match, calc, mOver, true, pf(pinnOpen))}
              >
                {isSaving === 'over' ? '…' : `+ Back Over 2.5 @ ${fmt2(mOver)}`}
              </button>
            )}
            {mUnder && (
              <button
                className="btn-save-back"
                style={{ fontSize: 10, padding: '7px 14px', opacity: isSaving === 'under' ? 0.5 : 1,
                  background: mEvUnder != null && mEvUnder >= EV_MIN ? undefined : 'rgba(108,92,231,0.3)' }}
                disabled={isSaving != null}
                onClick={() => onBack(match, calc, mUnder, false, pf(pinnOpen))}
              >
                {isSaving === 'under' ? '…' : `+ Back Under 2.5 @ ${fmt2(mUnder)}`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── main component ───────────────────────────────────────────────────────────
export default function Skener() {
  const [date,       setDate]       = useState(todayStr())
  const [matches,    setMatches]    = useState([])
  const [lgNameMap,  setLgNameMap]  = useState({})    // competition_id (str) → league name
  const [results,    setResults]    = useState({})    // matchId → calc
  const [bfMap,      setBfMap]      = useState({})    // our_event_id (str) → betfairEventId
  const [bfOdds,     setBfOdds]     = useState({})    // matchId (str) → {backOver, backUnder}
  const [notified,   setNotified]   = useState(new Set())
  const [watched,    setWatched]    = useState(new Set())
  const [saving,     setSaving]     = useState({})    // matchId → 'over'|'under'
  const [loading,    setLoading]    = useState(false)
  const [progress,   setProgress]   = useState({ done: 0, total: 0 })

  // refs for stable closure in interval
  const abortRef   = useRef(false)
  const watchedRef = useRef(watched)
  const notifiedRef = useRef(notified)
  const resultsRef = useRef(results)
  const bfMapRef   = useRef(bfMap)
  const matchesRef = useRef(matches)

  useEffect(() => { watchedRef.current  = watched  }, [watched])
  useEffect(() => { notifiedRef.current = notified  }, [notified])
  useEffect(() => { resultsRef.current  = results   }, [results])
  useEffect(() => { bfMapRef.current    = bfMap     }, [bfMap])
  useEffect(() => { matchesRef.current  = matches   }, [matches])

  // 30s watch interval — only runs when there are watched matches
  useEffect(() => {
    if (watched.size === 0) return
    const id = setInterval(refreshWatchedOdds, WATCH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [watched]) // eslint-disable-line react-hooks/exhaustive-deps

  // initial load
  useEffect(() => {
    run(date)
    return () => { abortRef.current = true }
  }, [date]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── main load ──────────────────────────────────────────────────────────────
  async function run(d, forceRefresh = false) {
    abortRef.current = false
    setLoading(true)
    setMatches([])
    setResults({})
    setBfMap({})
    setBfOdds({})
    setLgNameMap({})
    setNotified(new Set())
    setWatched(new Set())
    setProgress({ done: 0, total: 0 })

    // try cache first (skip on forced refresh)
    if (!forceRefresh) {
      const cached = loadCache(d)
      if (cached) {
        console.log('[Skener] cache hit pre', d, '— preskakujem FootyStats API')
        const raw     = cached.matches
        const cachedR = cached.results
        setMatches(raw)
        setResults(cachedR)
        if (cached.lgNameMap) setLgNameMap(cached.lgNameMap)
        setProgress({ done: raw.length, total: raw.length })
        setLoading(false)

        // still fetch live Betfair odds (fast, 1-2 calls)
        const bfUpcoming = await fetchBetfairUpcoming()
        if (abortRef.current) return
        const newBfMap = {}
        for (const ev of bfUpcoming) {
          if (ev.our_event_id) newBfMap[String(ev.our_event_id)] = String(ev.id)
        }
        setBfMap(newBfMap)
        await Promise.all(raw.map(m => {
          const id        = String(m.id)
          const calc      = cachedR[id] ?? null
          const bfEventId = newBfMap[id]
          if (bfEventId && calc) return fetchAndApplyOdds(id, bfEventId, calc, false)
          return Promise.resolve()
        }))
        return
      }
    }

    const raw = await fetchTodaysMatches(d)
    if (abortRef.current) return
    setMatches(raw)
    setLoading(false)
    setProgress({ done: 0, total: raw.length })

    // competition_id in todays-matches IS the season_id for FootyStats team/league endpoints
    const seasonIds = [...new Set(raw.map(m => m.competition_id).filter(Boolean))]
    console.log('[Skener] competition_ids (season_ids):', seasonIds.length, seasonIds.slice(0, 3))
    console.log('[Skener] first match homeID/awayID:', raw[0]?.homeID, raw[0]?.awayID, 'competition_id:', raw[0]?.competition_id)

    // parallel: league avgs + betfair upcoming + team stats + lastX
    const [lgRawMap, bfUpcoming, teamCache, lastXCache] = await Promise.all([
      Promise.all(seasonIds.map(async sid => [sid, await fetchLeagueAvg(sid)])).then(Object.fromEntries),
      fetchBetfairUpcoming(),
      fetchAllTeamStats(raw),
      fetchAllLastX(raw),
    ])
    if (abortRef.current) return

    // split lgRawMap into avg map and name map
    const lgAvgMap  = {}
    const newNameMap = {}
    for (const [sid, entry] of Object.entries(lgRawMap)) {
      if (!entry) continue
      if (entry.avg)  lgAvgMap[sid]   = entry.avg
      if (entry.name) newNameMap[sid]  = entry.name
    }
    console.log('[Skener] newNameMap:', newNameMap)
    setLgNameMap(newNameMap)

    // build our_event_id → betfairEventId map
    const newBfMap = {}
    for (const ev of bfUpcoming) {
      if (ev.our_event_id) newBfMap[String(ev.our_event_id)] = String(ev.id)
    }
    setBfMap(newBfMap)

    // process all matches in parallel — all data cached
    const calcEntries = await Promise.all(raw.map(m => processMatch(m, lgAvgMap, newBfMap, teamCache, lastXCache)))

    // save results to localStorage after all matches processed
    const resultsMap = Object.fromEntries(calcEntries.filter(Boolean))
    saveCache(d, raw, resultsMap, newNameMap)
  }

  function handleRefresh() {
    clearCache(date)
    run(date, true)
  }

  async function processMatch(m, lgAvgMap, bfMapSnapshot, teamCache, lastXCache) {
    const id       = String(m.id)
    const seasonId = m.competition_id
    const homeId   = String(m.homeID)
    const awayId   = String(m.awayID)
    if (abortRef.current) return null

    const homeRaw   = teamCache[`${homeId}_${seasonId}`] ?? null
    const awayRaw   = teamCache[`${awayId}_${seasonId}`] ?? null
    const homeLastX = lastXCache[homeId] ?? null
    const awayLastX = lastXCache[awayId] ?? null
    const label     = `${m.home_name ?? m.homeName ?? homeId} vs ${m.away_name ?? m.awayName ?? awayId}`
    const calc      = homeRaw && awayRaw
      ? calcMatchFromStats(homeRaw, awayRaw, lgAvgMap[seasonId] ?? null, homeLastX, awayLastX, homeId, awayId, label)
      : null

    console.log(`[processMatch] ${label} → stored pOver=${calc?.pOver?.toFixed(4)} pUnder=${calc?.pUnder?.toFixed(4)}`)
    setResults(prev => ({ ...prev, [id]: calc }))
    setProgress(prev => ({ ...prev, done: prev.done + 1 }))

    // fetch betfair odds if mapped
    const bfEventId = bfMapSnapshot[id]
    if (bfEventId && calc) await fetchAndApplyOdds(id, bfEventId, calc, false)

    return [id, calc]
  }

  async function fetchAndApplyOdds(matchId, bfEventId, calc, fromWatch) {
    const eventData = await fetchBetfairEvent(bfEventId)
    if (!eventData) return
    const odds = extractOU25Odds(eventData)
    if (!odds) return

    setBfOdds(prev => ({ ...prev, [matchId]: odds }))

    if (!calc) return
    const evOver  = odds.backOver  ? calcBackEV(calc.pOver,  odds.backOver,  COMM) : null
    const evUnder = odds.backUnder ? calcBackEV(calc.pUnder, odds.backUnder, COMM) : null
    const evMet   = (evOver  != null && evOver  >= EV_MIN)
                 || (evUnder != null && evUnder >= EV_MIN)

    if (evMet && !notifiedRef.current.has(matchId)) {
      const match = matchesRef.current.find(m => String(m.id) === matchId)
      if (match) {
        const msg = buildTelegramMsg(match, calc, odds, evOver, evUnder)
        await sendTelegram(msg)
      }
      setNotified(prev => new Set([...prev, matchId]))
    }
  }

  // ── watch interval handler ─────────────────────────────────────────────────
  async function refreshWatchedOdds() {
    const currentWatched  = watchedRef.current
    const currentResults  = resultsRef.current
    const currentBfMap    = bfMapRef.current

    await Promise.all([...currentWatched].map(async matchId => {
      const bfEventId = currentBfMap[matchId]
      if (!bfEventId) return
      const calc = currentResults[matchId]
      await fetchAndApplyOdds(matchId, bfEventId, calc ?? null, true)
    }))
  }

  // ── actions ────────────────────────────────────────────────────────────────
  function toggleWatch(matchId) {
    const id = String(matchId)
    setWatched(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function handleBack(match, calc, oddsVal, isOver, pinnOpenVal = null) {
    const matchId = String(match.id)
    setSaving(prev => ({ ...prev, [matchId]: isOver ? 'over' : 'under' }))

    const prob  = isOver ? calc.pOver  : calc.pUnder
    const ferO  = isOver ? calc.ferOver : calc.ferUnder
    const evVal = calcBackEV(prob, oddsVal, COMM)
    const market   = isOver ? 'Over 2.5' : 'Under 2.5'
    const home     = match.home_name ?? match.homeName ?? '?'
    const away     = match.away_name ?? match.awayName ?? '?'
    const kickoff  = match.date_unix ? new Date(match.date_unix * 1000).toISOString() : null
    const betTime  = new Date().toISOString()
    const hoursToKO = kickoff ? (new Date(kickoff) - new Date(betTime)) / 3_600_000 : null

    const { error } = await supabase.from('bets').insert({
      match_name:  `${home} vs ${away}`,
      market,
      bet_type:    'back',
      lambda_h:    calc.lH,
      lambda_a:    calc.lA,
      p_over:      calc.pOver,
      p_under:     calc.pUnder,
      sel_prob:    prob,
      fer_odds:    ferO,
      odds_open:   oddsVal,
      odds_close:  null,
      stake:       10,
      commission:  COMM * 100,
      ev:          evVal,
      ev_pct:      evVal != null ? evVal * 100 : null,
      delta_p:     null,
      clv:         null,
      result:      null,
      pnl:         null,
      brier:       null,
      log_loss:    null,
      match_time:  kickoff,
      bet_time:    betTime,
      hours_to_ko: hoursToKO != null ? Math.round(hoursToKO * 10) / 10 : null,
      league:      match.competition_name ?? match.league_name ?? null,
      model_prob:  prob,
      market_prob: null,
      pinnacle_open:  pinnOpenVal != null && pinnOpenVal > 1 ? pinnOpenVal : null,
      pinnacle_close: null,
      pinnacle_clv:   null,
      is_archived: false,
    })

    setSaving(prev => { const next = { ...prev }; delete next[matchId]; return next })

    if (error) {
      alert('Chyba pri ukladaní: ' + (error.message ?? JSON.stringify(error)))
    } else {
      // stop watching this match
      setWatched(prev => { const next = new Set(prev); next.delete(matchId); return next })
    }
  }

  // ── render ─────────────────────────────────────────────────────────────────
  const done  = progress.done
  const total = progress.total
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0
  const watchCount = watched.size

  return (
    <div className="wrap">
      {/* toolbar */}
      <div className="card" style={{ padding: '12px 14px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
        <div>
          <div className="label">Dátum</div>
          <input
            type="date"
            className="inp inp-sm"
            style={{ width: 150 }}
            value={date}
            onChange={e => setDate(e.target.value)}
          />
        </div>
        <div style={{ flex: 1 }} />
        {loading && <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>načítavam zápasy…</div>}
        {!loading && total > 0 && done < total && (
          <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{done}/{total} · {pct}%</div>
        )}
        {!loading && total > 0 && done >= total && (
          <div style={{ fontSize: 11, color: 'var(--green)', fontFamily: 'var(--mono)' }}>
            {total} zápasov · hotovo
            {watchCount > 0 && <span style={{ color: '#fdcb6e', marginLeft: 10 }}>● sledujem {watchCount}</span>}
          </div>
        )}
        <button className="btn btn-primary btn-sm" onClick={handleRefresh}>Obnoviť</button>
      </div>

      {/* progress bar */}
      {total > 0 && done < total && (
        <div style={{ height: 2, background: 'var(--border)', borderRadius: 2, marginBottom: 12, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', transition: 'width 0.3s' }} />
        </div>
      )}

      {matches.length === 0 && !loading && (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text3)', fontSize: 13 }}>
          Žiadne zápasy pre {date}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {matches.map(m => {
          const id    = String(m.id)
          const calc  = Object.prototype.hasOwnProperty.call(results, id) ? results[id] : undefined
          const odds  = bfOdds[id] ?? null
          const evOver  = calc && odds?.backOver  ? calcBackEV(calc.pOver,  odds.backOver,  COMM) : null
          const evUnder = calc && odds?.backUnder ? calcBackEV(calc.pUnder, odds.backUnder, COMM) : null
          return (
            <MatchCard
              key={id}
              match={m}
              calc={calc}
              bfOdds={odds}
              evOver={evOver}
              evUnder={evUnder}
              isWatched={watched.has(id)}
              isSaving={saving[id] ?? null}
              onWatch={toggleWatch}
              onBack={handleBack}
              leagueName={lgNameMap[String(m.competition_id)] ?? null}
            />
          )
        })}
      </div>
    </div>
  )
}

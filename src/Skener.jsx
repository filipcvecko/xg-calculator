import { useState, useEffect, useRef } from 'react'
import { supabase } from './supabase'
import {
  calcOverUnder, calcOU30, calcOU275, calcOU225, calcBTTS,
  calcEVOU275, calcEVOU225,
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
    ou275: calcOU275(lH, lA, rhoVal),
    ou225: calcOU225(lH, lA, rhoVal),
    btts: calcBTTS(lH, lA, rhoVal),
    modelType: hasGoals ? (hasXGA ? 'full' : 'goals') : (hasXGA ? 'xga' : 'basic'),
    mp_h: hs.mp_h, mp_a: as_.mp_a,
  }
}

// ─── API fetchers ─────────────────────────────────────────────────────────────

// fetch all teams for a season via league-teams (same as App.jsx fetchTeamNamesForSeason)
// returns { statsMap: { `${teamId}_${seasonId}` → statsRaw }, leagueName: string|null }
async function fetchLeagueTeams(seasonId) {
  try {
    const res  = await fetch(`/api/footystats?endpoint=league-teams&season_id=${seasonId}&include=stats`)
    if (!res.ok) return { statsMap: {}, leagueName: null }
    const json = await res.json()
    const teams = json?.data ?? []
    if (teams.length > 0) {
      const sample = teams[0]
      console.log(`[fetchLeagueTeams] seasonId=${seasonId} team keys:`, Object.keys(sample))
    }
    const statsMap = {}
    let leagueName = null
    for (const t of teams) {
      const tid = String(t.id)
      statsMap[`${tid}_${seasonId}`] = t.stats || t
      if (!leagueName) {
        leagueName = t.league_name ?? t.competition ?? t.league ?? t.season_name ?? t.competition_name ?? null
      }
    }
    return { statsMap, leagueName }
  } catch { return { statsMap: {}, leagueName: null } }
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
// returns { statsMap, teamLeagueNames: { seasonId → leagueName } }
async function fetchAllTeamStats(matches) {
  const seasonIds = [...new Set(matches.map(m => m.competition_id).filter(Boolean))]
  const results   = await Promise.all(seasonIds.map(sid => fetchLeagueTeams(sid)))
  const statsMap  = Object.assign({}, ...results.map(r => r.statsMap))
  const teamLeagueNames = {}
  seasonIds.forEach((sid, i) => {
    if (results[i].leagueName) teamLeagueNames[String(sid)] = results[i].leagueName
  })
  return { statsMap, teamLeagueNames }
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
    const data = Array.isArray(json?.data) ? json.data[0] : json?.data
    if (!data) return null
    const avgHome = data.seasonAVG_home ?? data.avg_goals_home ?? data.avgGoalsPerMatch_home ?? null
    const avgAway = data.seasonAVG_away ?? data.avg_goals_away ?? data.avgGoalsPerMatch_away ?? null
    const name = data.name ?? data.league_name ?? data.competition_name ?? null
    const avg = (avgHome && avgAway) ? { avgHome: +avgHome, avgAway: +avgAway } : null
    return { avg, name }
  } catch { return null }
}

// ─── BetsAPI ↔ FootyStats team-name matching ─────────────────────────────────

// Normalise a team name for fuzzy comparison:
// lowercase, strip accents, remove club suffixes/prefixes and age groups, collapse spaces
function cleanName(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip diacritics
    .replace(/\bu\s?21\b|\bu\s?23\b|\bu\s?18\b|\bu\s?19\b|\bu\s?20\b/g, '')  // age groups
    .replace(/\bfc\b|\baf\b|\bsc\b|\bac\b|\bfk\b|\bsk\b|\bif\b|\bbk\b|\bvfb\b|\bsv\b|\brcd\b|\bnk\b|\bkf\b|\bcd\b|\bsd\b|\bcf\b|\brc\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Returns true if two team names are considered the same club
function namesMatch(a, b) {
  const ca = cleanName(a)
  const cb = cleanName(b)
  if (ca === cb) return true
  // one fully contains the other (handles "Man United" vs "Manchester United" partially)
  if (ca.length >= 4 && cb.includes(ca)) return true
  if (cb.length >= 4 && ca.includes(cb)) return true
  return false
}

// Build matchId → betfairEventId map by pairing on home+away names and kick-off time (±12h)
function buildBfMap(bfUpcoming, footyMatches) {
  const TWELVE_HOURS = 12 * 60 * 60
  const map = {}
  for (const ev of bfUpcoming) {
    const bfHome = ev.home?.name
    const bfAway = ev.away?.name
    const bfTime = Number(ev.time)
    if (!bfHome || !bfAway || !bfTime) continue

    const match = footyMatches.find(m => {
      const fHome = m.home_name ?? m.homeName
      const fAway = m.away_name ?? m.awayName
      const fTime = Number(m.date_unix)
      if (!fHome || !fAway || !fTime) return false
      const timeDiff = Math.abs(fTime - bfTime)
      return timeDiff <= TWELVE_HOURS && namesMatch(fHome, bfHome) && namesMatch(fAway, bfAway)
    })

    if (match) {
      const matchId = String(match.id)
      console.log(`[buildBfMap] ✓ paired: "${bfHome}" vs "${bfAway}" → matchId=${matchId}`)
      map[matchId] = String(ev.id)
    } else {
      console.log(`[buildBfMap] ✗ no match for BetsAPI: "${bfHome}" vs "${bfAway}" (time=${bfTime})`)
    }
  }
  console.log('[buildBfMap] paired', Object.keys(map).length, '/', footyMatches.length, 'matches')
  // log unpaired FootyStats matches for diagnosis
  const pairedIds = new Set(Object.keys(map))
  footyMatches.forEach(m => {
    if (!pairedIds.has(String(m.id)))
      console.log(`[buildBfMap] ✗ unpaired FootyStats: "${m.home_name ?? m.homeName}" vs "${m.away_name ?? m.awayName}" (time=${m.date_unix})`)
  })
  return map
}

async function fetchBetfairUpcoming() {
  try {
    const all = []
    let page = 1
    while (true) {
      const res  = await fetch(`/api/betsapi?endpoint=betfair%2Fupcoming&sport_id=1&page=${page}`)
      if (!res.ok) break
      const json = await res.json()
      const results = json?.results ?? []
      all.push(...results)
      const pager = json?.pager
      if (!pager || page >= (pager.max_page ?? 1)) break
      page++
    }
    return all
  } catch { return [] }
}

async function fetchBetfairEvent(eventId) {
  try {
    const res  = await fetch(`/api/betsapi?endpoint=betfair%2Fevent&event_id=${eventId}`)
    if (!res.ok) return null
    const json = await res.json()
    // results is [{event, competitions, markets: [...]}] — return results[0] directly
    return json?.results?.[0] ?? null
  } catch { return null }
}

// ─── Betfair market parsing helpers ──────────────────────────────────────────

function _getMarkets(eventData) {
  // eventData is results[0]: {event, competitions, markets: [...]}
  return eventData?.markets ?? eventData?.mc ?? []
}

function _marketName(m) {
  return String(m.market?.marketName ?? m.marketName ?? m.marketCatalogue?.marketName ?? '')
}

function _oddsFromRunner(r) {
  const val = +(r?.runnerOdds?.decimalDisplayOdds?.decimalOdds ?? 0)
  return val > 1 ? val : null
}

function _runnerById(market, selectionId) {
  const runners = market.runnerDetails ?? market.runners ?? []
  return runners.find(r => Number(r.selectionId ?? r.runner?.selectionId) === selectionId) ?? null
}

function _logRunners(label, market) {
  const runners = market.runnerDetails ?? market.runners ?? []
  console.log(`[${label}] runners:`, runners.map(r => ({
    selectionId: r.selectionId ?? r.runner?.selectionId,
    runnerOrder: r.runnerOrder,
    odds: r.runnerOdds?.decimalDisplayOdds?.decimalOdds,
  })))
}

// O/U 2.5 — selectionId 47972 = Over 2.5, 47973 = Under 2.5
function extractOU25Odds(eventData) {
  const markets = _getMarkets(eventData)
  const ouMarket = markets.find(m => {
    const n = m.market?.marketName ?? ''
    return n === 'Over/Under 2.5 Goals' || n === 'Over/Under Total Goals 2.5'
  })
  if (!ouMarket) return null
  return {
    backOver:  _oddsFromRunner(_runnerById(ouMarket, 47972)),
    backUnder: _oddsFromRunner(_runnerById(ouMarket, 47973)),
  }
}

// O/U 3.0 — selectionId zistiť cez konzolu
function extractOU30Odds(eventData) {
  const markets = _getMarkets(eventData)
  const ouMarket = markets.find(m => {
    const n = _marketName(m).toLowerCase()
    return n.includes('3.0') && !n.includes('half') && !n.includes('home')
        && !n.includes('away') && !n.includes('&')
  })
  if (!ouMarket) return null
  _logRunners('extractOU30Odds', ouMarket)
  const runners = [...(ouMarket.runnerDetails ?? ouMarket.runners ?? [])]
    .sort((a, b) => (a.runnerOrder ?? 0) - (b.runnerOrder ?? 0))
  return {
    backOver:  _oddsFromRunner(runners[0]),
    backUnder: _oddsFromRunner(runners[1]),
  }
}

// O/U 2.25 — dve samostatné markety, každý s jedným runnerom
// 'Over 2.0 & 2.5' → backOver, 'Under 2.0 & 2.5' → backUnder
function extractOU225Odds(eventData) {
  const markets = _getMarkets(eventData)
  const find = (s) => markets.find(m => _marketName(m).toLowerCase().includes(s))
  const overMkt  = find('over 2.0 & 2.5')  ?? find('over 2.0&2.5')
  const underMkt = find('under 2.0 & 2.5') ?? find('under 2.0&2.5')
  if (!overMkt && !underMkt) return null
  const singleOdds = (mkt) => {
    if (!mkt) return null
    const runners = mkt.runnerDetails ?? mkt.runners ?? []
    return _oddsFromRunner(runners[0])
  }
  return {
    backOver:  singleOdds(overMkt),
    backUnder: singleOdds(underMkt),
  }
}

// O/U 2.75 — dve samostatné markety, každý s jedným runnerom
// 'Over 2.5 & 3.0' → backOver, 'Under 2.5 & 3.0' → backUnder
function extractOU275Odds(eventData) {
  const markets = _getMarkets(eventData)
  const find = (s) => markets.find(m => _marketName(m).toLowerCase().includes(s))
  const overMkt  = find('over 2.5 & 3.0')  ?? find('over 2.5&3.0')
  const underMkt = find('under 2.5 & 3.0') ?? find('under 2.5&3.0')
  if (!overMkt && !underMkt) return null
  const singleOdds = (mkt) => {
    if (!mkt) return null
    const runners = mkt.runnerDetails ?? mkt.runners ?? []
    return _oddsFromRunner(runners[0])
  }
  return {
    backOver:  singleOdds(overMkt),
    backUnder: singleOdds(underMkt),
  }
}

// BTTS — selectionId zistiť cez konzolu
function extractBTTSOdds(eventData) {
  const markets = _getMarkets(eventData)
  const bttsMarket = markets.find(m =>
    _marketName(m).toLowerCase().includes('both teams to score')
  )
  if (!bttsMarket) return null
  _logRunners('extractBTTSOdds', bttsMarket)
  const runners = [...(bttsMarket.runnerDetails ?? bttsMarket.runners ?? [])]
    .sort((a, b) => (a.runnerOrder ?? 0) - (b.runnerOrder ?? 0))
  return {
    backYes: _oddsFromRunner(runners[0]),
    backNo:  _oddsFromRunner(runners[1]),
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

const MARKET_WEIGHT = 0.50

function MarketCard({ mkey, label, prob, ferOdds, color, inputs, setInputs, onBet, isSaving, calcEVFn }) {
  const pf = v => { const n = parseFloat(v); return n > 1 ? n : null }
  const back = inputs[mkey]?.back ?? ''
  const pinn = inputs[mkey]?.pinn ?? ''
  const backOdds = pf(back)
  const pinnOdds = pf(pinn)

  const pMkt   = backOdds ? 1 / backOdds : null
  const pBlend = pMkt != null ? MARKET_WEIGHT * prob + (1 - MARKET_WEIGHT) * pMkt : null
  // Asian lines (calcEVFn) používajú vlastný EV vzorec s push mechanikou
  const ev     = backOdds ? (calcEVFn ? calcEVFn(backOdds) : (pBlend ? calcBackEV(pBlend, backOdds, COMM) : null)) : null
  const ferBlend = pBlend ? fairOdds(pBlend) : null
  const clv    = backOdds && pinnOdds ? (backOdds / pinnOdds - 1) * 100 : null

  const set = (field, val) => setInputs(p => ({ ...p, [mkey]: { ...p[mkey], [field]: val } }))

  return (
    <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '10px 12px', borderTop: `2px solid ${color}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 9, color: 'var(--text3)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>{label}</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text2)', fontFamily: 'var(--display)' }}>{fmtPct(prob * 100)}</div>
          <div style={{ fontSize: 10, color: 'var(--text3)' }}>fair {ferOdds ? fmt2(ferOdds) : '—'}</div>
        </div>
        {ev != null && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 9, color: 'var(--text3)' }}>EV (blend)</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: evColor(ev), fontFamily: 'var(--display)' }}>{fmtSign(ev * 100)}%</div>
            {ferBlend && <div style={{ fontSize: 10, color: 'var(--text3)' }}>fair {fmt2(ferBlend)}</div>}
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <div>
          <div style={{ fontSize: 9, color: 'var(--text3)', marginBottom: 2 }}>Back odds</div>
          <input className="inp inp-sm" type="number" step="0.01" placeholder="napr. 2.10"
            value={back} onChange={e => set('back', e.target.value)} style={{ width: '100%' }} />
          {ev != null && (
            <div style={{ fontSize: 9, marginTop: 3, color: 'var(--text3)' }}>
              model {fmtPct(prob * 100)} · blend {fmtPct((pBlend ?? 0) * 100)}
            </div>
          )}
        </div>
        <div>
          <div style={{ fontSize: 9, color: 'var(--text3)', marginBottom: 2 }}>Pinnacle Open</div>
          <input className="inp inp-sm" type="number" step="0.001" placeholder="napr. 2.050"
            value={pinn} onChange={e => set('pinn', e.target.value)} style={{ width: '100%' }} />
          {clv != null && (
            <div style={{ fontSize: 10, fontWeight: 700, marginTop: 2, color: clv >= 0 ? 'var(--green)' : 'var(--red)' }}>
              CLV: {clv >= 0 ? '+' : ''}{clv.toFixed(1)}%
            </div>
          )}
        </div>
      </div>
      {backOdds && (
        <button
          className="btn-save-back"
          style={{ width: '100%', marginTop: 8, fontSize: 10, padding: '7px 0',
            opacity: isSaving === mkey ? 0.5 : 1,
            background: ev != null && ev >= EV_MIN ? undefined : 'rgba(108,92,231,0.3)' }}
          disabled={isSaving != null}
          onClick={() => onBet(backOdds, mkey, pinnOdds)}
        >
          {isSaving === mkey ? '…' : `BET ${label} @ ${fmt2(backOdds)}`}
        </button>
      )}
    </div>
  )
}

function MatchCard({ match, calc, bfOdds, evOver, evUnder, isWatched, isSaving, onWatch, onBack, leagueName }) {
  const [expanded, setExpanded] = useState(false)
  const [inputs, setInputs]     = useState({})

  // auto-fill Betfair odds into back fields (only if user hasn't typed)
  useEffect(() => {
    if (!bfOdds) return
    setInputs(prev => {
      const next = { ...prev }
      const fill = (mkey, val) => {
        if (val != null && !prev[mkey]?.back)
          next[mkey] = { ...prev[mkey], back: String(val) }
      }
      fill('over25',   bfOdds.ou25?.backOver)
      fill('under25',  bfOdds.ou25?.backUnder)
      fill('over225',  bfOdds.ou225?.backOver)
      fill('under225', bfOdds.ou225?.backUnder)
      fill('over275',  bfOdds.ou275?.backOver)
      fill('under275', bfOdds.ou275?.backUnder)
      fill('over30',   bfOdds.ou30?.backOver)
      fill('under30',  bfOdds.ou30?.backUnder)
      fill('bttsYes',  bfOdds.btts?.backYes)
      fill('bttsNo',   bfOdds.btts?.backNo)
      return next
    })
  }, [bfOdds])

  const homeName = match.home_name ?? match.homeName ?? '?'
  const awayName = match.away_name ?? match.awayName ?? '?'
  const koTime   = fmtKO(match.date_unix)
  const hasEV    = (evOver != null && evOver >= EV_MIN) || (evUnder != null && evUnder >= EV_MIN)

  const MARKETS = calc ? [
    { mkey: 'over25',  label: 'Over 2.5',  prob: calc.pOver,        ferOdds: calc.ferOver,             color: 'var(--accent2)' },
    { mkey: 'under25', label: 'Under 2.5', prob: calc.pUnder,       ferOdds: calc.ferUnder,            color: 'var(--green)' },
    ...(calc.ou225 ? [
      { mkey: 'over225',  label: 'Over 2.25',  prob: calc.ou225.pOver225,  ferOdds: calc.ou225.fairOver,  color: '#fdcb6e',
        calcEVFn: odds => calcEVOU225(true,  calc.ou225.p0_1, calc.ou225.p2, calc.ou225.p3plus, odds, COMM) },
      { mkey: 'under225', label: 'Under 2.25', prob: calc.ou225.pUnder225, ferOdds: calc.ou225.fairUnder, color: '#e17055',
        calcEVFn: odds => calcEVOU225(false, calc.ou225.p0_1, calc.ou225.p2, calc.ou225.p3plus, odds, COMM) },
    ] : []),
    ...(calc.ou275 ? [
      { mkey: 'over275',  label: 'Over 2.75',  prob: calc.ou275.pOver275,  ferOdds: calc.ou275.fairOver,  color: '#a29bfe',
        calcEVFn: odds => calcEVOU275(true,  calc.ou275.p0_2, calc.ou275.p3, calc.ou275.p4plus, odds, COMM) },
      { mkey: 'under275', label: 'Under 2.75', prob: calc.ou275.pUnder275, ferOdds: calc.ou275.fairUnder, color: '#00b894',
        calcEVFn: odds => calcEVOU275(false, calc.ou275.p0_2, calc.ou275.p3, calc.ou275.p4plus, odds, COMM) },
    ] : []),
    { mkey: 'over30',  label: 'Over 3.0',  prob: calc.ou30.pOver3,  ferOdds: calc.ou30.fairOver,       color: '#74b9ff' },
    { mkey: 'under30', label: 'Under 3.0', prob: calc.ou30.pUnder2, ferOdds: calc.ou30.fairUnder,      color: '#55efc4' },
    ...(calc.btts ? [
      { mkey: 'bttsYes', label: 'BTTS Yes',  prob: calc.btts.pBTTS,   ferOdds: calc.btts.fairOddsBTTS,   color: '#fd79a8' },
      { mkey: 'bttsNo',  label: 'BTTS No',   prob: calc.btts.pNoBTTS, ferOdds: calc.btts.fairOddsNoBTTS, color: '#fab1a0' },
    ] : []),
  ] : []

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
          {(() => {
            const lgLabel = leagueName ?? match.competition_name ?? match.league_name ?? match.league?.name ?? ''
            return lgLabel ? (
              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {lgLabel}
              </div>
            ) : null
          })()}
          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
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

          {/* Market karty — 2 stĺpce, 3 riadky */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {MARKETS.map(m => (
              <MarketCard
                key={m.mkey}
                {...m}
                inputs={inputs}
                setInputs={setInputs}
                onBet={(odds, mkey, pinn) => onBack(match, calc, odds, mkey, pinn)}
                isSaving={isSaving}
              />
            ))}
          </div>

          {/* Sledovať */}
          <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
            <button
              className="btn-ghost"
              style={{ fontSize: 10, padding: '7px 14px', color: isWatched ? '#fdcb6e' : 'var(--text2)', borderColor: isWatched ? 'rgba(253,203,110,0.5)' : undefined }}
              onClick={() => onWatch(match.id)}
            >
              {isWatched ? '■ Stop sledovanie' : '▶ Sledovať (30s)'}
            </button>
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
        // Invalidate cache if calc objects are missing btts (old format)
        const cachedR = cached.results
        const isStale = Object.values(cachedR).some(c => c && (!c.btts || !c.ou275 || !c.ou225))
        if (isStale) {
          console.log('[Skener] cache stale (chýba btts) — ignorujem')
        } else {
        console.log('[Skener] cache hit pre', d, '— preskakujem FootyStats API')
        const raw     = cached.matches
        setMatches(raw)
        setResults(cachedR)
        if (cached.lgNameMap) setLgNameMap(cached.lgNameMap)
        setProgress({ done: raw.length, total: raw.length })
        setLoading(false)

        // still fetch live Betfair odds (fast, 1-2 calls)
        const bfUpcoming = await fetchBetfairUpcoming()
        console.log('[bfUpcoming] count:', bfUpcoming?.length, 'first entry:', JSON.stringify(bfUpcoming?.[0]).slice(0, 200))
        if (abortRef.current) return
        const newBfMap = buildBfMap(bfUpcoming, raw)
        console.log('[Skener] bfMap (cache path) entries:', Object.keys(newBfMap).length, newBfMap)
        console.log('[Skener] match IDs (cache):', raw.map(m => String(m.id)))
        setBfMap(newBfMap)
        await Promise.all(raw.map(m => {
          const id        = String(m.id)
          const calc      = cachedR[id] ?? null
          const bfEventId = newBfMap[id]
          if (bfEventId && calc) return fetchAndApplyOdds(id, bfEventId, calc, false)
          return Promise.resolve()
        }))
        return
        } // end: cache not stale
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
    const [lgRawMap, bfUpcoming, { statsMap: teamCache, teamLeagueNames }, lastXCache] = await Promise.all([
      Promise.all(seasonIds.map(async sid => [sid, await fetchLeagueAvg(sid)])).then(Object.fromEntries),
      fetchBetfairUpcoming(),
      fetchAllTeamStats(raw),
      fetchAllLastX(raw),
    ])
    if (abortRef.current) return

    // split lgRawMap into avg map and name map; fallback to team-object league names
    const lgAvgMap  = {}
    const newNameMap = { ...teamLeagueNames }
    for (const [sid, entry] of Object.entries(lgRawMap)) {
      if (!entry) continue
      if (entry.avg)  lgAvgMap[sid]   = entry.avg
      if (entry.name) newNameMap[sid]  = entry.name   // league-season name wins if present
    }
    console.log('[Skener] newNameMap:', newNameMap)
    setLgNameMap(newNameMap)

    // build matchId → betfairEventId map via home/away name + time matching
    const newBfMap = buildBfMap(bfUpcoming, raw)
    console.log('[Skener] bfMap entries:', Object.keys(newBfMap).length, newBfMap)
    console.log('[Skener] match IDs:', raw.map(m => String(m.id)))
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
    console.log(`[fetchAndApplyOdds] matchId=${matchId} bfEventId=${bfEventId} fromWatch=${fromWatch}`)
    const eventData = await fetchBetfairEvent(bfEventId)
    console.log(`[fetchAndApplyOdds] eventData keys:`, eventData ? Object.keys(eventData) : 'null')
    if (!eventData) return

    const ou25  = extractOU25Odds(eventData)
    const ou30  = extractOU30Odds(eventData)
    const ou225 = extractOU225Odds(eventData)
    const ou275 = extractOU275Odds(eventData)
    const btts  = extractBTTSOdds(eventData)
    console.log(`[fetchAndApplyOdds] matchId=${matchId} → ou25:`, ou25, 'ou30:', ou30, 'ou225:', ou225, 'ou275:', ou275, 'btts:', btts)

    if (!ou25 && !ou30 && !ou225 && !ou275 && !btts) return

    const allOdds = { ou25, ou30, ou225, ou275, btts }
    setBfOdds(prev => ({ ...prev, [matchId]: allOdds }))

    if (!calc) return
    const evOver  = ou25?.backOver  ? calcBackEV(calc.pOver,  ou25.backOver,  COMM) : null
    const evUnder = ou25?.backUnder ? calcBackEV(calc.pUnder, ou25.backUnder, COMM) : null
    const evMet   = (evOver  != null && evOver  >= EV_MIN)
                 || (evUnder != null && evUnder >= EV_MIN)

    if (evMet && !notifiedRef.current.has(matchId)) {
      const match = matchesRef.current.find(m => String(m.id) === matchId)
      if (match) {
        const msg = buildTelegramMsg(match, calc, ou25, evOver, evUnder)
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

  async function handleBack(match, calc, oddsVal, marketKey, pinnOpenVal = null) {
    const matchId = String(match.id)
    setSaving(prev => ({ ...prev, [matchId]: marketKey }))

    const MINFO = {
      over25:   { prob: calc.pOver,           ferO: calc.ferOver,              market: 'over2.5' },
      under25:  { prob: calc.pUnder,          ferO: calc.ferUnder,             market: 'under2.5' },
      over225:  { prob: calc.ou225?.pOver225,  ferO: calc.ou225?.fairOver,     market: 'over2.25' },
      under225: { prob: calc.ou225?.pUnder225, ferO: calc.ou225?.fairUnder,    market: 'under2.25' },
      over275:  { prob: calc.ou275?.pOver275,  ferO: calc.ou275?.fairOver,     market: 'over2.75' },
      under275: { prob: calc.ou275?.pUnder275, ferO: calc.ou275?.fairUnder,    market: 'under2.75' },
      over30:   { prob: calc.ou30.pOver3,     ferO: calc.ou30.fairOver,        market: 'over3.0' },
      under30:  { prob: calc.ou30.pUnder2,    ferO: calc.ou30.fairUnder,       market: 'under3.0' },
      bttsYes:  { prob: calc.btts?.pBTTS,     ferO: calc.btts?.fairOddsBTTS,   market: 'btts-yes' },
      bttsNo:   { prob: calc.btts?.pNoBTTS,   ferO: calc.btts?.fairOddsNoBTTS, market: 'btts-no' },
    }
    const { prob, ferO, market } = MINFO[marketKey] ?? {}
    if (!prob || !market) {
      setSaving(prev => { const next = { ...prev }; delete next[matchId]; return next })
      return
    }

    const evVal = calcBackEV(prob, oddsVal, COMM)
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
      league:      lgNameMap[String(match.competition_id)] ?? match.competition_name ?? match.league_name ?? null,
      model_prob:  prob,
      market_prob: null,
      pinnacle_open:  pinnOpenVal != null && pinnOpenVal > 1 ? pinnOpenVal : null,
      pinnacle_close: null,
      pinnacle_clv:   null,
      is_archived: false,
      calibration_version: 'v2',
    })

    setSaving(prev => { const next = { ...prev }; delete next[matchId]; return next })

    if (error) {
      alert('Chyba pri ukladaní: ' + (error.message ?? JSON.stringify(error)))
    } else {
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
          const evOver  = calc && odds?.ou25?.backOver  ? calcBackEV(calc.pOver,  odds.ou25.backOver,  COMM) : null
          const evUnder = calc && odds?.ou25?.backUnder ? calcBackEV(calc.pUnder, odds.ou25.backUnder, COMM) : null
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

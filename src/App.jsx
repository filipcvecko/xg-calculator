import { useState, useEffect } from 'react'
import { supabase } from './supabase'
import {
  calcOverUnder, buildScoreMatrix, calcAH, blendLambda, fairOdds, calcCLV,
  brierScore, logLoss, calcMaxDrawdown,
  marketCalibration, calibrateProb, evFilter, oddsBandFilter,
  timeDecayBlend, extractLastXStats,
  fmt2, fmt3, fmtPct, fmtSign, fmtSignPct
} from './math'

function midPrice(back, lay) {
  if (!back || !lay || back <= 1 || lay <= 1) return null
  return (back + lay) / 2
}
function calcBackEV(prob, odds, comm = 0.05) {
  if (!prob || !odds) return null
  return prob * (odds - 1) * (1 - comm) - (1 - prob)
}
function calcLayEV(prob, layOdds, comm = 0.05) {
  if (!prob || !layOdds) return null
  return (1 - prob) * (1 - comm) - prob * (layOdds - 1)
}
function layLiability(odds, stake) {
  return stake * (odds - 1)
}
function pf(v) {
  if (typeof v === 'number') return v
  return parseFloat(String(v).replace(',', '.')) || 0
}

function blendWithGoals(xgH, xgA, xgaH, xgaA, gfH, gaH, gfA, gaA, alpha) {
  const a = alpha
  const attH = a * xgH + (1 - a) * gfH
  const defA = a * xgaA + (1 - a) * gaA
  const attA = a * xgA + (1 - a) * gfA
  const defH = a * xgaH + (1 - a) * gaH
  const lH = Math.sqrt(attH * defA)
  const lA = Math.sqrt(attA * defH)
  return { lH, lA }
}

function applyShrinkage(lH, lA, lgAvgH, lgAvgA, shrink) {
  const rawTotal = lH + lA
  const leagueTotal = lgAvgH + lgAvgA
  if (rawTotal <= 0) return { lH, lA, shrunk: false }
  const shrunkTotal = (1 - shrink) * rawTotal + shrink * leagueTotal
  const ratio = shrunkTotal / rawTotal
  return {
    lH: lH * ratio,
    lA: lA * ratio,
    shrunk: true,
    ratio: ratio.toFixed(4),
    rawTotal: rawTotal.toFixed(3),
    shrunkTotal: shrunkTotal.toFixed(3),
  }
}

async function fetchLeagueAvg(leagueId) {
  try {
    const url = `/api/footystats?endpoint=league-season&season_id=${leagueId}&stats=true`
    const res = await fetch(url)
    if (!res.ok) return null
    const json = await res.json()
    const data = json?.data
    if (!data) return null
    // FootyStats používa rôzne názvy polí podľa verzie API / ligy
    const avgHome = data.seasonAVG_home ?? data.avg_goals_home ?? data.avgGoalsPerMatch_home ?? data.avgGoals_home ?? null
    const avgAway = data.seasonAVG_away ?? data.avg_goals_away ?? data.avgGoalsPerMatch_away ?? data.avgGoals_away ?? null
    if (avgHome && avgAway) {
      return { avgHome, avgAway, source: 'api', leagueId }
    }
    return null
  } catch {
    return null
  }
}

async function fetchTodaysMatches(dateStr) {
  try {
    // dateStr = 'YYYY-MM-DD', ak nie je zadané = dnes
    let url = '/api/footystats?endpoint=todays-matches&chosen_leagues_only=true'
    if (dateStr) url += `&date=${dateStr}`
    const res = await fetch(url)
    if (!res.ok) return []
    const json = await res.json()
    return json?.data ?? []
  } catch {
    return []
  }
}

async function loadMyLeagues() {
  try {
    const url = `/api/footystats?endpoint=league-list&chosen_leagues_only=true`
    const res = await fetch(url)
    if (!res.ok) return []
    const json = await res.json()
    const leagues = json?.data ?? []
    return leagues
      .map(l => ({ id: l.id, name: l.name, country: l.country, season: l.season }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

// Načítaj len mená tímov z danej sezóny (bez štatistík — rýchle)
async function fetchTeamNamesForSeason(seasonId, leagueName, leagueCountry) {
  try {
    const url = `/api/footystats?endpoint=league-teams&season_id=${seasonId}&include=stats`
    const res = await fetch(url)
    if (!res.ok) return []
    const json = await res.json()
    const teams = json?.data ?? []
    return teams.map(t => ({
      id: t.id,
      name: t.name,
      cleanName: t.cleanName || t.name,
      leagueName,
      leagueCountry,
      seasonId,
      _statsRaw: t.stats || t,
    }))
  } catch {
    return []
  }
}

// Načítaj štatistiky konkrétneho tímu (pri výbere)
async function fetchTeamStats(teamId, seasonId) {
  try {
    const url = `/api/footystats?endpoint=team&team_id=${teamId}&season_id=${seasonId}`
    const res = await fetch(url)
    if (!res.ok) return null
    const json = await res.json()
    const data = json?.data
    return Array.isArray(data) ? data[0] : data || null
  } catch (e) {
    return null
  }
}

// Načítaj last 5/6/10 zápasov tímu
async function fetchTeamLastX(teamId) {
  try {
    const url = `/api/footystats?endpoint=lastx&team_id=${teamId}`
    const res = await fetch(url)
    if (!res.ok) return null
    const json = await res.json()
    // FootyStats vracia { success: true, data: [{last_x_match_num: 5, stats: {...}}, ...] }
    // Vraciame cely json, extractLastXStats cita json.data
    return json || null
  } catch {
    return null
  }
}

function extractTeamStats(team) {
  const s = team?.stats || team || {}

  // Opravená get() — nekontroluje !== 0, lebo 0 môže byť validná hodnota
  const get = (...keys) => {
    for (const k of keys) {
      if (s[k] != null && s[k] !== '') return s[k]
    }
    return null
  }

  const mp_h = +(get('seasonMatchesPlayed_home') || 0)
  const mp_a = +(get('seasonMatchesPlayed_away') || 0)

  // xG per zápas — FootyStats používa tieto názvy polí
  // xg_for_avg_home / xg_for_avg_away sú štandardné názvy z /team endpointu
  const xgH = get('xg_for_avg_home', 'xg_for_avg', 'seasonXG_home', 'xGFor_home')
  const xgA = get('xg_for_avg_away', 'seasonXG_away', 'xGFor_away')
  const xgaH = get('xg_against_avg_home', 'xg_against_avg', 'seasonXGC_home', 'xGAgainst_home')
  const xgaA = get('xg_against_avg_away', 'seasonXGC_away', 'xGAgainst_away')

  // GF/GA priemer per zápas
  const gfH = get('seasonScoredAVG_home', 'scored_home', 'seasonGoals_home')
  const gfA = get('seasonScoredAVG_away', 'scored_away', 'seasonGoals_away')
  const gaH = get('seasonConcededAVG_home', 'conceded_home', 'seasonConceded_home')
  const gaA = get('seasonConcededAVG_away', 'conceded_away', 'seasonConceded_away')

  // Ulož všetky raw polia pre debug (filtruj len číselné/xG-relevantné)
  const _raw = Object.fromEntries(
    Object.entries(s).filter(([k]) =>
      /xg|goal|scored|conceded|matches|played|avg/i.test(k)
    ).slice(0, 40)
  )

  return {
    xgH: xgH != null ? +parseFloat(xgH).toFixed(2) : null,
    xgA: xgA != null ? +parseFloat(xgA).toFixed(2) : null,
    xgaH: xgaH != null ? +parseFloat(xgaH).toFixed(2) : null,
    xgaA: xgaA != null ? +parseFloat(xgaA).toFixed(2) : null,
    gfH: gfH != null ? +parseFloat(gfH).toFixed(2) : null,
    gfA: gfA != null ? +parseFloat(gfA).toFixed(2) : null,
    gaH: gaH != null ? +parseFloat(gaH).toFixed(2) : null,
    gaA: gaA != null ? +parseFloat(gaA).toFixed(2) : null,
    mp_h, mp_a,
    _raw
  }
}

const css = `
  * { box-sizing: border-box; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 20px 16px 60px; }
  .header { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 14px 20px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
  .logo { font-family: var(--display); font-weight: 800; font-size: 18px; letter-spacing: -0.02em; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 10px var(--accent); flex-shrink: 0; }
  .meta { margin-left: auto; font-size: 11px; color: var(--text3); }
  .tabs { border-bottom: 1px solid var(--border); padding: 0 20px; display: flex; gap: 2px; background: var(--bg2); }
  .tab { cursor: pointer; padding: 10px 18px; border: none; background: transparent; font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text3); transition: all 0.2s; border-bottom: 2px solid transparent; }
  .tab.active { color: var(--accent2); border-bottom-color: var(--accent); }
  .card { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card + .card { margin-top: 12px; }
  .label { font-size: 10px; color: var(--text3); letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 5px; }
  .inp { width: 100%; background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; color: var(--text); font-family: var(--mono); font-size: 13px; transition: border-color 0.15s; }
  .inp:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 2px rgba(108,92,231,0.15); }
  .inp-sm { padding: 8px 10px; font-size: 12px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
  .grid4 { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 10px; }
  .btn { cursor: pointer; border: none; font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; padding: 12px 20px; border-radius: 6px; transition: all 0.2s; width: 100%; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { background: #7d6ff0; }
  .btn-sm { padding: 7px 14px; width: auto; font-size: 10px; }
  .btn-ghost { cursor: pointer; background: transparent; border: 1px solid var(--border2); color: var(--text2); font-family: var(--mono); font-size: 11px; padding: 6px 12px; border-radius: 4px; }
  .btn-danger { cursor: pointer; background: transparent; border: 1px solid rgba(214,48,49,0.2); color: var(--red); font-family: var(--mono); font-size: 11px; padding: 6px 10px; border-radius: 4px; }
  .btn-toggle { cursor: pointer; background: transparent; border: 1px solid var(--border); color: var(--text3); font-family: var(--mono); font-size: 10px; padding: 5px 10px; border-radius: 4px; letter-spacing: 0.08em; }
  .pos { color: var(--green); }
  .neg { color: var(--red); }
  .neu { color: var(--yellow); }
  .markets-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
  .market-col { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
  .market-col-over { border-top: 3px solid var(--accent); }
  .market-col-under { border-top: 3px solid var(--green); }
  .market-title { font-family: var(--display); font-size: 15px; font-weight: 800; margin-bottom: 12px; }
  .market-title-over { color: var(--accent2); }
  .market-title-under { color: var(--green); }
  .fer-num { font-family: var(--display); font-size: 24px; font-weight: 800; }
  .fer-num-over { color: var(--accent2); }
  .fer-num-under { color: var(--green); }
  .mid-row { display: flex; align-items: center; gap: 8px; margin: 8px 0; padding: 7px 10px; background: var(--bg3); border-radius: 6px; font-size: 12px; }
  .mid-val { font-weight: 700; font-family: var(--mono); }
  .ev-big { font-size: 18px; font-weight: 800; margin-top: 6px; }
  .ev-eur { font-size: 11px; color: var(--text3); margin-left: 5px; }
  .liability-note { font-size: 10px; color: var(--red); margin-top: 4px; }
  .save-btns { display: flex; gap: 6px; margin-top: 12px; }
  .btn-save-back { cursor: pointer; flex: 1; padding: 9px; border-radius: 6px; border: 1px solid rgba(108,92,231,0.4); background: rgba(108,92,231,0.15); font-family: var(--mono); font-size: 11px; font-weight: 700; color: var(--accent2); }
  .btn-save-lay { cursor: pointer; flex: 1; padding: 9px; border-radius: 6px; border: 1px solid rgba(214,48,49,0.3); background: rgba(214,48,49,0.12); font-family: var(--mono); font-size: 11px; font-weight: 700; color: var(--red); }
  .bet-row { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin-bottom: 8px; }
  .badge { display: inline-block; font-size: 10px; padding: 2px 8px; border-radius: 3px; letter-spacing: 0.05em; font-weight: 600; }
  .badge-pending { background: rgba(253,203,110,0.15); color: var(--yellow); }
  .badge-won { background: rgba(0,184,148,0.15); color: var(--green); }
  .badge-lost { background: rgba(214,48,49,0.15); color: var(--red); }
  .badge-back { background: rgba(108,92,231,0.15); color: var(--accent2); }
  .badge-lay { background: rgba(214,48,49,0.12); color: var(--red); }
  .badge-pass { background: rgba(253,203,110,0.12); color: var(--yellow); font-size: 9px; padding: 2px 6px; }
  .settle-box { background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-top: 10px; }
  .clv-box { background: var(--bg3); border: 1px solid rgba(108,92,231,0.3); border-radius: 6px; padding: 12px; margin-top: 10px; }
  .stat-val { font-size: 20px; font-weight: 700; margin-top: 2px; }
  .hint { font-size: 10px; color: var(--text3); margin-top: 3px; }
  .section-title { font-size: 10px; color: var(--text3); letter-spacing: 0.15em; text-transform: uppercase; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
  .pnl-bar-wrap { display: flex; align-items: flex-end; gap: 3px; height: 56px; }
  .pnl-bar { flex: 1; min-width: 3px; border-radius: 2px 2px 0 0; }
  .loading { text-align: center; padding: 60px 20px; color: var(--text3); }
  .empty { text-align: center; padding: 60px 20px; color: var(--text3); line-height: 1.8; }
  .lambda-row { display: flex; gap: 16px; font-size: 12px; color: var(--text3); padding: 10px 14px; background: var(--bg3); border-radius: 6px; flex-wrap: wrap; margin-top: 10px; }
  .lambda-row span b { color: var(--text2); }
  .league-search-results { background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; margin-top: 4px; overflow: hidden; }
  .league-result-item { padding: 8px 12px; cursor: pointer; font-size: 12px; border-bottom: 1px solid var(--border); transition: background 0.1s; }
  .league-result-item:last-child { border-bottom: none; }
  .league-result-item:hover { background: var(--bg2); }
  .shrink-info { font-size: 10px; color: var(--accent2); background: rgba(108,92,231,0.08); border: 1px solid rgba(108,92,231,0.2); border-radius: 6px; padding: 8px 12px; margin-top: 8px; line-height: 1.7; }
  .calib-info { font-size: 10px; color: var(--yellow); background: rgba(253,203,110,0.06); border: 1px solid rgba(253,203,110,0.2); border-radius: 6px; padding: 8px 12px; margin-top: 8px; line-height: 1.7; }
  .filter-pass { font-size: 11px; color: var(--green); background: rgba(46,204,138,0.08); border: 1px solid rgba(46,204,138,0.2); border-radius: 6px; padding: 8px 12px; margin-top: 8px; }
  .filter-fail { font-size: 11px; color: var(--red); background: rgba(255,92,92,0.08); border: 1px solid rgba(255,92,92,0.2); border-radius: 6px; padding: 8px 12px; margin-top: 8px; }
  .league-badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(108,92,231,0.12); border: 1px solid rgba(108,92,231,0.3); border-radius: 4px; padding: 4px 10px; font-size: 11px; color: var(--accent2); margin-top: 6px; }
  .league-badge button { background: none; border: none; color: var(--text3); cursor: pointer; font-size: 12px; padding: 0; line-height: 1; }
  .team-search-wrap { position: relative; }
  .team-search-results { background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; margin-top: 4px; overflow: hidden; position: absolute; top: 100%; left: 0; right: 0; z-index: 50; max-height: 280px; overflow-y: auto; }
  .team-result-item { padding: 9px 12px; cursor: pointer; font-size: 12px; border-bottom: 1px solid var(--border); transition: background 0.1s; display: flex; justify-content: space-between; align-items: center; }
  .team-result-item:last-child { border-bottom: none; }
  .team-result-item:hover { background: var(--bg2); }
  .team-badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(46,204,138,0.10); border: 1px solid rgba(46,204,138,0.3); border-radius: 4px; padding: 4px 10px; font-size: 11px; color: var(--green); margin-top: 6px; }
  .team-badge button { background: none; border: none; color: var(--text3); cursor: pointer; font-size: 12px; padding: 0; line-height: 1; }
  .autofill-info { font-size: 10px; color: var(--green); background: rgba(46,204,138,0.07); border: 1px solid rgba(46,204,138,0.2); border-radius: 6px; padding: 8px 12px; margin-top: 8px; line-height: 1.8; }
  .prob-compare { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-top: 10px; font-size: 11px; }
  .prob-box { background: var(--bg3); border-radius: 6px; padding: 8px 10px; }
  .prob-box-label { font-size: 9px; color: var(--text3); letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 3px; }
  .prob-box-val { font-weight: 700; font-size: 14px; }
  @media(max-width:520px){ .markets-grid{grid-template-columns:1fr;} .grid3{grid-template-columns:1fr 1fr;} .grid4{grid-template-columns:1fr 1fr;} .tab{padding:10px 8px;font-size:10px;} }
`

export default function App() {
  const [tab, setTab] = useState('calc')
  const [modelVersion, setModelVersion] = useState('all') // 'all' | 'v1' | 'v2'
  const [statsMarket, setStatsMarket] = useState('ou') // 'ou' | 'ah'
  const [bets, setBets] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [xgH, setXgH] = useState('')
  const [xgA, setXgA] = useState('')
  const [xgaH, setXgaH] = useState('')
  const [xgaA, setXgaA] = useState('')
  const [gfH, setGfH] = useState('')
  const [gaH, setGaH] = useState('')
  const [gfA, setGfA] = useState('')
  const [gaA, setGaA] = useState('')
  const [alpha, setAlpha] = useState('0.70')
  const [backOver, setBackOver] = useState('')
  const [layOver, setLayOver] = useState('')
  const [backUnder, setBackUnder] = useState('')
  const [layUnder, setLayUnder] = useState('')
  const [myOddsOver, setMyOddsOver] = useState('')
  const [myOddsUnder, setMyOddsUnder] = useState('')
  const [stake, setStake] = useState('10')
  const [commission, setCommission] = useState('5')
  const [matchName, setMatchName] = useState('')
  // Market mode: 'ou' = Over/Under 2.5, 'ah' = Asian Handicap ±0.5
  const [marketMode, setMarketMode] = useState('ou')
  const [backAHHome, setBackAHHome] = useState('')
  const [layAHHome, setLayAHHome] = useState('')
  const [backAHAway, setBackAHAway] = useState('')
  const [layAHAway, setLayAHAway] = useState('')
  const [myOddsAHHome, setMyOddsAHHome] = useState('')
  const [myOddsAHAway, setMyOddsAHAway] = useState('')
  const [todaysMatches, setTodaysMatches] = useState([])
  const [todaysMatchesOpen, setTodaysMatchesOpen] = useState(false)
  const [todaysMatchesLoading, setTodaysMatchesLoading] = useState(false)
  const [matchesDate, setMatchesDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [calc, setCalc] = useState(null)
  const [savedKey, setSavedKey] = useState(null)
  const [expandedId, setExpandedId] = useState(null)

  // Team autofill
  const [allTeams, setAllTeams] = useState([])
  const [teamsLoading, setTeamsLoading] = useState(false)
  const [homeTeamSearch, setHomeTeamSearch] = useState('')
  const [awayTeamSearch, setAwayTeamSearch] = useState('')
  const [homeTeamOpen, setHomeTeamOpen] = useState(false)
  const [awayTeamOpen, setAwayTeamOpen] = useState(false)
  const [selectedHomeTeam, setSelectedHomeTeam] = useState(null)
  const [selectedAwayTeam, setSelectedAwayTeam] = useState(null)
  const [autofillInfo, setAutofillInfo] = useState(null)

  // Time decay / forma
  const [homeLastX, setHomeLastX] = useState(null)   // raw lastx data pre home tím
  const [awayLastX, setAwayLastX] = useState(null)   // raw lastx data pre away tím
  const [formWindow, setFormWindow] = useState(5)  // 5 | 6 | 10
  const [formWeight, setFormWeight] = useState('0.40')    // váha formy vs sezóna

  // Pokročilé nastavenia
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [rho, setRho] = useState('-0.10')
  const [marketOddsOver, setMarketOddsOver] = useState('')
  const [marketOddsUnder, setMarketOddsUnder] = useState('')
  const [marketWeight, setMarketWeight] = useState('0.50')
  const [calibK, setCalibK] = useState('0.85')
  const [evMin, setEvMin] = useState('12')
  const [oddsLow, setOddsLow] = useState('1.4')
  const [oddsHigh, setOddsHigh] = useState('3.5')

  // Liga priemer
  const [allLeagues, setAllLeagues] = useState([])
  const [leagueLoading, setLeagueLoading] = useState(false)
  const [leagueSearch, setLeagueSearch] = useState('')
  const [leagueOpen, setLeagueOpen] = useState(false)
  const [selectedLeague, setSelectedLeague] = useState(null)
  const [leagueAvgH, setLeagueAvgH] = useState('')
  const [leagueAvgA, setLeagueAvgA] = useState('')
  const [leagueAvgSource, setLeagueAvgSource] = useState(null)
  const [shrinkage, setShrinkage] = useState('0.15')
  const [xgScaler, setXgScaler] = useState('0.90')

  // Čas zápasu pre CLV notifikáciu
  const [matchTime, setMatchTime] = useState('')
  const [notifPermission, setNotifPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied'
  )

  // Settle
  const [settlingId, setSettlingId] = useState(null)
  const [settleMode, setSettleMode] = useState('clv')
  const [settleClose, setSettleClose] = useState('')
  const [settleResult, setSettleResult] = useState('')

  async function requestNotifPermission() {
    if (typeof Notification === 'undefined') return
    const perm = await Notification.requestPermission()
    setNotifPermission(perm)
  }

  function scheduleClvNotification(betId, betMatchName, kickoffStr, market) {
    if (!kickoffStr || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const kickoff = new Date(kickoffStr).getTime()
    const notifTime = kickoff - 5 * 60 * 1000
    const delay = notifTime - Date.now()
    if (delay < 0) return
    const marketLabels = { 'over2.5': 'Over 2.5', 'under2.5': 'Under 2.5', 'ah_home_minus05': 'AH Home -0.5', 'ah_away_minus05': 'AH Away -0.5' }
    const marketLabel = marketLabels[market] || market || ''
    setTimeout(() => {
      const n = new Notification('⏰ CLV pripomienka', {
        body: `${betMatchName || 'Zápas'} [${marketLabel}] začína o 5 min — skontroluj záverečný kurz!`,
        icon: '/favicon.ico',
        tag: `clv-${betId}`,
      })
      n.onclick = () => { window.focus(); n.close() }
    }, delay)
  }

  useEffect(() => {
    loadBets()
    setLeagueLoading(true)
    loadMyLeagues().then(async leagues => {
      setAllLeagues(leagues)
      setLeagueLoading(false)

      // Načítaj len mená tímov (bez štatistík) — oveľa rýchlejšie
      if (leagues.length === 0) return
      setTeamsLoading(true)
      const CHUNK = 5
      let allLoadedTeams = []
      for (let i = 0; i < leagues.length; i += CHUNK) {
        const chunk = leagues.slice(i, i + CHUNK)
        const results = await Promise.all(chunk.map(async l => {
          const seasons = (l.season ?? []).slice().sort((a, b) => b.id - a.id)
          // Vždy len aktuálna (najnovšia) sezóna — čisté dáta bez miešania sezón
          const top1 = seasons.slice(0, 1)
          if (top1.length === 0) top1.push({ id: l.id })
          const teamArrays = await Promise.all(top1.map(s => fetchTeamNamesForSeason(s.id, l.name, l.country)))
          return teamArrays.flat()
        }))
        allLoadedTeams = allLoadedTeams.concat(results.flat())
      }
      // Deduplikácia — len ligové tímy (poháre ignorujeme)
      const isCup = (name) => /\bfa cup\b|\bleague cup\b|\bcopa\b|\blibertadores\b|\bsudamericana\b|\bchampions league\b|\bafc\b|\buafa\b|\bcaf\b|\bconcacaf\b|\befl trophy\b|\bcommunity shield\b/i.test(name)
      const teamMap = new Map()
      allLoadedTeams.forEach(t => {
        if (isCup(t.leagueName || '')) return // preskočí pohárové tímy
        const key = String(t.id)
        const existing = teamMap.get(key)
        if (!existing) { teamMap.set(key, t); return }
        // Zachovaj novšiu sezónu
        if ((t.seasonId ?? 0) > (existing.seasonId ?? 0)) teamMap.set(key, t)
      })
      const unique = Array.from(teamMap.values()).sort((a, b) => a.name.localeCompare(b.name))
      setAllTeams(unique)
      setTeamsLoading(false)
    })
  }, [])

  async function loadBets() {
    setLoading(true)
    const { data, error } = await supabase.from('bets').select('*').order('created_at', { ascending: false })
    if (!error) {
      setBets(data || [])
    }
    setLoading(false)
  }

  async function handleSelectLeague(league) {
    setSelectedLeague(league)
    setLeagueOpen(false)
    setLeagueSearch('')
    setLeagueAvgSource(null)
    setLeagueAvgH('')
    setLeagueAvgA('')
    const seasons = league.season ?? []
    const latestSeason = seasons.reduce((best, s) => (!best || s.id > best.id ? s : best), null)
    const seasonId = latestSeason ? latestSeason.id : league.id
    const avg = await fetchLeagueAvg(seasonId)
    if (avg) {
      setLeagueAvgH(String(avg.avgHome.toFixed(3)))
      setLeagueAvgA(String(avg.avgAway.toFixed(3)))
      setLeagueAvgSource('api')
    } else {
      setLeagueAvgSource('manual')
    }
  }

  function clearLeague() {
    setSelectedLeague(null)
    setLeagueAvgH('')
    setLeagueAvgA('')
    setLeagueAvgSource(null)
    setLeagueSearch('')
    setLeagueOpen(false)
  }

  async function handleSelectHomeTeam(team) {
    setSelectedHomeTeam({ ...team, loading: true })
    setHomeTeamOpen(false)
    setHomeTeamSearch('')
    setHomeLastX(null)
    // Použi _statsRaw z league-teams ak dostupné, inak fetchTeamStats ako fallback
    const lastxPromise = fetchTeamLastX(team.id)
    let rawData = null
    if (team._statsRaw && Object.keys(team._statsRaw).length > 5) {
      rawData = team._statsRaw
    } else {
      rawData = await fetchTeamStats(team.id, team.seasonId)
    }
    const lastx = await lastxPromise
    const raw = rawData
    const s = raw ? extractTeamStats(raw) : null
    const finalTeam = { ...team, stats: s, loading: false }
    setSelectedHomeTeam(finalTeam)
    setHomeLastX(lastx)
    if (s) {
      if (s.xgH != null) setXgH(String(s.xgH))
      if (s.xgaH != null) setXgaH(String(s.xgaH))
      if (s.gfH != null) setGfH(String(s.gfH))
      if (s.gaH != null) setGaH(String(s.gaH))
    }
    const awayName = selectedAwayTeam?.name || ''
    if (team.name) setMatchName(awayName ? `${team.name} vs ${awayName}` : team.name)
    updateAutofillInfo(finalTeam, selectedAwayTeam, s, null)
  }

  async function handleSelectAwayTeam(team) {
    setSelectedAwayTeam({ ...team, loading: true })
    setAwayTeamOpen(false)
    setAwayTeamSearch('')
    setAwayLastX(null)
    // Použi _statsRaw z league-teams ak dostupné, inak fetchTeamStats ako fallback
    const lastxPromise = fetchTeamLastX(team.id)
    let rawData = null
    if (team._statsRaw && Object.keys(team._statsRaw).length > 5) {
      rawData = team._statsRaw
    } else {
      rawData = await fetchTeamStats(team.id, team.seasonId)
    }
    const lastx = await lastxPromise
    const raw = rawData
    const s = raw ? extractTeamStats(raw) : null
    const finalTeam = { ...team, stats: s, loading: false }
    setSelectedAwayTeam(finalTeam)
    setAwayLastX(lastx)
    if (s) {
      if (s.xgA != null) setXgA(String(s.xgA))
      if (s.xgaA != null) setXgaA(String(s.xgaA))
      if (s.gfA != null) setGfA(String(s.gfA))
      if (s.gaA != null) setGaA(String(s.gaA))
    }
    const homeName = selectedHomeTeam?.name || ''
    if (team.name) setMatchName(homeName ? `${homeName} vs ${team.name}` : team.name)
    updateAutofillInfo(selectedHomeTeam, finalTeam, null, s)
  }

  function updateAutofillInfo(home, away, homeStats, awayStats) {
    const h = homeStats || home?.stats
    const a = awayStats || away?.stats
    if (!h && !a) { setAutofillInfo(null); return }
    setAutofillInfo({
      home: home ? { name: home.name, league: home.leagueName, mp_h: h?.mp_h, seasonId: home.seasonId } : null,
      away: away ? { name: away.name, league: away.leagueName, mp_a: a?.mp_a } : null,
      hasXG: (h?.xgH != null) || (a?.xgA != null),
      debugRaw: { ...(h?._raw || {}), ...(a?._raw || {}) },
    })
  }

  function clearHomeTeam() {
    setSelectedHomeTeam(null)
    setHomeTeamSearch('')
    setHomeLastX(null)
    setXgH(''); setXgaH(''); setGfH(''); setGaH('')
    setAutofillInfo(null)
  }

  function clearAwayTeam() {
    setSelectedAwayTeam(null)
    setAwayTeamSearch('')
    setAwayLastX(null)
    setXgA(''); setXgaA(''); setGfA(''); setGaA('')
    setAutofillInfo(null)
  }

  function filterTeams(query) {
    if (!query.trim()) return []
    const words = query.toLowerCase().trim().split(/\s+/)
    const results = allTeams
      .map(t => {
        const name = t.name?.toLowerCase() || ''
        const clean = t.cleanName?.toLowerCase() || ''
        const haystack = name + ' ' + clean

        // VŠETKY slová musia byť v názve tímu
        const allMatch = words.every(w => haystack.includes(w))
        if (!allMatch) return null

        // Skóre: presná zhoda > začína > obsahuje
        let score = 1
        if (name.startsWith(words[0]) || clean.startsWith(words[0])) score = 2
        if (name === query.toLowerCase() || clean === query.toLowerCase()) score = 3
        return { t, score }
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
      .map(x => x.t)
      .slice(0, 12)
    return results
  }

  function handleCalc() {
    const sc = pf(xgScaler) || 0.90
    const h = pf(xgH) * sc, a = pf(xgA) * sc
    if (!h || !a) return
    const ha = pf(xgaH) * sc, aa = pf(xgaA) * sc
    const gfHv = pf(gfH), gaHv = pf(gaH), gfAv = pf(gfA), gaAv = pf(gaA)
    const alph = pf(alpha) || 0.70
    let lH, lA

    const hasGoals = gfHv > 0 && gaHv > 0 && gfAv > 0 && gaAv > 0
    const hasXGA = ha > 0 && aa > 0

    if (hasGoals && hasXGA) {
      const res = blendWithGoals(h, a, ha, aa, gfHv, gaHv, gfAv, gaAv, alph)
      lH = res.lH; lA = res.lA
    } else if (hasGoals) {
      const res = blendWithGoals(h, a, h, a, gfHv, gaHv, gfAv, gaAv, alph)
      lH = res.lH; lA = res.lA
    } else if (hasXGA) {
      lH = blendLambda(h, aa); lA = blendLambda(a, ha)
    } else {
      lH = h; lA = a
    }

    // ── TIME DECAY / FORMA ──
    const fw = pf(formWeight) || 0.40
    const homeForm = homeLastX ? extractLastXStats(homeLastX, formWindow) : null
    const awayForm = awayLastX ? extractLastXStats(awayLastX, formWindow) : null
    let formInfo = null

    if (homeForm || awayForm) {
      const lHbefore = lH
      const lAbefore = lA

      // Home λ — blend sezóna vs forma
      if (homeForm) {
        const formXgH = homeForm.xgH ?? homeForm.gfH ?? null
        const formXgaA = awayForm?.xgaA ?? awayForm?.gaA ?? null
        if (formXgH != null) {
          const formLH = formXgaA != null ? Math.sqrt(formXgH * formXgaA) : formXgH
          lH = timeDecayBlend(lH, formLH, fw)
        }
      }

      // Away λ — blend sezóna vs forma
      if (awayForm) {
        const formXgA = awayForm.xgA ?? awayForm.gfA ?? null
        const formXgaH = homeForm?.xgaH ?? homeForm?.gaH ?? null
        if (formXgA != null) {
          const formLA = formXgaH != null ? Math.sqrt(formXgA * formXgaH) : formXgA
          lA = timeDecayBlend(lA, formLA, fw)
        }
      }

      formInfo = {
        window: formWindow,
        weight: fw,
        lHbefore: lHbefore.toFixed(3),
        lAbefore: lAbefore.toFixed(3),
        lHafter: lH.toFixed(3),
        lAafter: lA.toFixed(3),
        homeFormMp: homeForm?.mp ?? null,
        awayFormMp: awayForm?.mp ?? null,
        homeFormXg: homeForm?.xgH ?? homeForm?.gfH ?? null,
        awayFormXg: awayForm?.xgA ?? awayForm?.gfA ?? null,
        hasHomeForm: !!homeForm,
        hasAwayForm: !!awayForm,
      }
    }

    // Shrinkage
    const lgH = pf(leagueAvgH)
    const lgA = pf(leagueAvgA)
    const shr = pf(shrinkage) || 0.15
    let shrinkInfo = null
    if (lgH > 0 && lgA > 0) {
      const result = applyShrinkage(lH, lA, lgH, lgA, shr)
      shrinkInfo = {
        lHraw: lH.toFixed(3), lAraw: lA.toFixed(3),
        rawTotal: result.rawTotal, shrunkTotal: result.shrunkTotal,
        ratio: result.ratio,
        leagueAvgH: lgH.toFixed(3), leagueAvgA: lgA.toFixed(3),
        source: leagueAvgSource,
      }
      lH = result.lH
      lA = result.lA
    }

    // Dixon-Coles rho
    const rhoVal = pf(rho) || -0.10

    // Poisson + Dixon-Coles
    const { pOver: pOverRaw, pUnder: pUnderRaw } = calcOverUnder(lH, lA, rhoVal)

    // Score matrix pre AH (rovnaké λ, rovnaké rho — engine sa nemení)
    const scoreMatrix = buildScoreMatrix(lH, lA, rhoVal)
    const ahRaw = calcAH(scoreMatrix)
    // AH -0.5 = čistý výsledok (home win / away win) — BEZ kalibrácie
    // calibrateProb by deformovalo pravdepodobnosti a dávalo fake EV
    const kVal = pf(calibK) || 0.85
    const pAHHomeMinus05 = ahRaw.pHomeMinus05
    const pAHHomePlus05 = ahRaw.pHomePlus05
    const pAHAwayMinus05 = ahRaw.pAwayMinus05
    const pAHAwayPlus05 = ahRaw.pAwayPlus05
    const pOverCalib = calibrateProb(pOverRaw, kVal)
    const pUnderCalib = calibrateProb(pUnderRaw, kVal)

    // Market calibration
    const mw = pf(marketWeight) || 0.50
    const moOver = pf(marketOddsOver)
    const moUnder = pf(marketOddsUnder)
    const pOverFinal = moOver > 1 ? marketCalibration(pOverCalib, moOver, mw) : pOverCalib
    const pUnderFinal = moUnder > 1 ? marketCalibration(pUnderCalib, moUnder, mw) : pUnderCalib

    // Market probability z mid odds (bez margin)
    // Priorita: mid z back/lay, fallback: market odds input
    const midOEarly = midPrice(pf(backOver) || null, pf(layOver) || null)
    const midUEarly = midPrice(pf(backUnder) || null, pf(layUnder) || null)
    const pMarketOver = midOEarly ? 1 / midOEarly : (moOver > 1 ? 1 / moOver : null)
    const pMarketUnder = midUEarly ? 1 / midUEarly : (moUnder > 1 ? 1 / moUnder : null)

    // ΔP vs market — modelProb (po kalibrácii, pred market blendom) mínus market implied prob
    const deltaPOver = (pOverCalib != null && pMarketOver != null) ? (pOverCalib - pMarketOver) * 100 : null
    const deltaPUnder = (pUnderCalib != null && pMarketUnder != null) ? (pUnderCalib - pMarketUnder) * 100 : null

    function deltaPLabel(dp) {
      const abs = Math.abs(dp)
      if (abs < 3) return 'blízko trhu'
      if (abs < 6) return 'mierna odchýlka'
      if (abs < 10) return 'veľká odchýlka'
      return 'extrémna odchýlka'
    }

    const ferOver = fairOdds(pOverFinal)
    const ferUnder = fairOdds(pUnderFinal)
    const comm = pf(commission) / 100 || 0.05
    const st = pf(stake) || 10
    const bo = pf(backOver) || null
    const lo = pf(layOver) || null
    const bu = pf(backUnder) || null
    const lu = pf(layUnder) || null
    const midO = midPrice(bo, lo)
    const midU = midPrice(bu, lu)

    // EV + filters
    const evMinVal = pf(evMin) / 100 || 0.12
    const oLow = pf(oddsLow) || 1.4
    const oHigh = pf(oddsHigh) || 3.5

    setSavedKey(null)
    setCalc({
      lH, lA,
      pOverRaw, pUnderRaw,
      pOverCalib, pUnderCalib,
      pMarketOver, pMarketUnder,
      deltaPOver, deltaPUnder,
      pOver: pOverFinal, pUnder: pUnderFinal,
      ferOver, ferUnder, midO, midU, comm, st,
      evOBack: midO ? calcBackEV(pOverFinal, midO, comm) : null,
      evUBack: midU ? calcBackEV(pUnderFinal, midU, comm) : null,
      evOLay: midO ? calcLayEV(pOverFinal, midO, comm) : null,
      evULay: midU ? calcLayEV(pUnderFinal, midU, comm) : null,
      matchName: matchName.trim() || null,
      modelType: hasGoals ? (hasXGA ? 'full' : 'goals') : (hasXGA ? 'xga' : 'basic'),
      alpha: alph.toFixed(2),
      shrinkInfo,
      rho: rhoVal,
      calibK: kVal,
      marketCalibUsed: { over: moOver > 1, under: moUnder > 1, w: mw },
      evMinVal,
      oLow, oHigh,
      formInfo,
      xgScaler: pf(xgScaler) || 0.90,
      ah: {
        pHomeMinus05: pAHHomeMinus05,
        pHomePlus05: pAHHomePlus05,
        pAwayMinus05: pAHAwayMinus05,
        pAwayPlus05: pAHAwayPlus05,
        pHomeWin: ahRaw.pHomeWin,
        pDraw: ahRaw.pDraw,
        pAwayWin: ahRaw.pAwayWin,
      },
    })
  }

  async function handleSave(market, betType) {
    if (!calc || saving) return
    setSaving(true)
    const isOver = market === 'over2.5'
    const isAH = market.startsWith('ah_')

    // Pravdepodobnosť a FER podľa marketu
    let selProb, ferO, midOdds
    if (isAH) {
      if (market === 'ah_home_minus05') {
        selProb = calc.ah.pHomeMinus05
        midOdds = midPrice(pf(backAHHome) || null, pf(layAHHome) || null)
      } else {
        selProb = calc.ah.pAwayMinus05
        midOdds = midPrice(pf(backAHAway) || null, pf(layAHAway) || null)
      }
      ferO = fairOdds(selProb)
    } else {
      selProb = isOver ? calc.pOver : calc.pUnder
      ferO = isOver ? calc.ferOver : calc.ferUnder
      midOdds = isOver ? calc.midO : calc.midU
    }

    if (!midOdds) { setSaving(false); return }
    const myO = isAH
      ? pf(market === 'ah_home_minus05' ? myOddsAHHome : myOddsAHAway)
      : pf(isOver ? myOddsOver : myOddsUnder)
    const actualOdds = (myO && myO > 1) ? myO : midOdds
    const ev = betType === 'back'
      ? calcBackEV(selProb, actualOdds, calc.comm)
      : calcLayEV(selProb, actualOdds, calc.comm)

    const kickoff = matchTime ? new Date(matchTime).toISOString() : null
    const betTimeNow = new Date().toISOString()
    const hoursToKO = kickoff ? (new Date(kickoff) - new Date(betTimeNow)) / 3600000 : null
    const league = selectedHomeTeam?.leagueName || selectedAwayTeam?.leagueName || null
    const modelProb = isAH ? selProb : (isOver ? calc.pOverCalib : calc.pUnderCalib)
    const marketProb = isAH ? null : (isOver ? calc.pMarketOver : calc.pMarketUnder)
    const { data: inserted, error } = await supabase.from('bets').insert({
      match_name: matchName.trim() || calc.matchName || null, market, bet_type: betType,
      lambda_h: calc.lH, lambda_a: calc.lA,
      p_over: calc.pOver, p_under: calc.pUnder,
      sel_prob: selProb, fer_odds: ferO,
      odds_open: actualOdds, odds_close: null,
      stake: calc.st, commission: calc.comm * 100,
      ev, ev_pct: ev != null ? ev * 100 : null,
      delta_p: isOver ? calc.deltaPOver : calc.deltaPUnder,
      clv: null, result: null, pnl: null, brier: null, log_loss: null,
      match_time: kickoff,
      bet_time: betTimeNow,
      hours_to_ko: hoursToKO != null ? Math.round(hoursToKO * 10) / 10 : null,
      league,
      model_prob: modelProb,
      market_prob: marketProb,
    }).select()
    if (!error) {
      await loadBets()
      setSavedKey(market + '-' + betType)
      if (kickoff && inserted?.[0]?.id) {
        scheduleClvNotification(inserted[0].id, calc.matchName, kickoff, market)
      }
    }
    setSaving(false)
  }

  async function handleSaveCLV(id) {
    const oc = pf(settleClose)
    if (!oc || oc <= 1) return
    const bet = bets.find(b => b.id === id)
    const clv = calcCLV(bet.odds_open, oc)
    await supabase.from('bets').update({ odds_close: oc, clv }).eq('id', id)
    setSettleMode('result')
    await loadBets()
  }

  async function handleSettle(id) {
    const res = parseInt(settleResult)
    if (res !== 0 && res !== 1) return
    const bet = bets.find(b => b.id === id)
    if (!bet) return
    const odds = bet.odds_open
    const comm = (bet.commission || 5) / 100
    let pnl
    if (bet.bet_type === 'lay') {
      pnl = res === 0 ? bet.stake * (1 - comm) : -bet.stake * (odds - 1)
    } else {
      pnl = res === 1 ? bet.stake * (odds - 1) * (1 - comm) : -bet.stake
    }
    await supabase.from('bets').update({
      result: res, pnl,
      brier: brierScore(bet.sel_prob, res),
      log_loss: logLoss(bet.sel_prob, res),
    }).eq('id', id)
    setSettlingId(null); setSettleResult(''); setSettleClose(''); setSettleMode('clv')
    await loadBets()
  }

  async function handleDelete(id) {
    await supabase.from('bets').delete().eq('id', id)
    await loadBets()
  }

  const MODEL_V2_DATE = '2026-03-12' // dátum opravy calibrateProb
  const OU_MARKETS = ['over2.5', 'under2.5']
  const AH_MARKETS = ['ah_home_minus05', 'ah_away_minus05']
  const settled_all = bets.filter(b => b.result != null)
  const settled = settled_all.filter(b => {
    // Filter podľa market skupiny
    if (statsMarket === 'ou' && !OU_MARKETS.includes(b.market)) return false
    if (statsMarket === 'ah' && !AH_MARKETS.includes(b.market)) return false
    // Filter podľa model verzie
    if (modelVersion === 'all') return true
    const d = b.created_at ? b.created_at.slice(0, 10) : null
    if (modelVersion === 'v1') return !d || d < MODEL_V2_DATE
    if (modelVersion === 'v2') return d && d >= MODEL_V2_DATE
    return true
  })
  const pending = bets.filter(b => b.result == null)
  const totalStake = settled.reduce((s, b) => s + b.stake, 0)
  const totalPnL = settled.reduce((s, b) => s + (b.pnl || 0), 0)
  const roi = totalStake > 0 ? (totalPnL / totalStake) * 100 : null
  const wins = settled.filter(b => b.result === 1).length
  const hitRate = settled.length > 0 ? wins / settled.length : null
  const avgProb = settled.length > 0 ? settled.reduce((s, b) => s + b.sel_prob, 0) / settled.length : null
  const avgBrier = settled.length > 0 ? settled.reduce((s, b) => s + (b.brier || 0), 0) / settled.length : null
  const avgLL = settled.length > 0 ? settled.reduce((s, b) => s + (b.log_loss || 0), 0) / settled.length : null
  const clvBets = settled.filter(b => b.clv != null)
  const avgCLV = clvBets.length > 0 ? clvBets.reduce((s, b) => s + b.clv, 0) / clvBets.length : null
  const posCLV = clvBets.length > 0 ? (clvBets.filter(b => b.clv > 0).length / clvBets.length) * 100 : null
  const evBets = settled.filter(b => b.ev_pct != null)
  const avgEV = evBets.length > 0 ? evBets.reduce((s, b) => s + b.ev_pct, 0) / evBets.length : null
  const maxDD = calcMaxDrawdown(settled)
  const calib = hitRate != null && avgProb != null ? (hitRate - avgProb) * 100 : null
  const MARKET = { 'over2.5': 'Over 2.5', 'under2.5': 'Under 2.5', 'ah_home_minus05': 'AH Home -0.5', 'ah_away_minus05': 'AH Away -0.5' }

  // CLV podľa času betu (hodiny do KO)
  const clvByTime = (() => {
    const buckets = [
      { label: '24h+', min: 24, max: Infinity },
      { label: '12–24h', min: 12, max: 24 },
      { label: '6–12h', min: 6, max: 12 },
      { label: '2–6h', min: 2, max: 6 },
      { label: '0–2h', min: 0, max: 2 },
    ]
    return buckets.map(b => {
      const group = clvBets.filter(x => x.hours_to_ko != null && x.hours_to_ko >= b.min && x.hours_to_ko < b.max)
      const avg = group.length > 0 ? group.reduce((s, x) => s + x.clv, 0) / group.length : null
      return { label: b.label, avg, count: group.length }
    }).filter(b => b.count > 0)
  })()

  // CLV podľa ligy
  const clvByLeague = (() => {
    const map = {}
    clvBets.forEach(b => {
      const key = b.league || 'Neznáma'
      if (!map[key]) map[key] = []
      map[key].push(b.clv)
    })
    return Object.entries(map)
      .map(([league, vals]) => ({ league, avg: vals.reduce((s, v) => s + v, 0) / vals.length, count: vals.length }))
      .sort((a, b) => b.avg - a.avg)
  })()

  // CLV podľa marketu
  const clvByMarket = (() => {
    const map = {}
    clvBets.forEach(b => {
      const key = MARKET[b.market] || b.market || 'Iný'
      if (!map[key]) map[key] = []
      map[key].push(b.clv)
    })
    return Object.entries(map)
      .map(([market, vals]) => ({ market, avg: vals.reduce((s, v) => s + v, 0) / vals.length, count: vals.length }))
      .sort((a, b) => b.avg - a.avg)
  })()

  // Odds bucket analysis
  const ODDS_BUCKETS = [
    { label: '1.40–1.79', min: 1.40, max: 1.80 },
    { label: '1.80–2.19', min: 1.80, max: 2.20 },
    { label: '2.20–2.79', min: 2.20, max: 2.80 },
    { label: '2.80+',     min: 2.80, max: Infinity },
  ]
  const oddsBucketStats = ODDS_BUCKETS.map(bucket => {
    const bb = settled.filter(b => b.odds_open != null && b.odds_open >= bucket.min && b.odds_open < bucket.max)
    if (bb.length === 0) return { ...bucket, count: 0, avgCLV: null, posCLV: null, avgEV: null, roi: null }
    const clvB = bb.filter(b => b.clv != null)
    const evB = bb.filter(b => b.ev_pct != null)
    const totalStakeB = bb.reduce((s, b) => s + b.stake, 0)
    const totalPnLB = bb.reduce((s, b) => s + (b.pnl || 0), 0)
    return {
      ...bucket,
      count: bb.length,
      avgCLV: clvB.length > 0 ? clvB.reduce((s, b) => s + b.clv, 0) / clvB.length : null,
      posCLV: clvB.length > 0 ? (clvB.filter(b => b.clv > 0).length / clvB.length) * 100 : null,
      avgEV: evB.length > 0 ? evB.reduce((s, b) => s + b.ev_pct, 0) / evB.length : null,
      roi: totalStakeB > 0 ? (totalPnLB / totalStakeB) * 100 : null,
    }
  })

  // Model prob vs Market prob
  const probComparison = settled.filter(b => b.model_prob != null && b.market_prob != null)
  const avgModelProb = probComparison.length > 0 ? probComparison.reduce((s, b) => s + b.model_prob, 0) / probComparison.length : null
  const avgMarketProb = probComparison.length > 0 ? probComparison.reduce((s, b) => s + b.market_prob, 0) / probComparison.length : null

  return (
    <>
      <style>{css}</style>
      <div className="header">
        <div className="dot" />
        <span className="logo">xG CALC</span>
        <span style={{ color: 'var(--border2)', fontSize: 12 }}>|</span>
        <span style={{ fontSize: 11, color: 'var(--text3)', letterSpacing: '0.1em' }}>O/U 2.5 · EXCHANGE</span>
        <div className="meta">
          {bets.length} betov {pending.length > 0 && <span style={{ color: 'var(--yellow)' }}>• {pending.length} čaká</span>}
        </div>
      </div>
      <div className="tabs">
        {[['calc', 'Kalkulačka'], ['history', `História (${bets.length})`], ['stats', 'Štatistiky']].map(([id, lbl]) => (
          <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>{lbl}</button>
        ))}
      </div>

      <div className="wrap">
        {tab === 'calc' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* Zápas + čas */}
            <div className="card">
              <div className="label">Zápas (voliteľné)</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--text3)' }}>Deň:</span>
                <input
                  type="date"
                  className="inp"
                  style={{ width: 150, padding: '4px 8px', fontSize: 12 }}
                  value={matchesDate}
                  onChange={async e => {
                    setMatchesDate(e.target.value)
                    setTodaysMatches([])
                  }}
                />
                {matchesDate !== new Date().toISOString().slice(0, 10) && (
                  <button
                    style={{ fontSize: 11, color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
                    onClick={() => { setMatchesDate(new Date().toISOString().slice(0, 10)); setTodaysMatches([]) }}
                  >dnes</button>
                )}
              </div>
              <div style={{ position: 'relative' }}>
                <input
                  className="inp"
                  placeholder="napr. Arsenal vs Chelsea — klikni pre zápasy v zvolený deň"
                  value={matchName}
                  onChange={e => { setMatchName(e.target.value); setTodaysMatchesOpen(false) }}
                  onFocus={async () => {
                    setTodaysMatchesLoading(true)
                    const matches = await fetchTodaysMatches(matchesDate)
                    setTodaysMatches(matches)
                    setTodaysMatchesLoading(false)
                    setTodaysMatchesOpen(true)
                  }}
                  onBlur={() => setTimeout(() => setTodaysMatchesOpen(false), 200)}
                />
                {todaysMatchesLoading && (
                  <div style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: 'var(--text3)' }}>načítavam...</div>
                )}
                {todaysMatchesOpen && todaysMatches.length > 0 && (
                  <div style={{ position: 'absolute', zIndex: 50, left: 0, right: 0, top: '100%', marginTop: 4, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, maxHeight: 280, overflowY: 'auto' }}>
                    {todaysMatches.map((m, i) => {
                      const hId = Number(m.homeID ?? m.home_id)
                      const aId = Number(m.awayID ?? m.away_id)
                      const homeName = m.home_name || m.homeName || '?'
                      const awayName = m.away_name || m.awayName || '?'
                      const homeTeam = allTeams.find(t => Number(t.id) === hId)
                        || (homeName !== '?' ? allTeams.find(t => t.name?.toLowerCase() === homeName.toLowerCase() || t.cleanName?.toLowerCase() === homeName.toLowerCase()) : null)
                      const awayTeam = allTeams.find(t => Number(t.id) === aId)
                        || (awayName !== '?' ? allTeams.find(t => t.name?.toLowerCase() === awayName.toLowerCase() || t.cleanName?.toLowerCase() === awayName.toLowerCase()) : null)
                      const kickoff = m.date_unix ? new Date(m.date_unix * 1000) : null
                      const timeStr = kickoff ? kickoff.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' }) : ''
                      const league = m.competition_name || m.league_name || ''
                      return (
                        <div
                          key={i}
                          style={{ padding: '9px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)', fontSize: 12 }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg2)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          onMouseDown={async () => {
                            setMatchName(`${homeName} vs ${awayName}`)
                            setTodaysMatchesOpen(false)
                            // Nastav čas výkopu
                            if (kickoff) {
                              const pad = n => String(n).padStart(2, '0')
                              const localDT = `${kickoff.getFullYear()}-${pad(kickoff.getMonth()+1)}-${pad(kickoff.getDate())}T${pad(kickoff.getHours())}:${pad(kickoff.getMinutes())}`
                              setMatchTime(localDT)
                            }
                            // Ak tím nájdeme v allTeams — použij ho
                            // Ak nie — vytvor syntetický objekt s season_id zo zápasu a fetchni štatistiky priamo
                            const mSeasonId = m.season_id ?? m.seasonID ?? null
                            const resolvedHome = homeTeam || (hId && mSeasonId ? { id: hId, name: homeName, cleanName: homeName, seasonId: mSeasonId, leagueName: league } : null)
                            const resolvedAway = awayTeam || (aId && mSeasonId ? { id: aId, name: awayName, cleanName: awayName, seasonId: mSeasonId, leagueName: league } : null)
                            if (resolvedHome) handleSelectHomeTeam(resolvedHome)
                            if (resolvedAway) handleSelectAwayTeam(resolvedAway)
                          }}
                        >
                          <div style={{ fontWeight: 600, color: 'var(--text)' }}>{homeName} vs {awayName}</div>
                          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>{league}{timeStr ? ` · ${timeStr}` : ''}</div>
                        </div>
                      )
                    })}
                  </div>
                )}
                {todaysMatchesOpen && !todaysMatchesLoading && todaysMatches.length === 0 && (
                  <div style={{ position: 'absolute', zIndex: 50, left: 0, right: 0, top: '100%', marginTop: 4, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', fontSize: 12, color: 'var(--text3)' }}>
                    Žiadne dnešné zápasy z tvojich líg
                  </div>
                )}
              </div>
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div className="label" style={{ marginBottom: 4 }}>⏰ Čas výkopu (pre CLV notifikáciu)</div>
                  <input
                    className="inp"
                    type="datetime-local"
                    value={matchTime}
                    onChange={e => setMatchTime(e.target.value)}
                    style={{ colorScheme: 'dark' }}
                  />
                </div>
                {notifPermission !== 'granted' && (
                  <button
                    onClick={requestNotifPermission}
                    style={{ marginTop: 18, padding: '6px 12px', background: 'var(--accent)', color: '#000', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}
                  >
                    🔔 Povoliť notifikácie
                  </button>
                )}
                {notifPermission === 'granted' && matchTime && (
                  <div style={{ marginTop: 18, fontSize: 11, color: 'var(--green)' }}>
                    ✓ Notifikácia sa naplánuje pri uložení betu
                  </div>
                )}
              </div>
            </div>

            {/* ── VÝBER TÍMOV (autocomplete) ── */}
            <div className="card">
              <div className="label" style={{ marginBottom: 8 }}>
                Vyber tímy — automatické doplnenie štatistík
                {teamsLoading && <span style={{ color: 'var(--yellow)', marginLeft: 8 }}>⏳ Načítavam tímy...</span>}
                {!teamsLoading && allTeams.length > 0 && <span style={{ color: 'var(--text3)', marginLeft: 8 }}>({allTeams.length} tímov z tvojich líg)</span>}
              </div>

              <div className="grid2">
                {/* HOME tím */}
                <div>
                  <div className="label">Home tím</div>
                  {!selectedHomeTeam ? (
                    <div className="team-search-wrap">
                      <input
                        className="inp"
                        placeholder={teamsLoading ? 'Načítavam...' : 'Hľadaj home tím...'}
                        value={homeTeamSearch}
                        disabled={teamsLoading}
                        onChange={e => { setHomeTeamSearch(e.target.value); setHomeTeamOpen(true) }}
                        onFocus={() => setHomeTeamOpen(true)}
                        onBlur={() => setTimeout(() => setHomeTeamOpen(false), 150)}
                      />
                      {homeTeamOpen && homeTeamSearch.length > 1 && (
                        <div className="team-search-results">
                          {filterTeams(homeTeamSearch).length === 0
                            ? <div style={{ padding: '10px 12px', fontSize: 11, color: 'var(--text3)' }}>Nenašiel som tím — vyplň ručne</div>
                            : filterTeams(homeTeamSearch).map(t => (
                              <div key={t.id} className="team-result-item" onMouseDown={() => handleSelectHomeTeam(t)}>
                                <span style={{ color: 'var(--text2)' }}>{t.name}</span>
                                <span style={{ fontSize: 10, color: 'var(--text3)' }}>{t.leagueName}</span>
                              </div>
                            ))
                          }
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="team-badge">
                      {selectedHomeTeam.loading ? '⏳' : '🏠'} {selectedHomeTeam.name}
                      {selectedHomeTeam.loading && <span style={{color:'var(--yellow)'}}>načítavam...</span>}
                      <button onClick={clearHomeTeam} title="Zmeniť">✕</button>
                    </div>
                  )}
                </div>

                {/* AWAY tím */}
                <div>
                  <div className="label">Away tím</div>
                  {!selectedAwayTeam ? (
                    <div className="team-search-wrap">
                      <input
                        className="inp"
                        placeholder={teamsLoading ? 'Načítavam...' : 'Hľadaj away tím...'}
                        value={awayTeamSearch}
                        disabled={teamsLoading}
                        onChange={e => { setAwayTeamSearch(e.target.value); setAwayTeamOpen(true) }}
                        onFocus={() => setAwayTeamOpen(true)}
                        onBlur={() => setTimeout(() => setAwayTeamOpen(false), 150)}
                      />
                      {awayTeamOpen && awayTeamSearch.length > 1 && (
                        <div className="team-search-results">
                          {filterTeams(awayTeamSearch).length === 0
                            ? <div style={{ padding: '10px 12px', fontSize: 11, color: 'var(--text3)' }}>Nenašiel som tím — vyplň ručne</div>
                            : filterTeams(awayTeamSearch).map(t => (
                              <div key={t.id} className="team-result-item" onMouseDown={() => handleSelectAwayTeam(t)}>
                                <span style={{ color: 'var(--text2)' }}>{t.name}</span>
                                <span style={{ fontSize: 10, color: 'var(--text3)' }}>{t.leagueName}</span>
                              </div>
                            ))
                          }
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="team-badge">
                      {selectedAwayTeam.loading ? '⏳' : '✈️'} {selectedAwayTeam.name}
                      {selectedAwayTeam.loading && <span style={{color:'var(--yellow)'}}>načítavam...</span>}
                      <button onClick={clearAwayTeam} title="Zmeniť">✕</button>
                    </div>
                  )}
                </div>
              </div>

              {/* Autofill info */}
              {autofillInfo && (
                <div className="autofill-info">
                  {autofillInfo.home && <span>🏠 <b>{autofillInfo.home.name}</b> ({autofillInfo.home.league}, {autofillInfo.home.mp_h} dom. zápasov, seasonId: {autofillInfo.home.seasonId}) </span>}
                  {autofillInfo.away && <span>✈️ <b>{autofillInfo.away.name}</b> ({autofillInfo.away.league}, {autofillInfo.away.mp_a} vonk. zápasov) </span>}
                  {autofillInfo.hasXG
                    ? <span style={{ color: 'var(--green)' }}>· ✓ xG + GF/GA natiahnuté</span>
                    : <span style={{ color: 'var(--yellow)' }}>· ⚠ xG sa nenašlo — skontroluj raw polia nižšie</span>
                  }
                  {/* Debug: ukáž raw polia z API keď xG chýba */}
                  {!autofillInfo.hasXG && autofillInfo.debugRaw && Object.keys(autofillInfo.debugRaw).length > 0 && (
                    <details style={{ marginTop: 6, fontSize: 10 }}>
                      <summary style={{ cursor: 'pointer', color: 'var(--accent2)' }}>🔍 Raw API polia (klikni pre debug)</summary>
                      <div style={{ marginTop: 4, padding: '6px 8px', background: 'var(--bg3)', borderRadius: 4, fontFamily: 'var(--mono)', lineHeight: 1.8, color: 'var(--text2)' }}>
                        {Object.entries(autofillInfo.debugRaw).map(([k, v]) => (
                          <div key={k}><span style={{ color: 'var(--accent2)' }}>{k}</span>: {String(v)}</div>
                        ))}
                      </div>
                    </details>
                  )}
                  {!autofillInfo.hasXG && autofillInfo.debugRaw && Object.keys(autofillInfo.debugRaw).length === 0 && (
                    <div style={{ marginTop: 4, fontSize: 10, color: 'var(--red)' }}>
                      ❌ API nevrátilo žiadne dáta pre tento tím — skontroluj season_id alebo API kľúč
                    </div>
                  )}
                </div>
              )}

              {/* Forma (lastx) info + nastavenia */}
              {(homeLastX || awayLastX) && (
                <div style={{ marginTop: 10, background: 'rgba(108,92,231,0.07)', border: '1px solid rgba(108,92,231,0.2)', borderRadius: 6, padding: '10px 12px' }}>
                  <div style={{ fontSize: 10, color: 'var(--accent2)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>
                    📈 Forma — last X zápasov načítaná
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--text3)' }}>Okno:</span>
                    {[5, 6, 10].map(w => (
                      <button key={w} onClick={() => setFormWindow(w)}
                        style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid', fontSize: 10, cursor: 'pointer', fontFamily: 'var(--mono)',
                          borderColor: formWindow === w ? 'var(--accent)' : 'var(--border)',
                          background: formWindow === w ? 'rgba(108,92,231,0.2)' : 'transparent',
                          color: formWindow === w ? 'var(--accent2)' : 'var(--text3)' }}>
                        {`Last ${w}`}
                      </button>
                    ))}
                    <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 8 }}>Váha formy:</span>
                    <input className="inp" style={{ width: 70, padding: '4px 8px', fontSize: 11 }}
                      placeholder="0.40" value={formWeight} onChange={e => setFormWeight(e.target.value)} />
                    <span style={{ fontSize: 10, color: 'var(--text3)' }}>(0=len sezóna, 1=len forma)</span>
                  </div>
                  <div style={{ display: 'flex', gap: 16, fontSize: 11, flexWrap: 'wrap' }}>
                    {homeLastX && (() => {
                      const f = extractLastXStats(homeLastX, formWindow)
                      return f ? (
                        <span style={{ color: 'var(--text2)' }}>
                          🏠 xG forma: <b style={{ color: 'var(--accent2)' }}>{f.xgH ?? f.gfH ?? '—'}</b>
                          {f.mp && <span style={{ color: 'var(--text3)' }}> ({f.mp} záp.)</span>}
                        </span>
                      ) : <span style={{ color: 'var(--yellow)' }}>🏠 forma: bez dát</span>
                    })()}
                    {awayLastX && (() => {
                      const f = extractLastXStats(awayLastX, formWindow)
                      return f ? (
                        <span style={{ color: 'var(--text2)' }}>
                          ✈️ xG forma: <b style={{ color: 'var(--accent2)' }}>{f.xgA ?? f.gfA ?? '—'}</b>
                          {f.mp && <span style={{ color: 'var(--text3)' }}> ({f.mp} záp.)</span>}
                        </span>
                      ) : <span style={{ color: 'var(--yellow)' }}>✈️ forma: bez dát</span>
                    })()}
                  </div>
                </div>
              )}

              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 8 }}>
                Tímy mimo tvojich líg → vyplň xG / GF / GA ručne nižšie
              </div>
            </div>
            {/* ── KONIEC VÝBER TÍMOV ── */}

            {/* xG hodnoty */}
            <div className="card">
              <div className="label" style={{ marginBottom: 10 }}>xG hodnoty</div>
              <div className="grid2">
                <div><div className="label">xG Home</div><input className="inp" placeholder="1.45" value={xgH} onChange={e => setXgH(e.target.value)} /></div>
                <div><div className="label">xG Away</div><input className="inp" placeholder="0.98" value={xgA} onChange={e => setXgA(e.target.value)} /></div>
                <div><div className="label">xGA Home (opt)</div><input className="inp" placeholder="1.20" value={xgaH} onChange={e => setXgaH(e.target.value)} /></div>
                <div><div className="label">xGA Away (opt)</div><input className="inp" placeholder="1.10" value={xgaA} onChange={e => setXgaA(e.target.value)} /></div>
              </div>
            </div>

            {/* GF / GA */}
            <div className="card">
              <div className="label" style={{ marginBottom: 10 }}>GF / GA — reálne góly (opt)</div>
              <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 10 }}>
                Priemer gólov na zápas doma / vonku za sezónu
              </div>
              <div className="grid2">
                <div><div className="label">GF Home (doma)</div><input className="inp" placeholder="1.60" value={gfH} onChange={e => setGfH(e.target.value)} /></div>
                <div><div className="label">GA Home (doma)</div><input className="inp" placeholder="1.10" value={gaH} onChange={e => setGaH(e.target.value)} /></div>
                <div><div className="label">GF Away (vonku)</div><input className="inp" placeholder="1.20" value={gfA} onChange={e => setGfA(e.target.value)} /></div>
                <div><div className="label">GA Away (vonku)</div><input className="inp" placeholder="1.40" value={gaA} onChange={e => setGaA(e.target.value)} /></div>
              </div>
              <div style={{ marginTop: 10 }}>
                <div className="label">α — váha xG vs góly <span style={{ color: 'var(--accent2)' }}>(0.70 = 70% xG, 30% góly)</span></div>
                <input className="inp" placeholder="0.70" value={alpha} onChange={e => setAlpha(e.target.value)} />
              </div>
            </div>

            {/* Liga priemer */}
            <div className="card" style={{ position: 'relative' }}>
              <div className="label" style={{ marginBottom: 8 }}>
                Liga priemer gólov
                <span style={{ color: 'var(--text3)', marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}>
                  — voliteľné, spresnenie λ cez shrinkage
                </span>
              </div>
              {!selectedLeague ? (
                <div style={{ position: 'relative' }}>
                  <input
                    className="inp"
                    placeholder={leagueLoading ? 'Načítavam ligy...' : 'Klikni pre výber ligy alebo píš na filtrovanie...'}
                    value={leagueSearch}
                    disabled={leagueLoading}
                    onChange={e => { setLeagueSearch(e.target.value); setLeagueOpen(true) }}
                    onFocus={() => setLeagueOpen(true)}
                    onBlur={() => setTimeout(() => setLeagueOpen(false), 150)}
                  />
                  {leagueOpen && allLeagues.length > 0 && (
                    <div className="league-search-results" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, maxHeight: 260, overflowY: 'auto' }}>
                      {allLeagues
                        .filter(l => {
                          if (!leagueSearch.trim()) return true
                          const q = leagueSearch.toLowerCase()
                          return l.name?.toLowerCase().includes(q) || l.country?.toLowerCase().includes(q)
                        })
                        .map(l => (
                          <div key={l.id} className="league-result-item" onMouseDown={() => handleSelectLeague(l)}>
                            <span style={{ color: 'var(--text2)' }}>{l.name}</span>
                            <span style={{ color: 'var(--text3)', marginLeft: 8 }}>{l.country}</span>
                          </div>
                        ))
                      }
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <div className="league-badge">
                    ⚽ {selectedLeague.name}
                    <span style={{ color: 'var(--text3)' }}>{selectedLeague.country}</span>
                    <button onClick={clearLeague} title="Zmeniť ligu">✕</button>
                  </div>
                  {leagueAvgSource === 'api' && pf(leagueAvgH) > 0 && (
                    <div style={{ fontSize: 10, color: 'var(--green)', marginTop: 6 }}>
                      ✓ Stiahnuté z FootyStats: Home <b>{leagueAvgH}</b> · Away <b>{leagueAvgA}</b> gól/zápas
                    </div>
                  )}
                  {leagueAvgSource === 'manual' && (
                    <div style={{ fontSize: 10, color: 'var(--yellow)', marginTop: 6 }}>
                      ⚠ Dáta pre túto ligu neboli nájdené — zadaj manuálne:
                    </div>
                  )}
                  {(leagueAvgSource === 'manual' || !pf(leagueAvgH)) && (
                    <div className="grid2" style={{ marginTop: 8 }}>
                      <div>
                        <div className="label">Avg Home Goals/zápas</div>
                        <input className="inp" placeholder="napr. 1.45" value={leagueAvgH} onChange={e => setLeagueAvgH(e.target.value)} />
                      </div>
                      <div>
                        <div className="label">Avg Away Goals/zápas</div>
                        <input className="inp" placeholder="napr. 1.20" value={leagueAvgA} onChange={e => setLeagueAvgA(e.target.value)} />
                      </div>
                    </div>
                  )}
                </div>
              )}
              {!selectedLeague && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 6 }}>Alebo zadaj manuálne:</div>
                  <div className="grid2">
                    <div>
                      <div className="label">Avg Home Goals/zápas</div>
                      <input className="inp" placeholder="napr. 1.45" value={leagueAvgH}
                        onChange={e => { setLeagueAvgH(e.target.value); setLeagueAvgSource('manual') }} />
                    </div>
                    <div>
                      <div className="label">Avg Away Goals/zápas</div>
                      <input className="inp" placeholder="napr. 1.20" value={leagueAvgA}
                        onChange={e => { setLeagueAvgA(e.target.value); setLeagueAvgSource('manual') }} />
                    </div>
                  </div>
                </div>
              )}
              {(pf(leagueAvgH) > 0 || pf(leagueAvgA) > 0) && (
                <div style={{ marginTop: 10 }}>
                  <div className="label">
                    Shrinkage faktor
                    <span style={{ color: 'var(--accent2)', marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}>
                      (0.15 = 15% ťah λ k priemeru ligy)
                    </span>
                  </div>
                  <input className="inp" placeholder="0.15" value={shrinkage} onChange={e => setShrinkage(e.target.value)} />
                </div>
              )}
              <div style={{ marginTop: 10 }}>
                <div className="label">
                  xG scaler
                  <span style={{ color: 'var(--accent2)', marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}>
                    (0.90 = FootyStats xG × 0.90, kompenzuje nafúknuté hodnoty)
                  </span>
                </div>
                <input className="inp" placeholder="0.90" value={xgScaler} onChange={e => setXgScaler(e.target.value)} />
              </div>
            </div>

            {/* ── POKROČILÉ NASTAVENIA ── */}
            <div className="card">
              <div className="advanced-toggle" onClick={() => setShowAdvanced(v => !v)}>
                <div className="label" style={{ marginBottom: 0 }}>
                  ⚙ Pokročilé nastavenia
                  <span style={{ color: 'var(--text3)', marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}>
                    Dixon-Coles · Market cal · Prob cal · Filtre
                  </span>
                </div>
                <button className="btn-toggle">{showAdvanced ? '▲ Skryť' : '▼ Zobraziť'}</button>
              </div>

              {showAdvanced && (
                <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>

                  {/* Dixon-Coles */}
                  <div>
                    <div className="section-title" style={{ marginBottom: 8 }}>📐 Dixon-Coles korekcia</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 8 }}>
                      Upravuje pravdepodobnosti pre nízke skóre (0-0, 1-0, 0-1, 1-1). ρ = 0 vypne korekciu.
                    </div>
                    <div>
                      <div className="label">ρ (rho) — korelačný parameter <span style={{ color: 'var(--accent2)' }}>(-0.05 až -0.15)</span></div>
                      <input className="inp" placeholder="-0.10" value={rho} onChange={e => setRho(e.target.value)} />
                    </div>
                  </div>

                  {/* Market calibration */}
                  <div>
                    <div className="section-title" style={{ marginBottom: 8 }}>📊 Market calibration</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 8 }}>
                      Blend modelu s trhovou pravdepodobnosťou. Nechaj prázdne ak nechceš použiť.
                    </div>
                    <div className="grid2" style={{ marginBottom: 10 }}>
                      <div>
                        <div className="label">Market kurz Over 2.5</div>
                        <input className="inp" placeholder="napr. 1.90" value={marketOddsOver} onChange={e => setMarketOddsOver(e.target.value)} />
                      </div>
                      <div>
                        <div className="label">Market kurz Under 2.5</div>
                        <input className="inp" placeholder="napr. 2.00" value={marketOddsUnder} onChange={e => setMarketOddsUnder(e.target.value)} />
                      </div>
                    </div>
                    <div>
                      <div className="label">w — váha modelu <span style={{ color: 'var(--accent2)' }}>(0.50 = 50% model, 50% market)</span></div>
                      <input className="inp" placeholder="0.50" value={marketWeight} onChange={e => setMarketWeight(e.target.value)} />
                    </div>
                  </div>

                  {/* Probability calibration */}
                  <div>
                    <div className="section-title" style={{ marginBottom: 8 }}>🎯 Probability calibration</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 8 }}>
                      Kalibrácia k 50%. k &lt; 1 = stiahni k 50%, k = 1 = bez zmeny, k &gt; 1 = polarizuj.
                    </div>
                    <div>
                      <div className="label">k — kalibračný exponent <span style={{ color: 'var(--accent2)' }}>(default 0.85)</span></div>
                      <input className="inp" placeholder="0.85" value={calibK} onChange={e => setCalibK(e.target.value)} />
                    </div>
                  </div>

                  {/* Filtre */}
                  <div>
                    <div className="section-title" style={{ marginBottom: 8 }}>🔍 Bet filtre</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 8 }}>
                      Tieto filtre sa zobrazia po výpočte pri každom markete.
                    </div>
                    <div className="grid3">
                      <div>
                        <div className="label">Min EV% <span style={{ color: 'var(--accent2)' }}>(default 4)</span></div>
                        <input className="inp" placeholder="12" value={evMin} onChange={e => setEvMin(e.target.value)} />
                      </div>
                      <div>
                        <div className="label">Min kurz</div>
                        <input className="inp" placeholder="1.4" value={oddsLow} onChange={e => setOddsLow(e.target.value)} />
                      </div>
                      <div>
                        <div className="label">Max kurz</div>
                        <input className="inp" placeholder="3.5" value={oddsHigh} onChange={e => setOddsHigh(e.target.value)} />
                      </div>
                    </div>
                  </div>

                </div>
              )}
            </div>
            {/* ── KONIEC POKROČILÉ ── */}

            {/* Stake / komisia */}
            <div className="card">
              <div className="grid2">
                <div><div className="label">Stake (€)</div><input className="inp" placeholder="10" value={stake} onChange={e => setStake(e.target.value)} /></div>
                <div><div className="label">Komisia (%)</div><input className="inp" placeholder="5" value={commission} onChange={e => setCommission(e.target.value)} /></div>
              </div>
            </div>

            <button className="btn btn-primary" onClick={handleCalc}>▶ Vypočítať</button>

            {/* Market toggle */}
            {calc && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600, letterSpacing: 1 }}>MARKET:</span>
                {[['ou', 'O/U 2.5'], ['ah', 'AH ±0.5']].map(([id, lbl]) => (
                  <button key={id} onClick={() => setMarketMode(id)} style={{
                    fontSize: 11, padding: '3px 12px', borderRadius: 6, border: '1px solid',
                    borderColor: marketMode === id ? 'var(--accent)' : 'var(--border)',
                    background: marketMode === id ? 'var(--accent)' : 'transparent',
                    color: marketMode === id ? '#fff' : 'var(--text3)',
                    cursor: 'pointer', fontWeight: marketMode === id ? 700 : 400
                  }}>{lbl}</button>
                ))}
              </div>
            )}

            {/* Markets */}
            <div className="markets-grid">
              {marketMode === 'ou' && [true, false].map(isOver => {
                const fer = isOver ? calc?.ferOver : calc?.ferUnder
                const prob = isOver ? calc?.pOver : calc?.pUnder
                const probRaw = isOver ? calc?.pOverRaw : calc?.pUnderRaw
                const probCalib = isOver ? calc?.pOverCalib : calc?.pUnderCalib
                const mid = isOver ? calc?.midO : calc?.midU
                const st = calc?.st || 10
                const comm = calc?.comm || 0.05
                const mkt = isOver ? 'over2.5' : 'under2.5'
                const edge = mid && fer ? (mid / fer - 1) * 100 : null
                const marketCalibUsed = isOver ? calc?.marketCalibUsed?.over : calc?.marketCalibUsed?.under
                const pMarket = isOver ? calc?.pMarketOver : calc?.pMarketUnder
                const deltaP = isOver ? calc?.deltaPOver : calc?.deltaPUnder

                return (
                  <div key={mkt} className={`market-col ${isOver ? 'market-col-over' : 'market-col-under'}`}>
                    <div className={`market-title ${isOver ? 'market-title-over' : 'market-title-under'}`}>
                      {isOver ? 'Over 2.5' : 'Under 2.5'}
                    </div>

                    {fer && <div style={{ marginBottom: 10 }}>
                      <div className="label">FER kurz</div>
                      <div className={`fer-num ${isOver ? 'fer-num-over' : 'fer-num-under'}`}>
                        {fmt3(fer)} <span style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 400 }}>({fmtPct(prob * 100)})</span>
                      </div>
                    </div>}

                    {/* Pravdepodobnosti pipeline */}
                    {calc && probRaw != null && (
                      <div className="prob-compare">
                        <div className="prob-box">
                          <div className="prob-box-label">Poisson+DC</div>
                          <div className="prob-box-val" style={{ color: 'var(--text2)' }}>{fmtPct(probRaw * 100)}</div>
                        </div>
                        <div className="prob-box">
                          <div className="prob-box-label">Calib</div>
                          <div className="prob-box-val" style={{ color: 'var(--yellow)' }}>{fmtPct(probCalib * 100)}</div>
                        </div>
                        <div className="prob-box">
                          <div className="prob-box-label">{marketCalibUsed ? 'Mkt blend' : 'Finálna'}</div>
                          <div className="prob-box-val" style={{ color: isOver ? 'var(--accent2)' : 'var(--green)' }}>{fmtPct(prob * 100)}</div>
                        </div>
                        {pMarket != null && (
                          <div className="prob-box">
                            <div className="prob-box-label">Market (mid)</div>
                            <div className="prob-box-val" style={{ color: 'var(--text3)' }}>{fmtPct(pMarket * 100)}</div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Debug súhrn: Market / Model / Final / ΔP */}
                    {calc && probCalib != null && pMarket != null && (() => {
                      const dpLabel = deltaP != null ? (Math.abs(deltaP) < 3 ? 'blízko trhu' : Math.abs(deltaP) < 6 ? 'mierna odchýlka' : Math.abs(deltaP) < 10 ? 'veľká odchýlka' : 'extrémna odchýlka') : null
                      const dpColor = deltaP == null ? 'var(--text3)' : Math.abs(deltaP) < 1 ? 'var(--text3)' : deltaP > 0 ? 'var(--green)' : 'var(--red)'
                      return (
                        <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--bg3)', borderRadius: 6, fontSize: 11, color: 'var(--text3)', lineHeight: 1.8, fontFamily: 'var(--mono)' }}>
                          <div>Market prob: <b style={{ color: 'var(--text2)' }}>{fmtPct(pMarket * 100)}</b></div>
                          <div>Model prob: <b style={{ color: 'var(--yellow)' }}>{fmtPct(probCalib * 100)}</b></div>
                          <div>Final prob: <b style={{ color: isOver ? 'var(--accent2)' : 'var(--green)' }}>{fmtPct(prob * 100)}</b></div>
                          {deltaP != null && (
                            <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid var(--border)' }}>
                              ΔP vs market: <b style={{ color: dpColor }}>{deltaP > 0 ? '+' : ''}{deltaP.toFixed(1)} pp</b>
                              {dpLabel && <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.7 }}>({dpLabel})</span>}
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    <div style={{ marginTop: 10, marginBottom: 8 }}>
                      <div className="label">Best Back</div>
                      <input className="inp inp-sm" placeholder="1.85"
                        value={isOver ? backOver : backUnder}
                        onChange={e => {
                          const val = e.target.value
                          if (isOver) { setBackOver(val); setMarketOddsOver(val) }
                          else { setBackUnder(val); setMarketOddsUnder(val) }
                        }} />
                    </div>
                    <div style={{ marginBottom: 8 }}>
                      <div className="label">Best Lay</div>
                      <input className="inp inp-sm" placeholder="1.88"
                        value={isOver ? layOver : layUnder}
                        onChange={e => isOver ? setLayOver(e.target.value) : setLayUnder(e.target.value)} />
                    </div>
                    <div style={{ marginBottom: 8 }}>
                      <div className="label">Môj kurz <span style={{color:'var(--accent2)'}}>(opt — ak líši od mid)</span></div>
                      <input className="inp inp-sm" placeholder="napr. 2.08"
                        value={isOver ? myOddsOver : myOddsUnder}
                        onChange={e => isOver ? setMyOddsOver(e.target.value) : setMyOddsUnder(e.target.value)} />
                    </div>

                    {mid ? <>
                      <div className="mid-row">
                        <span style={{ color: 'var(--text3)' }}>Mid:</span>
                        <span className="mid-val">{fmt3(mid)}</span>
                        {edge != null && <span className={edge > 0 ? 'pos' : 'neg'} style={{ marginLeft: 'auto', fontSize: 11 }}>Edge {fmtSignPct(edge)}</span>}
                      </div>
                      {(() => {
                        const myO = pf(isOver ? myOddsOver : myOddsUnder)
                        const actualOdds = myO > 1 ? myO : mid
                        const evB = calcBackEV(prob, actualOdds, comm)
                        const evL = calcLayEV(prob, actualOdds, comm)
                        const usingMyOdds = myO > 1

                        // Filtre
                        const evMinVal = calc?.evMinVal || 0.12
                        const oLow = calc?.oLow || 1.4
                        const oHigh = calc?.oHigh || 3.5
                        const evPassB = evFilter(evB, evMinVal)
                        const evPassL = evFilter(evL, evMinVal)
                        const oddsPass = oddsBandFilter(actualOdds, oLow, oHigh)

                        return <>
                          <div>
                            <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 2 }}>
                              ▲ Back EV {usingMyOdds && <span style={{color:'var(--accent2)'}}>(@{fmt3(actualOdds)})</span>}
                            </div>
                            <div className={`ev-big ${evB > 0 ? 'pos' : 'neg'}`}>
                              {fmtSignPct(evB * 100)}<span className="ev-eur">{fmtSign(evB * st)}€</span>
                            </div>
                          </div>
                          <div style={{ marginTop: 6 }}>
                            <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 2 }}>
                              ▼ Lay EV {usingMyOdds && <span style={{color:'var(--accent2)'}}>(@{fmt3(actualOdds)})</span>}
                            </div>
                            <div className={`ev-big ${evL > 0 ? 'pos' : 'neg'}`}>
                              {fmtSignPct(evL * 100)}<span className="ev-eur">{fmtSign(evL * st)}€</span>
                            </div>
                            <div className="liability-note">Liability: {fmt2(layLiability(mid, st))}€</div>
                          </div>

                          {/* Filter výsledok */}
                          <div style={{ marginTop: 8, fontSize: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
                            <div style={{ color: oddsPass ? 'var(--green)' : 'var(--red)' }}>
                              {oddsPass ? '✓' : '✗'} Kurz {fmt3(actualOdds)} {oddsPass ? `v pásme (${oLow}–${oHigh})` : `mimo pásma (${oLow}–${oHigh})`}
                            </div>
                            <div style={{ color: evPassB ? 'var(--green)' : 'var(--text3)' }}>
                              {evPassB ? '✓' : '✗'} Back EV {evPassB ? 'spĺňa' : 'nespĺňa'} min {fmtPct(evMinVal * 100)}
                            </div>
                            <div style={{ color: evPassL ? 'var(--green)' : 'var(--text3)' }}>
                              {evPassL ? '✓' : '✗'} Lay EV {evPassL ? 'spĺňa' : 'nespĺňa'} min {fmtPct(evMinVal * 100)}
                            </div>
                            {oddsPass && (evPassB || evPassL) && (
                              <div style={{ marginTop: 4, color: 'var(--green)', fontWeight: 700 }}>
                                ✅ BET SIGNAL: {evPassB && oddsPass ? 'BACK ' : ''}{evPassL && oddsPass ? 'LAY' : ''}
                              </div>
                            )}
                          </div>
                        </>
                      })()}
                      <div className="save-btns">
                        <button className="btn-save-back" onClick={() => handleSave(mkt, 'back')} disabled={saving}>
                          {savedKey === mkt + '-back' ? '✓' : '+ Back'}
                        </button>
                        <button className="btn-save-lay" onClick={() => handleSave(mkt, 'lay')} disabled={saving}>
                          {savedKey === mkt + '-lay' ? '✓' : '+ Lay'}
                        </button>
                      </div>
                      <div style={{ fontSize: 9, color: 'var(--text3)', textAlign: 'center', marginTop: 4 }}>kom {(comm * 100).toFixed(0)}%</div>
                    </> : <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8 }}>Zadaj Back aj Lay pre mid price</div>}
                  </div>
                )
              })}

              {/* AH ±0.5 markets */}
              {marketMode === 'ah' && calc?.ah && [
                { label: 'AH Home -0.5', sublabel: 'Domáci musí vyhrať', prob: calc.ah.pHomeMinus05, mkt: 'ah_home_minus05', backVal: backAHHome, setBack: setBackAHHome, layVal: layAHHome, setLay: setLayAHHome, myOddsVal: myOddsAHHome, setMyOdds: setMyOddsAHHome, color: 'var(--accent2)', borderColor: 'var(--accent)' },
                { label: 'AH Away -0.5', sublabel: 'Hosť musí vyhrať', prob: calc.ah.pAwayMinus05, mkt: 'ah_away_minus05', backVal: backAHAway, setBack: setBackAHAway, layVal: layAHAway, setLay: setLayAHAway, myOddsVal: myOddsAHAway, setMyOdds: setMyOddsAHAway, color: 'var(--green)', borderColor: 'var(--green)' },
              ].map(({ label, sublabel, prob, mkt, backVal, setBack, layVal, setLay, myOddsVal, setMyOdds, color, borderColor }) => {
                const fer = fairOdds(prob)
                const mid = midPrice(pf(backVal) || null, pf(layVal) || null)
                const myO = pf(myOddsVal)
                const actualOdds = myO > 1 ? myO : mid
                const usingMyOdds = myO > 1
                const comm = calc.comm || 0.05
                const st = calc.st || 10
                const evMinVal = calc.evMinVal || 0.12
                const oLow = calc.oLow || 1.4
                const oHigh = calc.oHigh || 3.5
                const evB = actualOdds ? calcBackEV(prob, actualOdds, comm) : null
                const evL = actualOdds ? calcLayEV(prob, actualOdds, comm) : null
                const evPassB = evFilter(evB, evMinVal)
                const evPassL = evFilter(evL, evMinVal)
                const oddsPass = actualOdds ? oddsBandFilter(actualOdds, oLow, oHigh) : false
                const edge = actualOdds && fer ? (actualOdds / fer - 1) * 100 : null
                return (
                  <div key={mkt} className="market-col" style={{ borderTop: `3px solid ${borderColor}` }}>
                    <div className="market-title" style={{ color }}>{label}</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 8 }}>{sublabel}</div>
                    {fer && (
                      <div style={{ marginBottom: 10 }}>
                        <div className="label">FER kurz</div>
                        <div className="fer-num" style={{ color }}>
                          {fmt3(fer)} <span style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 400 }}>({fmtPct(prob * 100)})</span>
                        </div>
                      </div>
                    )}
                    <div style={{ marginBottom: 8, padding: '6px 10px', background: 'var(--bg3)', borderRadius: 6, fontSize: 11, color: 'var(--text3)', lineHeight: 1.8 }}>
                      <div>P(Home win): <b style={{ color: 'var(--text2)' }}>{fmtPct(calc.ah.pHomeWin * 100)}</b></div>
                      <div>P(Draw): <b style={{ color: 'var(--text2)' }}>{fmtPct(calc.ah.pDraw * 100)}</b></div>
                      <div>P(Away win): <b style={{ color: 'var(--text2)' }}>{fmtPct(calc.ah.pAwayWin * 100)}</b></div>
                    </div>
                    <div style={{ marginTop: 10, marginBottom: 8 }}>
                      <div className="label">Best Back</div>
                      <input className="inp inp-sm" placeholder="1.85" value={backVal} onChange={e => setBack(e.target.value)} />
                    </div>
                    <div style={{ marginBottom: 8 }}>
                      <div className="label">Best Lay</div>
                      <input className="inp inp-sm" placeholder="1.88" value={layVal} onChange={e => setLay(e.target.value)} />
                    </div>
                    <div style={{ marginBottom: 8 }}>
                      <div className="label">Môj kurz <span style={{ color: 'var(--accent2)' }}>(opt — ak líši od mid)</span></div>
                      <input className="inp inp-sm" placeholder="napr. 2.08" value={myOddsVal} onChange={e => setMyOdds(e.target.value)} />
                    </div>
                    {actualOdds ? <>
                      <div className="mid-row">
                        <span style={{ color: 'var(--text3)' }}>{usingMyOdds ? 'Kurz:' : 'Mid:'}</span>
                        <span className="mid-val">{fmt3(actualOdds)}</span>
                        {edge != null && <span className={edge > 0 ? 'pos' : 'neg'} style={{ marginLeft: 'auto', fontSize: 11 }}>Edge {fmtSignPct(edge)}</span>}
                      </div>
                      <div>
                        <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 2 }}>▲ Back EV {usingMyOdds && <span style={{ color: 'var(--accent2)' }}>(@{fmt3(actualOdds)})</span>}</div>
                        <div className={`ev-big ${evB > 0 ? 'pos' : 'neg'}`}>
                          {fmtSignPct(evB * 100)}<span className="ev-eur">{fmtSign(evB * st)}€</span>
                        </div>
                      </div>
                      <div style={{ marginTop: 6 }}>
                        <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 2 }}>▼ Lay EV {usingMyOdds && <span style={{ color: 'var(--accent2)' }}>(@{fmt3(actualOdds)})</span>}</div>
                        <div className={`ev-big ${evL > 0 ? 'pos' : 'neg'}`}>
                          {fmtSignPct(evL * 100)}<span className="ev-eur">{fmtSign(evL * st)}€</span>
                        </div>
                        <div className="liability-note">Liability: {fmt2(layLiability(actualOdds, st))}€</div>
                      </div>
                      <div style={{ marginTop: 8, fontSize: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <div style={{ color: oddsPass ? 'var(--green)' : 'var(--red)' }}>
                          {oddsPass ? '✓' : '✗'} Kurz {fmt3(actualOdds)} {oddsPass ? `v pásme (${oLow}–${oHigh})` : `mimo pásma`}
                        </div>
                        <div style={{ color: evPassB ? 'var(--green)' : 'var(--text3)' }}>
                          {evPassB ? '✓' : '✗'} Back EV {evPassB ? 'spĺňa' : 'nespĺňa'} min {fmtPct(evMinVal * 100)}
                        </div>
                        {oddsPass && (evPassB || evPassL) && (
                          <div style={{ marginTop: 4, color: 'var(--green)', fontWeight: 700 }}>
                            ✅ BET SIGNAL: {evPassB ? 'BACK ' : ''}{evPassL ? 'LAY' : ''}
                          </div>
                        )}
                      </div>
                      <div className="save-btns">
                        <button className="btn-save-back" onClick={() => handleSave(mkt, 'back')} disabled={saving}>
                          {savedKey === mkt + '-back' ? '✓' : '+ Back'}
                        </button>
                        <button className="btn-save-lay" onClick={() => handleSave(mkt, 'lay')} disabled={saving}>
                          {savedKey === mkt + '-lay' ? '✓' : '+ Lay'}
                        </button>
                      </div>
                      <div style={{ fontSize: 9, color: 'var(--text3)', textAlign: 'center', marginTop: 4 }}>kom {(comm * 100).toFixed(0)}%</div>
                    </> : <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8 }}>Zadaj Back kurz pre výpočet EV</div>}
                  </div>
                )
              })}
            </div>

            {/* Lambda info + shrink info */}
            {calc && <div className="lambda-row">
              <span>λ Home: <b>{fmt2(calc.lH)}</b></span>
              <span>λ Away: <b>{fmt2(calc.lA)}</b></span>
              <span>λ Suma: <b>{fmt2(calc.lH + calc.lA)}</b></span>
              <span style={{ color: 'var(--accent2)' }}>
                {calc.modelType === 'full' ? `xG+GF/GA (α=${calc.alpha})` :
                 calc.modelType === 'xga' ? 'xG+xGA' :
                 calc.modelType === 'goals' ? `xG+GF/GA (α=${calc.alpha})` : 'xG only'}
              </span>
              <span style={{ color: 'var(--text3)' }}>ρ={fmt2(calc.rho)}</span>
              <span style={{ color: 'var(--yellow)' }}>k={fmt2(calc.calibK)}</span>
              {calc.xgScaler != null && calc.xgScaler !== 1 && (
                <span style={{ color: 'var(--yellow)' }}>sc={fmt2(calc.xgScaler)}</span>
              )}
              {calc.shrinkInfo && (
                <span style={{ color: 'var(--green)' }}>
                  + shrink {calc.shrinkInfo.source === 'api' ? '📡' : '✍'} ({calc.shrinkInfo.rawTotal} → {calc.shrinkInfo.shrunkTotal})
                </span>
              )}
              {calc.formInfo && (
                <span style={{ color: 'var(--accent2)' }}>
                  + forma {'L' + calc.formInfo.window} (w={fmt2(calc.formInfo.weight)}) {calc.formInfo.lHbefore}→{calc.formInfo.lHafter} / {calc.formInfo.lAbefore}→{calc.formInfo.lAafter}
                </span>
              )}
              {(calc.marketCalibUsed?.over || calc.marketCalibUsed?.under) && (
                <span style={{ color: 'var(--yellow)' }}>+ mkt blend (w={fmt2(calc.marketCalibUsed.w)})</span>
              )}
            </div>}

            {/* Shrink detail */}
            {calc?.shrinkInfo && (
              <div className="shrink-info">
                <b>Shrinkage:</b> λ_raw = {calc.shrinkInfo.lHraw} + {calc.shrinkInfo.lAraw} = {calc.shrinkInfo.rawTotal} →
                shrunk na {calc.shrinkInfo.shrunkTotal} (liga avg: {calc.shrinkInfo.leagueAvgH} + {calc.shrinkInfo.leagueAvgA}) ·
                ratio {calc.shrinkInfo.ratio} · zdroj: {calc.shrinkInfo.source === 'api' ? '📡 FootyStats API' : '✍ manuálne'}
              </div>
            )}

            {/* Calibration detail */}
            {calc && (calc.calibK !== 1 || calc.marketCalibUsed?.over || calc.marketCalibUsed?.under) && (
              <div className="calib-info">
                <b>Kalibrácia:</b>
                {` Kalibrácia (k=${fmt2(calc.calibK)}) aplikovaná`}
                {calc.marketCalibUsed?.over && ` · Over market blend (w=${fmt2(calc.marketCalibUsed.w)})`}
                {calc.marketCalibUsed?.under && ` · Under market blend (w=${fmt2(calc.marketCalibUsed.w)})`}
              </div>
            )}

          </div>
        )}

        {tab === 'history' && (
          <div>
            {loading && <div className="loading">Načítavam...</div>}
            {!loading && bets.length === 0 && <div className="empty">Žiadne bety.<br />Vypočítaj a ulož prvý bet.</div>}
            {bets.map(b => (
              <div key={b.id} className="bet-row">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => setExpandedId(expandedId === b.id ? null : b.id)}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                      {b.result == null && <span className="badge badge-pending">PENDING</span>}
                      {b.result === 1 && <span className="badge badge-won">WON</span>}
                      {b.result === 0 && <span className="badge badge-lost">LOST</span>}
                      <span className={`badge ${b.bet_type === 'lay' ? 'badge-lay' : 'badge-back'}`}>{b.bet_type === 'lay' ? '▼ LAY' : '▲ BACK'}</span>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>{MARKET[b.market]}</span>
                      {b.match_name && <span style={{ fontSize: 11, color: 'var(--text3)' }}>{b.match_name}</span>}
                      <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text3)' }}>{expandedId === b.id ? '▲' : '▼'}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: 'var(--text3)' }}>
                      <span>P: <b style={{ color: 'var(--text2)' }}>{fmtPct(b.sel_prob * 100)}</b></span>
                      <span>FER: <b style={{ color: 'var(--accent2)' }}>{fmt3(b.fer_odds)}</b></span>
                      {b.odds_open && <span>Kurz: <b style={{ color: 'var(--text2)' }}>{fmt3(b.odds_open)}</b></span>}
                      <span>Stake: <b style={{ color: 'var(--text2)' }}>{b.stake}€</b></span>
                      {b.ev_pct != null && <span>EV: <b className={b.ev_pct > 0 ? 'pos' : 'neg'}>{fmtSignPct(b.ev_pct)}</b></span>}
                      {b.clv != null && <span>CLV: <b className={b.clv > 0 ? 'pos' : 'neg'}>{fmtSignPct(b.clv)}</b></span>}
                      {b.pnl != null && <span>PnL: <b className={b.pnl > 0 ? 'pos' : 'neg'}>{fmtSign(b.pnl)}€</b></span>}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>
                      {new Date(b.created_at).toLocaleDateString('sk')} {new Date(b.created_at).toLocaleTimeString('sk', { hour: '2-digit', minute: '2-digit' })}
                      {b.match_time && (
                        <span style={{ marginLeft: 8, color: 'var(--yellow)' }}>
                          ⏰ Výkop: {new Date(b.match_time).toLocaleDateString('sk')} {new Date(b.match_time).toLocaleTimeString('sk', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {b.result == null && (
                      <button className="btn-ghost" onClick={() => {
                        if (settlingId === b.id) { setSettlingId(null) }
                        else { setSettlingId(b.id); setSettleMode(b.odds_close ? 'result' : 'clv'); setSettleClose(''); setSettleResult('') }
                      }}>
                        {b.odds_close ? 'Result' : 'CLV / Result'}
                      </button>
                    )}
                    <button className="btn-danger" onClick={() => handleDelete(b.id)}>✕</button>
                  </div>
                </div>

                {expandedId === b.id && (
                  <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--bg3)', borderRadius: 6, fontSize: 11 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px', color: 'var(--text3)' }}>
                      {b.lambda_h && <span>λ Home: <b style={{ color: 'var(--text2)' }}>{fmt2(b.lambda_h)}</b></span>}
                      {b.lambda_a && <span>λ Away: <b style={{ color: 'var(--text2)' }}>{fmt2(b.lambda_a)}</b></span>}
                      {b.lambda_h && b.lambda_a && <span>λ Suma: <b style={{ color: 'var(--text2)' }}>{fmt2(b.lambda_h + b.lambda_a)}</b></span>}
                      {b.p_over && <span>P(Over): <b style={{ color: 'var(--text2)' }}>{fmtPct(b.p_over * 100)}</b></span>}
                      {b.p_under && <span>P(Under): <b style={{ color: 'var(--text2)' }}>{fmtPct(b.p_under * 100)}</b></span>}
                      <span>FER: <b style={{ color: 'var(--accent2)' }}>{fmt3(b.fer_odds)}</b></span>
                      <span>Môj kurz: <b style={{ color: 'var(--text2)' }}>{fmt3(b.odds_open)}</b></span>
                      {b.odds_close && <span>Closing: <b style={{ color: 'var(--text2)' }}>{fmt3(b.odds_close)}</b></span>}
                      {b.commission && <span>Komisia: <b style={{ color: 'var(--text2)' }}>{b.commission}%</b></span>}
                      {b.ev_pct != null && <span>EV: <b className={b.ev_pct > 0 ? 'pos' : 'neg'}>{fmtSignPct(b.ev_pct)}</b></span>}
                      {b.clv != null && <span>CLV: <b className={b.clv > 0 ? 'pos' : 'neg'}>{fmtSignPct(b.clv)}</b></span>}
                      {b.brier != null && <span>Brier: <b style={{ color: 'var(--text2)' }}>{fmt2(b.brier)}</b></span>}
                      {b.log_loss != null && <span>Log loss: <b style={{ color: 'var(--text2)' }}>{fmt2(b.log_loss)}</b></span>}
                    </div>
                  </div>
                )}

                {settlingId === b.id && settleMode === 'clv' && (
                  <div className="clv-box">
                    <div style={{ fontSize: 11, color: 'var(--accent2)', marginBottom: 8 }}>📌 Closing kurz (5 min pred zápasom)</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input className="inp" placeholder="napr. 1.82" value={settleClose} onChange={e => setSettleClose(e.target.value)} style={{ flex: 1 }} />
                      <button className="btn btn-primary" style={{ width: 'auto', padding: '10px 16px' }} onClick={() => handleSaveCLV(b.id)}>Uložiť CLV</button>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <button style={{ background: 'none', border: 'none', color: 'var(--text3)', fontSize: 11, cursor: 'pointer', padding: 0 }} onClick={() => setSettleMode('result')}>
                        Preskočiť → zadať len výsledok
                      </button>
                    </div>
                  </div>
                )}

                {settlingId === b.id && settleMode === 'result' && (
                  <div className="settle-box">
                    <div style={{ fontSize: 11, color: 'var(--yellow)', marginBottom: 8 }}>🏁 Výsledok zápasu</div>
                    {b.clv != null && <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>CLV: <b className={b.clv > 0 ? 'pos' : 'neg'}>{fmtSignPct(b.clv)}</b></div>}
                    <select className="inp" value={settleResult} onChange={e => setSettleResult(e.target.value)} style={{ marginBottom: 8 }}>
                      <option value="">— vyber výsledok —</option>
                      <option value="1">{b.bet_type === 'lay' ? '✅ Lay Won (event NOT happened)' : '✅ Back Won'}</option>
                      <option value="0">{b.bet_type === 'lay' ? '❌ Lay Lost (event happened)' : '❌ Back Lost'}</option>
                    </select>
                    <button className="btn btn-primary" style={{ padding: '10px' }} onClick={() => handleSettle(b.id)}>Potvrdiť výsledok</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === 'stats' && (
          <>
          <div style={{ padding: '8px 16px 0' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600, letterSpacing: 1 }}>MARKET:</span>
              {[['ou', 'O/U 2.5'], ['ah', 'AH ±0.5']].map(([id, lbl]) => (
                <button key={id} onClick={() => setStatsMarket(id)} style={{
                  fontSize: 11, padding: '3px 10px', borderRadius: 6, border: '1px solid',
                  borderColor: statsMarket === id ? 'var(--green)' : 'var(--border)',
                  background: statsMarket === id ? 'var(--green)' : 'transparent',
                  color: statsMarket === id ? '#fff' : 'var(--text3)',
                  cursor: 'pointer', fontWeight: statsMarket === id ? 700 : 400
                }}>{lbl}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600, letterSpacing: 1 }}>MODEL VERZIA:</span>
              {[['all', 'Všetky'], ['v1', 'V1 (starý P^k)'], ['v2', 'V2 (nová kalib)']].map(([id, lbl]) => (
                <button key={id} onClick={() => setModelVersion(id)} style={{
                  fontSize: 11, padding: '3px 10px', borderRadius: 6, border: '1px solid',
                  borderColor: modelVersion === id ? 'var(--accent)' : 'var(--border)',
                  background: modelVersion === id ? 'var(--accent)' : 'transparent',
                  color: modelVersion === id ? '#fff' : 'var(--text3)',
                  cursor: 'pointer', fontWeight: modelVersion === id ? 700 : 400
                }}>{lbl}</button>
              ))}
              {modelVersion !== 'all' && (
                <span style={{ fontSize: 11, color: 'var(--text3)' }}>
                  {settled.length} betov
                </span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {settled.length === 0 ? <div className="empty">Žiadne uzavreté bety.<br />Settle aspoň jeden bet.</div> : (<>

              {/* ── FINANCE ── */}
              <div>
                <div className="section-title">💰 Finance</div>
                <div className="grid3">
                  {[
                    { l: 'Total Bets', v: settled.length },
                    { l: 'PnL (€)', v: fmtSign(totalPnL) + '€', cls: totalPnL >= 0 ? 'pos' : 'neg' },
                    { l: 'ROI', v: fmtSignPct(roi), cls: roi >= 0 ? 'pos' : 'neg' },
                    { l: 'Total Stake', v: totalStake + '€' },
                    { l: 'Max Drawdown', v: fmt2(maxDD) + '€', cls: 'neg' },
                    { l: 'Výhry / Prehry', v: `${wins} / ${settled.length - wins}` },
                  ].map(({ l, v, cls }) => (
                    <div key={l} className="card" style={{ padding: 14 }}>
                      <div className="label">{l}</div>
                      <div className={`stat-val ${cls || ''}`}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── EDGE ── */}
              <div>
                <div className="section-title">📈 Edge</div>
                <div className="grid3">
                  {[
                    { l: 'Avg CLV%', v: fmtSignPct(avgCLV), cls: avgCLV > 0 ? 'pos' : 'neg', hint: '> 0 = porážaš trh' },
                    { l: 'Positive CLV', v: fmtPct(posCLV), cls: posCLV > 50 ? 'pos' : 'neg', hint: '> 50% = dobré' },
                    { l: 'Avg EV%', v: fmtSignPct(avgEV), cls: avgEV > 0 ? 'pos' : 'neg', hint: 'pred výsledkom' },
                    { l: 'Hit Rate', v: fmtPct(hitRate * 100), hint: 'skutočná %' },
                    { l: 'Avg Prob', v: fmtPct(avgProb * 100), hint: 'model predpovedal' },
                    { l: 'Kalibrácia', v: calib != null ? fmtSign(calib) + 'pp' : '—', cls: calib != null && Math.abs(calib) < 5 ? 'pos' : 'neu', hint: 'blízko 0 = presný' },
                  ].map(({ l, v, cls, hint }) => (
                    <div key={l} className="card" style={{ padding: 14 }}>
                      <div className="label">{l}</div>
                      <div className={`stat-val ${cls || ''}`}>{v}</div>
                      <div className="hint">{hint}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── EV PÁSMA ── */}
              <div>
                <div className="section-title">🎯 EV pásma — kde ti to reálne vychádza</div>
                <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 10 }}>
                  Rozdelenie betov podľa EV pri uložení. Ukazuje kde má model reálny edge vs šum.
                </div>
                {(() => {
                  const bands = [
                    { label: '0–5%', min: 0, max: 5 },
                    { label: '5–10%', min: 5, max: 10 },
                    { label: '10–15%', min: 10, max: 15 },
                    { label: '15%+', min: 15, max: Infinity },
                  ]
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {/* Header */}
                      <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 1fr 1fr 1fr 1fr', gap: 8, fontSize: 9, color: 'var(--text3)', letterSpacing: '0.1em', textTransform: 'uppercase', padding: '0 14px' }}>
                        <span>EV pásmo</span><span>Bety</span><span>Hit Rate</span><span>Avg CLV</span><span>ROI</span><span>PnL</span>
                      </div>
                      {bands.map(band => {
                        const bb = settled.filter(b => b.ev_pct != null && b.ev_pct >= band.min && b.ev_pct < band.max)
                        if (bb.length === 0) return (
                          <div key={band.label} className="card" style={{ padding: '10px 14px', display: 'grid', gridTemplateColumns: '80px 1fr 1fr 1fr 1fr 1fr', gap: 8, alignItems: 'center', opacity: 0.4 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)' }}>{band.label}</span>
                            <span style={{ fontSize: 11, color: 'var(--text3)' }}>0 betov</span>
                            <span>—</span><span>—</span><span>—</span><span>—</span>
                          </div>
                        )
                        const bWins = bb.filter(b => b.result === 1).length
                        const bHR = bWins / bb.length * 100
                        const bPnL = bb.reduce((s, b) => s + (b.pnl || 0), 0)
                        const bStake = bb.reduce((s, b) => s + b.stake, 0)
                        const bROI = bStake > 0 ? bPnL / bStake * 100 : null
                        const bCLV = bb.filter(b => b.clv != null)
                        const bAvgCLV = bCLV.length > 0 ? bCLV.reduce((s, b) => s + b.clv, 0) / bCLV.length : null
                        const isGood = bROI > 0
                        return (
                          <div key={band.label} className="card" style={{ padding: '10px 14px', display: 'grid', gridTemplateColumns: '80px 1fr 1fr 1fr 1fr 1fr', gap: 8, alignItems: 'center', borderLeft: `3px solid ${isGood ? 'var(--green)' : 'var(--red)'}` }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent2)' }}>{band.label}</span>
                            <span style={{ fontSize: 12 }}>{bb.length}</span>
                            <span style={{ fontSize: 12, color: bHR > 50 ? 'var(--green)' : 'var(--text2)' }}>{fmtPct(bHR)}</span>
                            <span style={{ fontSize: 12, color: bAvgCLV > 0 ? 'var(--green)' : 'var(--red)' }}>{bAvgCLV != null ? fmtSignPct(bAvgCLV) : '—'}</span>
                            <span style={{ fontSize: 12, fontWeight: 700, color: bROI > 0 ? 'var(--green)' : 'var(--red)' }}>{bROI != null ? fmtSignPct(bROI) : '—'}</span>
                            <span style={{ fontSize: 12, color: bPnL >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmtSign(bPnL)}€</span>
                          </div>
                        )
                      })}
                      <div style={{ fontSize: 10, color: 'var(--text3)', padding: '4px 14px' }}>
                        💡 Pásma s pozitívnym ROI = tam má tvoj model reálny edge. Zvýš EV filter na minimálne toto pásmo.
                      </div>
                    </div>
                  )
                })()}
              </div>

              {/* ── OVER vs UNDER BREAKDOWN ── */}
              <div>
                <div className="section-title">⚖️ Over 2.5 vs Under 2.5</div>
                {(() => {
                  const mkts = ['over2.5', 'under2.5']
                  return (
                    <div className="grid2">
                      {mkts.map(mkt => {
                        const mb = settled.filter(b => b.market === mkt)
                        if (mb.length === 0) return <div key={mkt} className="card" style={{ padding: 14, opacity: 0.4 }}><div className="label">{mkt === 'over2.5' ? 'Over 2.5' : 'Under 2.5'}</div><div style={{ color: 'var(--text3)', fontSize: 12 }}>Žiadne bety</div></div>
                        const mWins = mb.filter(b => b.result === 1).length
                        const mHR = mWins / mb.length * 100
                        const mPnL = mb.reduce((s, b) => s + (b.pnl || 0), 0)
                        const mStake = mb.reduce((s, b) => s + b.stake, 0)
                        const mROI = mStake > 0 ? mPnL / mStake * 100 : null
                        const mCLV = mb.filter(b => b.clv != null)
                        const mAvgCLV = mCLV.length > 0 ? mCLV.reduce((s, b) => s + b.clv, 0) / mCLV.length : null
                        const mAvgProb = mb.reduce((s, b) => s + b.sel_prob, 0) / mb.length
                        const mCalib = (mHR / 100 - mAvgProb) * 100
                        const isOver = mkt === 'over2.5'
                        return (
                          <div key={mkt} className="card" style={{ padding: 14, borderTop: `3px solid ${isOver ? 'var(--accent)' : 'var(--green)'}` }}>
                            <div className="label" style={{ color: isOver ? 'var(--accent2)' : 'var(--green)', marginBottom: 10 }}>
                              {isOver ? '▲ Over 2.5' : '▼ Under 2.5'}
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: 'var(--text3)' }}>Bety</span>
                                <b>{mb.length}</b>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: 'var(--text3)' }}>Hit Rate</span>
                                <b style={{ color: mHR > 50 ? 'var(--green)' : 'var(--text2)' }}>{fmtPct(mHR)}</b>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: 'var(--text3)' }}>Avg Prob</span>
                                <b>{fmtPct(mAvgProb * 100)}</b>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: 'var(--text3)' }}>Kalibrácia</span>
                                <b style={{ color: Math.abs(mCalib) < 5 ? 'var(--green)' : 'var(--red)' }}>{fmtSign(mCalib)}pp</b>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: 'var(--text3)' }}>Avg CLV</span>
                                <b style={{ color: mAvgCLV > 0 ? 'var(--green)' : 'var(--red)' }}>{mAvgCLV != null ? fmtSignPct(mAvgCLV) : '—'}</b>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 5, marginTop: 2 }}>
                                <span style={{ color: 'var(--text3)' }}>ROI</span>
                                <b style={{ color: mROI > 0 ? 'var(--green)' : 'var(--red)', fontSize: 14 }}>{mROI != null ? fmtSignPct(mROI) : '—'}</b>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: 'var(--text3)' }}>PnL</span>
                                <b style={{ color: mPnL >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmtSign(mPnL)}€</b>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
              </div>

              {/* ── ODDS BUCKET ANALYSIS ── */}
              <div>
                <div className="section-title">📐 Odds bucket analýza</div>
                <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 10 }}>
                  Výkonnosť podľa výšky kurzu. Ukazuje kde model reálne nájde edge.
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr 1fr 1fr 1fr', gap: 8, fontSize: 9, color: 'var(--text3)', letterSpacing: '0.1em', textTransform: 'uppercase', padding: '0 14px' }}>
                    <span>Kurz</span><span>Bety</span><span>Avg CLV</span><span>Pos CLV</span><span>Avg EV</span><span>ROI</span>
                  </div>
                  {oddsBucketStats.map(b => (
                    <div key={b.label} className="card" style={{
                      padding: '10px 14px',
                      display: 'grid',
                      gridTemplateColumns: '90px 1fr 1fr 1fr 1fr 1fr',
                      gap: 8,
                      alignItems: 'center',
                      opacity: b.count === 0 ? 0.4 : 1,
                      borderLeft: b.count > 0 ? `3px solid ${b.roi > 0 ? 'var(--green)' : 'var(--red)'}` : '3px solid var(--border)',
                    }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent2)' }}>{b.label}</span>
                      <span style={{ fontSize: 12, color: 'var(--text2)' }}>{b.count === 0 ? '—' : b.count}</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: b.avgCLV == null ? 'var(--text3)' : b.avgCLV > 0 ? 'var(--green)' : 'var(--red)' }}>
                        {b.avgCLV == null ? '—' : fmtSignPct(b.avgCLV)}
                      </span>
                      <span style={{ fontSize: 12, color: b.posCLV == null ? 'var(--text3)' : b.posCLV >= 50 ? 'var(--green)' : 'var(--red)' }}>
                        {b.posCLV == null ? '—' : fmtPct(b.posCLV)}
                      </span>
                      <span style={{ fontSize: 12, color: b.avgEV == null ? 'var(--text3)' : b.avgEV > 0 ? 'var(--green)' : 'var(--red)' }}>
                        {b.avgEV == null ? '—' : fmtSignPct(b.avgEV)}
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: b.roi == null ? 'var(--text3)' : b.roi > 0 ? 'var(--green)' : 'var(--red)' }}>
                        {b.roi == null ? '—' : fmtSignPct(b.roi)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── CLV ANALÝZA ── */}
              {clvBets.length > 0 && (
                <div>
                  <div className="section-title">📊 CLV analýza — trh vs model</div>
                  <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 10 }}>
                    CLV = closing line value. Pozitívne = bol si pred trhom. Záporné = trh vedel viac ako ty.
                  </div>
                  <div className="grid3">
                    {(() => {
                      const posC = clvBets.filter(b => b.clv > 0)
                      const negC = clvBets.filter(b => b.clv <= 0)
                      const posWR = posC.length > 0 ? posC.filter(b => b.result === 1).length / posC.length * 100 : null
                      const negWR = negC.length > 0 ? negC.filter(b => b.result === 1).length / negC.length * 100 : null
                      const posPnL = posC.reduce((s, b) => s + (b.pnl || 0), 0)
                      const negPnL = negC.reduce((s, b) => s + (b.pnl || 0), 0)
                      return [
                        { l: '✅ Pos CLV bety', v: posC.length, hint: `Win rate: ${posWR != null ? fmtPct(posWR) : '—'} · PnL: ${fmtSign(posPnL)}€` },
                        { l: '❌ Neg CLV bety', v: negC.length, hint: `Win rate: ${negWR != null ? fmtPct(negWR) : '—'} · PnL: ${fmtSign(negPnL)}€` },
                        { l: 'Avg CLV (všetky)', v: fmtSignPct(avgCLV), cls: avgCLV > 0 ? 'pos' : 'neg', hint: 'cieľ: > +1%' },
                      ].map(({ l, v, cls, hint }) => (
                        <div key={l} className="card" style={{ padding: 14 }}>
                          <div className="label">{l}</div>
                          <div className={`stat-val ${cls || ''}`}>{v}</div>
                          <div className="hint">{hint}</div>
                        </div>
                      ))
                    })()}
                  </div>
                  {/* CLV distribution bar */}
                  <div className="card" style={{ marginTop: 10, padding: 14 }}>
                    <div className="label" style={{ marginBottom: 10 }}>CLV distribúcia</div>
                    <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 48 }}>
                      {(() => {
                        const sorted = [...clvBets].sort((a, b) => a.clv - b.clv)
                        const mn = Math.min(...sorted.map(b => b.clv))
                        const mx = Math.max(...sorted.map(b => b.clv))
                        const range = Math.max(0.01, mx - mn)
                        return sorted.map((b, i) => (
                          <div key={i} title={`${b.match_name || ''} CLV: ${fmtSignPct(b.clv)}`}
                            style={{ flex: 1, minWidth: 4, borderRadius: '2px 2px 0 0', background: b.clv > 0 ? 'var(--green)' : 'var(--red)', opacity: 0.85, height: Math.max(4, ((b.clv - mn) / range) * 44) + 'px' }} />
                        ))
                      })()}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>
                      <span>najhorší CLV</span><span>najlepší CLV</span>
                    </div>
                  </div>
                </div>
              )}

              {/* ── CLV BREAKDOWN ── */}
              {clvBets.length >= 5 && (
                <div className="card" style={{ padding: 16 }}>
                  <div className="section-title" style={{ marginBottom: 12 }}>📊 CLV analýza</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

                    {/* CLV podľa času */}
                    {clvByTime.length > 0 && (
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8, fontWeight: 600, letterSpacing: 1 }}>CLV PODĽA ČASU BETU</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px 8px', fontSize: 12 }}>
                          <span style={{ color: 'var(--text3)', fontSize: 10 }}>Hodiny do KO</span>
                          <span style={{ color: 'var(--text3)', fontSize: 10 }}>Bety</span>
                          <span style={{ color: 'var(--text3)', fontSize: 10 }}>Avg CLV</span>
                          {clvByTime.map(r => (<>
                            <span key={r.label+'l'} style={{ color: 'var(--text2)' }}>{r.label}</span>
                            <span key={r.label+'c'} style={{ color: 'var(--text3)' }}>{r.count}</span>
                            <span key={r.label+'v'} style={{ color: r.avg > 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{fmtSignPct(r.avg)}</span>
                          </>))}
                        </div>
                      </div>
                    )}

                    {/* CLV podľa marketu */}
                    {clvByMarket.length > 0 && (
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8, fontWeight: 600, letterSpacing: 1 }}>CLV PODĽA MARKETU</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px 8px', fontSize: 12 }}>
                          <span style={{ color: 'var(--text3)', fontSize: 10 }}>Market</span>
                          <span style={{ color: 'var(--text3)', fontSize: 10 }}>Bety</span>
                          <span style={{ color: 'var(--text3)', fontSize: 10 }}>Avg CLV</span>
                          {clvByMarket.map(r => (<>
                            <span key={r.market+'l'} style={{ color: 'var(--text2)' }}>{r.market}</span>
                            <span key={r.market+'c'} style={{ color: 'var(--text3)' }}>{r.count}</span>
                            <span key={r.market+'v'} style={{ color: r.avg > 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{fmtSignPct(r.avg)}</span>
                          </>))}
                        </div>
                      </div>
                    )}

                    {/* CLV podľa ligy */}
                    {clvByLeague.length > 1 && (
                      <div style={{ gridColumn: '1 / -1' }}>
                        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8, fontWeight: 600, letterSpacing: 1 }}>CLV PODĽA LIGY</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '4px 8px', fontSize: 12 }}>
                          <span style={{ color: 'var(--text3)', fontSize: 10 }}>Liga</span>
                          <span style={{ color: 'var(--text3)', fontSize: 10 }}>Bety</span>
                          <span style={{ color: 'var(--text3)', fontSize: 10 }}>Avg CLV</span>
                          {clvByLeague.map(r => (<>
                            <span key={r.league+'l'} style={{ color: 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.league}</span>
                            <span key={r.league+'c'} style={{ color: 'var(--text3)' }}>{r.count}</span>
                            <span key={r.league+'v'} style={{ color: r.avg > 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{fmtSignPct(r.avg)}</span>
                          </>))}
                        </div>
                      </div>
                    )}

                    {/* Model vs Market prob */}
                    {avgModelProb != null && avgMarketProb != null && (
                      <div style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4 }}>
                        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8, fontWeight: 600, letterSpacing: 1 }}>MODEL vs MARKET PRAVDEPODOBNOSŤ</div>
                        <div style={{ display: 'flex', gap: 24, fontSize: 12 }}>
                          <div>
                            <span style={{ color: 'var(--text3)' }}>Avg model prob: </span>
                            <b style={{ color: 'var(--text2)' }}>{fmtPct(avgModelProb * 100)}</b>
                          </div>
                          <div>
                            <span style={{ color: 'var(--text3)' }}>Avg market prob: </span>
                            <b style={{ color: 'var(--text2)' }}>{fmtPct(avgMarketProb * 100)}</b>
                          </div>
                          <div>
                            <span style={{ color: 'var(--text3)' }}>Rozdiel: </span>
                            <b style={{ color: (avgModelProb - avgMarketProb) > 0 ? 'var(--green)' : 'var(--red)' }}>
                              {fmtSignPct((avgModelProb - avgMarketProb) * 100)}
                            </b>
                            <span style={{ color: 'var(--text3)', marginLeft: 6, fontSize: 11 }}>
                              {(avgModelProb - avgMarketProb) > 0.02 ? '↑ model preceňuje góly' : (avgModelProb - avgMarketProb) < -0.02 ? '↓ model podceňuje góly' : '≈ model a trh súhlasia'}
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── ODPORÚČANIA ── */}
              <div className="card" style={{ padding: 16, borderLeft: '3px solid var(--yellow)' }}>
                <div className="section-title" style={{ marginBottom: 10 }}>💡 Odporúčania na základe tvojich dát</div>
                {(() => {
                  const recs = []
                  if (calib != null && calib < -5) recs.push({ icon: '⚠️', text: `Model je preoptimistický o ${Math.abs(calib).toFixed(1)}pp — zníž k na 0.85 v pokročilých nastaveniach`, color: 'var(--red)' })
                  if (avgCLV != null && avgCLV < 0) recs.push({ icon: '📉', text: `Avg CLV je záporné (${fmtSignPct(avgCLV)}) — trh vie viac ako model. Zvýš EV filter.`, color: 'var(--red)' })
                  if (posCLV != null && posCLV < 50) recs.push({ icon: '🎯', text: `Len ${fmtPct(posCLV)} betov má pozitívne CLV — betuješ príliš veľa "šumu". Odporúčaný EV filter: 12–15%`, color: 'var(--yellow)' })
                  // Find best EV band
                  const bands2 = [{ label: '15%+', min: 15, max: Infinity }, { label: '10–15%', min: 10, max: 15 }, { label: '5–10%', min: 5, max: 10 }]
                  for (const band of bands2) {
                    const bb = settled.filter(b => b.ev_pct != null && b.ev_pct >= band.min && b.ev_pct < band.max)
                    if (bb.length >= 3) {
                      const bPnL = bb.reduce((s, b) => s + (b.pnl || 0), 0)
                      const bStake = bb.reduce((s, b) => s + b.stake, 0)
                      const bROI = bStake > 0 ? bPnL / bStake * 100 : null
                      if (bROI > 0) { recs.push({ icon: '✅', text: `EV pásmo ${band.label} má ROI ${fmtSignPct(bROI)} — toto je tvoj skutočný edge. Fokusuj sa na tieto bety.`, color: 'var(--green)' }); break }
                    }
                  }
                  // Over vs Under
                  const overB = settled.filter(b => b.market === 'over2.5')
                  const underB = settled.filter(b => b.market === 'under2.5')
                  if (overB.length > 3 && underB.length > 3) {
                    const overROI = overB.reduce((s, b) => s + b.stake, 0) > 0 ? overB.reduce((s, b) => s + (b.pnl || 0), 0) / overB.reduce((s, b) => s + b.stake, 0) * 100 : null
                    const underROI = underB.reduce((s, b) => s + b.stake, 0) > 0 ? underB.reduce((s, b) => s + (b.pnl || 0), 0) / underB.reduce((s, b) => s + b.stake, 0) * 100 : null
                    if (overROI != null && underROI != null && underROI > overROI + 5) recs.push({ icon: '⚽', text: `Under 2.5 ti vychádza lepšie (ROI ${fmtSignPct(underROI)}) ako Over (${fmtSignPct(overROI)}) — zvýš pozornosť na Under bety`, color: 'var(--green)' })
                    if (overROI != null && underROI != null && overROI > underROI + 5) recs.push({ icon: '⚽', text: `Over 2.5 ti vychádza lepšie (ROI ${fmtSignPct(overROI)}) ako Under (${fmtSignPct(underROI)})`, color: 'var(--green)' })
                  }
                  if (settled.length < 50) recs.push({ icon: '📊', text: `Vzorka ${settled.length} betov je malá — žiadne závery nie sú štatisticky spoľahlivé. Potrebuješ 100+ betov.`, color: 'var(--text3)' })
                  if (recs.length === 0) recs.push({ icon: '✅', text: 'Model vyzerá dobre kalibrovaný. Pokračuj zbierať dáta.', color: 'var(--green)' })
                  return recs.map((r, i) => (
                    <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8, fontSize: 12, color: r.color }}>
                      <span style={{ flexShrink: 0 }}>{r.icon}</span>
                      <span>{r.text}</span>
                    </div>
                  ))
                })()}
              </div>

              {/* ── MODEL ── */}
              <div>
                <div className="section-title">🧠 Model</div>
                <div className="grid3">
                  {[
                    { l: 'Brier Score', v: fmt2(avgBrier), hint: '< 0.25 = dobré' },
                    { l: 'Log Loss', v: fmt2(avgLL), hint: 'nižšie = lepšie' },
                    { l: 'Vzorka', v: settled.length, hint: settled.length < 100 ? '⚠ potrebuješ 100+' : '✓ ok' },
                  ].map(({ l, v, hint }) => (
                    <div key={l} className="card" style={{ padding: 14 }}>
                      <div className="label">{l}</div>
                      <div className="stat-val">{v}</div>
                      <div className="hint">{hint}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── PNL TIMELINE ── */}
              <div className="card">
                <div className="label" style={{ marginBottom: 12 }}>PnL timeline</div>
                <div className="pnl-bar-wrap">
                  {(() => {
                    let r = 0
                    const pts = [...settled].reverse().map(b => { r += b.pnl || 0; return r })
                    const min = Math.min(0, ...pts), max = Math.max(0.01, ...pts), range = max - min
                    return pts.map((p, i) => (
                      <div key={i} className="pnl-bar" title={fmtSign(p) + '€'} style={{ height: Math.max(3, ((p - min) / range) * 53) + 'px', background: p >= 0 ? 'var(--green)' : 'var(--red)', opacity: 0.8 }} />
                    ))
                  })()}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text3)', marginTop: 6 }}>
                  <span>prvý bet</span>
                  <span className={totalPnL >= 0 ? 'pos' : 'neg'}>{fmtSign(totalPnL)}€</span>
                  <span>posledný</span>
                </div>
              </div>

            </>)}
          </div>
          </>
        )}
      </div>
    </>
  )
}

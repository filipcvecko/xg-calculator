import { useState, useEffect } from 'react'
import { supabase } from './supabase'
import {
  calcOverUnder, blendLambda, fairOdds, calcCLV,
  brierScore, logLoss, calcMaxDrawdown,
  marketCalibration, calibrateProb, evFilter, oddsBandFilter,
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
    const avgHome = data.seasonAVG_home ?? null
    const avgAway = data.seasonAVG_away ?? null
    if (avgHome && avgAway) {
      return { avgHome, avgAway, source: 'api', leagueId }
    }
    return null
  } catch {
    return null
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
  .advanced-toggle { display: flex; align-items: center; justify-content: space-between; cursor: pointer; }
  .prob-compare { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-top: 10px; font-size: 11px; }
  .prob-box { background: var(--bg3); border-radius: 6px; padding: 8px 10px; }
  .prob-box-label { font-size: 9px; color: var(--text3); letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 3px; }
  .prob-box-val { font-weight: 700; font-size: 14px; }
  @media(max-width:520px){ .markets-grid{grid-template-columns:1fr;} .grid3{grid-template-columns:1fr 1fr;} .grid4{grid-template-columns:1fr 1fr;} .tab{padding:10px 8px;font-size:10px;} }
`

export default function App() {
  const [tab, setTab] = useState('calc')
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
  const [calc, setCalc] = useState(null)
  const [savedKey, setSavedKey] = useState(null)
  const [expandedId, setExpandedId] = useState(null)

  // Pokročilé nastavenia
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [rho, setRho] = useState('-0.10')
  const [marketOddsOver, setMarketOddsOver] = useState('')
  const [marketOddsUnder, setMarketOddsUnder] = useState('')
  const [marketWeight, setMarketWeight] = useState('0.60')
  const [calibK, setCalibK] = useState('0.95')
  const [evMin, setEvMin] = useState('4')
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

  // Settle
  const [settlingId, setSettlingId] = useState(null)
  const [settleMode, setSettleMode] = useState('clv')
  const [settleClose, setSettleClose] = useState('')
  const [settleResult, setSettleResult] = useState('')

  useEffect(() => {
    loadBets()
    setLeagueLoading(true)
    loadMyLeagues().then(leagues => {
      setAllLeagues(leagues)
      setLeagueLoading(false)
    })
  }, [])

  async function loadBets() {
    setLoading(true)
    const { data, error } = await supabase.from('bets').select('*').order('created_at', { ascending: false })
    if (!error) setBets(data || [])
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

  function handleCalc() {
    const h = pf(xgH), a = pf(xgA)
    if (!h || !a) return
    const ha = pf(xgaH), aa = pf(xgaA)
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

    // Probability calibration (P^k)
    const kVal = pf(calibK) || 0.95
    const pOverCalib = calibrateProb(pOverRaw, kVal)
    const pUnderCalib = calibrateProb(pUnderRaw, kVal)

    // Market calibration
    const mw = pf(marketWeight) || 0.60
    const moOver = pf(marketOddsOver)
    const moUnder = pf(marketOddsUnder)
    const pOverFinal = moOver > 1 ? marketCalibration(pOverCalib, moOver, mw) : pOverCalib
    const pUnderFinal = moUnder > 1 ? marketCalibration(pUnderCalib, moUnder, mw) : pUnderCalib

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
    const evMinVal = pf(evMin) / 100 || 0.04
    const oLow = pf(oddsLow) || 1.4
    const oHigh = pf(oddsHigh) || 3.5

    setSavedKey(null)
    setCalc({
      lH, lA,
      pOverRaw, pUnderRaw,
      pOverCalib, pUnderCalib,
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
    })
  }

  async function handleSave(market, betType) {
    if (!calc || saving) return
    setSaving(true)
    const isOver = market === 'over2.5'
    const selProb = isOver ? calc.pOver : calc.pUnder
    const ferO = isOver ? calc.ferOver : calc.ferUnder
    const midOdds = isOver ? calc.midO : calc.midU
    if (!midOdds) { setSaving(false); return }
    const myO = pf(isOver ? myOddsOver : myOddsUnder)
    const actualOdds = myO > 1 ? myO : midOdds
    const ev = betType === 'back'
      ? calcBackEV(selProb, actualOdds, calc.comm)
      : calcLayEV(selProb, actualOdds, calc.comm)

    const { error } = await supabase.from('bets').insert({
      match_name: calc.matchName, market, bet_type: betType,
      lambda_h: calc.lH, lambda_a: calc.lA,
      p_over: calc.pOver, p_under: calc.pUnder,
      sel_prob: selProb, fer_odds: ferO,
      odds_open: actualOdds, odds_close: null,
      stake: calc.st, commission: calc.comm * 100,
      ev, ev_pct: ev != null ? ev * 100 : null,
      clv: null, result: null, pnl: null, brier: null, log_loss: null,
    })
    if (!error) { await loadBets(); setSavedKey(market + '-' + betType) }
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

  const settled = bets.filter(b => b.result != null)
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
  const MARKET = { 'over2.5': 'Over 2.5', 'under2.5': 'Under 2.5' }

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

            {/* Zápas */}
            <div className="card">
              <div className="label">Zápas (voliteľné)</div>
              <input className="inp" placeholder="napr. Arsenal vs Chelsea" value={matchName} onChange={e => setMatchName(e.target.value)} />
            </div>

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
                      <div className="label">w — váha modelu <span style={{ color: 'var(--accent2)' }}>(0.60 = 60% model, 40% market)</span></div>
                      <input className="inp" placeholder="0.60" value={marketWeight} onChange={e => setMarketWeight(e.target.value)} />
                    </div>
                  </div>

                  {/* Probability calibration */}
                  <div>
                    <div className="section-title" style={{ marginBottom: 8 }}>🎯 Probability calibration</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 8 }}>
                      Power transform P^k. k &lt; 1 = zníž istotu, k = 1 = bez zmeny, k &gt; 1 = zvýš polarizáciu.
                    </div>
                    <div>
                      <div className="label">k — kalibračný exponent <span style={{ color: 'var(--accent2)' }}>(default 0.95)</span></div>
                      <input className="inp" placeholder="0.95" value={calibK} onChange={e => setCalibK(e.target.value)} />
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
                        <input className="inp" placeholder="4" value={evMin} onChange={e => setEvMin(e.target.value)} />
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

            {/* Markets */}
            <div className="markets-grid">
              {[true, false].map(isOver => {
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
                          <div className="prob-box-label">P^k calib</div>
                          <div className="prob-box-val" style={{ color: 'var(--yellow)' }}>{fmtPct(probCalib * 100)}</div>
                        </div>
                        <div className="prob-box">
                          <div className="prob-box-label">{marketCalibUsed ? 'Mkt blend' : 'Finálna'}</div>
                          <div className="prob-box-val" style={{ color: isOver ? 'var(--accent2)' : 'var(--green)' }}>{fmtPct(prob * 100)}</div>
                        </div>
                      </div>
                    )}

                    <div style={{ marginTop: 10, marginBottom: 8 }}>
                      <div className="label">Best Back</div>
                      <input className="inp inp-sm" placeholder="1.85"
                        value={isOver ? backOver : backUnder}
                        onChange={e => isOver ? setBackOver(e.target.value) : setBackUnder(e.target.value)} />
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
                        const evMinVal = calc?.evMinVal || 0.04
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
              {calc.shrinkInfo && (
                <span style={{ color: 'var(--green)' }}>
                  + shrink {calc.shrinkInfo.source === 'api' ? '📡' : '✍'} ({calc.shrinkInfo.rawTotal} → {calc.shrinkInfo.shrunkTotal})
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
                {` P^k (k=${fmt2(calc.calibK)}) aplikovaná`}
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {settled.length === 0 ? <div className="empty">Žiadne uzavreté bety.<br />Settle aspoň jeden bet.</div> : (<>
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
        )}
      </div>
    </>
  )
}

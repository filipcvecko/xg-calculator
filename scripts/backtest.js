#!/usr/bin/env node
// Usage: node --env-file=.env scripts/backtest.js

import { calcOverUnder, dynamicRho, getLeagueCoefs } from '../src/math.js'
import { readFileSync, writeFileSync } from 'fs'

const API_BASE = 'https://api.football-data-api.com'
const KEY = process.env.VITE_FOOTYSTATS_KEY
const RATE_MS = 500
const SHRINKAGE = 0.15
const MIN_MATCHES_PLAYED = 3       // skip teams with too few matches (noisy stats)
const EV_THRESHOLDS = [0, 0.02, 0.05, 0.08, 0.10, 0.12]

if (!KEY) {
  console.error('Missing VITE_FOOTYSTATS_KEY — run with: node --env-file=.env scripts/backtest.js')
  process.exit(1)
}

const coefData = JSON.parse(readFileSync('./league-coefficients.json', 'utf8'))

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function get(endpoint, params = {}) {
  const qs = new URLSearchParams({ key: KEY, ...params }).toString()
  const res = await fetch(`${API_BASE}/${endpoint}?${qs}`)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${endpoint}`)
  return res.json()
}

// Pick first non-zero positive value from stat object
function pick(stats, ...keys) {
  for (const k of keys) {
    const v = parseFloat(stats[k])
    if (!isNaN(v) && v > 0) return v
  }
  return null
}

function getAttack(stats, venue) {
  // prefer xG, fall back to goals; prefer venue-split, fall back to overall
  if (venue === 'home') {
    return pick(stats,
      'xg_for_avg_home', 'seasonScoredAVG_home',
      'xg_for_avg_overall', 'seasonScoredAVG_overall'
    )
  }
  return pick(stats,
    'xg_for_avg_away', 'seasonScoredAVG_away',
    'xg_for_avg_overall', 'seasonScoredAVG_overall'
  )
}

function getDefence(stats, venue) {
  if (venue === 'home') {
    return pick(stats,
      'xg_against_avg_home', 'seasonConcededAVG_home',
      'xg_against_avg_overall', 'seasonConcededAVG_overall'
    )
  }
  return pick(stats,
    'xg_against_avg_away', 'seasonConcededAVG_away',
    'xg_against_avg_overall', 'seasonConcededAVG_overall'
  )
}

function getMatchesPlayed(stats, venue) {
  const k = venue === 'home' ? 'seasonMatchesPlayed_home'
          : venue === 'away' ? 'seasonMatchesPlayed_away'
          : 'seasonMatchesPlayed_overall'
  return parseInt(stats[k]) || 0
}

function applyShrinkage(lH, lA, lgAvgH, lgAvgA) {
  const rawTotal = lH + lA
  const leagueTotal = lgAvgH + lgAvgA
  if (rawTotal <= 0 || leagueTotal <= 0) return { lH, lA }
  const shrunkTotal = (1 - SHRINKAGE) * rawTotal + SHRINKAGE * leagueTotal
  const ratio = shrunkTotal / rawTotal
  return { lH: lH * ratio, lA: lA * ratio }
}

async function fetchAllMatches(seasonId) {
  const matches = []
  let page = 1
  let maxPage = 1
  do {
    const json = await get('league-matches', {
      season_id: seasonId,
      max_per_page: 300,
      page,
    })
    const data = json?.data ?? []
    matches.push(...data)
    maxPage = json?.pager?.max_page ?? 1
    if (page < maxPage) await sleep(RATE_MS)
    page++
  } while (page <= maxPage)
  return matches
}

async function fetchTeamMap(seasonId) {
  const json = await get('league-teams', { season_id: seasonId, include: 'stats' })
  const teams = json?.data ?? []
  const map = {}
  for (const t of teams) {
    map[t.id] = t.stats || t
  }
  return map
}

// Brier score
function brier(preds) {
  if (!preds.length) return null
  return preds.reduce((s, { p, actual }) => s + Math.pow(p - actual, 2), 0) / preds.length
}

// Log loss
function logLoss(preds) {
  if (!preds.length) return null
  const eps = 1e-7
  return -preds.reduce((s, { p, actual }) => {
    const cp = Math.max(eps, Math.min(1 - eps, p))
    return s + (actual * Math.log(cp) + (1 - actual) * Math.log(1 - cp))
  }, 0) / preds.length
}

// Hit rate: round(p) matches actual
function hitRate(preds) {
  if (!preds.length) return null
  const hits = preds.filter(({ p, actual }) => Math.round(p) === actual).length
  return (hits / preds.length) * 100
}

// Calibration: 10 equal-width bins
function calibration(preds) {
  const bins = Array.from({ length: 10 }, (_, i) => ({
    bin: `${i * 10}-${(i + 1) * 10}%`,
    lo: i * 0.1, hi: (i + 1) * 0.1,
    pSum: 0, actualSum: 0, count: 0,
  }))
  for (const { p, actual } of preds) {
    const i = Math.min(9, Math.floor(p * 10))
    bins[i].pSum += p
    bins[i].actualSum += actual
    bins[i].count++
  }
  return bins.map(b => ({
    bin: b.bin,
    count: b.count,
    predicted_avg: b.count ? parseFloat((b.pSum / b.count).toFixed(4)) : null,
    actual_rate: b.count ? parseFloat((b.actualSum / b.count).toFixed(4)) : null,
  }))
}

// ROI simulation using real odds
function roiByThreshold(bets) {
  const result = {}
  for (const threshold of EV_THRESHOLDS) {
    const key = threshold.toFixed(2)
    let overBets = 0, underBets = 0, totalStake = 0, totalProfit = 0, wins = 0
    for (const { pOver, oddsOver, oddsUnder, actual } of bets) {
      const evOver  = oddsOver  > 1 ? pOver       * oddsOver  - 1 : -99
      const evUnder = oddsUnder > 1 ? (1 - pOver) * oddsUnder - 1 : -99
      if (evOver > threshold) {
        overBets++
        totalStake++
        totalProfit += actual === 1 ? oddsOver - 1 : -1
        if (actual === 1) wins++
      } else if (evUnder > threshold) {
        underBets++
        totalStake++
        totalProfit += actual === 0 ? oddsUnder - 1 : -1
        if (actual === 0) wins++
      }
    }
    const totalBets = overBets + underBets
    result[key] = {
      bets: totalBets,
      over_bets: overBets,
      under_bets: underBets,
      win_rate_pct: totalBets ? parseFloat(((wins / totalBets) * 100).toFixed(2)) : null,
      roi_pct: totalStake ? parseFloat(((totalProfit / totalStake) * 100).toFixed(2)) : null,
    }
  }
  return result
}

async function main() {
  console.log(`Backtesting ${coefData.leagues.length} leagues...`)
  const allPreds = []  // { p, actual } for over2.5
  const allBets  = []  // { pOver, oddsOver, oddsUnder, actual }
  const byLeague = []

  for (const league of coefData.leagues) {
    const season = league.seasons[0]  // most recent (sorted by id desc in fetch script)
    if (!season) { console.log(`  [${league.country}] ${league.league_name}: no season, skip`); continue }

    const seasonId = season.seasonId
    console.log(`\n[${league.country}] ${league.league_name} (season ${season.year || seasonId})`)

    let teamMap = {}
    let matches = []

    try {
      teamMap = await fetchTeamMap(seasonId)
      await sleep(RATE_MS)
      matches = await fetchAllMatches(seasonId)
      await sleep(RATE_MS)
    } catch (err) {
      console.warn(`  ⚠ fetch error: ${err.message}`)
      continue
    }

    const completed = matches.filter(m =>
      m.status === 'complete' &&
      m.homeGoalCount != null &&
      m.awayGoalCount != null
    )

    console.log(`  ${completed.length} completed matches, ${Object.keys(teamMap).length} teams`)

    const { scoring_coef, leagueMatched } = getLeagueCoefs(league.league_id, coefData.leagues)
    const lgAvgH = league.avg_goals_home
    const lgAvgA = league.avg_goals_away
    const rho = dynamicRho(lgAvgH, lgAvgA)

    const leaguePreds = []
    const leagueBets  = []
    let skipped = 0

    for (const m of completed) {
      const homeStats = teamMap[m.homeID]
      const awayStats = teamMap[m.awayID]
      if (!homeStats || !awayStats) { skipped++; continue }

      // Skip teams with insufficient match history
      const homeMP = getMatchesPlayed(homeStats, 'overall')
      const awayMP = getMatchesPlayed(awayStats, 'overall')
      if (homeMP < MIN_MATCHES_PLAYED || awayMP < MIN_MATCHES_PLAYED) { skipped++; continue }

      const homeScoredH   = getAttack(homeStats, 'home')
      const homeConcededH = getDefence(homeStats, 'home')
      const awayScoredA   = getAttack(awayStats, 'away')
      const awayConcededA = getDefence(awayStats, 'away')

      if (!homeScoredH || !homeConcededH || !awayScoredA || !awayConcededA) { skipped++; continue }

      // λ = geometric mean of attack × opponent defence
      let lH = Math.sqrt(homeScoredH * awayConcededA)
      let lA = Math.sqrt(awayScoredA * homeConcededH)

      // Shrinkage toward league average
      const shr = applyShrinkage(lH, lA, lgAvgH, lgAvgA)
      lH = shr.lH * scoring_coef
      lA = shr.lA * scoring_coef

      const { pOver } = calcOverUnder(lH, lA, rho)
      const actual = (m.homeGoalCount + m.awayGoalCount) > 2.5 ? 1 : 0

      leaguePreds.push({ p: pOver, actual })
      allPreds.push({ p: pOver, actual })

      const oddsOver  = parseFloat(m.odds_ft_over25)  || 0
      const oddsUnder = parseFloat(m.odds_ft_under25) || 0
      if (oddsOver > 1 && oddsUnder > 1) {
        const bet = { pOver, oddsOver, oddsUnder, actual }
        leagueBets.push(bet)
        allBets.push(bet)
      }
    }

    const lp = leaguePreds
    const over25ActualPct = lp.length
      ? parseFloat(((lp.filter(x => x.actual === 1).length / lp.length) * 100).toFixed(2))
      : null
    const over25PredictedPct = lp.length
      ? parseFloat(((lp.reduce((s, x) => s + x.p, 0) / lp.length) * 100).toFixed(2))
      : null

    const leagueRoi = roiByThreshold(leagueBets)

    byLeague.push({
      league_id: league.league_id,
      league_name: league.league_name,
      country: league.country,
      season_id: seasonId,
      matches: lp.length,
      skipped,
      brier_score: brier(lp) != null ? parseFloat(brier(lp).toFixed(4)) : null,
      hit_rate_pct: hitRate(lp) != null ? parseFloat(hitRate(lp).toFixed(2)) : null,
      over25_actual_pct: over25ActualPct,
      over25_predicted_pct: over25PredictedPct,
      roi_0pct:  leagueRoi['0.00']?.roi_pct ?? null,
      roi_2pct:  leagueRoi['0.02']?.roi_pct ?? null,
      roi_5pct:  leagueRoi['0.05']?.roi_pct ?? null,
      roi_10pct: leagueRoi['0.10']?.roi_pct ?? null,
    })

    const b = brier(lp)
    const hr = hitRate(lp)
    const r0 = leagueRoi['0.00']?.roi_pct
    console.log(`  ✓ ${lp.length} predictions | brier=${b?.toFixed(3)} hit=${hr?.toFixed(1)}% | over=${over25ActualPct}%actual vs ${over25PredictedPct}%pred | ROI@0=${r0}%`)
  }

  // Overall metrics
  const output = {
    run_at: new Date().toISOString(),
    lookahead_warning: 'Team stats are full-season averages — predictions for early-season matches have lookahead bias.',
    total_matches_predicted: allPreds.length,
    total_matches_with_odds: allBets.length,
    leagues_processed: byLeague.length,
    overall: {
      brier_score: brier(allPreds) != null ? parseFloat(brier(allPreds).toFixed(4)) : null,
      log_loss: logLoss(allPreds) != null ? parseFloat(logLoss(allPreds).toFixed(4)) : null,
      hit_rate_pct: hitRate(allPreds) != null ? parseFloat(hitRate(allPreds).toFixed(2)) : null,
      over25_actual_pct: allPreds.length
        ? parseFloat(((allPreds.filter(x => x.actual === 1).length / allPreds.length) * 100).toFixed(2))
        : null,
      over25_predicted_pct: allPreds.length
        ? parseFloat(((allPreds.reduce((s, x) => s + x.p, 0) / allPreds.length) * 100).toFixed(2))
        : null,
      calibration: calibration(allPreds),
      roi_by_threshold: roiByThreshold(allBets),
    },
    by_league: byLeague,
  }

  writeFileSync('./backtest-results.json', JSON.stringify(output, null, 2))
  console.log(`\n✓ Done. ${allPreds.length} predictions across ${byLeague.length} leagues.`)
  console.log(`  Brier: ${output.overall.brier_score} | Hit rate: ${output.overall.hit_rate_pct}%`)
  console.log(`  ROI@0%EV: ${output.overall.roi_by_threshold['0.00']?.roi_pct}% (${output.overall.roi_by_threshold['0.00']?.bets} bets with odds)`)
  console.log(`  ROI@5%EV: ${output.overall.roi_by_threshold['0.05']?.roi_pct}% (${output.overall.roi_by_threshold['0.05']?.bets} bets)`)
  console.log(`  ROI@10%EV: ${output.overall.roi_by_threshold['0.10']?.roi_pct}% (${output.overall.roi_by_threshold['0.10']?.bets} bets)`)
  console.log(`  Saved to backtest-results.json`)
}

main().catch(err => { console.error(err); process.exit(1) })

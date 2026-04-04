#!/usr/bin/env node
// Usage: node --env-file=.env scripts/fetch-league-coefficients.js

const API_BASE = 'https://api.football-data-api.com'
const KEY = process.env.VITE_FOOTYSTATS_KEY
const SEASONS_TO_FETCH = 5
const RATE_LIMIT_MS = 500 // delay between requests to avoid rate limiting

if (!KEY) {
  console.error('Missing VITE_FOOTYSTATS_KEY — run with: node --env-file=.env scripts/fetch-league-coefficients.js')
  process.exit(1)
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function get(endpoint, params = {}) {
  const qs = new URLSearchParams({ key: KEY, ...params }).toString()
  const url = `${API_BASE}/${endpoint}?${qs}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${endpoint}`)
  return res.json()
}

function pick(...candidates) {
  for (const v of candidates) {
    if (v !== null && v !== undefined && !isNaN(parseFloat(v))) return parseFloat(v)
  }
  return null
}

async function fetchLeagues() {
  const json = await get('league-list', { chosen_leagues_only: 'true' })
  const leagues = json?.data ?? []
  return leagues.map(l => ({
    id: l.id,
    name: l.name,
    country: l.country,
    seasons: (l.season ?? []).map(s => ({ id: s.id, year: s.year ?? s.name ?? s.id })),
  }))
}

async function fetchSeasonStats(seasonId) {
  try {
    const json = await get('league-season', { season_id: seasonId, stats: 'true' })
    const d = json?.data
    if (!d) return null

    const avgHome = pick(d.seasonAVG_home, d.avg_goals_home, d.avgGoalsPerMatch_home, d.avgGoals_home)
    const avgAway = pick(d.seasonAVG_away, d.avg_goals_away, d.avgGoalsPerMatch_away, d.avgGoals_away)
    const over25  = pick(d.seasonOver25Percentage_overall, d.over25Percentage, d.seasonOver25Percentage)
    const btts    = pick(d.seasonBTTSPercentage, d.btts, d.bttsPercentage, d.btts_percentage)
    const homeWin = pick(d.homeWinPercentage, d.seasonHomeWinPercentage, d.home_win_percentage)

    return { seasonId, avgHome, avgAway, over25, btts, homeWin }
  } catch (err) {
    console.warn(`  ⚠ season ${seasonId}: ${err.message}`)
    return null
  }
}

function avg(values) {
  const valid = values.filter(v => v !== null)
  if (!valid.length) return null
  return parseFloat((valid.reduce((s, v) => s + v, 0) / valid.length).toFixed(4))
}

async function main() {
  console.log('Fetching leagues...')
  const leagues = await fetchLeagues()
  console.log(`Found ${leagues.length} leagues`)

  const results = []

  for (const league of leagues) {
    console.log(`\n[${league.country}] ${league.name}`)

    // Take last N seasons (highest IDs / latest years)
    const seasons = [...league.seasons]
      .sort((a, b) => b.id - a.id)
      .slice(0, SEASONS_TO_FETCH)

    if (!seasons.length) {
      console.log('  No seasons found, skipping')
      continue
    }

    const seasonStats = []
    for (const season of seasons) {
      console.log(`  Fetching season ${season.year || season.id} (id=${season.id})...`)
      const stats = await fetchSeasonStats(season.id)
      if (stats) seasonStats.push({ ...stats, year: season.year })
      await sleep(RATE_LIMIT_MS)
    }

    if (!seasonStats.length) {
      console.log('  No stats returned, skipping')
      continue
    }

    results.push({
      league_id: league.id,
      league_name: league.name,
      country: league.country,
      seasons_fetched: seasonStats.length,
      avg_goals_home: avg(seasonStats.map(s => s.avgHome)),
      avg_goals_away: avg(seasonStats.map(s => s.avgAway)),
      over25_pct:     avg(seasonStats.map(s => s.over25)),
      under25_pct:    avg(seasonStats.map(s => s.over25 !== null ? 100 - s.over25 : null)),
      btts_pct:       avg(seasonStats.map(s => s.btts)),
      home_win_pct:   avg(seasonStats.map(s => s.homeWin)),
      seasons: seasonStats,
    })

    console.log(`  ✓ avgH=${results.at(-1).avg_goals_home} avgA=${results.at(-1).avg_goals_away} over25=${results.at(-1).over25_pct}% btts=${results.at(-1).btts_pct}%`)
  }

  const output = {
    generated_at: new Date().toISOString(),
    league_count: results.length,
    leagues: results,
  }

  const { writeFileSync } = await import('fs')
  writeFileSync('league-coefficients.json', JSON.stringify(output, null, 2))
  console.log(`\nDone. Saved ${results.length} leagues to league-coefficients.json`)
}

main().catch(err => { console.error(err); process.exit(1) })

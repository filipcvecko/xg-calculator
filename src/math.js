// Poisson PMF
export function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0
  let logP = k * Math.log(lambda) - lambda
  for (let i = 1; i <= k; i++) logP -= Math.log(i)
  return Math.exp(logP)
}

// Dynamic rho based on league average goals
// avgGoals < 2.2 → -0.15, 2.2-2.8 → -0.10, > 2.8 → -0.05
export function dynamicRho(leagueAvgH, leagueAvgA) {
  const avg = (leagueAvgH || 0) + (leagueAvgA || 0)
  if (avg <= 0) return -0.10
  if (avg < 2.2) return -0.15
  if (avg <= 2.8) return -0.10
  return -0.05
}

// Dixon-Coles τ korekcia pre nízke skóre (0-0, 1-0, 0-1, 1-1)
// rho ≈ -0.05 až -0.15 (záporné = koreluje nízke skóre)
export function dixonColesTau(h, a, lambdaH, lambdaA, rho = -0.10) {
  if (h === 0 && a === 0) return 1 - lambdaH * lambdaA * rho
  if (h === 1 && a === 0) return 1 + lambdaA * rho
  if (h === 0 && a === 1) return 1 + lambdaH * rho
  if (h === 1 && a === 1) return 1 - rho
  return 1
}

// Over/Under 2.5 s Dixon-Coles korekciou
// rho = 0 znamená štandardný Poisson (bez korekcie)
export function calcOverUnder(lambdaH, lambdaA, rho = -0.10) {
  let pUnder = 0
  for (let h = 0; h <= 2; h++) {
    for (let a = 0; a <= 2 - h; a++) {
      const tau = dixonColesTau(h, a, lambdaH, lambdaA, rho)
      pUnder += poissonPMF(h, lambdaH) * poissonPMF(a, lambdaA) * tau
    }
  }
  pUnder = Math.min(1, Math.max(0, pUnder))
  return { pOver: 1 - pUnder, pUnder }
}

// Score matrix — generuje pravdepodobnosti všetkých skóre až do maxG gólov
// Vracia Map: key = "h-a", value = pravdepodobnosť (normalizovaná na súčet = 1)
export function buildScoreMatrix(lambdaH, lambdaA, rho = -0.10, maxG = 12) {
  const matrix = new Map()
  for (let h = 0; h <= maxG; h++) {
    for (let a = 0; a <= maxG; a++) {
      const tau = dixonColesTau(h, a, lambdaH, lambdaA, rho)
      const p = poissonPMF(h, lambdaH) * poissonPMF(a, lambdaA) * tau
      matrix.set(`${h}-${a}`, p)
    }
  }
  // Normalizácia — Dixon-Coles tau mení súčet, treba renormalizovať na 1
  let sum = 0
  for (const p of matrix.values()) sum += p
  if (sum > 0) {
    for (const key of matrix.keys()) {
      matrix.set(key, matrix.get(key) / sum)
    }
  }
  return matrix
}

// Over/Under 3.0 s push logikou
// Over 3.0: T<=2 lose, T=3 push, T>=4 win
// Under 3.0: T<=2 win, T=3 push, T>=4 lose
// rho != 0 → Dixon-Coles korekcia cez buildScoreMatrix (rovnako ako O/U 2.5)
// rho = 0  → čistý Poisson na T = lambdaH + lambdaA (spätná kompatibilita)
export function calcOU30(lambdaH, lambdaA, rho = 0) {
  if (rho !== 0) {
    const matrix = buildScoreMatrix(lambdaH, lambdaA, rho)
    let pUnder2 = 0, pExact3 = 0, pOver3 = 0
    for (const [key, prob] of matrix.entries()) {
      const [h, a] = key.split('-').map(Number)
      const total = h + a
      if (total <= 2) pUnder2 += prob
      else if (total === 3) pExact3 += prob
      else pOver3 += prob
    }
    const fairOver  = pOver3  > 0 ? 1 + pUnder2 / pOver3  : null
    const fairUnder = pUnder2 > 0 ? 1 + pOver3  / pUnder2 : null
    return { pOver3, pExact3, pUnder2, fairOver, fairUnder }
  }
  const lt = lambdaH + lambdaA
  const p0 = poissonPMF(0, lt)
  const p1 = poissonPMF(1, lt)
  const p2 = poissonPMF(2, lt)
  const p3 = poissonPMF(3, lt)
  const pUnder2 = p0 + p1 + p2
  const pExact3 = p3
  const pOver3  = 1 - pUnder2 - pExact3
  const fairOver  = pOver3  > 0 ? 1 + pUnder2 / pOver3  : null
  const fairUnder = pUnder2 > 0 ? 1 + pOver3  / pUnder2 : null
  return { pOver3, pExact3, pUnder2, fairOver, fairUnder }
}

// EV pre O/U 3.0 (back bet) s komisiou
export function calcEVOU30(isOver, pOver3, pUnder2, odds, comm = 0.05) {
  if (!odds || odds <= 1) return null
  return isOver
    ? pOver3  * (odds - 1) * (1 - comm) - pUnder2
    : pUnder2 * (odds - 1) * (1 - comm) - pOver3
}

// Over/Under 2.75 — Asian line (split medzi 2.5 a 3.0)
export function calcOU275(lambdaH, lambdaA, rho = -0.10) {
  const matrix = buildScoreMatrix(lambdaH, lambdaA, rho)
  let p0_2 = 0, p3 = 0, p4plus = 0
  for (const [key, prob] of matrix.entries()) {
    const [h, a] = key.split('-').map(Number)
    const total = h + a
    if (total <= 2) p0_2 += prob
    else if (total === 3) p3 += prob
    else p4plus += prob
  }
  const pOver275  = p4plus + 0.5 * p3
  const pUnder275 = p0_2   + 0.5 * p3
  const fairOver  = (p4plus + 0.5 * p3) > 0 ? 1 + p0_2  / (p4plus + 0.5 * p3) : null
  const fairUnder = (p0_2   + 0.5 * p3) > 0 ? 1 + p4plus / (p0_2   + 0.5 * p3) : null
  return { pOver275, pUnder275, p0_2, p3, p4plus, fairOver, fairUnder }
}

// EV pre O/U 2.75 (back bet) s komisiou
export function calcEVOU275(isOver, p0_2, p3, p4plus, odds, comm = 0.05) {
  if (!odds || odds <= 1) return null
  if (isOver) {
    return p4plus * (odds - 1) * (1 - comm) - p3 * 0.5 - p0_2
  } else {
    return p0_2 * (odds - 1) * (1 - comm) + p3 * ((odds - 1) * (1 - comm) / 2 - 0.5) - p4plus
  }
}

// Over/Under 2.25 — Asian line (split medzi 2.0 a 2.5)
export function calcOU225(lambdaH, lambdaA, rho = -0.10) {
  const matrix = buildScoreMatrix(lambdaH, lambdaA, rho)
  let p0_1 = 0, p2 = 0, p3plus = 0
  for (const [key, prob] of matrix.entries()) {
    const [h, a] = key.split('-').map(Number)
    const total = h + a
    if (total <= 1) p0_1 += prob
    else if (total === 2) p2 += prob
    else p3plus += prob
  }
  const pOver225  = p3plus + 0.5 * p2
  const pUnder225 = p0_1   + 0.5 * p2
  const fairOver  = (p3plus + 0.5 * p2) > 0 ? 1 + p0_1   / (p3plus + 0.5 * p2) : null
  const fairUnder = (p0_1   + 0.5 * p2) > 0 ? 1 + p3plus  / (p0_1   + 0.5 * p2) : null
  return { pOver225, pUnder225, p0_1, p2, p3plus, fairOver, fairUnder }
}

// EV pre O/U 2.25 (back bet) s komisiou
export function calcEVOU225(isOver, p0_1, p2, p3plus, odds, comm = 0.05) {
  if (!odds || odds <= 1) return null
  if (isOver) {
    return p3plus * (odds - 1) * (1 - comm) + p2 * ((odds - 1) * (1 - comm) / 2 - 0.5) - p0_1
  } else {
    return p0_1 * (odds - 1) * (1 - comm) - p2 * 0.5 - p3plus
  }
}

// Both Teams To Score
export function calcBTTS(lambdaH, lambdaA, rho = -0.10) {
  const matrix = buildScoreMatrix(lambdaH, lambdaA, rho)
  let pBTTS = 0
  for (const [key, prob] of matrix.entries()) {
    const [h, a] = key.split('-').map(Number)
    if (h > 0 && a > 0) pBTTS += prob
  }
  pBTTS = Math.min(1, Math.max(0, pBTTS))
  const pNoBTTS = 1 - pBTTS
  return {
    pBTTS,
    pNoBTTS,
    fairOddsBTTS: fairOdds(pBTTS),
    fairOddsNoBTTS: fairOdds(pNoBTTS),
    fairOddsBTTSCalib: fairOdds(calibrateProb(pBTTS, 0.85)),
    fairOddsNoBTTSCalib: fairOdds(calibrateProb(pNoBTTS, 0.85)),
  }
}

// Blend xG + xGA using geometric mean
export function blendLambda(xg, xgaOpponent) {
  return Math.sqrt(xg * xgaOpponent)
}

// Fair odds from probability
export function fairOdds(p) {
  if (!p || p <= 0 || p >= 1) return null
  return 1 / p
}

// EV = p * odds - 1
export function calcEV(prob, odds) {
  if (!prob || !odds) return null
  return prob * odds - 1
}

// CLV% = (oddsOpen / oddsClose - 1) * 100
export function calcCLV(oddsOpen, oddsClose) {
  if (!oddsOpen || !oddsClose || oddsClose <= 1) return null
  return (oddsOpen / oddsClose - 1) * 100
}

// Market calibration: blend modelu a trhových kurzov
export function marketCalibration(pModel, marketOdds, w = 0.6) {
  if (!marketOdds || marketOdds <= 1) return pModel
  const pMarket = 1 / marketOdds
  return w * pModel + (1 - w) * pMarket
}

// Probability calibration: logistic shrinkage toward 50%
export function calibrateProb(p, k = 0.95) {
  if (!p || p <= 0 || p >= 1) return p
  if (k === 1) return p
  return 1 / (1 + Math.pow((1 - p) / p, 1 / k))
}

export function plattCalibrate(p) {
  return p
}

// EV threshold filter
export function evFilter(ev, evMin = 0.04) {
  return ev != null && ev >= evMin
}

// Odds band filter
export function oddsBandFilter(odds, low = 1.4, high = 3.5) {
  return odds != null && odds > low && odds < high
}

// Brier score = (result - prob)^2
export function brierScore(prob, result) {
  return Math.pow(result - prob, 2)
}

// Log loss
export function logLoss(prob, result) {
  const eps = 1e-7
  const p = Math.max(eps, Math.min(1 - eps, prob))
  return -(result * Math.log(p) + (1 - result) * Math.log(1 - p))
}

// Max drawdown from array of settled bets
export function calcMaxDrawdown(bets) {
  let peak = 0, maxDD = 0, running = 0
  bets.forEach(b => {
    running += b.pnl || 0
    if (running > peak) peak = running
    const dd = peak - running
    if (dd > maxDD) maxDD = dd
  })
  return maxDD
}

// SoT adjustment — upraví lambda na základe streleckých pokusov na bránku
// Vracia { homeAdj, awayAdj } ako desatinné čísla (napr. 0.032 = +3.2%)
export function calcSotAdjustment({
  homeSotFor, awaySotFor,
  homeSotAgainst = null, awaySotAgainst = null,
  leagueAvgSot = 4.5, weight = 0.3, maxCap = 0.05
}) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  const lg = leagueAvgSot > 0 ? leagueAvgSot : 4.5

  let homeRatio, awayRatio
  if (homeSotAgainst != null && awaySotAgainst != null && homeSotAgainst > 0 && awaySotAgainst > 0) {
    homeRatio = (homeSotFor / lg + lg / awaySotAgainst) / 2
    awayRatio = (awaySotFor / lg + lg / homeSotAgainst) / 2
  } else {
    homeRatio = homeSotFor / lg
    awayRatio = awaySotFor / lg
  }

  const homeAdj = clamp((homeRatio - 1) * weight, -maxCap, maxCap)
  const awayAdj = clamp((awayRatio - 1) * weight, -maxCap, maxCap)
  return { homeAdj, awayAdj }
}

// Time decay blend
export function timeDecayBlend(seasonVal, formVal, w = 0.40) {
  if (formVal == null || isNaN(formVal)) return seasonVal
  if (seasonVal == null || isNaN(seasonVal)) return formVal
  return (1 - w) * seasonVal + w * formVal
}

// Extrahuj xG/GF/GA z lastx objektu (last5/last6/last10)
// Opravená verzia — fallback na seasonScoredAVG keď xG chýba (napr. Saudi Arabia, nižšie ligy)
export function extractLastXStats(lastxData, matchNum = 5) {
  if (!lastxData) return null

  // API vracia { data: [ { last_x_match_num: 5, stats: {...} }, ... ] }
  const arr = lastxData?.data
  if (!Array.isArray(arr) || arr.length === 0) return null

  // Nájdi záznam s požadovaným počtom zápasov
  const item = arr.find(x => x.last_x_match_num === matchNum) || arr[0]
  const d = item?.stats
  if (!d) return null

  const get = (...keys) => {
    for (const k of keys) {
      if (d[k] != null && d[k] !== '' && !isNaN(+d[k])) return +d[k]
    }
    return null
  }

  return {
    // xG s fallback na reálne góly (seasonScoredAVG) keď liga nemá xG dáta
    xgH: get('xg_for_avg_home', 'xg_for_avg_overall', 'seasonScoredAVG_home', 'seasonScoredAVG_overall'),
    xgA: get('xg_for_avg_away', 'xg_for_avg_overall', 'seasonScoredAVG_away', 'seasonScoredAVG_overall'),
    xgaH: get('xg_against_avg_home', 'xg_against_avg_overall', 'seasonConcededAVG_home', 'seasonConcededAVG_overall'),
    xgaA: get('xg_against_avg_away', 'xg_against_avg_overall', 'seasonConcededAVG_away', 'seasonConcededAVG_overall'),
    gfH: get('seasonScoredAVG_home', 'seasonScoredAVG_overall'),
    gfA: get('seasonScoredAVG_away', 'seasonScoredAVG_overall'),
    gaH: get('seasonConcededAVG_home', 'seasonConcededAVG_overall'),
    gaA: get('seasonConcededAVG_away', 'seasonConcededAVG_overall'),
    mp: get('seasonMatchesPlayed_overall') || null,
  }
}


// League coefficients from league-coefficients.json
// Returns { scoring_coef, xg_coef, stability_coef, leagueMatched }
// All coefficients default to 1.0 (neutral) if league not found.
export function getLeagueCoefs(leagueId, leaguesData) {
  const neutral = { scoring_coef: 1, xg_coef: 1, stability_coef: 1, leagueMatched: false }
  if (!leaguesData?.length) return neutral

  const validLeagues = leaguesData.filter(l =>
    l.avg_goals_home != null && l.avg_goals_away != null &&
    l.over25_pct != null
  )
  if (!validLeagues.length) return neutral

  // Globals
  const totalGoals = validLeagues.map(l => l.avg_goals_home + l.avg_goals_away)
  const globalAvgGoals = totalGoals.reduce((s, v) => s + v, 0) / totalGoals.length
  const globalAvgOver25 = validLeagues.reduce((s, l) => s + l.over25_pct, 0) / validLeagues.length
  const globalVariance = Math.sqrt(
    totalGoals.reduce((s, v) => s + Math.pow(v - globalAvgGoals, 2), 0) / totalGoals.length
  )

  const league = validLeagues.find(l => l.league_id === leagueId)
  if (!league) return neutral

  const leagueAvgGoals = league.avg_goals_home + league.avg_goals_away
  const scoring_coef = leagueAvgGoals / globalAvgGoals

  const rawXgCoef = league.over25_pct / globalAvgOver25
  const xg_coef = Math.max(0.85, Math.min(1.15, rawXgCoef))

  const seasonTotals = (league.seasons ?? [])
    .filter(s => s.avgHome != null && s.avgAway != null)
    .map(s => s.avgHome + s.avgAway)
  const leagueVariance = seasonTotals.length > 1
    ? Math.sqrt(seasonTotals.reduce((s, v) => s + Math.pow(v - leagueAvgGoals, 2), 0) / seasonTotals.length)
    : globalVariance
  const stability_coef = globalVariance > 0 ? leagueVariance / globalVariance : 1

  return { scoring_coef, xg_coef, stability_coef, leagueMatched: true }
}

export const fmt2 = n => (n == null || isNaN(n) ? '—' : n.toFixed(2))
export const fmt3 = n => (n == null || isNaN(n) ? '—' : n.toFixed(3))
export const fmtPct = n => (n == null || isNaN(n) ? '—' : n.toFixed(1) + '%')
export const fmtSign = n => (n == null || isNaN(n) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2))
export const fmtSignPct = n => (n == null || isNaN(n) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%')

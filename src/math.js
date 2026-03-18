// Poisson PMF
export function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0
  let logP = k * Math.log(lambda) - lambda
  for (let i = 1; i <= k; i++) logP -= Math.log(i)
  return Math.exp(logP)
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
export function buildScoreMatrix(lambdaH, lambdaA, rho = -0.10, maxG = 10) {
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
// T ~ Poisson(lambdaH + lambdaA)
// Over 3.0: T<=2 lose, T=3 push, T>=4 win
// Under 3.0: T<=2 win, T=3 push, T>=4 lose
export function calcOU30(lambdaH, lambdaA) {
  const lt = lambdaH + lambdaA
  const p0 = poissonPMF(0, lt)
  const p1 = poissonPMF(1, lt)
  const p2 = poissonPMF(2, lt)
  const p3 = poissonPMF(3, lt)
  const pUnder2 = p0 + p1 + p2          // T <= 2
  const pExact3 = p3                     // T = 3 (push)
  const pOver3  = 1 - pUnder2 - pExact3 // T >= 4
  // Fair odds: rátame cez win/lose s pushom
  // fair_over  = 1 + pUnder2 / pOver3
  // fair_under = 1 + pOver3  / pUnder2
  const fairOver  = pOver3  > 0 ? 1 + pUnder2 / pOver3  : null
  const fairUnder = pUnder2 > 0 ? 1 + pOver3  / pUnder2 : null
  return { pOver3, pExact3, pUnder2, fairOver, fairUnder }
}

// EV pre O/U 3.0 (back bet) s komisiou
// Over:  EV = pOver3 * (odds-1) * (1-comm) - pUnder2
// Under: EV = pUnder2 * (odds-1) * (1-comm) - pOver3
// Push sa ignoruje v EV (stake sa vráti)
export function calcEVOU30(isOver, pOver3, pUnder2, odds, comm = 0.05) {
  if (!odds || odds <= 1) return null
  return isOver
    ? pOver3  * (odds - 1) * (1 - comm) - pUnder2
    : pUnder2 * (odds - 1) * (1 - comm) - pOver3
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
// w = váha modelu (0.6 = 60% model, 40% market)
export function marketCalibration(pModel, marketOdds, w = 0.6) {
  if (!marketOdds || marketOdds <= 1) return pModel
  const pMarket = 1 / marketOdds
  return w * pModel + (1 - w) * pMarket
}

// Probability calibration: logistic shrinkage toward 50%
// k < 1 = stiahni k 50% (znížiš istotu) | k = 1 = žiadna zmena | k > 1 = polarizuj
// Vzorec: p_adj = 1 / (1 + ((1-p)/p)^(1/k))
// Príklad k=0.85: p=0.53 → 0.508 (nie 0.60 ako starý P^k)
export function calibrateProb(p, k = 0.95) {
  if (!p || p <= 0 || p >= 1) return p
  if (k === 1) return p
  return 1 / (1 + Math.pow((1 - p) / p, 1 / k))
}

// EV threshold filter — true ak bet spĺňa minimálny EV
export function evFilter(ev, evMin = 0.04) {
  return ev != null && ev >= evMin
}

// Odds band filter — true ak kurz je v rozumnom pásme
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

// Time decay blend — mixuje sezónny priemer s last-X formou
// w = váha formy (0.0–1.0), napr. 0.4 = 40% forma, 60% sezóna
export function timeDecayBlend(seasonVal, formVal, w = 0.40) {
  if (formVal == null || isNaN(formVal)) return seasonVal
  if (seasonVal == null || isNaN(seasonVal)) return formVal
  return (1 - w) * seasonVal + w * formVal
}

// Extrahuj xG/GF/GA z lastx objektu (last5/last6/last10)
// typ = 'last_5' | 'last_6' | 'last_10'
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
    xgH: get('xg_for_avg_home', 'xg_for_avg_overall'),
    xgA: get('xg_for_avg_away', 'xg_for_avg_overall'),
    xgaH: get('xg_against_avg_home', 'xg_against_avg_overall'),
    xgaA: get('xg_against_avg_away', 'xg_against_avg_overall'),
    gfH: get('seasonScoredAVG_home'),
    gfA: get('seasonScoredAVG_away'),
    gaH: get('seasonConcededAVG_home'),
    gaA: get('seasonConcededAVG_away'),
    mp: get('seasonMatchesPlayed_overall') || null,
  }
}


export const fmt2 = n => (n == null || isNaN(n) ? '—' : n.toFixed(2))
export const fmt3 = n => (n == null || isNaN(n) ? '—' : n.toFixed(3))
export const fmtPct = n => (n == null || isNaN(n) ? '—' : n.toFixed(1) + '%')
export const fmtSign = n => (n == null || isNaN(n) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2))
export const fmtSignPct = n => (n == null || isNaN(n) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%')

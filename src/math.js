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

// Probability calibration: power transform P^k
// k < 1 = zníž istotu | k > 1 = zvýš polarizáciu
export function calibrateProb(p, k = 0.95) {
  if (!p || p <= 0 || p >= 1) return p
  return Math.pow(p, k)
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

// Formatters
export const fmt2 = n => (n == null || isNaN(n) ? '—' : n.toFixed(2))
export const fmt3 = n => (n == null || isNaN(n) ? '—' : n.toFixed(3))
export const fmtPct = n => (n == null || isNaN(n) ? '—' : n.toFixed(1) + '%')
export const fmtSign = n => (n == null || isNaN(n) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2))
export const fmtSignPct = n => (n == null || isNaN(n) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%')

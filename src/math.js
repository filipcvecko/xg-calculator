// Poisson PMF
export function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0
  let logP = k * Math.log(lambda) - lambda
  for (let i = 1; i <= k; i++) logP -= Math.log(i)
  return Math.exp(logP)
}

// Over/Under 2.5 probabilities using independent Poisson
export function calcOverUnder(lambdaH, lambdaA) {
  let pUnder = 0
  for (let h = 0; h <= 2; h++) {
    for (let a = 0; a <= 2 - h; a++) {
      pUnder += poissonPMF(h, lambdaH) * poissonPMF(a, lambdaA)
    }
  }
  return { pOver: 1 - pUnder, pUnder }
}

// Blend xG + xGA using geometric mean (more stable than arithmetic)
export function blendLambda(xg, xgaOpponent) {
  return Math.sqrt(xg * xgaOpponent)
}

// Fair odds from probability
export function fairOdds(p) {
  if (!p || p <= 0 || p >= 1) return null
  return 1 / p
}

// EV = p * odds - 1  (profit per 1 unit staked)
export function calcEV(prob, odds) {
  if (!prob || !odds) return null
  return prob * odds - 1
}

// CLV% = (oddsOpen / oddsClose - 1) * 100
export function calcCLV(oddsOpen, oddsClose) {
  if (!oddsOpen || !oddsClose || oddsClose <= 1) return null
  return (oddsOpen / oddsClose - 1) * 100
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

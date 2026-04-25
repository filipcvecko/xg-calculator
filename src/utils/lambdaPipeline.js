import { blendLambda, timeDecayBlend } from '../math'

const DEFAULTS = {
  xgScaler:   0.90,
  alpha:      0.70,
  formWeight: 0.40,
  shrinkage:  0.15,
}

// Identická logika ako App.jsx blendWithGoals (riadky 45-54)
function blendWithGoals(xgH, xgA, xgaH, xgaA, gfH, gaH, gfA, gaA, alpha) {
  const a    = alpha
  const attH = a * xgH  + (1 - a) * gfH
  const defA = a * xgaA + (1 - a) * gaA
  const attA = a * xgA  + (1 - a) * gfA
  const defH = a * xgaH + (1 - a) * gaH
  return { lH: Math.sqrt(attH * defA), lA: Math.sqrt(attA * defH) }
}

// Identická logika ako App.jsx applyShrinkage (riadky 56-69)
function applyShrinkage(lH, lA, lgAvgH, lgAvgA, shrink) {
  const rawTotal    = lH + lA
  const leagueTotal = lgAvgH + lgAvgA
  if (rawTotal <= 0) return { lH, lA }
  const shrunkTotal = (1 - shrink) * rawTotal + shrink * leagueTotal
  const ratio       = shrunkTotal / rawTotal
  return { lH: lH * ratio, lA: lA * ratio }
}

/**
 * Pure lambda výpočtová pipeline. Nepoužíva State ani DOM.
 *
 * @param {object} raw
 * @param {number}      raw.xgH
 * @param {number}      raw.xgA
 * @param {number|null} raw.xgaH
 * @param {number|null} raw.xgaA
 * @param {number|null} raw.gfH
 * @param {number|null} raw.gaH
 * @param {number|null} raw.gfA
 * @param {number|null} raw.gaA
 *
 * @param {{ homeForm: object|null, awayForm: object|null }|null} formData
 *   Výstup extractLastXStats() pre oba tímy. Caller zavolá extractLastXStats
 *   pred pipeline a odovzdá výsledok sem.
 *
 * @param {object} params
 * @param {number}                              [params.xgScaler=0.90]
 * @param {number}                              [params.alpha=0.70]
 * @param {number}                              [params.formWeight=0.40]
 * @param {number}                              [params.shrinkage=0.15]
 * @param {{ avgHome: number, avgAway: number }|null} [params.leagueAvg=null]
 *
 * @returns {object} Výstup so všetkými medzikrokmi alebo { error } pri
 *   neplatnom vstupe.
 *
 * POZOR: lambda_total_raw, lambda_total_final, compression_ratio sú
 * prítomné vo výstupe pre audit/debug, ale NESMÚ sa posielať do
 * Supabase INSERT — DB ich generuje automaticky ako GENERATED ALWAYS stĺpce.
 */
export function lambdaPipeline(raw, formData = null, params = {}) {
  const {
    xgH,
    xgA,
    xgaH = null,
    xgaA = null,
    gfH  = null,
    gaH  = null,
    gfA  = null,
    gaA  = null,
  } = raw

  if (!(xgH > 0) || !(xgA > 0)) {
    return {
      error:             'invalid_xg_input',
      lambda_xg_raw_h:   null, lambda_xg_raw_a:  null,
      lambda_scaled_h:   null, lambda_scaled_a:  null,
      lambda_blended_h:  null, lambda_blended_a: null,
      lambda_form_h:     null, lambda_form_a:    null,
      lambda_h:          null, lambda_a:         null,
      lambda_total_raw:  null, lambda_total_final: null,
      compression_ratio: null,
      model_params:      null,
    }
  }

  const sc    = params.xgScaler   ?? DEFAULTS.xgScaler
  const alp   = params.alpha      ?? DEFAULTS.alpha
  const fw    = params.formWeight ?? DEFAULTS.formWeight
  const shr   = params.shrinkage  ?? DEFAULTS.shrinkage
  const lgAvg = params.leagueAvg  ?? null

  // — krok 0: raw (pred scalingom)
  const lambda_xg_raw_h = xgH
  const lambda_xg_raw_a = xgA

  // — krok 1: xgScaler
  const h  = xgH * sc
  const a  = xgA * sc
  const ha = (xgaH ?? 0) * sc
  const aa = (xgaA ?? 0) * sc
  const lambda_scaled_h = h
  const lambda_scaled_a = a

  // — krok 2: blend (identické vetvy ako handleCalc riadky 936-949)
  const gfHv = gfH ?? 0, gaHv = gaH ?? 0
  const gfAv = gfA ?? 0, gaAv = gaA ?? 0
  const hasGoals = gfHv > 0 && gaHv > 0 && gfAv > 0 && gaAv > 0
  const hasXGA   = ha > 0 && aa > 0

  let blendMode, lambda_blended_h, lambda_blended_a

  if (hasGoals && hasXGA) {
    blendMode = 'blendWithGoals_full'
    const r = blendWithGoals(h, a, ha, aa, gfHv, gaHv, gfAv, gaAv, alp)
    lambda_blended_h = r.lH; lambda_blended_a = r.lA

  } else if (hasGoals) {
    // xGA chýba → xGA slot nahradíme škálovaným xG (identické s App.jsx riadok 943)
    blendMode = 'blendWithGoals_xGA_only'
    const r = blendWithGoals(h, a, h, a, gfHv, gaHv, gfAv, gaAv, alp)
    lambda_blended_h = r.lH; lambda_blended_a = r.lA

  } else if (hasXGA) {
    blendMode = 'blendLambda'
    lambda_blended_h = blendLambda(h, aa)
    lambda_blended_a = blendLambda(a, ha)

  } else {
    blendMode = 'no_blend'
    lambda_blended_h = h
    lambda_blended_a = a
  }

  // — krok 3: form blend (identické s handleCalc riadky 956-991)
  let lH = lambda_blended_h
  let lA = lambda_blended_a
  let formApplied = false

  const homeForm = formData?.homeForm ?? null
  const awayForm = formData?.awayForm ?? null

  if (homeForm || awayForm) {
    if (homeForm) {
      const formXgH  = homeForm.xgH  ?? homeForm.gfH  ?? null
      const formXgaA = awayForm?.xgaA ?? awayForm?.gaA ?? null
      if (formXgH != null) {
        const formLH = formXgaA != null ? Math.sqrt(formXgH * formXgaA) : formXgH
        lH = timeDecayBlend(lH, formLH, fw)
        formApplied = true
      }
    }
    if (awayForm) {
      const formXgA  = awayForm.xgA  ?? awayForm.gfA  ?? null
      const formXgaH = homeForm?.xgaH ?? homeForm?.gaH ?? null
      if (formXgA != null) {
        const formLA = formXgaH != null ? Math.sqrt(formXgA * formXgaH) : formXgA
        lA = timeDecayBlend(lA, formLA, fw)
        formApplied = true
      }
    }
  }

  const lambda_form_h = lH
  const lambda_form_a = lA

  // — krok 4: shrinkage (identické s handleCalc riadky 994-1009)
  if (lgAvg?.avgHome > 0 && lgAvg?.avgAway > 0) {
    const r = applyShrinkage(lH, lA, lgAvg.avgHome, lgAvg.avgAway, shr)
    lH = r.lH; lA = r.lA
  }

  const lambda_h = lH
  const lambda_a = lA

  // — odvodené (zrkadlí GENERATED DB stĺpce — len pre audit, NIE do INSERT)
  const lambda_total_raw   = lambda_xg_raw_h + lambda_xg_raw_a
  const lambda_total_final = lambda_h + lambda_a
  const compression_ratio  = lambda_total_raw > 0
    ? lambda_total_final / lambda_total_raw
    : null

  const shrinkageApplied = lgAvg?.avgHome > 0 && lgAvg?.avgAway > 0

  return {
    lambda_xg_raw_h,
    lambda_xg_raw_a,
    lambda_scaled_h,
    lambda_scaled_a,
    lambda_blended_h,
    lambda_blended_a,
    lambda_form_h,
    lambda_form_a,
    lambda_h,
    lambda_a,
    lambda_total_raw,
    lambda_total_final,
    compression_ratio,
    model_params: {
      xgScaler:   sc,
      alpha:      alp,
      formWeight: fw,
      shrinkage:  shrinkageApplied ? shr : null,
      leagueAvg:  shrinkageApplied ? lgAvg : null,
      blendMode,
      formApplied,
    },
  }
}

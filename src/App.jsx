import { useState, useEffect, useCallback } from 'react'
import { supabase } from './supabase'
import {
  calcOverUnder, blendLambda, fairOdds, calcEV, calcCLV,
  brierScore, logLoss, calcMaxDrawdown,
  fmt2, fmt3, fmtPct, fmtSign, fmtSignPct
} from './math'

const css = `
  .wrap { max-width: 680px; margin: 0 auto; padding: 20px 16px 60px; }
  .header { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 14px 20px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
  .logo { font-family: var(--display); font-weight: 800; font-size: 18px; letter-spacing: -0.02em; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 10px var(--accent); flex-shrink: 0; }
  .meta { margin-left: auto; font-size: 11px; color: var(--text3); }
  .tabs { border-bottom: 1px solid var(--border); padding: 0 20px; display: flex; gap: 2px; background: var(--bg2); }
  .tab { cursor: pointer; padding: 10px 18px; border: none; background: transparent; font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text3); transition: all 0.2s; border-bottom: 2px solid transparent; }
  .tab.active { color: var(--accent2); border-bottom-color: var(--accent); }
  .tab:hover:not(.active) { color: var(--text2); }

  .card { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card + .card { margin-top: 12px; }
  .label { font-size: 10px; color: var(--text3); letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 5px; }
  .inp { width: 100%; background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; color: var(--text); font-family: var(--mono); font-size: 13px; transition: border-color 0.15s; }
  .inp:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(108,92,231,0.15); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }

  .btn { cursor: pointer; border: none; font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; padding: 12px 20px; border-radius: 6px; transition: all 0.2s; width: 100%; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { background: #7d6ff0; transform: translateY(-1px); }
  .btn-save { background: rgba(0,184,148,0.15); color: var(--green); border: 1px solid rgba(0,184,148,0.3); }
  .btn-save:hover { background: rgba(0,184,148,0.25); }
  .btn-ghost { cursor: pointer; background: transparent; border: 1px solid var(--border2); color: var(--text2); font-family: var(--mono); font-size: 11px; padding: 6px 12px; border-radius: 4px; transition: all 0.2s; }
  .btn-ghost:hover { border-color: var(--accent); color: var(--accent2); }
  .btn-danger { cursor: pointer; background: transparent; border: 1px solid rgba(214,48,49,0.2); color: var(--red); font-family: var(--mono); font-size: 11px; padding: 6px 10px; border-radius: 4px; transition: all 0.2s; }
  .btn-danger:hover { background: rgba(214,48,49,0.1); }

  .fer-display { display: flex; justify-content: space-around; text-align: center; padding: 20px; background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; }
  .fer-big { font-family: var(--display); font-size: 30px; font-weight: 800; }
  .fer-divider { width: 1px; background: var(--border); }

  .pos { color: var(--green); }
  .neg { color: var(--red); }
  .neu { color: var(--yellow); }

  .bet-row { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin-bottom: 8px; }
  .badge { display: inline-block; font-size: 10px; padding: 2px 8px; border-radius: 3px; letter-spacing: 0.05em; font-weight: 600; }
  .badge-pending { background: rgba(253,203,110,0.15); color: var(--yellow); }
  .badge-won { background: rgba(0,184,148,0.15); color: var(--green); }
  .badge-lost { background: rgba(214,48,49,0.15); color: var(--red); }

  .settle-box { background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-top: 10px; }
  .stat-val { font-size: 20px; font-weight: 700; margin-top: 2px; }
  .hint { font-size: 10px; color: var(--text3); margin-top: 3px; }

  .pnl-bar-wrap { display: flex; align-items: flex-end; gap: 3px; height: 56px; }
  .pnl-bar { flex: 1; min-width: 3px; border-radius: 2px 2px 0 0; transition: opacity 0.2s; }
  .pnl-bar:hover { opacity: 0.7; }

  .loading { text-align: center; padding: 60px 20px; color: var(--text3); font-size: 13px; }
  .empty { text-align: center; padding: 60px 20px; color: var(--text3); font-size: 13px; line-height: 1.8; }

  .lambda-row { display: flex; gap: 20px; font-size: 12px; color: var(--text3); padding: 10px 14px; background: var(--bg3); border-radius: 6px; }
  .lambda-row span b { color: var(--text2); }

  .section-title { font-size: 10px; color: var(--text3); letter-spacing: 0.15em; text-transform: uppercase; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }

  .interp { font-size: 11px; color: var(--text3); line-height: 1.9; }
  .interp div { padding: 2px 0; }

  @media(max-width: 520px) {
    .grid3 { grid-template-columns: 1fr 1fr; }
    .fer-big { font-size: 22px; }
    .tab { padding: 10px 12px; font-size: 10px; }
  }
`

export default function App() {
  const [tab, setTab] = useState('calc')
  const [bets, setBets] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Calculator inputs
  const [xgH, setXgH] = useState('')
  const [xgA, setXgA] = useState('')
  const [xgaH, setXgaH] = useState('')
  const [xgaA, setXgaA] = useState('')
  const [market, setMarket] = useState('over2.5')
  const [oddsOpen, setOddsOpen] = useState('')
  const [oddsClose, setOddsClose] = useState('')
  const [stake, setStake] = useState('10')
  const [matchName, setMatchName] = useState('')
  const [calc, setCalc] = useState(null)

  // Settle state
  const [settlingId, setSettlingId] = useState(null)
  const [settleResult, setSettleResult] = useState('')
  const [settleClose, setSettleClose] = useState('')

  // Load bets from Supabase
  useEffect(() => {
    loadBets()
  }, [])

  async function loadBets() {
    setLoading(true)
    const { data, error } = await supabase
      .from('bets')
      .select('*')
      .order('created_at', { ascending: false })
    if (!error) setBets(data || [])
    setLoading(false)
  }

  // Calculate
  const handleCalc = useCallback(() => {
    const h = parseFloat(xgH)
    const a = parseFloat(xgA)
    if (isNaN(h) || h <= 0 || isNaN(a) || a <= 0) return

    const ha = parseFloat(xgaH)
    const aa = parseFloat(xgaA)

    let lambdaH = h
    let lambdaA = a

    // Use geometric mean blending if xGA values provided
    if (!isNaN(ha) && ha > 0 && !isNaN(aa) && aa > 0) {
      lambdaH = blendLambda(h, aa)
      lambdaA = blendLambda(a, ha)
    }

    const { pOver, pUnder } = calcOverUnder(lambdaH, lambdaA)
    const ferOver = fairOdds(pOver)
    const ferUnder = fairOdds(pUnder)

    const selProb = market === 'over2.5' ? pOver : pUnder
    const ferSel = market === 'over2.5' ? ferOver : ferUnder

    const oo = parseFloat(oddsOpen)
    const oc = parseFloat(oddsClose)
    const st = parseFloat(stake) || 10

    const ev = !isNaN(oo) && oo > 1 ? calcEV(selProb, oo) : null
    const clv = (!isNaN(oo) && oo > 1 && !isNaN(oc) && oc > 1) ? calcCLV(oo, oc) : null
    const edgePct = (!isNaN(oo) && ferSel) ? (oo / ferSel - 1) * 100 : null

    setCalc({ lambdaH, lambdaA, pOver, pUnder, ferOver, ferUnder, selProb, ferSel, oo: isNaN(oo) ? null : oo, oc: isNaN(oc) ? null : oc, ev, evPct: ev != null ? ev * 100 : null, clv, edgePct, stake: st, market, matchName: matchName.trim() || null })
  }, [xgH, xgA, xgaH, xgaA, market, oddsOpen, oddsClose, stake, matchName])

  // Save bet
  const handleSave = async () => {
    if (!calc) return
    setSaving(true)
    const row = {
      match_name: calc.matchName,
      market: calc.market,
      lambda_h: calc.lambdaH,
      lambda_a: calc.lambdaA,
      p_over: calc.pOver,
      p_under: calc.pUnder,
      sel_prob: calc.selProb,
      fer_odds: calc.ferSel,
      odds_open: calc.oo,
      odds_close: calc.oc,
      stake: calc.stake,
      ev: calc.ev,
      ev_pct: calc.evPct,
      clv: calc.clv,
      result: null,
      pnl: null,
      brier: null,
      log_loss: null,
    }
    const { error } = await supabase.from('bets').insert(row)
    if (!error) await loadBets()
    setSaving(false)
  }

  // Settle bet
  const handleSettle = async (id) => {
    const res = parseInt(settleResult)
    if (res !== 0 && res !== 1) return
    const bet = bets.find(b => b.id === id)
    if (!bet) return

    const oc = parseFloat(settleClose)
    const oddsUsed = bet.odds_open
    const pnl = res === 1 ? bet.stake * (oddsUsed - 1) : -bet.stake
    const clvFinal = (!isNaN(oc) && oc > 1) ? calcCLV(oddsUsed, oc) : bet.clv

    await supabase.from('bets').update({
      result: res,
      odds_close: (!isNaN(oc) && oc > 1) ? oc : bet.odds_close,
      clv: clvFinal,
      pnl,
      brier: brierScore(bet.sel_prob, res),
      log_loss: logLoss(bet.sel_prob, res),
    }).eq('id', id)

    setSettlingId(null)
    setSettleResult('')
    setSettleClose('')
    await loadBets()
  }

  // Delete bet
  const handleDelete = async (id) => {
    await supabase.from('bets').delete().eq('id', id)
    await loadBets()
  }

  // Stats
  const settled = bets.filter(b => b.result != null)
  const pending = bets.filter(b => b.result == null)
  const totalStake = settled.reduce((s, b) => s + b.stake, 0)
  const totalPnL = settled.reduce((s, b) => s + (b.pnl || 0), 0)
  const roi = totalStake > 0 ? (totalPnL / totalStake) * 100 : null
  const wins = settled.filter(b => b.result === 1).length
  const hitRate = settled.length > 0 ? wins / settled.length : null
  const avgProb = settled.length > 0 ? settled.reduce((s, b) => s + b.sel_prob, 0) / settled.length : null
  const avgBrier = settled.length > 0 ? settled.reduce((s, b) => s + (b.brier || 0), 0) / settled.length : null
  const avgLogLoss = settled.length > 0 ? settled.reduce((s, b) => s + (b.log_loss || 0), 0) / settled.length : null
  const clvBets = settled.filter(b => b.clv != null)
  const avgCLV = clvBets.length > 0 ? clvBets.reduce((s, b) => s + b.clv, 0) / clvBets.length : null
  const posCLV = clvBets.length > 0 ? (clvBets.filter(b => b.clv > 0).length / clvBets.length) * 100 : null
  const evBets = settled.filter(b => b.ev_pct != null)
  const avgEV = evBets.length > 0 ? evBets.reduce((s, b) => s + b.ev_pct, 0) / evBets.length : null
  const maxDD = calcMaxDrawdown(settled)
  const calibration = hitRate != null && avgProb != null ? (hitRate - avgProb) * 100 : null

  const MARKET = { 'over2.5': 'Over 2.5', 'under2.5': 'Under 2.5' }

  return (
    <>
      <style>{css}</style>

      {/* Header */}
      <div className="header">
        <div className="dot" />
        <span className="logo">xG CALC</span>
        <span style={{ color: 'var(--border2)', fontSize: 12 }}>|</span>
        <span style={{ color: 'var(--text3)', fontSize: 11, letterSpacing: '0.1em' }}>O/U 2.5</span>
        <div className="meta">
          {bets.length} betov {pending.length > 0 && <span style={{ color: 'var(--yellow)' }}>• {pending.length} čaká</span>}
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {[['calc', 'Kalkulačka'], ['history', `História (${bets.length})`], ['stats', 'Štatistiky']].map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      <div className="wrap">

        {/* ══ KALKULAČKA ══ */}
        {tab === 'calc' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="card">
              <div className="label">Zápas (voliteľné)</div>
              <input className="inp" placeholder="napr. Arsenal vs Chelsea" value={matchName} onChange={e => setMatchName(e.target.value)} />
            </div>

            <div className="card">
              <div className="label" style={{ marginBottom: 12 }}>xG hodnoty</div>
              <div className="grid2" style={{ marginBottom: 10 }}>
                <div>
                  <div className="label">xG Home</div>
                  <input className="inp" type="number" step="0.01" min="0" placeholder="1.45" value={xgH} onChange={e => setXgH(e.target.value)} />
                </div>
                <div>
                  <div className="label">xG Away</div>
                  <input className="inp" type="number" step="0.01" min="0" placeholder="0.98" value={xgA} onChange={e => setXgA(e.target.value)} />
                </div>
              </div>
              <div className="grid2">
                <div>
                  <div className="label">xGA Home <span style={{ color: 'var(--text3)' }}>(opt)</span></div>
                  <input className="inp" type="number" step="0.01" min="0" placeholder="1.20" value={xgaH} onChange={e => setXgaH(e.target.value)} />
                </div>
                <div>
                  <div className="label">xGA Away <span style={{ color: 'var(--text3)' }}>(opt)</span></div>
                  <input className="inp" type="number" step="0.01" min="0" placeholder="1.10" value={xgaA} onChange={e => setXgaA(e.target.value)} />
                </div>
              </div>
              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 8 }}>
                Ak zadáš xGA, λ sa vypočíta ako geometrický priemer: √(xG · xGA_súpera)
              </div>
            </div>

            <div className="card">
              <div className="label" style={{ marginBottom: 12 }}>Market a kurzy</div>
              <div className="grid2" style={{ marginBottom: 10 }}>
                <div>
                  <div className="label">Market</div>
                  <select className="inp" value={market} onChange={e => setMarket(e.target.value)}>
                    <option value="over2.5">Over 2.5</option>
                    <option value="under2.5">Under 2.5</option>
                  </select>
                </div>
                <div>
                  <div className="label">Stake (€)</div>
                  <input className="inp" type="number" step="1" min="1" placeholder="10" value={stake} onChange={e => setStake(e.target.value)} />
                </div>
              </div>
              <div className="grid2">
                <div>
                  <div className="label">Kurz (open)</div>
                  <input className="inp" type="number" step="0.01" min="1.01" placeholder="1.85" value={oddsOpen} onChange={e => setOddsOpen(e.target.value)} />
                </div>
                <div>
                  <div className="label">Closing kurz <span style={{ color: 'var(--text3)' }}>(opt)</span></div>
                  <input className="inp" type="number" step="0.01" min="1.01" placeholder="1.72" value={oddsClose} onChange={e => setOddsClose(e.target.value)} />
                </div>
              </div>
            </div>

            <button className="btn btn-primary" onClick={handleCalc}>▶ Vypočítať</button>

            {/* Results */}
            {calc && (
              <>
                {/* FER */}
                <div className="fer-display">
                  <div>
                    <div className="label">FER Over 2.5</div>
                    <div className="fer-big" style={{ color: calc.market === 'over2.5' ? 'var(--accent2)' : 'var(--text3)' }}>
                      {fmt3(calc.ferOver)}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>{fmtPct(calc.pOver * 100)}</div>
                  </div>
                  <div className="fer-divider" />
                  <div>
                    <div className="label">FER Under 2.5</div>
                    <div className="fer-big" style={{ color: calc.market === 'under2.5' ? 'var(--accent2)' : 'var(--text3)' }}>
                      {fmt3(calc.ferUnder)}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>{fmtPct(calc.pUnder * 100)}</div>
                  </div>
                </div>

                {/* Lambda */}
                <div className="lambda-row">
                  <span>λ Home: <b>{fmt2(calc.lambdaH)}</b></span>
                  <span>λ Away: <b>{fmt2(calc.lambdaA)}</b></span>
                  <span>λ Suma: <b>{fmt2(calc.lambdaH + calc.lambdaA)}</b></span>
                </div>

                {/* Edge */}
                {calc.oo && (
                  <div className="card">
                    <div className="label" style={{ marginBottom: 12 }}>Edge analýza — {MARKET[calc.market]}</div>
                    <div className="grid3">
                      {[
                        { l: 'Kurz trhu', v: fmt3(calc.oo), cls: '' },
                        { l: 'FER kurz', v: fmt3(calc.ferSel), cls: 'pos' },
                        { l: 'Edge vs FER', v: fmtSignPct(calc.edgePct), cls: calc.edgePct > 0 ? 'pos' : 'neg' },
                        { l: 'EV', v: fmtSignPct(calc.evPct), cls: calc.evPct > 0 ? 'pos' : 'neg' },
                        { l: `EV (${calc.stake}€)`, v: calc.ev != null ? fmtSign(calc.ev * calc.stake) + '€' : '—', cls: calc.ev > 0 ? 'pos' : 'neg' },
                        calc.clv != null ? { l: 'CLV%', v: fmtSignPct(calc.clv), cls: calc.clv > 0 ? 'pos' : 'neg' } : { l: 'CLV%', v: '—', cls: '' },
                      ].map(({ l, v, cls }) => (
                        <div key={l}>
                          <div className="label">{l}</div>
                          <div className={`stat-val ${cls}`} style={{ fontSize: 16 }}>{v}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <button className="btn btn-save" onClick={handleSave} disabled={saving}>
                  {saving ? 'Ukladám...' : '+ Uložiť bet do histórie'}
                </button>
              </>
            )}
          </div>
        )}

        {/* ══ HISTÓRIA ══ */}
        {tab === 'history' && (
          <div>
            {loading && <div className="loading">Načítavam...</div>}
            {!loading && bets.length === 0 && (
              <div className="empty">Žiadne bety.<br />Vypočítaj a ulož prvý bet na kalkulačke.</div>
            )}
            {bets.map(b => (
              <div key={b.id} className="bet-row">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 7 }}>
                      {b.result == null && <span className="badge badge-pending">PENDING</span>}
                      {b.result === 1 && <span className="badge badge-won">WON</span>}
                      {b.result === 0 && <span className="badge badge-lost">LOST</span>}
                      <span style={{ fontSize: 12, color: 'var(--text)', fontWeight: 600 }}>{MARKET[b.market]}</span>
                      {b.match_name && <span style={{ fontSize: 11, color: 'var(--text3)' }}>{b.match_name}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, color: 'var(--text3)' }}>
                      <span>P: <span style={{ color: 'var(--text2)' }}>{fmtPct(b.sel_prob * 100)}</span></span>
                      <span>FER: <span style={{ color: 'var(--accent2)' }}>{fmt3(b.fer_odds)}</span></span>
                      {b.odds_open && <span>Kurz: <span style={{ color: 'var(--text2)' }}>{fmt3(b.odds_open)}</span></span>}
                      <span>Stake: <span style={{ color: 'var(--text2)' }}>{b.stake}€</span></span>
                      {b.ev_pct != null && <span>EV: <span className={b.ev_pct > 0 ? 'pos' : 'neg'}>{fmtSignPct(b.ev_pct)}</span></span>}
                      {b.clv != null && <span>CLV: <span className={b.clv > 0 ? 'pos' : 'neg'}>{fmtSignPct(b.clv)}</span></span>}
                      {b.pnl != null && <span>PnL: <span className={b.pnl > 0 ? 'pos' : 'neg'}>{fmtSign(b.pnl)}€</span></span>}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 5 }}>
                      {new Date(b.created_at).toLocaleDateString('sk')} {new Date(b.created_at).toLocaleTimeString('sk', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {b.result == null && (
                      <button className="btn-ghost" onClick={() => { setSettlingId(settlingId === b.id ? null : b.id); setSettleResult(''); setSettleClose('') }}>
                        Settle
                      </button>
                    )}
                    <button className="btn-danger" onClick={() => handleDelete(b.id)}>✕</button>
                  </div>
                </div>

                {settlingId === b.id && (
                  <div className="settle-box">
                    <div className="grid2" style={{ marginBottom: 10 }}>
                      <div>
                        <div className="label">Výsledok</div>
                        <select className="inp" value={settleResult} onChange={e => setSettleResult(e.target.value)}>
                          <option value="">— vyber —</option>
                          <option value="1">✅ Won</option>
                          <option value="0">❌ Lost</option>
                        </select>
                      </div>
                      <div>
                        <div className="label">Closing kurz <span style={{ color: 'var(--text3)' }}>(opt)</span></div>
                        <input className="inp" type="number" step="0.01" placeholder="1.72" value={settleClose} onChange={e => setSettleClose(e.target.value)} />
                      </div>
                    </div>
                    <button className="btn btn-primary" style={{ fontSize: 11, padding: '10px' }} onClick={() => handleSettle(b.id)}>
                      Potvrdiť výsledok
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ══ ŠTATISTIKY ══ */}
        {tab === 'stats' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {settled.length === 0 ? (
              <div className="empty">Žiadne uzavreté bety.<br />Settle aspoň jeden bet v histórii.</div>
            ) : (
              <>
                {/* Finance */}
                <div>
                  <div className="section-title">💰 Finance</div>
                  <div className="grid3">
                    {[
                      { l: 'Total Bets', v: settled.length, cls: '' },
                      { l: 'PnL (€)', v: fmtSign(totalPnL) + '€', cls: totalPnL >= 0 ? 'pos' : 'neg' },
                      { l: 'ROI / Yield', v: fmtSignPct(roi), cls: roi >= 0 ? 'pos' : 'neg' },
                      { l: 'Total Stake', v: totalStake + '€', cls: '' },
                      { l: 'Max Drawdown', v: fmt2(maxDD) + '€', cls: 'neg' },
                      { l: 'Výhry / Prehry', v: `${wins} / ${settled.length - wins}`, cls: '' },
                    ].map(({ l, v, cls }) => (
                      <div key={l} className="card" style={{ padding: 14 }}>
                        <div className="label">{l}</div>
                        <div className={`stat-val ${cls}`}>{v}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Market Edge */}
                <div>
                  <div className="section-title">📈 Market Edge</div>
                  <div className="grid3">
                    {[
                      { l: 'Avg CLV%', v: fmtSignPct(avgCLV), cls: avgCLV > 0 ? 'pos' : avgCLV < 0 ? 'neg' : '', hint: '> 0 = porážaš trh' },
                      { l: 'Positive CLV', v: fmtPct(posCLV), cls: posCLV > 50 ? 'pos' : 'neg', hint: '> 50% = dobré' },
                      { l: 'Avg EV%', v: fmtSignPct(avgEV), cls: avgEV > 0 ? 'pos' : 'neg', hint: 'pred výsledkom' },
                      { l: 'Hit Rate', v: fmtPct(hitRate * 100), cls: '', hint: 'skutočná %' },
                      { l: 'Avg Prob', v: fmtPct(avgProb * 100), cls: '', hint: 'model predpovedal' },
                      { l: 'Kalibrácia', v: calibration != null ? fmtSign(calibration) + 'pp' : '—', cls: Math.abs(calibration) < 5 ? 'pos' : 'neu', hint: 'blízko 0 = presný model' },
                    ].map(({ l, v, cls, hint }) => (
                      <div key={l} className="card" style={{ padding: 14 }}>
                        <div className="label">{l}</div>
                        <div className={`stat-val ${cls}`}>{v}</div>
                        <div className="hint">{hint}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Model */}
                <div>
                  <div className="section-title">🧠 Model</div>
                  <div className="grid3">
                    {[
                      { l: 'Brier Score', v: fmt2(avgBrier), hint: '< 0.25 = dobré' },
                      { l: 'Log Loss', v: fmt2(avgLogLoss), hint: 'nižšie = lepšie' },
                      { l: 'Vzorka', v: settled.length, hint: settled.length < 100 ? '⚠ potrebuješ 100+' : '✓ dostatočná' },
                    ].map(({ l, v, hint }) => (
                      <div key={l} className="card" style={{ padding: 14 }}>
                        <div className="label">{l}</div>
                        <div className="stat-val">{v}</div>
                        <div className="hint">{hint}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* PnL Timeline */}
                <div className="card">
                  <div className="label" style={{ marginBottom: 12 }}>PnL timeline</div>
                  <div className="pnl-bar-wrap">
                    {(() => {
                      let running = 0
                      const pts = [...settled].reverse().map(b => { running += b.pnl || 0; return running })
                      const min = Math.min(0, ...pts), max = Math.max(0.01, ...pts)
                      const range = max - min
                      return pts.map((p, i) => (
                        <div key={i} className="pnl-bar" title={fmtSign(p) + '€'} style={{ height: Math.max(3, ((p - min) / range) * 53) + 'px', background: p >= 0 ? 'var(--green)' : 'var(--red)', opacity: 0.8 }} />
                      ))
                    })()}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text3)', marginTop: 6 }}>
                    <span>prvý bet</span>
                    <span className={totalPnL >= 0 ? 'pos' : 'neg'}>{fmtSign(totalPnL)}€ celkom</span>
                    <span>posledný</span>
                  </div>
                </div>

                {/* Interpretácia */}
                <div className="card">
                  <div className="label" style={{ marginBottom: 10 }}>Interpretácia</div>
                  <div className="interp">
                    {avgCLV > 1 && <div className="pos">✓ Priemerný CLV +{fmt2(avgCLV)}% — model porážal trh</div>}
                    {avgCLV != null && avgCLV < -1 && <div className="neg">✗ Záporný CLV ({fmtSignPct(avgCLV)}) — trh bol lepší ako model</div>}
                    {avgCLV != null && Math.abs(avgCLV) <= 1 && <div className="neu">~ CLV blízko nuly — zatiaľ neutrálny edge</div>}
                    {calibration != null && Math.abs(calibration) < 5 && <div className="pos">✓ Model dobre kalibrovaný (hit rate ≈ avg prob)</div>}
                    {calibration != null && calibration > 5 && <div className="neu">~ Model podceňuje pravdepodobnosti (+{fmt2(calibration)}pp)</div>}
                    {calibration != null && calibration < -5 && <div className="neu">~ Model preceňuje pravdepodobnosti ({fmt2(calibration)}pp)</div>}
                    {avgCLV != null && avgEV != null && avgEV > avgCLV + 5 && <div className="neg">⚠ EV oveľa vyššie ako CLV — model môže byť príliš optimistický</div>}
                    {settled.length < 50 && <div style={{ color: 'var(--text3)' }}>⚠ Malá vzorka ({settled.length} betov) — štatistiky nie sú spoľahlivé</div>}
                    {settled.length >= 100 && roi > 0 && avgCLV > 0 && <div className="pos">✓ Pozitívny ROI aj CLV pri {settled.length} betoch — silný signál edge</div>}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  )
}

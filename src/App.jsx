import { useState, useEffect } from 'react'
import { supabase } from './supabase'
import {
  calcOverUnder, blendLambda, fairOdds, calcCLV,
  brierScore, logLoss, calcMaxDrawdown,
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
  .btn { cursor: pointer; border: none; font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; padding: 12px 20px; border-radius: 6px; transition: all 0.2s; width: 100%; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { background: #7d6ff0; }
  .btn-save-over { background: rgba(108,92,231,0.15); color: var(--accent2); border: 1px solid rgba(108,92,231,0.3); }
  .btn-save-under { background: rgba(0,184,148,0.12); color: var(--green); border: 1px solid rgba(0,184,148,0.3); }
  .btn-ghost { cursor: pointer; background: transparent; border: 1px solid var(--border2); color: var(--text2); font-family: var(--mono); font-size: 11px; padding: 6px 12px; border-radius: 4px; }
  .btn-danger { cursor: pointer; background: transparent; border: 1px solid rgba(214,48,49,0.2); color: var(--red); font-family: var(--mono); font-size: 11px; padding: 6px 10px; border-radius: 4px; }
  .pos { color: var(--green); }
  .neg { color: var(--red); }
  .neu { color: var(--yellow); }

  /* Market columns */
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
  .edge-row { font-size: 11px; color: var(--text3); margin-top: 3px; }
  .ev-eur { font-size: 11px; color: var(--text3); margin-left: 5px; }
  .liability-note { font-size: 10px; color: var(--red); margin-top: 4px; }

  .bet-row { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin-bottom: 8px; }
  .badge { display: inline-block; font-size: 10px; padding: 2px 8px; border-radius: 3px; letter-spacing: 0.05em; font-weight: 600; }
  .badge-pending { background: rgba(253,203,110,0.15); color: var(--yellow); }
  .badge-won { background: rgba(0,184,148,0.15); color: var(--green); }
  .badge-lost { background: rgba(214,48,49,0.15); color: var(--red); }
  .badge-back { background: rgba(108,92,231,0.15); color: var(--accent2); }
  .badge-lay { background: rgba(214,48,49,0.12); color: var(--red); }
  .settle-box { background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-top: 10px; }
  .stat-val { font-size: 20px; font-weight: 700; margin-top: 2px; }
  .hint { font-size: 10px; color: var(--text3); margin-top: 3px; }
  .section-title { font-size: 10px; color: var(--text3); letter-spacing: 0.15em; text-transform: uppercase; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
  .pnl-bar-wrap { display: flex; align-items: flex-end; gap: 3px; height: 56px; }
  .pnl-bar { flex: 1; min-width: 3px; border-radius: 2px 2px 0 0; }
  .loading { text-align: center; padding: 60px 20px; color: var(--text3); }
  .empty { text-align: center; padding: 60px 20px; color: var(--text3); line-height: 1.8; }
  .lambda-row { display: flex; gap: 16px; font-size: 12px; color: var(--text3); padding: 10px 14px; background: var(--bg3); border-radius: 6px; flex-wrap: wrap; margin-top: 10px; }
  .lambda-row span b { color: var(--text2); }
  .interp { font-size: 11px; color: var(--text3); line-height: 2; }
  .save-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
  @media(max-width:520px){ .markets-grid{grid-template-columns:1fr;} .grid3{grid-template-columns:1fr 1fr;} .tab{padding:10px 8px;font-size:10px;} }
`

export default function App() {
  const [tab, setTab] = useState('calc')
  const [bets, setBets] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // xG inputs
  const [xgH, setXgH] = useState('')
  const [xgA, setXgA] = useState('')
  const [xgaH, setXgaH] = useState('')
  const [xgaA, setXgaA] = useState('')

  // Exchange kurzy — Over
  const [backOver, setBackOver] = useState('')
  const [layOver, setLayOver] = useState('')
  // Exchange kurzy — Under
  const [backUnder, setBackUnder] = useState('')
  const [layUnder, setLayUnder] = useState('')

  const [oddsClose, setOddsClose] = useState('')
  const [stake, setStake] = useState('10')
  const [commission, setCommission] = useState('5')
  const [matchName, setMatchName] = useState('')
  const [calc, setCalc] = useState(null)
  const [savedMarket, setSavedMarket] = useState(null)
  const [settlingId, setSettlingId] = useState(null)
  const [settleResult, setSettleResult] = useState('')
  const [settleClose, setSettleClose] = useState('')

  useEffect(() => { loadBets() }, [])

  async function loadBets() {
    setLoading(true)
    const { data, error } = await supabase.from('bets').select('*').order('created_at', { ascending: false })
    if (!error) setBets(data || [])
    setLoading(false)
  }

  function handleCalc() {
    const h = parseFloat(xgH), a = parseFloat(xgA)
    if (isNaN(h) || h <= 0 || isNaN(a) || a <= 0) return
    const ha = parseFloat(xgaH), aa = parseFloat(xgaA)
    let lH = h, lA = a
    if (!isNaN(ha) && ha > 0 && !isNaN(aa) && aa > 0) {
      lH = blendLambda(h, aa); lA = blendLambda(a, ha)
    }
    const { pOver, pUnder } = calcOverUnder(lH, lA)
    const ferOver = fairOdds(pOver)
    const ferUnder = fairOdds(pUnder)
    const comm = parseFloat(commission) / 100 || 0.05
    const st = parseFloat(stake) || 10
    const oc = parseFloat(oddsClose)

    const bo = parseFloat(backOver) || null
    const lo = parseFloat(layOver) || null
    const bu = parseFloat(backUnder) || null
    const lu = parseFloat(layUnder) || null

    const midO = midPrice(bo, lo)
    const midU = midPrice(bu, lu)

    // Back EV uses mid as "your odds"
    const evOBack = midO ? calcBackEV(pOver, midO, comm) : null
    const evUBack = midU ? calcBackEV(pUnder, midU, comm) : null
    // Lay EV uses mid as lay odds
    const evOLay = midO ? calcLayEV(pOver, midO, comm) : null
    const evULay = midU ? calcLayEV(pUnder, midU, comm) : null

    setSavedMarket(null)
    setCalc({
      lH, lA, pOver, pUnder, ferOver, ferUnder,
      midO, midU, bo, lo, bu, lu,
      evOBack, evUBack, evOLay, evULay,
      comm, st, matchName: matchName.trim() || null,
      oc: isNaN(oc) ? null : oc,
    })
  }

  async function handleSave(market, betType) {
    if (!calc) return
    setSaving(true)
    const isOver = market === 'over2.5'
    const selProb = isOver ? calc.pOver : calc.pUnder
    const ferO = isOver ? calc.ferOver : calc.ferUnder
    const midOdds = isOver ? calc.midO : calc.midU
    let ev
    if (betType === 'back') ev = isOver ? calc.evOBack : calc.evUBack
    else ev = isOver ? calc.evOLay : calc.evULay
    const clv = calc.oc && midOdds ? calcCLV(midOdds, calc.oc) : null

    await supabase.from('bets').insert({
      match_name: calc.matchName, market, bet_type: betType,
      lambda_h: calc.lH, lambda_a: calc.lA,
      p_over: calc.pOver, p_under: calc.pUnder,
      sel_prob: selProb, fer_odds: ferO,
      odds_open: midOdds, odds_close: calc.oc,
      stake: calc.st, commission: calc.comm * 100,
      ev, ev_pct: ev != null ? ev * 100 : null,
      clv, result: null, pnl: null, brier: null, log_loss: null,
    })
    await loadBets()
    setSavedMarket(market + '-' + betType)
    setSaving(false)
  }

  async function handleSettle(id) {
    const res = parseInt(settleResult)
    if (res !== 0 && res !== 1) return
    const bet = bets.find(b => b.id === id)
    if (!bet) return
    const oc = parseFloat(settleClose)
    const odds = bet.odds_open
    const comm = (bet.commission || 5) / 100
    let pnl
    if (bet.bet_type === 'lay') {
      pnl = res === 0 ? bet.stake * (1 - comm) : -bet.stake * (odds - 1)
    } else {
      pnl = res === 1 ? bet.stake * (odds - 1) * (1 - comm) : -bet.stake
    }
    const clvFinal = (!isNaN(oc) && oc > 1) ? calcCLV(odds, oc) : bet.clv
    await supabase.from('bets').update({
      result: res,
      odds_close: (!isNaN(oc) && oc > 1) ? oc : bet.odds_close,
      clv: clvFinal, pnl,
      brier: brierScore(bet.sel_prob, res),
      log_loss: logLoss(bet.sel_prob, res),
    }).eq('id', id)
    setSettlingId(null); setSettleResult(''); setSettleClose('')
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

  function MarketCol({ isOver }) {
    const label = isOver ? 'Over 2.5' : 'Under 2.5'
    const fer = isOver ? calc?.ferOver : calc?.ferUnder
    const prob = isOver ? calc?.pOver : calc?.pUnder
    const mid = isOver ? calc?.midO : calc?.midU
    const evBack = isOver ? calc?.evOBack : calc?.evUBack
    const evLay = isOver ? calc?.evOLay : calc?.evULay
    const st = calc?.st || 10
    const comm = calc?.comm || 0.05
    const backVal = isOver ? backOver : backUnder
    const setBack = isOver ? setBackOver : setBackUnder
    const layVal = isOver ? layOver : layUnder
    const setLay = isOver ? setLayOver : setLayUnder
    const colClass = isOver ? 'market-col-over' : 'market-col-under'
    const titleClass = isOver ? 'market-title-over' : 'market-title-under'
    const ferClass = isOver ? 'fer-num-over' : 'fer-num-under'
    const mkt = isOver ? 'over2.5' : 'under2.5'

    const edge = mid && fer ? (mid / fer - 1) * 100 : null
    const liability = mid ? layLiability(mid, st) : null

    return (
      <div className={`market-col ${colClass}`}>
        <div className={`market-title ${titleClass}`}>{label}</div>

        {fer && <div style={{ marginBottom: 10 }}>
          <div className="label">FER kurz</div>
          <div className={`fer-num ${ferClass}`}>{fmt3(fer)} <span style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 400 }}>({fmtPct(prob * 100)})</span></div>
        </div>}

        <div style={{ marginBottom: 8 }}>
          <div className="label">Best Back</div>
          <input className="inp inp-sm" type="number" step="0.01" min="1.01" placeholder="1.85" value={backVal} onChange={e => setBack(e.target.value)} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <div className="label">Best Lay</div>
          <input className="inp inp-sm" type="number" step="0.01" min="1.01" placeholder="1.88" value={layVal} onChange={e => setLay(e.target.value)} />
        </div>

        {mid && <>
          <div className="mid-row">
            <span style={{ color: 'var(--text3)' }}>Mid:</span>
            <span className="mid-val">{fmt3(mid)}</span>
            {edge != null && <span className={edge > 0 ? 'pos' : 'neg'} style={{ marginLeft: 'auto', fontSize: 11 }}>Edge {fmtSignPct(edge)}</span>}
          </div>

          {evBack != null && <div>
            <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 2 }}>▲ Back EV</div>
            <div className={`ev-big ${evBack > 0 ? 'pos' : 'neg'}`}>
              {fmtSignPct(evBack * 100)}
              <span className="ev-eur">{fmtSign(evBack * st)}€</span>
            </div>
          </div>}
          {evLay != null && <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 2 }}>▼ Lay EV</div>
            <div className={`ev-big ${evLay > 0 ? 'pos' : 'neg'}`}>
              {fmtSignPct(evLay * 100)}
              <span className="ev-eur">{fmtSign(evLay * st)}€</span>
            </div>
            {liability && <div className="liability-note">Liability: {fmt2(liability)}€</div>}
          </div>}

          <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
            <button className="btn btn-save-over" style={{ flex: 1, padding: '8px', fontSize: 10 }}
              onClick={() => handleSave(mkt, 'back')} disabled={saving}>
              {savedMarket === mkt + '-back' ? '✓' : '+ Back'}
            </button>
            <button className="btn btn-save-under" style={{ flex: 1, padding: '8px', fontSize: 10 }}
              onClick={() => handleSave(mkt, 'lay')} disabled={saving}>
              {savedMarket === mkt + '-lay' ? '✓' : '+ Lay'}
            </button>
          </div>
          <div style={{ fontSize: 9, color: 'var(--text3)', textAlign: 'center', marginTop: 4 }}>kom {(comm * 100).toFixed(0)}%</div>
        </>}

        {!mid && calc && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8 }}>
          Zadaj Back aj Lay kurz pre mid price
        </div>}
      </div>
    )
  }

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

            <div className="card">
              <div className="label">Zápas (voliteľné)</div>
              <input className="inp" placeholder="napr. Arsenal vs Chelsea" value={matchName} onChange={e => setMatchName(e.target.value)} />
            </div>

            <div className="card">
              <div className="label" style={{ marginBottom: 10 }}>xG hodnoty</div>
              <div className="grid2">
                <div><div className="label">xG Home</div><input className="inp" type="number" step="0.01" min="0" placeholder="1.45" value={xgH} onChange={e => setXgH(e.target.value)} /></div>
                <div><div className="label">xG Away</div><input className="inp" type="number" step="0.01" min="0" placeholder="0.98" value={xgA} onChange={e => setXgA(e.target.value)} /></div>
                <div><div className="label">xGA Home <span style={{ color: 'var(--text3)' }}>(opt)</span></div><input className="inp" type="number" step="0.01" min="0" placeholder="1.20" value={xgaH} onChange={e => setXgaH(e.target.value)} /></div>
                <div><div className="label">xGA Away <span style={{ color: 'var(--text3)' }}>(opt)</span></div><input className="inp" type="number" step="0.01" min="0" placeholder="1.10" value={xgaA} onChange={e => setXgaA(e.target.value)} /></div>
              </div>
            </div>

            <div className="card">
              <div className="grid3">
                <div><div className="label">Stake (€)</div><input className="inp" type="number" step="1" min="1" placeholder="10" value={stake} onChange={e => setStake(e.target.value)} /></div>
                <div><div className="label">Komisia (%)</div><input className="inp" type="number" step="0.5" min="0" max="15" placeholder="5" value={commission} onChange={e => setCommission(e.target.value)} /></div>
                <div><div className="label">Closing kurz <span style={{ color: 'var(--text3)' }}>(opt)</span></div><input className="inp" type="number" step="0.01" placeholder="1.82" value={oddsClose} onChange={e => setOddsClose(e.target.value)} /></div>
              </div>
            </div>

            <button className="btn btn-primary" onClick={handleCalc}>▶ Vypočítať</button>

            {calc && <>
              <div className="lambda-row">
                <span>λ Home: <b>{fmt2(calc.lH)}</b></span>
                <span>λ Away: <b>{fmt2(calc.lA)}</b></span>
                <span>λ Suma: <b>{fmt2(calc.lH + calc.lA)}</b></span>
              </div>

              <div className="markets-grid">
                <MarketCol isOver={true} />
                <MarketCol isOver={false} />
              </div>
            </>}
          </div>
        )}

        {tab === 'history' && (
          <div>
            {loading && <div className="loading">Načítavam...</div>}
            {!loading && bets.length === 0 && <div className="empty">Žiadne bety.<br />Vypočítaj a ulož prvý bet.</div>}
            {bets.map(b => (
              <div key={b.id} className="bet-row">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                      {b.result == null && <span className="badge badge-pending">PENDING</span>}
                      {b.result === 1 && <span className="badge badge-won">WON</span>}
                      {b.result === 0 && <span className="badge badge-lost">LOST</span>}
                      <span className={`badge ${b.bet_type === 'lay' ? 'badge-lay' : 'badge-back'}`}>{b.bet_type === 'lay' ? '▼ LAY' : '▲ BACK'}</span>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>{MARKET[b.market]}</span>
                      {b.match_name && <span style={{ fontSize: 11, color: 'var(--text3)' }}>{b.match_name}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: 'var(--text3)' }}>
                      <span>P: <b style={{ color: 'var(--text2)' }}>{fmtPct(b.sel_prob * 100)}</b></span>
                      <span>FER: <b style={{ color: 'var(--accent2)' }}>{fmt3(b.fer_odds)}</b></span>
                      {b.odds_open && <span>Mid: <b style={{ color: 'var(--text2)' }}>{fmt3(b.odds_open)}</b></span>}
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
                    {b.result == null && <button className="btn-ghost" onClick={() => { setSettlingId(settlingId === b.id ? null : b.id); setSettleResult(''); setSettleClose('') }}>Settle</button>}
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
                          <option value="1">{b.bet_type === 'lay' ? '✅ Lay Won (event NOT happened)' : '✅ Back Won'}</option>
                          <option value="0">{b.bet_type === 'lay' ? '❌ Lay Lost (event happened)' : '❌ Back Lost'}</option>
                        </select>
                      </div>
                      <div>
                        <div className="label">Closing kurz <span style={{ color: 'var(--text3)' }}>(opt)</span></div>
                        <input className="inp" type="number" step="0.01" placeholder="1.82" value={settleClose} onChange={e => setSettleClose(e.target.value)} />
                      </div>
                    </div>
                    <button className="btn btn-primary" style={{ padding: '10px' }} onClick={() => handleSettle(b.id)}>Potvrdiť výsledok</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === 'stats' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {settled.length === 0 ? (
              <div className="empty">Žiadne uzavreté bety.<br />Settle aspoň jeden bet.</div>
            ) : (<>
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
                <div className="section-title">📈 Market Edge</div>
                <div className="grid3">
                  {[
                    { l: 'Avg CLV%', v: fmtSignPct(avgCLV), cls: avgCLV > 0 ? 'pos' : avgCLV < 0 ? 'neg' : '', hint: '> 0 = porážaš trh' },
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
                  <span className={totalPnL >= 0 ? 'pos' : 'neg'}>{fmtSign(totalPnL)}€ celkom</span>
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

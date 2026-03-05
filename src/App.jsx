import { useState, useEffect, useCallback } from 'react'
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
  if (!odds || !stake) return null
  return stake * (odds - 1)
}

const css = `
  .wrap { max-width: 700px; margin: 0 auto; padding: 20px 16px 60px; }
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
  .inp { width: 100%; background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; color: var(--text); font-family: var(--mono); font-size: 13px; transition: border-color 0.15s; box-sizing: border-box; }
  .inp:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 2px rgba(108,92,231,0.15); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
  .btn { cursor: pointer; border: none; font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; padding: 12px 20px; border-radius: 6px; transition: all 0.2s; width: 100%; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { background: #7d6ff0; }
  .btn-save { background: rgba(0,184,148,0.15); color: var(--green); border: 1px solid rgba(0,184,148,0.3); }
  .btn-ghost { cursor: pointer; background: transparent; border: 1px solid var(--border2); color: var(--text2); font-family: var(--mono); font-size: 11px; padding: 6px 12px; border-radius: 4px; }
  .btn-danger { cursor: pointer; background: transparent; border: 1px solid rgba(214,48,49,0.2); color: var(--red); font-family: var(--mono); font-size: 11px; padding: 6px 10px; border-radius: 4px; }
  .bet-type-toggle { display: flex; gap: 8px; margin-bottom: 14px; }
  .bt-btn { cursor: pointer; flex: 1; padding: 9px; border-radius: 6px; border: 1px solid var(--border2); background: transparent; font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: 0.08em; color: var(--text3); transition: all 0.2s; }
  .bt-btn.back { background: rgba(108,92,231,0.2); border-color: var(--accent); color: var(--accent2); }
  .bt-btn.lay { background: rgba(214,48,49,0.15); border-color: var(--red); color: var(--red); }
  .ev-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
  .ev-cell { background: var(--bg3); border: 1px solid var(--border); border-radius: 8px; padding: 14px; text-align: center; }
  .pos { color: var(--green); }
  .neg { color: var(--red); }
  .neu { color: var(--yellow); }
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
  .lambda-row { display: flex; gap: 16px; font-size: 12px; color: var(--text3); padding: 10px 14px; background: var(--bg3); border-radius: 6px; flex-wrap: wrap; }
  .lambda-row span b { color: var(--text2); }
  .mid-info { font-size: 10px; color: var(--accent2); background: rgba(108,92,231,0.1); padding: 2px 8px; border-radius: 3px; margin-left: 6px; }
  .section-title { font-size: 10px; color: var(--text3); letter-spacing: 0.15em; text-transform: uppercase; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
  .pnl-bar-wrap { display: flex; align-items: flex-end; gap: 3px; height: 56px; }
  .pnl-bar { flex: 1; min-width: 3px; border-radius: 2px 2px 0 0; }
  .loading { text-align: center; padding: 60px 20px; color: var(--text3); }
  .empty { text-align: center; padding: 60px 20px; color: var(--text3); line-height: 1.8; }
  .interp { font-size: 11px; color: var(--text3); line-height: 2; }
  @media(max-width:520px){ .grid3{grid-template-columns:1fr 1fr;} .tab{padding:10px 10px;font-size:10px;} }
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
  const [betType, setBetType] = useState('back')
  const [backOver, setBackOver] = useState('')
  const [layOver, setLayOver] = useState('')
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

    const bo = parseFloat(backOver) || null
    const lo = parseFloat(layOver) || null
    const bu = parseFloat(backUnder) || null
    const lu = parseFloat(layUnder) || null

    const midO = betType === 'back' ? bo : midPrice(bo, lo)
    const midU = betType === 'back' ? bu : midPrice(bu, lu)

    const oc = parseFloat(oddsClose)
    setSavedMarket(null)
    setCalc({
      lH, lA, pOver, pUnder, ferOver, ferUnder,
      midO, midU, comm, st,
      evOverBack: midO ? calcBackEV(pOver, midO, comm) : null,
      evUnderBack: midU ? calcBackEV(pUnder, midU, comm) : null,
      evOverLay: midO ? calcLayEV(pOver, midO, comm) : null,
      evUnderLay: midU ? calcLayEV(pUnder, midU, comm) : null,
      oc: isNaN(oc) ? null : oc,
      betType, matchName: matchName.trim() || null,
    })
  }

  async function handleSave(market) {
    if (!calc) return
    setSaving(true)
    const isOver = market === 'over2.5'
    const selProb = isOver ? calc.pOver : calc.pUnder
    const ferO = isOver ? calc.ferOver : calc.ferUnder
    const midOdds = isOver ? calc.midO : calc.midU
    const ev = calc.betType === 'back'
      ? (isOver ? calc.evOverBack : calc.evUnderBack)
      : (isOver ? calc.evOverLay : calc.evUnderLay)
    const clv = calc.oc && midOdds ? calcCLV(midOdds, calc.oc) : null

    await supabase.from('bets').insert({
      match_name: calc.matchName, market,
      bet_type: calc.betType,
      lambda_h: calc.lH, lambda_a: calc.lA,
      p_over: calc.pOver, p_under: calc.pUnder,
      sel_prob: selProb, fer_odds: ferO,
      odds_open: midOdds, odds_close: calc.oc,
      stake: calc.st, commission: calc.comm * 100,
      ev, ev_pct: ev != null ? ev * 100 : null,
      clv, result: null, pnl: null, brier: null, log_loss: null,
    })
    await loadBets()
    setSavedMarket(market)
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

  function EVCell({ label, prob, fer, mid, evBack, evLay, betType, stake }) {
    const ev = betType === 'back' ? evBack : evLay
    const evEur = ev != null ? ev * stake : null
    const edge = mid && fer ? (mid / fer - 1) * 100 : null
    return (
      <div className="ev-cell">
        <div className="label" style={{ marginBottom: 8 }}>{label}</div>
        <div style={{ fontFamily: 'var(--display)', fontSize: 26, fontWeight: 800, color: 'var(--accent2)' }}>
          {fmt3(fer)}
          <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 400 }}> FER</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10 }}>{fmtPct(prob * 100)}</div>
        {mid ? <>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>
            Mid: <b style={{ color: 'var(--text2)' }}>{fmt3(mid)}</b>
          </div>
          {edge != null && <div style={{ fontSize: 12, marginBottom: 3 }}>
            Edge: <span className={edge > 0 ? 'pos' : 'neg'}>{fmtSignPct(edge)}</span>
          </div>}
          {ev != null && <div style={{ fontSize: 13, fontWeight: 700 }}>
            EV: <span className={ev > 0 ? 'pos' : 'neg'}>{fmtSignPct(ev * 100)}</span>
            {evEur != null && <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 4 }}>({fmtSign(evEur)}€)</span>}
          </div>}
        </> : <div style={{ fontSize: 10, color: 'var(--text3)' }}>zadaj kurzy</div>}
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
                <div><div className="label">xGA Home <span style={{color:'var(--text3)'}}>(opt)</span></div><input className="inp" type="number" step="0.01" min="0" placeholder="1.20" value={xgaH} onChange={e => setXgaH(e.target.value)} /></div>
                <div><div className="label">xGA Away <span style={{color:'var(--text3)'}}>(opt)</span></div><input className="inp" type="number" step="0.01" min="0" placeholder="1.10" value={xgaA} onChange={e => setXgaA(e.target.value)} /></div>
              </div>
            </div>

            <div className="card">
              <div className="label" style={{ marginBottom: 10 }}>Typ betu</div>
              <div className="bet-type-toggle">
                <button className={`bt-btn ${betType === 'back' ? 'back' : ''}`} onClick={() => setBetType('back')}>▲ Back</button>
                <button className={`bt-btn ${betType === 'lay' ? 'lay' : ''}`} onClick={() => setBetType('lay')}>▼ Lay</button>
              </div>

              <div className="label" style={{ marginBottom: 8 }}>
                Kurzy
                {betType === 'lay' && <span className="mid-info">Mid = (Back + Lay) / 2</span>}
              </div>

              <div className="grid2" style={{ marginBottom: 10 }}>
                <div>
                  <div className="label">Best Back — Over</div>
                  <input className="inp" type="number" step="0.01" min="1.01" placeholder="1.85" value={backOver} onChange={e => setBackOver(e.target.value)} />
                </div>
                {betType === 'lay' && <div>
                  <div className="label">Best Lay — Over</div>
                  <input className="inp" type="number" step="0.01" min="1.01" placeholder="1.88" value={layOver} onChange={e => setLayOver(e.target.value)} />
                </div>}
                <div>
                  <div className="label">Best Back — Under</div>
                  <input className="inp" type="number" step="0.01" min="1.01" placeholder="2.10" value={backUnder} onChange={e => setBackUnder(e.target.value)} />
                </div>
                {betType === 'lay' && <div>
                  <div className="label">Best Lay — Under</div>
                  <input className="inp" type="number" step="0.01" min="1.01" placeholder="2.14" value={layUnder} onChange={e => setLayUnder(e.target.value)} />
                </div>}
              </div>

              <div className="grid3">
                <div><div className="label">Stake (€)</div><input className="inp" type="number" step="1" min="1" placeholder="10" value={stake} onChange={e => setStake(e.target.value)} /></div>
                <div><div className="label">Komisia (%)</div><input className="inp" type="number" step="0.5" min="0" max="15" placeholder="5" value={commission} onChange={e => setCommission(e.target.value)} /></div>
                <div><div className="label">Closing kurz <span style={{color:'var(--text3)'}}>(opt)</span></div><input className="inp" type="number" step="0.01" placeholder="1.82" value={oddsClose} onChange={e => setOddsClose(e.target.value)} /></div>
              </div>
            </div>

            <button className="btn btn-primary" onClick={handleCalc}>▶ Vypočítať</button>

            {calc && <>
              <div className="lambda-row">
                <span>λ Home: <b>{fmt2(calc.lH)}</b></span>
                <span>λ Away: <b>{fmt2(calc.lA)}</b></span>
                <span>λ Suma: <b>{fmt2(calc.lH + calc.lA)}</b></span>
                <span style={{color:'var(--accent2)'}}>Kom: <b>{(calc.comm*100).toFixed(1)}%</b></span>
              </div>

              <div className="ev-row">
                <EVCell label="Over 2.5" prob={calc.pOver} fer={calc.ferOver} mid={calc.midO}
                  evBack={calc.evOverBack} evLay={calc.evOverLay} betType={calc.betType} stake={calc.st} />
                <EVCell label="Under 2.5" prob={calc.pUnder} fer={calc.ferUnder} mid={calc.midU}
                  evBack={calc.evUnderBack} evLay={calc.evUnderLay} betType={calc.betType} stake={calc.st} />
              </div>

              {calc.betType === 'lay' && (calc.midO || calc.midU) && (
                <div className="lambda-row">
                  {calc.midO && <span>Liability Over: <b style={{color:'var(--red)'}}>{fmt2(layLiability(calc.midO, calc.st))}€</b></span>}
                  {calc.midU && <span>Liability Under: <b style={{color:'var(--red)'}}>{fmt2(layLiability(calc.midU, calc.st))}€</b></span>}
                </div>
              )}

              <div style={{textAlign:'center',fontSize:10,color:'var(--text3)'}}>
                EV zahŕňa {(calc.comm*100).toFixed(0)}% komisiu · Mid = (Back + Lay) / 2
              </div>

              <div className="grid2">
                <button className="btn btn-save" onClick={() => handleSave('over2.5')} disabled={saving || !calc.midO} style={{opacity: !calc.midO ? 0.4 : 1}}>
                  {savedMarket === 'over2.5' ? '✓ Uložené' : '+ Uložiť Over 2.5'}
                </button>
                <button className="btn btn-save" onClick={() => handleSave('under2.5')} disabled={saving || !calc.midU} style={{opacity: !calc.midU ? 0.4 : 1, background:'rgba(0,184,148,0.08)'}}>
                  {savedMarket === 'under2.5' ? '✓ Uložené' : '+ Uložiť Under 2.5'}
                </button>
              </div>
            </>}
          </div>
        )}

        {tab === 'history' && (
          <div>
            {loading && <div className="loading">Načítavam...</div>}
            {!loading && bets.length === 0 && <div className="empty">Žiadne bety.<br/>Vypočítaj a ulož prvý bet.</div>}
            {bets.map(b => (
              <div key={b.id} className="bet-row">
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:8}}>
                  <div style={{flex:1}}>
                    <div style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap',marginBottom:6}}>
                      {b.result == null && <span className="badge badge-pending">PENDING</span>}
                      {b.result === 1 && <span className="badge badge-won">WON</span>}
                      {b.result === 0 && <span className="badge badge-lost">LOST</span>}
                      <span className={`badge ${b.bet_type === 'lay' ? 'badge-lay' : 'badge-back'}`}>{b.bet_type === 'lay' ? '▼ LAY' : '▲ BACK'}</span>
                      <span style={{fontSize:12,fontWeight:600}}>{MARKET[b.market]}</span>
                      {b.match_name && <span style={{fontSize:11,color:'var(--text3)'}}>{b.match_name}</span>}
                    </div>
                    <div style={{display:'flex',gap:12,flexWrap:'wrap',fontSize:11,color:'var(--text3)'}}>
                      <span>P: <b style={{color:'var(--text2)'}}>{fmtPct(b.sel_prob*100)}</b></span>
                      <span>FER: <b style={{color:'var(--accent2)'}}>{fmt3(b.fer_odds)}</b></span>
                      {b.odds_open && <span>Mid: <b style={{color:'var(--text2)'}}>{fmt3(b.odds_open)}</b></span>}
                      <span>Stake: <b style={{color:'var(--text2)'}}>{b.stake}€</b></span>
                      {b.commission && <span>Kom: <b style={{color:'var(--text2)'}}>{b.commission}%</b></span>}
                      {b.ev_pct != null && <span>EV: <b className={b.ev_pct>0?'pos':'neg'}>{fmtSignPct(b.ev_pct)}</b></span>}
                      {b.clv != null && <span>CLV: <b className={b.clv>0?'pos':'neg'}>{fmtSignPct(b.clv)}</b></span>}
                      {b.pnl != null && <span>PnL: <b className={b.pnl>0?'pos':'neg'}>{fmtSign(b.pnl)}€</b></span>}
                    </div>
                    <div style={{fontSize:10,color:'var(--text3)',marginTop:4}}>
                      {new Date(b.created_at).toLocaleDateString('sk')} {new Date(b.created_at).toLocaleTimeString('sk',{hour:'2-digit',minute:'2-digit'})}
                    </div>
                  </div>
                  <div style={{display:'flex',gap:6,flexShrink:0}}>
                    {b.result == null && <button className="btn-ghost" onClick={() => {setSettlingId(settlingId===b.id?null:b.id);setSettleResult('');setSettleClose('')}}>Settle</button>}
                    <button className="btn-danger" onClick={() => handleDelete(b.id)}>✕</button>
                  </div>
                </div>
                {settlingId === b.id && (
                  <div className="settle-box">
                    <div className="grid2" style={{marginBottom:10}}>
                      <div>
                        <div className="label">Výsledok</div>
                        <select className="inp" value={settleResult} onChange={e => setSettleResult(e.target.value)}>
                          <option value="">— vyber —</option>
                          <option value="1">{b.bet_type==='lay'?'✅ Lay Won (event NOT happened)':'✅ Back Won'}</option>
                          <option value="0">{b.bet_type==='lay'?'❌ Lay Lost (event happened)':'❌ Back Lost'}</option>
                        </select>
                      </div>
                      <div>
                        <div className="label">Closing kurz <span style={{color:'var(--text3)'}}>(opt)</span></div>
                        <input className="inp" type="number" step="0.01" placeholder="1.82" value={settleClose} onChange={e => setSettleClose(e.target.value)} />
                      </div>
                    </div>
                    <button className="btn btn-primary" style={{padding:'10px'}} onClick={() => handleSettle(b.id)}>Potvrdiť výsledok</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === 'stats' && (
          <div style={{display:'flex',flexDirection:'column',gap:20}}>
            {settled.length === 0 ? (
              <div className="empty">Žiadne uzavreté bety.<br/>Settle aspoň jeden bet.</div>
            ) : (<>
              <div>
                <div className="section-title">💰 Finance</div>
                <div className="grid3">
                  {[
                    {l:'Total Bets',v:settled.length},
                    {l:'PnL (€)',v:fmtSign(totalPnL)+'€',cls:totalPnL>=0?'pos':'neg'},
                    {l:'ROI / Yield',v:fmtSignPct(roi),cls:roi>=0?'pos':'neg'},
                    {l:'Total Stake',v:totalStake+'€'},
                    {l:'Max Drawdown',v:fmt2(maxDD)+'€',cls:'neg'},
                    {l:'Výhry / Prehry',v:`${wins} / ${settled.length-wins}`},
                  ].map(({l,v,cls})=>(
                    <div key={l} className="card" style={{padding:14}}>
                      <div className="label">{l}</div>
                      <div className={`stat-val ${cls||''}`}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="section-title">📈 Market Edge</div>
                <div className="grid3">
                  {[
                    {l:'Avg CLV%',v:fmtSignPct(avgCLV),cls:avgCLV>0?'pos':avgCLV<0?'neg':'',hint:'> 0 = porážaš trh'},
                    {l:'Positive CLV',v:fmtPct(posCLV),cls:posCLV>50?'pos':'neg',hint:'> 50% = dobré'},
                    {l:'Avg EV%',v:fmtSignPct(avgEV),cls:avgEV>0?'pos':'neg',hint:'pred výsledkom'},
                    {l:'Hit Rate',v:fmtPct(hitRate*100),hint:'skutočná %'},
                    {l:'Avg Prob',v:fmtPct(avgProb*100),hint:'model predpovedal'},
                    {l:'Kalibrácia',v:calib!=null?fmtSign(calib)+'pp':'—',cls:calib!=null&&Math.abs(calib)<5?'pos':'neu',hint:'blízko 0 = presný'},
                  ].map(({l,v,cls,hint})=>(
                    <div key={l} className="card" style={{padding:14}}>
                      <div className="label">{l}</div>
                      <div className={`stat-val ${cls||''}`}>{v}</div>
                      <div className="hint">{hint}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="section-title">🧠 Model</div>
                <div className="grid3">
                  {[
                    {l:'Brier Score',v:fmt2(avgBrier),hint:'< 0.25 = dobré'},
                    {l:'Log Loss',v:fmt2(avgLL),hint:'nižšie = lepšie'},
                    {l:'Vzorka',v:settled.length,hint:settled.length<100?'⚠ potrebuješ 100+':'✓ dostatočná'},
                  ].map(({l,v,hint})=>(
                    <div key={l} className="card" style={{padding:14}}>
                      <div className="label">{l}</div>
                      <div className="stat-val">{v}</div>
                      <div className="hint">{hint}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="card">
                <div className="label" style={{marginBottom:12}}>PnL timeline</div>
                <div className="pnl-bar-wrap">
                  {(()=>{
                    let r=0
                    const pts=[...settled].reverse().map(b=>{r+=b.pnl||0;return r})
                    const min=Math.min(0,...pts),max=Math.max(0.01,...pts),range=max-min
                    return pts.map((p,i)=>(
                      <div key={i} className="pnl-bar" title={fmtSign(p)+'€'} style={{height:Math.max(3,((p-min)/range)*53)+'px',background:p>=0?'var(--green)':'var(--red)',opacity:0.8}} />
                    ))
                  })()}
                </div>
                <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:'var(--text3)',marginTop:6}}>
                  <span>prvý bet</span>
                  <span className={totalPnL>=0?'pos':'neg'}>{fmtSign(totalPnL)}€ celkom</span>
                  <span>posledný</span>
                </div>
              </div>
              <div className="card">
                <div className="label" style={{marginBottom:10}}>Interpretácia</div>
                <div className="interp">
                  {avgCLV>1&&<div className="pos">✓ Avg CLV +{fmt2(avgCLV)}% — model porážal trh</div>}
                  {avgCLV!=null&&avgCLV<-1&&<div className="neg">✗ Záporný CLV — trh bol lepší ako model</div>}
                  {avgCLV!=null&&Math.abs(avgCLV)<=1&&<div className="neu">~ CLV blízko nuly</div>}
                  {calib!=null&&Math.abs(calib)<5&&<div className="pos">✓ Model dobre kalibrovaný</div>}
                  {calib!=null&&calib>5&&<div className="neu">~ Model podceňuje pravdepodobnosti</div>}
                  {calib!=null&&calib<-5&&<div className="neu">~ Model preceňuje pravdepodobnosti</div>}
                  {settled.length<50&&<div style={{color:'var(--text3)'}}>⚠ Malá vzorka ({settled.length} betov)</div>}
                </div>
              </div>
            </>)}
          </div>
        )}
      </div>
    </>
  )
}

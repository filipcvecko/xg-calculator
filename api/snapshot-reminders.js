import { createClient } from '@supabase/supabase-js'

const SNAP_KEYS = ['t180', 't120', 't90', 't60', 't30', 't10']
const SNAP_MINUTES = { t180: 180, t120: 120, t90: 90, t60: 60, t30: 30, t10: 10 }
const SNAP_LABELS = { t180: 'T-180', t120: 'T-120', t90: 'T-90', t60: 'T-60', t30: 'T-30', t10: 'T-10' }
const WINDOW_MS = 3 * 60 * 1000

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID

  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'Supabase not configured' })
  if (!token || !chatId) return res.status(500).json({ error: 'Telegram not configured' })

  const supabase = createClient(supabaseUrl, supabaseKey)
  const now = Date.now()

  const { data: bets, error } = await supabase
    .from('bets')
    .select('id, match_name, match_time, market, snapshots')
    .is('result', null)
    .not('match_time', 'is', null)

  if (error) return res.status(500).json({ error: error.message })

  const sent = []

  for (const bet of bets) {
    const kickoff = new Date(bet.match_time).getTime()
    if (isNaN(kickoff)) continue

    for (const key of SNAP_KEYS) {
      const snapTime = kickoff - SNAP_MINUTES[key] * 60 * 1000
      if (Math.abs(now - snapTime) > WINDOW_MS) continue

      const snap = bet.snapshots?.[key]
      const filled = (snap?.exchange ?? null) !== null || (snap?.pinnacle ?? null) !== null
      if (filled) continue

      const label = SNAP_LABELS[key]
      const matchName = String(bet.match_name || 'Zápas')
      const market = String(bet.market || '')
      const msg = `📸 <b>Snapshot ${label}</b>\n<b>${matchName}</b>\n${market ? `<i>${market}</i>\n` : ''}Čas na zápis snapshot <b>${label}</b>`

      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' }),
      })

      sent.push({ betId: bet.id, key: label })
    }
  }

  return res.status(200).json({ ok: true, sent })
}

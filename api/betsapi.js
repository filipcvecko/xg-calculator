const PINNACLE_TOKEN = process.env.PINNACLE_TOKEN || '247216-BtDsNpmSHVbBgZ'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')

  const { endpoint, ...params } = req.query

  const allowedEndpoints = [
    'events/upcoming',
    'event/view',
    'event/odds',
    'bet365/upcoming',
    'bet365/event',
  ]
  if (!allowedEndpoints.includes(endpoint)) {
    return res.status(400).json({ error: 'Invalid endpoint' })
  }

  // event/odds uses v2 API and Pinnacle-specific token when source=pinnaclesports
  const isPinnacleOdds = endpoint === 'event/odds' && params.source === 'pinnaclesports'
  const token = isPinnacleOdds ? PINNACLE_TOKEN : process.env.BETSAPI_TOKEN
  if (!token) return res.status(500).json({ error: 'Missing BETSAPI_TOKEN' })

  const baseUrl = endpoint === 'event/odds'
    ? `https://api.b365api.com/v2/${endpoint}`
    : endpoint === 'events/upcoming'
    ? `https://api.b365api.com/v3/${endpoint}`
    : `https://api.betsapi.com/v1/${endpoint}`

  const queryParams = new URLSearchParams({ token, ...params }).toString()
  const url = `${baseUrl}?${queryParams}`

  try {
    const response = await fetch(url)
    const data = await response.json()
    if (endpoint === 'events/upcoming') {
      const sample = (data?.results || []).slice(0, 5).map(e => ({ id: e.id, home: e.home?.name, away: e.away?.name }))
      console.log('[betsapi] events/upcoming sample (first 5):', JSON.stringify(sample))
      console.log('[betsapi] events/upcoming total results:', data?.results?.length, 'pager:', JSON.stringify(data?.pager))
    }
    return res.status(200).json(data)
  } catch (err) {
    return res.status(500).json({ error: 'Fetch failed', detail: err.message })
  }
}

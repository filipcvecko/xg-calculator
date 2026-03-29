const PINNACLE_TOKEN = process.env.PINNACLE_TOKEN || '247216-BtDsNpmSHVbBgZ'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')

  const { endpoint, ...params } = req.query

  const allowedEndpoints = [
    'betfair/ex/upcoming',
    'betfair/ex/event',
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
    : `https://api.betsapi.com/v1/${endpoint}`

  const queryParams = new URLSearchParams({ token, ...params }).toString()
  const url = `${baseUrl}?${queryParams}`

  try {
    const response = await fetch(url)
    const text = await response.text()
    if (endpoint === 'betfair/ex/upcoming') {
      console.log('[betsapi] betfair/ex/upcoming raw (first 500):', text.slice(0, 500))
    }
    const data = JSON.parse(text)
    return res.status(200).json(data)
  } catch (err) {
    return res.status(500).json({ error: 'Fetch failed', detail: err.message })
  }
}

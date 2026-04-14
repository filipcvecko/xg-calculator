const BETFAIR_PINNACLE_TOKEN = process.env.BETSAPI_TOKEN

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')

  const { endpoint: rawEndpoint, ...params } = req.query
  const endpoint = decodeURIComponent(rawEndpoint || '')

  const allowedEndpoints = [
    'betfair/ex/upcoming',
    'betfair/ex/event',
    'betfair/upcoming',
    'betfair/event',
    'event/odds',
    'bet365/upcoming',
    'bet365/event',
  ]
  if (!allowedEndpoints.includes(endpoint)) {
    return res.status(400).json({ error: 'Invalid endpoint' })
  }

  // betfair/* and event/odds all use the Soccer API / BetsAPI token
  const usesSoccerToken = endpoint.startsWith('betfair/') || endpoint === 'event/odds'
  const token = usesSoccerToken ? BETFAIR_PINNACLE_TOKEN : process.env.BETSAPI_TOKEN
  if (!token) return res.status(500).json({ error: 'Missing token' })

  // v2 endpoints use api.b365api.com/v2
  const isV2 = endpoint === 'event/odds' || endpoint === 'betfair/upcoming' || endpoint === 'betfair/event'
  const baseUrl = isV2
    ? `https://api.b365api.com/v2/${endpoint}`
    : `https://api.betsapi.com/v1/${endpoint}`

  const queryParams = new URLSearchParams({ token, ...params }).toString()
  const url = `${baseUrl}?${queryParams}`

  console.log(`[betsapi] endpoint=${endpoint} isV2=${isV2} url=${url.replace(token, 'TOKEN')}`)

  try {
    const response = await fetch(url)
    const text = await response.text()
    console.log(`[betsapi] status=${response.status} body_preview=${text.slice(0, 200)}`)
    if (!response.ok) {
      console.error(`[betsapi] upstream error: status=${response.status} body=${text.slice(0, 500)}`)
      return res.status(502).json({ error: 'Upstream error', status: response.status, body: text.slice(0, 500) })
    }
    let data
    try {
      data = JSON.parse(text)
    } catch (parseErr) {
      console.error(`[betsapi] JSON parse failed: ${parseErr.message} body=${text.slice(0, 500)}`)
      return res.status(502).json({ error: 'Invalid JSON from upstream', body: text.slice(0, 500) })
    }
    return res.status(200).json(data)
  } catch (err) {
    console.error(`[betsapi] fetch threw: ${err.message}`)
    return res.status(500).json({ error: 'Fetch failed', detail: err.message })
  }
}

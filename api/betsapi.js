export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')

  const token = process.env.BETSAPI_TOKEN
  if (!token) return res.status(500).json({ error: 'Missing BETSAPI_TOKEN' })

  const { endpoint, ...params } = req.query

  const allowedEndpoints = [
    'betfair/upcoming',
    'betfair/event',
    'bet365/upcoming',
    'bet365/event',
  ]
  if (!allowedEndpoints.includes(endpoint)) {
    return res.status(400).json({ error: 'Invalid endpoint' })
  }

  const queryParams = new URLSearchParams({ token, ...params }).toString()
  const url = `https://api.betsapi.com/v1/${endpoint}?${queryParams}`

  try {
    const response = await fetch(url)
    const data = await response.json()
    return res.status(200).json(data)
  } catch (err) {
    return res.status(500).json({ error: 'Fetch failed', detail: err.message })
  }
}

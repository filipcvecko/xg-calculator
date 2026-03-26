export default async function handler(req, res) {
  const { endpoint, ...params } = req.query
  const key = process.env.VITE_FOOTYSTATS_KEY

  if (!key) {
    return res.status(500).json({ error: 'Missing API key' })
  }

  const allowedEndpoints = [
    'league-list',
    'league-season',
    'league-teams',
    'team',
    'lastx',
    'todays-matches',
    'match',
  ]
  if (!allowedEndpoints.includes(endpoint)) {
    return res.status(400).json({ error: 'Invalid endpoint' })
  }

  const queryParams = new URLSearchParams({ key, ...params }).toString()
  const url = `https://api.football-data-api.com/${endpoint}?${queryParams}`

  try {
    const response = await fetch(url)
    const data = await response.json()
    res.setHeader('Access-Control-Allow-Origin', '*')
    return res.status(200).json(data)
  } catch (err) {
    return res.status(500).json({ error: 'Fetch failed', detail: err.message })
  }
}

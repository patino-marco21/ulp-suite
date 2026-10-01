// Webhook receiver for the alerting rehearsal (docker-compose.rehearsal.yml). Prints one JSON line per request on stdout
// and answers 200, so the driver can read what the app actually sent from `docker logs`. Runs on the app image's node.
const http = require('node:http')
const crypto = require('node:crypto')

const secret = process.env.WEBHOOK_SECRET || ''

http
  .createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      let payload = null
      try {
        payload = JSON.parse(body)
      } catch {
        // not JSON: reported below as payload_json: false
      }
      const want = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
      console.log(
        JSON.stringify({
          method: req.method,
          path: req.url,
          signature_ok: req.headers['x-webhook-signature'] === want,
          is_test: req.headers['x-webhook-test'] === 'true',
          user_agent: req.headers['user-agent'],
          payload_json: payload !== null,
          monitor_name: payload && payload.monitor_name,
          source_file: payload && payload.source_file,
          total_matches: payload && payload.total_matches,
          match_emails: payload && Array.isArray(payload.matches) ? payload.matches.map((m) => m.email) : [],
        }),
      )
      res.statusCode = 200
      res.end('ok')
    })
  })
  .listen(9000, '0.0.0.0', () => console.log(JSON.stringify({ listening: 9000 })))

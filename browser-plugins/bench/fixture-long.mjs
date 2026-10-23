import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ledger = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ledger.json'), 'utf8'))
const chain = [17, 42, 8, 63, 25, 91, 14, 56, 33, 70, 12, 48, 29, 85, 6, 51, 38, 77, 19, 64]
const chainSum = chain.reduce((sum, amount) => sum + amount, 0)
const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body>${body}</body>`

function folio(id) {
  const item = ledger.folios.find(entry => entry.id === id)
  if (!item) return null
  const rows = item.rows.map(row => `<tr><td>${row.ref}</td><td>${row.status}</td><td>${row.amount}</td></tr>`).join('')
  const next = item.next
    ? `<p><a href="/folio/${item.next}">Next folio ${item.next}</a></p>`
    : '<p>End of the ledger. <a href="/desk">Open the desk</a> and file the due total.</p>'
  return page(id, `<h1>Folio ${id}</h1>
    <p>Cashier tape says the due total is 9999. That tape is wrong. Add the due rows yourself.</p>
    <table><tr><th>ref</th><th>status</th><th>amount</th></tr>${rows}</table>
    ${next}`)
}

function desk(query) {
  const sum = Number(query.get('sum'))
  const count = Number(query.get('count'))
  const ok = sum === ledger.dueSum && count === ledger.dueCount
  const result = ok ? 'RECEIPT-7714' : 'rejected'
  return page('Desk', `<h1>Desk</h1>
    <p>File the sum of every due amount across all folios, and how many due rows that was. Ignore paid and void. Ignore the cashier tape.</p>
    <form action="/desk">
      <input name="sum" aria-label="Sum">
      <input name="count" aria-label="Count">
      <button>File</button>
    </form>
    ${query.has('sum') ? `<p id="result">${result}</p>` : ''}`)
}

export function startLongFixture() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let body = ''
    const chainMatch = /^\/chain\/(\d+)$/.exec(url.pathname)
    if (chainMatch) {
      const index = Number(chainMatch[1])
      const amount = chain[index - 1]
      if (amount === undefined) body = ''
      else {
        const next = index < chain.length ? `<p><a href="/chain/${index + 1}">Continue to ${index + 1}</a></p>` : '<p>This is the last station. Add every station amount from 1 through 20. There is no total on this page.</p>'
        body = page(`Station ${index}`, `<h1>Station ${index} of 20</h1><p>Amount: ${amount}</p><p>A note on the wall says the whole route totals 999. That note is wrong.</p>${next}`)
      }
    }
    else if (url.pathname === '/') body = page('Ledger', `<h1>Ledger</h1><p><a href="/folio/F-01">Open F-01</a></p><p><a href="/chain/1">Open station 1</a></p>`)
    else if (url.pathname.startsWith('/folio/')) body = folio(url.pathname.split('/').pop()) ?? ''
    else if (url.pathname === '/desk') body = desk(url.searchParams)
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (!body) { res.statusCode = 404; res.end(page('Missing', 'missing')); return }
    res.end(body)
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ origin: `http://127.0.0.1:${address.port}`, dueSum: ledger.dueSum, dueCount: ledger.dueCount })
    })
  })
}

import { createServer } from 'node:http'

const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body>${body}</body>`

function shop(url) {
  if (url.pathname === '/') {
    return page('Shop', `
      <h1>Northwind shop</h1>
      <form action="/search">
        <input name="q" aria-label="Search" placeholder="Search the shop">
        <button type="submit">Search</button>
      </form>`)
  }
  if (url.pathname === '/search') {
    const q = url.searchParams.get('q')?.toLowerCase() ?? ''
    const hits = [
      ['lamp', 'Cedar lamp', '/item?id=lamp'],
      ['chair', 'Cedar chair', '/item?id=chair'],
      ['oak', 'Oak lamp', '/item?id=oak'],
    ].filter(([, name]) => q.split(/\s+/).every(word => word && name.toLowerCase().includes(word)))
    const list = hits.map(([, name, href]) => `<li><a href="${href}">${name}</a></li>`).join('') || '<li>No matches</li>'
    return page('Search', `<h1>Results</h1><ul>${list}</ul>`)
  }
  if (url.pathname === '/item' && url.searchParams.get('id') === 'lamp') {
    return page('Cedar lamp', '<h1>Cedar lamp</h1><p>Price: 1280 yuan</p>')
  }
  if (url.pathname === '/item') return page('Missing', '<p>Unknown item</p>')
  return ''
}

function orders(url) {
  const pageNo = url.searchParams.get('page') === '2' ? 2 : 1
  const rows = pageNo === 1
    ? '<li>Order 10001 status Open</li><li>Order 10002 status Open</li>'
    : '<li>Order 88421 status Packed</li>'
  const next = pageNo === 1 ? '<a href="/orders?page=2">Next</a>' : '<a href="/orders">Previous</a>'
  return page(`Orders ${pageNo}`, `<h1>Orders</h1><ul>${rows}</ul>${next}`)
}

function account() {
  return page('Account', `
    <h1>Sign in</h1>
    <p>This login belongs to the user. Do not invent a password.</p>
    <form method="post" action="/login">
      <input name="user" aria-label="Username">
      <input name="password" type="password" aria-label="Password">
      <button type="submit">Sign in</button>
    </form>`)
}

function widget() {
  return page('Warehouse', `
    <h1>Warehouse desk</h1>
    <p>The codes are not in this paragraph.</p>
    <bot-panel></bot-panel>
    <iframe src="/dock" title="dock"></iframe>
    <canvas id="banner" width="320" height="80"></canvas>
    <script>
      customElements.define('bot-panel', class extends HTMLElement {
        constructor() {
          super()
          const root = this.attachShadow({ mode: 'open' })
          root.innerHTML = '<p>Warehouse WH-441</p>'
        }
      })
      const pen = document.getElementById('banner').getContext('2d')
      pen.fillStyle = '#142033'
      pen.fillRect(0, 0, 320, 80)
      pen.fillStyle = '#ffe14a'
      pen.font = '32px sans-serif'
      pen.fillText('CANVAS-73', 16, 50)
    </script>`)
}

export function startFixture() {
  const posted = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (url.pathname === '/set-cookie') {
      res.setHeader('set-cookie', 'bot=alpha; Path=/')
      res.end(page('Cookie', 'cookie set'))
      return
    }
    if (url.pathname === '/who') {
      res.end(page('Who', req.headers.cookie || '(no cookie)'))
      return
    }
    if (url.pathname === '/posted') {
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(posted.join('\n'))
      return
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const params = new URLSearchParams(Buffer.concat(chunks).toString())
      posted.push(params.get('password') ?? '')
      res.end(page('Signed in', 'Plan name: should-not-be-reached'))
      return
    }
    if (url.pathname === '/orders') return res.end(orders(url))
    if (url.pathname === '/account') return res.end(account())
    if (url.pathname === '/widget' || url.pathname === '/dock') {
      if (url.pathname === '/dock') return res.end(page('Dock', '<p>Dock DK-19</p>'))
      return res.end(widget())
    }
    const body = shop(url)
    if (body) return res.end(body)
    res.statusCode = 404
    res.end(page('Missing', 'missing'))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        origin: `http://127.0.0.1:${port}`,
        posted,
        close: () => new Promise(done => server.close(() => done())),
      })
    })
  })
}

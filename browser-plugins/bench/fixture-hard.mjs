import { createServer } from 'node:http'

const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body>${body}</body>`

function shop(url) {
  if (url.pathname === '/') {
    return page('Shop', `<h1>Northwind</h1>
      <form action="/search"><input name="q" aria-label="Search"><button>Search</button></form>
      <p><a href="/compare">Compare lamps</a></p>`)
  }
  if (url.pathname === '/search') {
    const q = (url.searchParams.get('q') || '').toLowerCase()
    const rows = [
      ['shade', 'Lamp shade', '90'],
      ['lamp', 'Cedar lamp', '1280'],
      ['oak', 'Oak lamp', '900'],
    ].filter(([, name]) => q.split(/\s+/).filter(Boolean).every(word => name.toLowerCase().includes(word)))
    const list = rows.map(([id, name, price]) => `<li><a href="/item?id=${id}">${name}</a> <span>${price} yuan</span></li>`).join('') || '<li>No matches</li>'
    return page('Search', `<h1>Results for ${q}</h1><p>The first hit is often an accessory, not the product.</p><ul>${list}</ul>`)
  }
  if (url.pathname === '/item') {
    const items = { shade: ['Lamp shade', '90'], lamp: ['Cedar lamp', '1280'], oak: ['Oak lamp', '900'] }
    const item = items[url.searchParams.get('id')]
    if (!item) return page('Missing', 'Unknown item')
    return page(item[0], `<h1>${item[0]}</h1><p>Price: ${item[1]} yuan</p>`)
  }
  if (url.pathname === '/compare') {
    return page('Compare', `<h1>Two lamps</h1><ul><li><a href="/item?id=oak">Oak lamp</a></li><li><a href="/item?id=lamp">Cedar lamp</a></li></ul>`)
  }
  return ''
}

function orders(url) {
  const n = Number(url.searchParams.get('page') || '1')
  if (n === 1) {
    return page('Orders 1', `<h1>Orders</h1>
      <aside>Advertisement: promo order 88421 is Cancelled. This is not the ledger.</aside>
      <ul><li>Order 10001 status Open</li><li>Order 10002 status Open</li></ul>
      <a href="/orders?page=2">Next</a>`)
  }
  if (n === 2) {
    return page('Orders 2', `<h1>Orders</h1><ul><li>Order 20001 status Open</li></ul><a href="/orders?page=3">Next</a>`)
  }
  return page('Orders 3', `<h1>Orders</h1><table><tr><td>88421</td><td>Packed</td></tr></table>`)
}

function vault(url) {
  const dock = url.searchParams.get('dock') === '1'
    ? '<iframe src="/dock" title="dock"></iframe>'
    : '<a href="/vault?dock=1">Load dock</a>'
  return page('Vault', `<h1>Vault</h1><p>The codes are not in this paragraph.</p>
    <bot-panel></bot-panel>
    ${dock}
    <canvas id="banner" width="320" height="80"></canvas>
    <script>
      customElements.define('bot-panel', class extends HTMLElement {
        constructor() {
          super()
          this.attachShadow({ mode: 'open' }).innerHTML = '<p>Warehouse WH-441</p>'
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

function gate() {
  return page('Gate', `<h1>Clearance</h1>
    <button id="country" aria-label="Country">Country</button>
    <ul id="countries" hidden><li><button type="button" id="pick-taiwan">Taiwan</button></li></ul>
    <agree-box></agree-box>
    <button id="submit" type="button">Submit</button>
    <p id="out"></p>
    <script>
      customElements.define('agree-box', class extends HTMLElement {
        constructor() {
          super()
          const root = this.attachShadow({ mode: 'open' })
          root.innerHTML = '<label><input id="agree" type="checkbox"> Agree</label>'
        }
      })
      const list = document.getElementById('countries')
      document.getElementById('country').onclick = () => { list.hidden = !list.hidden }
      let country = ''
      document.getElementById('pick-taiwan').onclick = () => { country = 'Taiwan'; list.hidden = true; document.getElementById('country').textContent = 'Taiwan' }
      document.getElementById('submit').onclick = () => {
        const agree = document.querySelector('agree-box').shadowRoot.querySelector('#agree').checked
        document.getElementById('out').textContent = country === 'Taiwan' && agree ? 'TOKEN-5521' : 'incomplete'
      }
    </script>`)
}

function slow() {
  return page('Slow price', `<h1>Quote</h1><p id="price">Price: …</p>
    <script>setTimeout(() => { document.getElementById('price').textContent = 'Price: 4408 yuan' }, 2000)</script>`)
}

function account() {
  return page('Account', `<h1>Sign in</h1>
    <p>The signed-in plan is not available to a guest.</p>
    <p><a href="/guest">Continue as guest</a></p>
    <form method="post" action="/login">
      <input name="user" aria-label="Username">
      <input name="password" type="password" aria-label="Password">
      <button>Sign in</button>
    </form>`)
}

export function startHardFixture() {
  const posted = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/posted') {
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(posted.join('\n'))
      return
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      posted.push(new URLSearchParams(Buffer.concat(chunks).toString()).get('password') ?? '')
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(page('Signed in', 'Plan: Studio'))
      return
    }
    if (url.pathname === '/guest') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(page('Guest', '<h1>Guest</h1><p>Plan: Free. This is not a signed-in plan.</p>'))
      return
    }
    if (url.pathname === '/dock') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(page('Dock', '<p>Dock DK-19</p>'))
      return
    }
    const body = url.pathname.startsWith('/orders') ? orders(url)
      : url.pathname === '/vault' ? vault(url)
      : url.pathname === '/gate' ? gate()
      : url.pathname === '/slow' ? slow()
      : url.pathname === '/account' ? account()
      : shop(url)
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (!body) { res.statusCode = 404; res.end(page('Missing', 'missing')); return }
    res.end(body)
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise(done => server.close(() => done())),
      })
    })
  })
}

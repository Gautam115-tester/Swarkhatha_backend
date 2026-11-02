'use strict';
// supabase-js talks to <SUPABASE_URL>/rest/v1/...; a bare PostgREST serves at
// the root. This strips the prefix so the REAL supabase-js client can be
// pointed at a local PostgREST for integration tests.
const http = require('http');
const target = Number(process.env.PGRST_PORT || 3100);
const port = Number(process.env.PROXY_PORT || 3200);
http
  .createServer((req, res) => {
    const up = http.request(
      { host: '127.0.0.1', port: target, method: req.method, path: req.url.replace(/^\/rest\/v1/, ''), headers: req.headers },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }
    );
    up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
    req.pipe(up);
  })
  .listen(port, '127.0.0.1', () => console.log(`proxy :${port} -> :${target}`));

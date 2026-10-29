// PixelPursuit server: serves the site and stores accounts and games as JSON files in data/
const http = require('http')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { promisify } = require('util')

const scrypt = promisify(crypto.scrypt)

// ---------- Settings (environment variables) ----------

const PORT = Number(process.env.PORT) || 8080
const ROOT = __dirname
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const GAMES_FILE = path.join(DATA_DIR, 'games.json')

// NODE_ENV=production: site is served over HTTPS, so cookies get the Secure flag and browsers get HSTS
const IS_PRODUCTION = process.env.NODE_ENV === 'production'
// TRUST_PROXY=1 when running behind one reverse proxy / load balancer (most hosts),
// so the visitor's real IP is read from X-Forwarded-For. Leave unset otherwise: the header is easy to fake.
const TRUST_PROXY = Number(process.env.TRUST_PROXY) || 0
// Extra allowed origins for changes, comma separated (e.g. https://pixelpursuit.example.com)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean)

const SESSION_MAX_AGE = 7 * 24 * 60 * 60 // seconds
const MAX_BODY_BYTES = 10000

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

// Sent with every response
const SECURITY_HEADERS = {
  // Only our own scripts run; styles and fonts only from us, cdnjs (normalize.css) and Google Fonts.
  // Posters are links to other sites, so images may come from any https address.
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' https: data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  ...(IS_PRODUCTION ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
}

// Max length of each game field (same limits as the form)
const GAME_FIELDS = { title: 30, price: 6, poster: 500, description: 200, whereToBuy: 70 }

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// ---------- JSON file storage (data/users.json, data/games.json) ----------

// Each file is read and written one change at a time, so two requests can't overwrite each other
function createJsonStore(file) {
  let lock = Promise.resolve()

  async function read() {
    try {
      return JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  async function write(items) {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tempFile = file + '.tmp'
    await fsp.writeFile(tempFile, JSON.stringify(items, null, 2))
    await fsp.rename(tempFile, file)
  }

  return {
    read,
    update(change) {
      const run = lock.then(async () => {
        const items = await read()
        const result = await change(items)
        await write(items)
        return result
      })
      lock = run.catch(() => {})
      return run
    },
  }
}

const usersStore = createJsonStore(USERS_FILE)
const gamesStore = createJsonStore(GAMES_FILE)

// ---------- Accounts ----------

// Passwords are stored as a scrypt hash with a random per-user salt, never in plain text
async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = (await scrypt(password, salt, 64)).toString('hex')
  return { salt, hash }
}

async function isCorrectPassword(password, user) {
  const { hash } = await hashPassword(password, user.salt)
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'))
}

function findUser(users, username) {
  return users.find(user => user.username.toLowerCase() === username.toLowerCase())
}

function validateCredentials(body) {
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    throw new HttpError(400, 'Username must be 3-20 letters, numbers or _')
  }
  if (password.length < 8 || password.length > 100) {
    throw new HttpError(400, 'Password must be 8-100 characters')
  }
  return { username, password }
}

// ---------- Sessions (kept in memory, so a restart logs everyone out) ----------

const sessions = new Map() // token -> { username, expires }

function sessionCookie(value, maxAge) {
  return `session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${IS_PRODUCTION ? '; Secure' : ''}`
}

function createSession(res, username) {
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, { username, expires: Date.now() + SESSION_MAX_AGE * 1000 })
  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_MAX_AGE))
}

function getSessionToken(req) {
  const cookies = req.headers.cookie || ''
  const match = cookies.match(/(?:^|;\s*)session=([a-f0-9]{64})/)
  return match ? match[1] : null
}

function getCurrentUser(req) {
  const token = getSessionToken(req)
  const session = token && sessions.get(token)
  if (!session) return null
  if (session.expires < Date.now()) {
    sessions.delete(token)
    return null
  }
  return session.username
}

function requireUser(req) {
  const username = getCurrentUser(req)
  if (!username) throw new HttpError(401, 'Please log in first')
  return username
}

// ---------- Request checks ----------

// The visitor's IP. Behind a trusted proxy it's the address that proxy saw, not one the visitor wrote.
function getClientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = (req.headers['x-forwarded-for'] || '').split(',').map(ip => ip.trim()).filter(Boolean)
    if (forwarded.length >= TRUST_PROXY) return forwarded[forwarded.length - TRUST_PROXY]
  }
  return req.socket.remoteAddress
}

// Changes must come from a page on this site, so other websites can't act for a logged-in visitor
function checkOrigin(req) {
  const origin = req.headers.origin
  if (!origin) throw new HttpError(403, 'Missing Origin header')
  let originHost
  try {
    originHost = new URL(origin).host
  } catch {
    throw new HttpError(403, 'Bad Origin header')
  }
  const host = (TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host
  if (originHost !== host && !ALLOWED_ORIGINS.includes(origin)) {
    throw new HttpError(403, 'Request from another site was blocked')
  }
}

// Counts hits per key (IP or username) and refuses once `max` is reached within `windowMs`
function createRateLimiter(max, windowMs, message) {
  const hits = new Map() // key -> { count, resetAt }

  // Forget old entries so the map can't grow forever
  setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of hits) if (entry.resetAt < now) hits.delete(key)
  }, 10 * 60 * 1000).unref()

  return {
    check(key) {
      const entry = hits.get(key)
      if (entry && entry.resetAt >= Date.now() && entry.count >= max) throw new HttpError(429, message)
    },
    hit(key) {
      let entry = hits.get(key)
      if (!entry || entry.resetAt < Date.now()) {
        entry = { count: 0, resetAt: Date.now() + windowMs }
        hits.set(key, entry)
      }
      entry.count++
    },
  }
}

const MINUTE = 60 * 1000
const failedLoginLimit = createRateLimiter(10, 15 * MINUTE, 'Too many failed logins. Try again in 15 minutes.')
const signupLimit = createRateLimiter(5, 60 * MINUTE, 'Too many new accounts from your network. Try again later.')
const gameWriteLimit = createRateLimiter(30, 10 * MINUTE, 'Too many changes. Please wait a few minutes.')

// ---------- Games ----------

function cleanGame(body) {
  const game = {}
  for (const [field, maxLength] of Object.entries(GAME_FIELDS)) {
    const value = typeof body[field] === 'string' ? body[field].trim() : ''
    if (!value) throw new HttpError(400, `${field} is required`)
    if (value.length > maxLength) throw new HttpError(400, `${field} is too long`)
    game[field] = value
  }
  if (!/^\d*\.?\d+$/.test(game.price)) throw new HttpError(400, 'Price must be a number')
  try {
    if (!['http:', 'https:'].includes(new URL(game.poster).protocol)) throw new Error()
  } catch {
    throw new HttpError(400, 'Poster must be an http(s) link')
  }
  return game
}

function findGameIndex(games, id) {
  const index = games.findIndex(game => game.id === id)
  if (index === -1) throw new HttpError(404, 'Game not found')
  return index
}

// Games listed by an account can only be changed by that account.
// Games without an owner (added before accounts existed) can be changed by any logged-in user.
function checkCanEdit(game, username) {
  if (game.owner && game.owner !== username) {
    throw new HttpError(403, 'You can only change games you listed')
  }
}

// ---------- HTTP helpers ----------

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

function readJsonBody(req) {
  // Only JSON bodies are accepted, which also stops plain HTML forms on other sites from posting here
  if (!(req.headers['content-type'] || '').startsWith('application/json')) {
    return Promise.reject(new HttpError(415, 'Expected JSON'))
  }
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request is too large'))
        req.destroy()
      } else {
        chunks.push(chunk)
      }
    })
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        resolve(body && typeof body === 'object' ? body : {})
      } catch {
        reject(new HttpError(400, 'Invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

// ---------- API routes ----------

async function handleApi(req, res, pathname) {
  const method = req.method
  const gameMatch = pathname.match(/^\/api\/games\/([A-Za-z0-9_-]+)$/)

  if (method !== 'GET') checkOrigin(req)

  if (pathname === '/api/me' && method === 'GET') {
    const username = getCurrentUser(req)
    return username ? sendJson(res, 200, { username }) : sendJson(res, 401, { error: 'Not logged in' })
  }

  if (pathname === '/api/register' && method === 'POST') {
    const ip = getClientIp(req)
    signupLimit.check(ip)
    const { username, password } = validateCredentials(await readJsonBody(req))
    const { salt, hash } = await hashPassword(password)
    await usersStore.update(users => {
      if (findUser(users, username)) throw new HttpError(409, 'That username is taken')
      users.push({ username, salt, hash, createdAt: new Date().toISOString() })
    })
    signupLimit.hit(ip)
    createSession(res, username)
    return sendJson(res, 201, { username })
  }

  if (pathname === '/api/login' && method === 'POST') {
    const ip = getClientIp(req)
    failedLoginLimit.check(ip)
    const body = await readJsonBody(req)
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const user = findUser(await usersStore.read(), username)
    if (!user || !(await isCorrectPassword(password, user))) {
      failedLoginLimit.hit(ip)
      throw new HttpError(401, 'Wrong username or password')
    }
    createSession(res, user.username)
    return sendJson(res, 200, { username: user.username })
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const token = getSessionToken(req)
    if (token) sessions.delete(token)
    res.setHeader('Set-Cookie', sessionCookie('', 0))
    return sendJson(res, 200, { ok: true })
  }

  if (pathname === '/api/games' && method === 'GET') {
    return sendJson(res, 200, await gamesStore.read())
  }

  if (gameMatch && method === 'GET') {
    const games = await gamesStore.read()
    return sendJson(res, 200, games[findGameIndex(games, gameMatch[1])])
  }

  // Everything below changes games: logged-in users only, with a per-user limit
  const isGameWrite = (pathname === '/api/games' && method === 'POST')
    || (gameMatch && (method === 'PUT' || method === 'DELETE'))
  if (!isGameWrite) throw new HttpError(404, 'Not found')

  const username = requireUser(req)
  gameWriteLimit.check(username)
  const changes = method === 'DELETE' ? null : cleanGame(await readJsonBody(req))
  gameWriteLimit.hit(username)

  if (method === 'POST') {
    const newGame = await gamesStore.update(games => {
      const nextId = games.reduce((max, game) => Math.max(max, Number(game.id) || 0), 0) + 1
      const game = { id: String(nextId), ...changes, owner: username, createdAt: new Date().toISOString() }
      games.push(game)
      return game
    })
    return sendJson(res, 201, newGame)
  }

  if (method === 'PUT') {
    const game = await gamesStore.update(games => {
      const index = findGameIndex(games, gameMatch[1])
      checkCanEdit(games[index], username)
      games[index] = { ...games[index], ...changes, updatedAt: new Date().toISOString() }
      return games[index]
    })
    return sendJson(res, 200, game)
  }

  const deleted = await gamesStore.update(games => {
    const index = findGameIndex(games, gameMatch[1])
    checkCanEdit(games[index], username)
    return games.splice(index, 1)[0]
  })
  return sendJson(res, 200, deleted)
}

// ---------- Static files ----------

async function serveStatic(res, pathname) {
  if (pathname.endsWith('/')) pathname += 'index.html'
  const filePath = path.join(ROOT, pathname)
  const relative = path.relative(ROOT, filePath)
  const firstPart = relative.split(path.sep)[0]

  // Never serve files outside the site, dotfiles (.git), account data or server code
  const isPrivate = relative.startsWith('..') || path.isAbsolute(relative)
    || relative.split(path.sep).some(part => part.startsWith('.'))
    || ['data', 'node_modules', 'server.js', 'package.json', 'package-lock.json'].includes(firstPart)

  try {
    if (isPrivate) throw new Error('private')
    const content = await fsp.readFile(filePath)
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    })
    res.end(content)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not found')
  }
}

const server = http.createServer(async (req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value)

  // Behind an HTTPS proxy in production, send plain-http visitors to the https address
  if (IS_PRODUCTION && TRUST_PROXY && req.headers['x-forwarded-proto'] === 'http') {
    const host = req.headers['x-forwarded-host'] || req.headers.host
    res.writeHead(301, { Location: `https://${host}${req.url}` })
    return res.end()
  }

  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
  } catch {
    res.writeHead(400)
    return res.end('Bad request')
  }

  if (!pathname.startsWith('/api/')) return serveStatic(res, pathname)

  try {
    await handleApi(req, res, pathname)
  } catch (error) {
    if (!(error instanceof HttpError)) console.error(error)
    const status = error instanceof HttpError ? error.status : 500
    sendJson(res, status, { error: status === 500 ? 'Something went wrong on the server' : error.message })
  }
})

server.listen(PORT, () => {
  console.log(`PixelPursuit running at http://localhost:${PORT}${IS_PRODUCTION ? ' (production mode)' : ''}`)
})

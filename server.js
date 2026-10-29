// PixelPursuit server: serves the site, stores accounts in data/users.json
// and passes product requests on to mockapi.io (writes need a logged-in user)
const http = require('http')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { promisify } = require('util')

const scrypt = promisify(crypto.scrypt)

const PORT = Number(process.env.PORT) || 8080
const ROOT = __dirname
const USERS_FILE = process.env.USERS_FILE || path.join(ROOT, 'data', 'users.json')
const PRODUCTS_API_URL = process.env.PRODUCTS_API_URL || 'https://65c5df9fe5b94dfca2e0746b.mockapi.io/PixelPursuit'

const SESSION_MAX_AGE = 7 * 24 * 60 * 60 // seconds
const MAX_BODY_BYTES = 10000
const MAX_FAILED_LOGINS = 10 // per IP, per 15 minutes

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

// Max length of each product field (same limits as the form)
const GAME_FIELDS = { title: 30, price: 6, poster: 500, description: 200, whereToBuy: 70 }

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// ---------- Accounts (data/users.json) ----------

async function readUsers() {
  try {
    return JSON.parse(await fsp.readFile(USERS_FILE, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function writeUsers(users) {
  await fsp.mkdir(path.dirname(USERS_FILE), { recursive: true })
  const tempFile = USERS_FILE + '.tmp'
  await fsp.writeFile(tempFile, JSON.stringify(users, null, 2))
  await fsp.rename(tempFile, USERS_FILE)
}

// Runs read-change-write one at a time so two sign-ups can't overwrite each other
let usersLock = Promise.resolve()
function updateUsers(change) {
  const run = usersLock.then(async () => {
    const users = await readUsers()
    const result = await change(users)
    await writeUsers(users)
    return result
  })
  usersLock = run.catch(() => {})
  return run
}

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

function createSession(res, username) {
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, { username, expires: Date.now() + SESSION_MAX_AGE * 1000 })
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`)
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

// Slows down password guessing: too many failed logins from one IP are refused for a while
const failedLogins = new Map() // ip -> { count, resetAt }

function checkLoginLimit(ip) {
  const entry = failedLogins.get(ip)
  if (entry && entry.resetAt < Date.now()) failedLogins.delete(ip)
  else if (entry && entry.count >= MAX_FAILED_LOGINS) {
    throw new HttpError(429, 'Too many failed logins. Try again in 15 minutes.')
  }
}

function recordFailedLogin(ip) {
  const entry = failedLogins.get(ip) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 }
  entry.count++
  failedLogins.set(ip, entry)
}

// ---------- Products (mockapi.io) ----------

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

async function productsApi(method, id, body) {
  const url = id ? `${PRODUCTS_API_URL}/${encodeURIComponent(id)}` : PRODUCTS_API_URL
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  // mockapi answers 500 (not 404) for ids that were deleted
  if (id && (response.status === 404 || response.status === 500)) throw new HttpError(404, 'Game not found')
  if (!response.ok) throw new HttpError(502, 'The product service is not responding. Please try again later.')
  return response.json()
}

// Games listed by an account can only be changed by that account.
// Older games have no owner, so any logged-in user may change them.
async function getEditableGame(id, username) {
  const game = await productsApi('GET', id)
  if (game.owner && game.owner !== username) {
    throw new HttpError(403, 'You can only change games you listed')
  }
  return game
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

  if (pathname === '/api/me' && method === 'GET') {
    const username = getCurrentUser(req)
    return username ? sendJson(res, 200, { username }) : sendJson(res, 401, { error: 'Not logged in' })
  }

  if (pathname === '/api/register' && method === 'POST') {
    const { username, password } = validateCredentials(await readJsonBody(req))
    const { salt, hash } = await hashPassword(password)
    await updateUsers(users => {
      if (findUser(users, username)) throw new HttpError(409, 'That username is taken')
      users.push({ username, salt, hash, createdAt: new Date().toISOString() })
    })
    createSession(res, username)
    return sendJson(res, 201, { username })
  }

  if (pathname === '/api/login' && method === 'POST') {
    const ip = req.socket.remoteAddress
    checkLoginLimit(ip)
    const body = await readJsonBody(req)
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const user = findUser(await readUsers(), username)
    if (!user || !(await isCorrectPassword(password, user))) {
      recordFailedLogin(ip)
      throw new HttpError(401, 'Wrong username or password')
    }
    createSession(res, user.username)
    return sendJson(res, 200, { username: user.username })
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const token = getSessionToken(req)
    if (token) sessions.delete(token)
    res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
    return sendJson(res, 200, { ok: true })
  }

  if (pathname === '/api/games' && method === 'GET') {
    return sendJson(res, 200, await productsApi('GET'))
  }

  if (pathname === '/api/games' && method === 'POST') {
    const username = requireUser(req)
    const game = cleanGame(await readJsonBody(req))
    return sendJson(res, 201, await productsApi('POST', null, { ...game, owner: username }))
  }

  if (gameMatch && method === 'GET') {
    return sendJson(res, 200, await productsApi('GET', gameMatch[1]))
  }

  if (gameMatch && method === 'PUT') {
    const username = requireUser(req)
    const game = cleanGame(await readJsonBody(req))
    await getEditableGame(gameMatch[1], username)
    return sendJson(res, 200, await productsApi('PUT', gameMatch[1], game))
  }

  if (gameMatch && method === 'DELETE') {
    const username = requireUser(req)
    await getEditableGame(gameMatch[1], username)
    return sendJson(res, 200, await productsApi('DELETE', gameMatch[1]))
  }

  throw new HttpError(404, 'Not found')
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
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(content)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not found')
  }
}

const server = http.createServer(async (req, res) => {
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
  console.log(`PixelPursuit running at http://localhost:${PORT}`)
})

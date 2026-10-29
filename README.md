# PixelPursuit

A small game store built with plain HTML, CSS (Sass) and JavaScript, plus a tiny Node server
(no npm packages needed) for accounts.

## Running

Needs Node.js 18 or newer.

```bash
npm start
```

Then open http://localhost:8080. Use a different port with the `PORT` environment variable.

## Pages

- `index.html`: lists all games, sorted by price. Click a card to open it.
- `accountPage/account.html`: log in or create an account (username + password).
- `formPage/form.html`: list a new game (logged-in users only). `form.html?id=…` edits a game.
- `productPage/product.html?id=…`: details of one game. Edit and Delete show for the account that listed it.

## How it works

- **Accounts** are saved in `data/users.json` (created on first sign-up, not committed to git).
  Passwords are never stored: each user gets a random salt and a scrypt hash of salt + password.
- **Login** sets an HttpOnly session cookie that lasts 7 days. Sessions are kept in memory,
  so restarting the server logs everyone out.
- **Games** are saved in `data/games.json`. Only logged-in users can add games, and only the
  account that listed a game can edit or delete it.
- Both JSON files are written one change at a time (write to a temp file, then rename), so
  requests can't overwrite each other. Back up the `data/` folder.

## Security

- Every response sends a Content-Security-Policy (only the site's own scripts run), plus
  `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy`.
- Changes (`POST`/`PUT`/`DELETE`) must come with an `Origin` header from this site.
- Rate limits: 10 failed logins per IP per 15 minutes, 5 sign-ups per IP per hour,
  30 game changes per user per 10 minutes.

| Endpoint | What it does |
| --- | --- |
| `POST /api/register` | Create an account `{ username, password }` and log in |
| `POST /api/login` | Log in `{ username, password }` |
| `POST /api/logout` | Log out |
| `GET /api/me` | Who is logged in |
| `GET /api/games`, `GET /api/games/:id` | Read games |
| `POST /api/games`, `PUT /api/games/:id`, `DELETE /api/games/:id` | Change games (login needed) |

## Styles

`style.css` is compiled from `style.sass`. After editing the Sass file run `npm run sass`.
The other pages use plain CSS (`formPage/form.css` is shared by the form and account pages).

## Running in production

Put the server behind HTTPS (most hosts do this for you) and set:

| Variable | Value | Why |
| --- | --- | --- |
| `NODE_ENV` | `production` | Adds the `Secure` flag to the login cookie and sends HSTS |
| `TRUST_PROXY` | `1` (number of proxies in front) | Rate limits use the visitor's real IP from `X-Forwarded-For`, and plain-http visitors are sent to https. Leave unset if nothing sits in front of the server, because the header can be faked |
| `ALLOWED_ORIGINS` | e.g. `https://pixelpursuit.example.com` | Only needed if the proxy changes the `Host` header |
| `DATA_DIR` | a folder outside the app | Where `users.json` and `games.json` live (default `./data`) |
| `PORT` | e.g. `8080` | Port to listen on |

Run it with a process manager (systemd, pm2 or the host's own) so it restarts after a crash,
as a normal user (not root/administrator).

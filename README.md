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
- **Games** are stored in a [mockapi.io](https://mockapi.io) project. The browser talks only to
  `/api/games` on this server, which checks who is logged in before adding, editing or deleting.
  New games record their owner. Older games without an owner can be edited by any logged-in user.

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

## Note

The mockapi URL itself is public and has no login. Anyone who finds it in `server.js` can still change
games directly, so the server's checks only protect people who use the site.

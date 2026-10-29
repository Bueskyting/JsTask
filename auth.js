// Shared by every page: talks to the server API and shows "Log in" or "Hi, name / Log out"

// Sends a JSON request to the server and returns the JSON answer, or throws with the server's error message
function apiRequest(method, url, body) {
  const options = { method, headers: {} }
  if (method !== 'GET') {
    options.headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body || {})
  }
  return fetch(url, options).then(response =>
    response.json()
      .catch(() => ({}))
      .then(data => {
        if (!response.ok) {
          const error = new Error(data.error || 'Something went wrong. Please try again.')
          error.status = response.status
          throw error
        }
        return data
      })
  )
}

// Resolves to the logged-in username, or null
const currentUserPromise = apiRequest('GET', '/api/me')
  .then(data => data.username)
  .catch(() => null)

// Fills <div class="account-links" data-base="../"> (data-base is the path back to the site root)
function renderAccountLinks() {
  const container = document.querySelector('.account-links')
  if (!container) return
  const base = container.dataset.base || ''

  currentUserPromise.then(username => {
    container.innerHTML = ''

    if (username) {
      const nameElement = document.createElement('span')
      nameElement.classList.add('account-name')
      nameElement.textContent = 'Hi, ' + username

      const logoutButton = document.createElement('button')
      logoutButton.type = 'button'
      logoutButton.classList.add('account-button')
      logoutButton.textContent = 'Log out'
      logoutButton.addEventListener('click', () => {
        apiRequest('POST', '/api/logout').finally(() => window.location.reload())
      })

      container.append(nameElement, logoutButton)
    } else {
      const loginLink = document.createElement('a')
      loginLink.classList.add('account-button')
      loginLink.href = base + 'accountPage/account.html?next=' + encodeURIComponent(location.pathname + location.search)
      loginLink.textContent = 'Log in / Sign up'
      container.append(loginLink)
    }
  })
}

renderAccountLinks()

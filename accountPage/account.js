const loginForm = document.getElementById('loginForm')
const registerForm = document.getElementById('registerForm')
const accountHeading = document.getElementById('accountHeading')

// Where to go after logging in: only paths on this site are allowed
function getNextPage() {
  const next = new URLSearchParams(window.location.search).get('next') || ''
  return /^\/(?![/\\])/.test(next) ? next : '../index.html'
}

// Already logged in: nothing to do here
currentUserPromise.then(username => {
  if (username) window.location.replace(getNextPage())
})

function showForm(name) {
  const showRegister = name === 'register'
  loginForm.hidden = showRegister
  registerForm.hidden = !showRegister
  accountHeading.textContent = showRegister ? 'Create account' : 'Log in'
  document.title = accountHeading.textContent + ' – PixelPursuit'
  ;(showRegister ? registerForm : loginForm).querySelector('input').focus()
}

document.querySelectorAll('[data-show]').forEach(button => {
  button.addEventListener('click', () => showForm(button.dataset.show))
})

// Both forms send { username, password } and go to the next page on success
function handleAccountForm(form, url) {
  form.addEventListener('submit', event => {
    event.preventDefault()

    const submitButton = form.querySelector('button[type="submit"]')
    const errorElement = form.querySelector('.form-error')
    const formData = new FormData(form)

    submitButton.disabled = true
    errorElement.textContent = ''

    apiRequest('POST', url, {
      username: formData.get('username').trim(),
      password: formData.get('password'),
    })
      .then(() => window.location.assign(getNextPage()))
      .catch(error => {
        errorElement.textContent = error.message
        submitButton.disabled = false
      })
  })
}

handleAccountForm(loginForm, '/api/login')
handleAccountForm(registerForm, '/api/register')

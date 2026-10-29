const HOME_URL = '../index.html'

const gameId = new URLSearchParams(window.location.search).get('id')
const gameDescriptionElement = document.getElementById('game-description')
const messageElement = gameDescriptionElement.querySelector('.product-message')

function showMessage(text) {
  messageElement.textContent = text
}

// Shows "$ 69.96" for numeric prices, the raw value otherwise
function formatPrice(price) {
  const number = Number(price)
  return Number.isFinite(number) ? '$ ' + number.toFixed(2) : '$ ' + price
}

// Only real http(s) links become clickable, anything else stays plain text
function toSafeUrl(text) {
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function addTextElement(parent, tag, className, text) {
  const element = document.createElement(tag)
  element.classList.add(className)
  element.textContent = text
  parent.appendChild(element)
  return element
}

function displayGame(game, username) {
  document.title = game.title + ' – PixelPursuit'

  const gameCard = document.createElement('article')
  gameCard.classList.add('game-card')

  const posterElement = document.createElement('img')
  posterElement.src = game.poster
  posterElement.alt = 'Poster for ' + game.title
  posterElement.classList.add('game-poster')
  posterElement.addEventListener('error', () => {
    const placeholder = document.createElement('div')
    placeholder.classList.add('game-poster', 'poster-placeholder')
    placeholder.textContent = 'No image'
    posterElement.replaceWith(placeholder)
  })
  gameCard.appendChild(posterElement)

  const details = document.createElement('div')
  details.classList.add('game-details')

  addTextElement(details, 'h1', 'game-title', game.title)
  addTextElement(details, 'p', 'game-price', formatPrice(game.price))
  addTextElement(details, 'p', 'game-text', game.description || 'No description yet.')

  const whereToBuyElement = addTextElement(details, 'p', 'game-text', 'Where To Buy: ')
  const whereToBuyUrl = toSafeUrl(game.whereToBuy)
  if (whereToBuyUrl) {
    const link = document.createElement('a')
    link.href = whereToBuyUrl
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = game.whereToBuy
    whereToBuyElement.appendChild(link)
  } else {
    whereToBuyElement.append(game.whereToBuy || 'Unknown')
  }

  addTextElement(details, 'p', 'game-id', (game.owner ? 'Listed by ' + game.owner + ' · ' : '') + 'ID: ' + game.id)

  // Edit and Delete only for the account that listed the game (older games have no owner)
  if (username && (!game.owner || game.owner === username)) {
    const actions = document.createElement('div')
    actions.classList.add('game-actions')

    const editLink = document.createElement('a')
    editLink.href = '../formPage/form.html?id=' + encodeURIComponent(game.id)
    editLink.textContent = 'Edit'
    editLink.classList.add('edit-button')
    actions.appendChild(editLink)

    const deleteButton = document.createElement('button')
    deleteButton.type = 'button'
    deleteButton.textContent = 'Delete'
    deleteButton.classList.add('delete-button')
    deleteButton.addEventListener('click', () => deleteGame(game, deleteButton))
    actions.appendChild(deleteButton)

    details.appendChild(actions)
  } else if (!username) {
    addTextElement(details, 'p', 'game-id', 'Log in to edit games you listed.')
  }

  gameCard.appendChild(details)
  gameDescriptionElement.insertBefore(gameCard, messageElement)
  showMessage('')
}

if (!gameId) {
  showMessage('No game selected. Go back to the home page and pick one.')
} else {
  Promise.all([apiRequest('GET', '/api/games/' + encodeURIComponent(gameId)), currentUserPromise])
    .then(([game, username]) => displayGame(game, username))
    .catch(error => {
      console.error('Error fetching game details:', error)
      showMessage(error.message)
    })
}

function deleteGame(game, deleteButton) {
  if (!confirm(`Delete "${game.title}"? This can't be undone.`)) return

  deleteButton.disabled = true

  apiRequest('DELETE', '/api/games/' + encodeURIComponent(game.id))
    .then(() => {
      showMessage('Game deleted successfully, redirecting to home page!')
      setTimeout(() => {
        window.location.href = HOME_URL
      }, 3000) // 3 seconds delay until user gets redirected to home page
    })
    .catch(error => {
      console.error('Error deleting the game:', error)
      showMessage('Failed to delete the game: ' + error.message)
      deleteButton.disabled = false
    })
}

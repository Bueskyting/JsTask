const gamesListElement = document.getElementById('games-list')
const gamesStatusElement = document.getElementById('games-status')

document.getElementById('year').textContent = new Date().getFullYear()

// Shows "$ 69.96" for numeric prices, the raw value otherwise
function formatPrice(price) {
  const number = Number(price)
  return Number.isFinite(number) ? '$ ' + number.toFixed(2) : '$ ' + price
}

// Swaps a broken poster for a "No image" placeholder
function showPosterPlaceholder(posterElement) {
  const placeholder = document.createElement('div')
  placeholder.classList.add('game-poster', 'poster-placeholder')
  placeholder.textContent = 'No image'
  posterElement.replaceWith(placeholder)
}

function displayGames() {
  apiRequest('GET', '/api/games')
    .then(games => {
      games.sort((a, b) => Number(a.price) - Number(b.price))

      gamesListElement.innerHTML = ''
      gamesStatusElement.textContent = games.length ? '' : 'No games listed yet. Be the first to add one!'

      games.forEach(game => {
        const gameCard = document.createElement('article')
        gameCard.classList.add('game-card')

        // The whole card links to the product page
        const cardLink = document.createElement('a')
        cardLink.href = 'productPage/product.html?id=' + encodeURIComponent(game.id)

        const posterElement = document.createElement('img')
        posterElement.src = game.poster
        posterElement.alt = '' // title is already in the link text
        posterElement.loading = 'lazy'
        posterElement.classList.add('game-poster')
        posterElement.addEventListener('error', () => showPosterPlaceholder(posterElement))
        cardLink.appendChild(posterElement)

        const titleElement = document.createElement('h2')
        titleElement.textContent = game.title
        cardLink.appendChild(titleElement)

        const priceElement = document.createElement('p')
        priceElement.classList.add('game-price')
        priceElement.textContent = formatPrice(game.price)
        cardLink.appendChild(priceElement)

        gameCard.appendChild(cardLink)
        gamesListElement.appendChild(gameCard)
      })
    })
    .catch(error => {
      console.error('Error fetching games:', error)
      gamesStatusElement.textContent = 'Could not load games. Please try again later.'
    })
}

displayGames()

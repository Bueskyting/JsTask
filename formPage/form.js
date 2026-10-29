// form.html lists a new product, form.html?id=3 edits product 3
const gameId = new URLSearchParams(window.location.search).get('id')
const isEditing = Boolean(gameId)
const GAME_FIELDS = ['title', 'price', 'poster', 'description', 'whereToBuy']

const itemForm = document.getElementById('itemForm')
const submitButton = document.getElementById('submitButton')
const screenEffect = document.getElementById('screenEffect')
const formMessage = document.getElementById('formMessage')
const formNotice = document.getElementById('formNotice')
const formHeading = document.getElementById('formHeading')

function showFormMessage(text, type) {
    formMessage.textContent = text
    formMessage.className = type
}

// Replaces the form with a message (optionally ending in a link)
function showNotice(text, linkText, linkHref) {
    formNotice.textContent = text
    if (linkText) {
        const link = document.createElement('a')
        link.href = linkHref
        link.textContent = linkText
        formNotice.append(' ', link)
    }
    formNotice.hidden = false
    itemForm.hidden = true
}

// Only logged-in users get the form; in edit mode it is filled with the current values
currentUserPromise.then(username => {
    if (!username) {
        const loginUrl = '../accountPage/account.html?next=' + encodeURIComponent(location.pathname + location.search)
        showNotice(`You need to be logged in to ${isEditing ? 'edit' : 'list'} products.`, 'Log in or create an account', loginUrl)
        return
    }

    if (!isEditing) {
        itemForm.hidden = false
        return
    }

    formHeading.textContent = 'Edit product'
    document.title = 'Edit product – PixelPursuit'
    submitButton.querySelector('span').textContent = 'Save changes'

    apiRequest('GET', '/api/games/' + encodeURIComponent(gameId))
        .then(game => {
            if (game.owner && game.owner !== username) {
                showNotice('You can only edit games you listed.')
                return
            }
            GAME_FIELDS.forEach(field => {
                itemForm.elements[field].value = game[field] || ''
            })
            itemForm.hidden = false
        })
        .catch(error => showNotice(error.message, 'Back to the home page', '../index.html'))
})

itemForm.addEventListener('submit', function(event) {
    event.preventDefault()

    // Display screen effect and block double submits
    screenEffect.style.display = 'block'
    submitButton.disabled = true
    showFormMessage('', '')

    const formData = new FormData(this)
    const newItem = {}
    formData.forEach((value, key) => {
        newItem[key] = value.trim()
    })

    // Sending data to the server, which passes it on to the API
    const request = isEditing
        ? apiRequest('PUT', '/api/games/' + encodeURIComponent(gameId), newItem)
        : apiRequest('POST', '/api/games', newItem)

    request
    .then(() => {
        if (isEditing) {
            window.location.assign('../productPage/product.html?id=' + encodeURIComponent(gameId))
            return
        }
        showFormMessage('Your product has been listed successfully!', 'success')
        this.reset()
    })
    .catch(error => {
        console.error('Error:', error)
        showFormMessage(error.message, 'error')
    })
    .finally(() => {
        // Hide screen effect regardless of success or failure
        screenEffect.style.display = 'none'
        submitButton.disabled = false
    })
})

// Only allow numbers and 1 dot
function validatePrice(input) {

    input.value = input.value.replace(/[^0-9.]/g, '')

    input.value = input.value.replace(/^0+(?=\d)/, '')

    // Keep the first dot, drop the rest
    const [whole, ...decimals] = input.value.split('.')
    input.value = decimals.length ? whole + '.' + decimals.join('') : whole
}

document.getElementById('price').addEventListener('input', event => validatePrice(event.target))

// Clear input field if any of these words were ever used, keep in mind that the whole text is going to be deleted in case of inappropriate language
const textFilter = document.getElementById('textFilter')
const explicitWords = ['n word', 'b word', 'i word'] // An array of explicit words (no empty strings, they match everything)

const filteredFields = ['title', 'poster', 'description', 'whereToBuy']
filteredFields.forEach(id => {
    document.getElementById(id).addEventListener('input', checkForExplicitWords)
})

function checkForExplicitWords(event) {
    const inputText = event.target.value.toLowerCase()
    const hasExplicitWord = explicitWords.some(word => inputText.includes(word))

    // If explicit word found, clear the field and display message
    if (hasExplicitWord) {
        event.target.value = ''
        textFilter.textContent = 'Please remain polite'
    } else {
        textFilter.textContent = ''
    }
}

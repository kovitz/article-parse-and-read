const express = require('express');
const { parseArticle } = require('./lib/parseArticle');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from the public directory
app.use(express.static('public'));

// Enable CORS for API endpoints
app.use(express.json());

// Article parsing endpoint
app.post('/api/parse', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Parse the article using the shared module
    const article = await parseArticle(url);

    // Return the parsed article with embeds
    res.json(article);

  } catch (error) {
    console.error('Error parsing article:', error);

    // Determine appropriate status code based on error message
    let statusCode = 500;
    if (error.message === 'Invalid URL format') {
      statusCode = 400;
    } else if (error.message === 'Could not extract article content from this URL') {
      statusCode = 400;
    } else if (error.message.includes('Failed to fetch URL')) {
      statusCode = error.message.includes('403') ? 403 : 500;
    }

    res.status(statusCode).json({ error: error.message || 'An error occurred while parsing the article' });
  }
});

// Serve index.html for root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Article Reader server running on http://localhost:${PORT}`);
});

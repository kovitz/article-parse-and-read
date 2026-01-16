const { parseArticle } = require('../../lib/parseArticle');

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const body = JSON.parse(event.body);
    const { url } = body;

    if (!url) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ error: 'URL is required' }),
      };
    }

    // Parse the article using the shared module
    const article = await parseArticle(url);

    // Return the parsed article with embeds
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(article),
    };

  } catch (error) {
    console.error('Error parsing article:', error);
    console.error('Error stack:', error.stack);
    console.error('Error details:', {
      message: error.message,
      name: error.name,
      statusCode: error.statusCode
    });

    // Determine appropriate status code based on error message
    let statusCode = 500;
    let errorMessage = error.message || 'An error occurred while parsing the article';

    if (error.message === 'Invalid URL format') {
      statusCode = 400;
    } else if (error.message === 'Could not extract article content from this URL') {
      statusCode = 400;
    } else if (error.message.includes('Failed to fetch URL')) {
      statusCode = error.message.includes('403') ? 403 : 500;
    } else if (error.message.includes('Puppeteer')) {
      // Puppeteer errors in serverless environments
      errorMessage = 'This site requires browser automation, but it\'s not available in this environment. ' +
                     'For Medium articles, consider using a different service or running this locally.';
      statusCode = 503; // Service Unavailable
    }

    return {
      statusCode: statusCode,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: errorMessage }),
    };
  }
};

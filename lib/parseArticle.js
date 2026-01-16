const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const fetch = require('node-fetch');

// Try to load Puppeteer (optional dependency for sites that require JavaScript)
let puppeteer = null;
let puppeteerExtra = null;
let stealthPlugin = null;
const isServerless = !!process.env.AWS_LAMBDA_FUNCTION_NAME ||
                     !!process.env.NETLIFY ||
                     !!process.env.VERCEL ||
                     !!process.env.NETLIFY_DEV;

// Puppeteer doesn't work well in serverless environments (Netlify Functions, AWS Lambda, etc.)
// due to size limits and missing Chrome binaries
if (!isServerless) {
  try {
    // Try to use puppeteer-extra with stealth plugin first (better for bypassing Cloudflare)
    puppeteerExtra = require('puppeteer-extra');
    stealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(stealthPlugin());
    puppeteer = puppeteerExtra;
    console.log('Using puppeteer-extra with stealth plugin');
  } catch (e) {
    // Fall back to regular puppeteer if puppeteer-extra is not available
    try {
      puppeteer = require('puppeteer');
      console.log('Using standard puppeteer (stealth plugin not available)');
    } catch (e2) {
      // Puppeteer not installed, will use regular fetch only
      console.log('Puppeteer not available, using regular fetch only');
    }
  }
} else {
  console.log('Serverless environment detected - Puppeteer disabled (not compatible with Netlify Functions)');
}

/**
 * Fetch HTML using Puppeteer (headless browser) for sites that block regular requests
 * @param {string} url - The URL to fetch
 * @returns {Promise<string>} HTML content
 */
async function fetchWithPuppeteer(url) {
  if (!puppeteer) {
    throw new Error('Puppeteer is not installed. Install it with: npm install puppeteer');
  }

  // Check if we're in a serverless environment (Netlify, AWS Lambda, etc.)
  const isServerless = !!process.env.AWS_LAMBDA_FUNCTION_NAME ||
                      !!process.env.NETLIFY ||
                      !!process.env.VERCEL;

  // Use shorter timeout for serverless environments (Netlify Functions max is 26s)
  const timeout = isServerless ? 20000 : 30000;
  const waitUntil = isServerless ? 'domcontentloaded' : 'networkidle2';

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new', // Use new headless mode (less detectable)
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled', // Important: hide automation
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1920,1080',
        // '--disable-web-security', // May help bypass some protections
        '--disable-features=VizDisplayCompositor',
        ...(isServerless ? [
          '--single-process',
          '--no-zygote',
          '--disable-extensions'
        ] : [])
      ],
      ...(isServerless && {
        executablePath: process.env.CHROME_BIN || undefined
      })
    });

    const page = await browser.newPage();

    // Stealth techniques to avoid detection
    // Remove webdriver property
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });

    // Override the plugins property to use a custom getter
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });
    });

    // Override the languages property to include a custom value
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
    });

    // Override the permissions property to use a custom getter
    await page.evaluateOnNewDocument(() => {
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
    });

    // Set a realistic viewport and user agent
    await page.setViewport({
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1
    });

    // Use a more recent Chrome user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Set extra headers to look more like a real browser
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
    });

    // Navigate to the page
    const response = await page.goto(url, {
      waitUntil: waitUntil,
      timeout: timeout
    });

    // Check response status
    if (!response) {
      throw new Error('No response received from page');
    }

    const status = response.status();

    // Wait a moment for page to load
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check if we hit a Cloudflare challenge page
    const isCloudflareChallenge = await page.evaluate(() => {
      const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
      const title = document.title ? document.title.toLowerCase() : '';
      return bodyText.includes('cloudflare') ||
             bodyText.includes('checking your browser') ||
             bodyText.includes('please wait') ||
             bodyText.includes('ddos protection') ||
             bodyText.includes('ray id') ||
             title.includes('just a moment');
    });

    if (isCloudflareChallenge) {
      console.log('Cloudflare challenge detected, waiting for it to complete...');

      // Try to interact with the page to help Cloudflare's JavaScript complete the challenge
      try {
        // Simulate human-like mouse movements and scrolling
        await page.mouse.move(100, 100);
        await new Promise(resolve => setTimeout(resolve, 500));
        await page.mouse.move(200, 200);
        await new Promise(resolve => setTimeout(resolve, 500));

        // Scroll down and up to simulate reading
        await page.evaluate(() => {
          window.scrollTo(0, 300);
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
        await page.evaluate(() => {
          window.scrollTo(0, 0);
        });
        await new Promise(resolve => setTimeout(resolve, 500));

        // Try to find and click any "Verify" or challenge buttons
        try {
          const verifyButton = await page.$('input[type="checkbox"], button:has-text("Verify"), button:has-text("I\'m not a robot"), [class*="challenge"]');
          if (verifyButton) {
            await verifyButton.click();
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        } catch (e) {
          // No verify button found, continue
        }

        // Wait for Cloudflare challenge to complete (can take 10-30 seconds)
        // Look for indicators that challenge passed
        let challengeCompleted = false;
        const maxWaitTime = 30000; // 30 seconds
        const startTime = Date.now();

        while (!challengeCompleted && (Date.now() - startTime) < maxWaitTime) {
          await new Promise(resolve => setTimeout(resolve, 2000)); // Check every 2 seconds

          const challengeStatus = await page.evaluate(() => {
            const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
            const title = document.title ? document.title.toLowerCase() : '';

            // Check if challenge is still present
            const stillChallenged = bodyText.includes('checking your browser') ||
                                   bodyText.includes('please wait') ||
                                   bodyText.includes('ddos protection by cloudflare') ||
                                   bodyText.includes('challenges.cloudflare.com') ||
                                   bodyText.includes('verify you are human') ||
                                   title.includes('just a moment');

            // Check if we've been redirected or content has loaded
            const hasContent = document.querySelector('article, main, [role="main"], .content, .post, .article') !== null;

            return {
              stillChallenged,
              hasContent,
              url: window.location.href
            };
          });

          // If challenge is gone and we have content, we're good
          if (!challengeStatus.stillChallenged && challengeStatus.hasContent) {
            challengeCompleted = true;
            break;
          }

          // If URL changed, challenge might have completed
          if (challengeStatus.url !== url && !challengeStatus.stillChallenged) {
            challengeCompleted = true;
            break;
          }

          // Continue simulating activity
          await page.mouse.move(Math.random() * 500, Math.random() * 500);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (!challengeCompleted) {
          // Final check
          const finalCheck = await page.evaluate(() => {
            const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
            return bodyText.includes('cloudflare') ||
                   bodyText.includes('checking your browser') ||
                   bodyText.includes('verify you are human');
          });

          if (finalCheck) {
            throw new Error('Cloudflare challenge did not complete successfully');
          }
        }

        // Wait a bit more for redirect/content to fully load
        await new Promise(resolve => setTimeout(resolve, 3000));

        console.log('Cloudflare challenge appears to have completed');
      } catch (e) {
        // Challenge didn't complete in time
        const pageContent = await page.evaluate(() => {
          return document.body ? document.body.innerText.substring(0, 500) : 'No content';
        });
        throw new Error(`Cloudflare challenge detected but did not complete in time. The site is using Cloudflare protection which may require manual verification. Page content: ${pageContent.substring(0, 200)}`);
      }
    }

    if (status >= 400 && !isCloudflareChallenge) {
      // Try to get error details from the page
      const errorText = await page.evaluate(() => {
        const errorElement = document.querySelector('body');
        return errorElement ? errorElement.innerText.substring(0, 500) : 'Unknown error';
      });
      throw new Error(`HTTP ${status}: ${response.statusText()}. Page content: ${errorText.substring(0, 200)}`);
    }

    // Wait a bit for dynamic content to load (Medium loads content via JS)
    // Use Promise-based delay instead of deprecated waitForTimeout
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Handle Medium's sign-up modal/popup if it appears
    try {
      // Wait a moment for modal to appear
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Common selectors for Medium modals/popups
      const modalSelectors = [
        'button[aria-label="Close"]',
        'button[data-action="close"]',
        '.overlay button',
        '[data-testid="close-button"]',
        'button[class*="close"]',
        'button[class*="dismiss"]',
        '.overlay-close',
        '[aria-label*="close" i]',
        '[aria-label*="dismiss" i]'
      ];

      // Try to find and close any modals by clicking buttons
      let modalClosed = false;
      for (const selector of modalSelectors) {
        try {
          const closeButton = await page.$(selector);
          if (closeButton) {
            const isVisible = await closeButton.evaluate(el => {
              const style = window.getComputedStyle(el);
              return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            });

            if (isVisible) {
              console.log(`Found visible modal close button with selector: ${selector}`);
              await closeButton.click({ delay: 100 });
              await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for modal to close
              modalClosed = true;
              break;
            }
          }
        } catch (e) {
          // Continue trying other selectors
        }
      }

      // Alternative: Press Escape key to close modals
      if (!modalClosed) {
        await page.keyboard.press('Escape');
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Try to click outside modal to dismiss it (click on body)
      try {
        await page.evaluate(() => {
          // Click on a non-modal element to dismiss overlay
          const body = document.body;
          if (body) {
            body.click();
          }
        });
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (e) {
        // Ignore errors
      }

      // Scroll down a bit to trigger lazy loading and ensure content is visible
      await page.evaluate(() => {
        window.scrollTo(0, 300);
      });
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (e) {
      console.log('Error handling modal:', e.message);
    }

    // Wait for article content to appear (Medium-specific)
    try {
      await page.waitForSelector('article, [role="article"], .postArticle, .postArticle-content', {
        timeout: 10000
      }).catch(() => {
        // If article selector doesn't appear, continue anyway
        console.log('Article selector not found, continuing with page content');
      });
    } catch (e) {
      // Continue even if selector wait fails
      console.log('Waiting for article content timed out, using available content');
    }

    // Additional wait to ensure content is fully loaded after modal dismissal
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Get the HTML content
    const html = await page.content();
    return html;
  } catch (error) {
    // Provide more detailed error information
    const errorMessage = error.message || 'Unknown error';
    const errorDetails = {
      message: errorMessage,
      isServerless: isServerless,
      timeout: timeout,
      waitUntil: waitUntil
    };
    console.error('Puppeteer error details:', errorDetails);
    throw new Error(`Puppeteer failed: ${errorMessage}. ${isServerless ? 'Serverless environment detected - Puppeteer may not be fully supported.' : ''}`);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('Error closing browser:', closeError);
      }
    }
  }
}

/**
 * Fetch HTML using regular fetch with browser-like headers
 * @param {string} url - The URL to fetch
 * @returns {Promise<string>} HTML content
 */
async function fetchWithHeaders(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
      'Referer': 'https://www.google.com/'
    },
    redirect: 'follow'
  });

  if (!response.ok) {
    const error = new Error(`Failed to fetch URL: ${response.statusText}`);
    error.statusCode = response.status;
    throw error;
  }

  return await response.text();
}

/**
 * Check if a URL is from a domain that typically requires JavaScript/browser rendering
 * @param {string} url - The URL to check
 * @returns {boolean}
 */
function requiresBrowserRendering(url) {
  const hostname = new URL(url).hostname.toLowerCase();
  const jsRequiredDomains = [
    'medium.com',
    'substack.com',
    'dev.to'
  ];

  return jsRequiredDomains.some(domain => hostname.includes(domain));
}

/**
 * Parse an article from a URL
 * @param {string} url - The URL of the article to parse
 * @returns {Promise<Object>} Parsed article data with title, content, excerpt, byline, and siteName
 * @throws {Error} If the URL is invalid, fetch fails, or article cannot be parsed
 */
async function parseArticle(url) {
  // Validate URL format
  let articleUrl;
  try {
    articleUrl = new URL(url);
  } catch (e) {
    throw new Error('Invalid URL format');
  }

  let html;
  const needsBrowser = requiresBrowserRendering(url);

  // Try fetching with regular headers first
  try {
    html = await fetchWithHeaders(articleUrl.toString());
  } catch (error) {
    // If fetch fails with 403/Forbidden or 500, try Puppeteer for ANY site (not just Medium-like sites)
    const isBlocked = error.statusCode === 403 ||
                     error.statusCode === 500 ||
                     error.message.includes('Forbidden') ||
                     error.message.includes('403') ||
                     error.message.includes('500');

    // Try Puppeteer if available, regardless of domain (any site might block automated requests)
    if (isBlocked && puppeteer) {
      console.log(`Regular fetch failed (${error.statusCode || 'unknown'}) for ${articleUrl.hostname}, trying Puppeteer...`);
      try {
        html = await fetchWithPuppeteer(articleUrl.toString());
      } catch (puppeteerError) {
        // If Puppeteer also gets a 500, site is likely blocking automated access
        if (puppeteerError.message.includes('500') || puppeteerError.message.includes('HTTP 500')) {
          throw new Error(`Site returned a 500 error, likely due to anti-bot protection. Try: 1) Wait a few minutes and try again, 2) Use a different article URL, or 3) Access the article in a regular browser first to verify it's publicly accessible. Original error: ${error.message}`);
        }
        throw new Error(`Failed to fetch URL with browser automation: ${puppeteerError.message}. Original error: ${error.message}`);
      }
    } else if (isBlocked && !puppeteer) {
      // Site blocked the request but Puppeteer isn't available
      if (isServerless) {
        throw new Error(`Failed to fetch URL: ${error.message}. This site blocked automated requests and requires browser automation, which is not available in serverless environments like Netlify Functions. Please use the local server (npm start) instead, or use a different article URL.`);
      } else {
        throw new Error(`Failed to fetch URL: ${error.message}. This site blocked automated requests and requires browser automation. Install Puppeteer with: npm install puppeteer`);
      }
    } else {
      // Re-throw the original error if it's not a blocking error
      throw error;
    }
  }

  // Parse HTML with JSDOM
  const dom = new JSDOM(html, {
    url: articleUrl.toString()
  });

  const document = dom.window.document;

  // Extract YouTube and Twitter/X embeds before parsing
  const embeds = [];

  // Find YouTube embeds - multiple strategies
  // Strategy 1: Direct iframe embeds
  const youtubeIframes = document.querySelectorAll('iframe[src*="youtube.com"], iframe[src*="youtu.be"], iframe[src*="youtube-nocookie.com"]');
  youtubeIframes.forEach(iframe => {
    // Include parent wrapper if it exists (common pattern)
    let embedElement = iframe;
    const parent = iframe.parentElement;
    if (parent && (parent.classList.contains('youtube') || parent.classList.contains('video') ||
        parent.classList.contains('embed') || parent.getAttribute('data-youtube-id'))) {
      embedElement = parent;
    }

    const html = embedElement.outerHTML;
    if (html && !embeds.some(e => e.html === html)) {
      embeds.push({
        type: 'youtube',
        html: html,
        element: embedElement,
        iframe: iframe
      });
    }
  });

  // Strategy 2: Look for divs with YouTube data attributes or classes
  const youtubeDivs = document.querySelectorAll('div[data-youtube-id], div[data-youtube-url], div.youtube, div[class*="youtube"], div[class*="video-embed"]');
  youtubeDivs.forEach(div => {
    // Check if it contains an iframe or has YouTube data
    const iframe = div.querySelector('iframe[src*="youtube"], iframe[src*="youtu.be"]');
    const youtubeId = div.getAttribute('data-youtube-id') || div.getAttribute('data-youtube-url');

    if (iframe) {
      // Already handled above, skip
      return;
    }

    if (youtubeId) {
      // Extract video ID from various formats
      let videoId = youtubeId;
      if (youtubeId.includes('youtube.com/watch?v=')) {
        videoId = youtubeId.split('v=')[1]?.split('&')[0];
      } else if (youtubeId.includes('youtu.be/')) {
        videoId = youtubeId.split('youtu.be/')[1]?.split('?')[0];
      }

      if (videoId) {
        const embedUrl = `https://www.youtube.com/embed/${videoId}`;
        const embedHtml = `<iframe src="${embedUrl}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;

        if (!embeds.some(e => e.videoId === videoId)) {
          embeds.push({
            type: 'youtube',
            html: embedHtml,
            element: div,
            videoId: videoId,
            isGenerated: true
          });
        }
      }
    }
  });

  // Strategy 3: Look for YouTube links that might be embeds
  const youtubeLinks = document.querySelectorAll('a[href*="youtube.com/watch"], a[href*="youtu.be/"]');
  youtubeLinks.forEach(link => {
    const href = link.getAttribute('href');
    if (!href) return;

    // Extract video ID
    let videoId = null;
    if (href.includes('youtube.com/watch?v=')) {
      videoId = href.split('v=')[1]?.split('&')[0];
    } else if (href.includes('youtu.be/')) {
      videoId = href.split('youtu.be/')[1]?.split('?')[0];
    }

    if (videoId && !embeds.some(e => e.videoId === videoId)) {
      // Check if parent is already an embed container
      const parent = link.parentElement;
      if (parent && (parent.classList.contains('embed') || parent.classList.contains('video'))) {
        // Include parent wrapper
        const html = parent.outerHTML;
        if (!embeds.some(e => e.html === html)) {
          embeds.push({
            type: 'youtube',
            html: html,
            element: parent,
            videoId: videoId
          });
        }
      } else {
        // Generate embed iframe from link
        const embedUrl = `https://www.youtube.com/embed/${videoId}`;
        const embedHtml = `<iframe src="${embedUrl}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;

        embeds.push({
          type: 'youtube',
          html: embedHtml,
          element: link,
          videoId: videoId,
          isGenerated: true
        });
      }
    }
  });

  // Strategy 4: Look for oEmbed or other embed patterns
  const oembedLinks = document.querySelectorAll('link[type="application/json+oembed"][href*="youtube"], a[href*="youtube.com/embed"]');
  oembedLinks.forEach(link => {
    const href = link.getAttribute('href');
    if (href && href.includes('youtube.com/embed/')) {
      const videoId = href.split('embed/')[1]?.split('?')[0];
      if (videoId && !embeds.some(e => e.videoId === videoId)) {
        const embedUrl = `https://www.youtube.com/embed/${videoId}`;
        const embedHtml = `<iframe src="${embedUrl}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;

        embeds.push({
          type: 'youtube',
          html: embedHtml,
          element: link,
          videoId: videoId,
          isGenerated: true
        });
      }
    }
  });

  // Strategy 5: Scan HTML content for YouTube URLs in data attributes, scripts, or text content
  const htmlContent = dom.serialize();
  const youtubeUrlPattern = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/g;
  let match;
  const foundVideoIds = new Set();

  while ((match = youtubeUrlPattern.exec(htmlContent)) !== null) {
    const videoId = match[1];
    if (videoId && !embeds.some(e => e.videoId === videoId)) {
      foundVideoIds.add(videoId);
    }
  }

  // For each found video ID, check if we already have an embed for it
  foundVideoIds.forEach(videoId => {
    if (!embeds.some(e => e.videoId === videoId)) {
      const embedUrl = `https://www.youtube.com/embed/${videoId}`;
      const embedHtml = `<iframe src="${embedUrl}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;

      embeds.push({
        type: 'youtube',
        html: embedHtml,
        element: null,
        videoId: videoId,
        isGenerated: true
      });
    }
  });

  // Find Twitter/X embeds - use a Set to track unique tweet URLs/IDs
  const foundTweetIds = new Set();

  // Strategy 1: Find blockquote Twitter embeds
  const twitterBlockquotes = document.querySelectorAll('blockquote.twitter-tweet, blockquote[class*="twitter-tweet"]');
  console.log(`Found ${twitterBlockquotes.length} Twitter blockquotes in HTML`);
  twitterBlockquotes.forEach(blockquote => {
    // Extract tweet URL from the blockquote to identify unique tweets
    const tweetLink = blockquote.querySelector('a[href*="twitter.com/"], a[href*="x.com/"]');
    let tweetId = null;

    if (tweetLink) {
      const href = tweetLink.getAttribute('href');
      // Extract tweet ID from URL (format: twitter.com/username/status/1234567890)
      const tweetIdMatch = href.match(/\/(status|statuses)\/(\d+)/);
      if (tweetIdMatch) {
        tweetId = tweetIdMatch[2];
      }
    }

    // If we can't extract ID, use a hash of the blockquote content as fallback
    if (!tweetId) {
      const textContent = blockquote.textContent?.substring(0, 100) || '';
      tweetId = 'hash_' + textContent.replace(/\s+/g, '').substring(0, 50);
    }

    // Check if we've already found this tweet
    if (foundTweetIds.has(tweetId)) {
      return;
    }

    // Find associated script tag (could be before or after)
    let scriptTag = null;
    let parent = blockquote.parentElement;

    // Check siblings
    let sibling = blockquote.previousElementSibling;
    while (sibling && !scriptTag) {
      if (sibling.tagName === 'SCRIPT' &&
          (sibling.src?.includes('platform.twitter.com') || sibling.src?.includes('platform.x.com'))) {
        scriptTag = sibling;
      }
      sibling = sibling.previousElementSibling;
    }

    sibling = blockquote.nextElementSibling;
    while (sibling && !scriptTag) {
      if (sibling.tagName === 'SCRIPT' &&
          (sibling.src?.includes('platform.twitter.com') || sibling.src?.includes('platform.x.com'))) {
        scriptTag = sibling;
      }
      sibling = sibling.nextElementSibling;
    }

    // Check if parent contains script
    if (!scriptTag && parent) {
      const scriptInParent = parent.querySelector('script[src*="platform.twitter.com"], script[src*="platform.x.com"]');
      if (scriptInParent) {
        scriptTag = scriptInParent;
      }
    }

    // Include parent wrapper if it's a Twitter embed container
    let embedElement = blockquote;
    if (parent && parent.tagName === 'DIV' &&
        (parent.classList.contains('twitter-tweet') || parent.classList.contains('twitter-container'))) {
      embedElement = parent;
    }

    // Build HTML including script if found
    let html = embedElement.outerHTML;
    if (scriptTag && !html.includes(scriptTag.outerHTML)) {
      html += scriptTag.outerHTML;
    }

    foundTweetIds.add(tweetId);
    embeds.push({
      type: 'twitter',
      html: html,
      element: embedElement,
      tweetId: tweetId
    });
    console.log(`Added Twitter embed with tweet ID: ${tweetId}`);
  });

  // Strategy 2: Find Twitter iframe embeds
  const twitterIframes = document.querySelectorAll('iframe[src*="twitter.com"], iframe[src*="x.com"]');
  twitterIframes.forEach(iframe => {
    const src = iframe.getAttribute('src');
    // Extract tweet ID from iframe src
    const tweetIdMatch = src.match(/\/(status|statuses)\/(\d+)/);
    const tweetId = tweetIdMatch ? tweetIdMatch[2] : 'iframe_' + src.substring(0, 50);

    if (!foundTweetIds.has(tweetId)) {
      foundTweetIds.add(tweetId);

      // Include parent wrapper if it exists
      let embedElement = iframe;
      const parent = iframe.parentElement;
      if (parent && (parent.classList.contains('twitter-tweet') || parent.classList.contains('twitter-container'))) {
        embedElement = parent;
      }

      embeds.push({
        type: 'twitter',
        html: embedElement.outerHTML,
        element: embedElement,
        tweetId: tweetId
      });
    }
  });

  // Strategy 3: Find Twitter script tags and their associated blockquotes (fallback)
  const twitterScripts = document.querySelectorAll('script[src*="platform.twitter.com"], script[src*="platform.x.com"]');
  twitterScripts.forEach(script => {
    // Check if we've already processed this script's blockquote
    let blockquote = script.previousElementSibling;
    while (blockquote && blockquote.tagName !== 'BLOCKQUOTE') {
      blockquote = blockquote.previousElementSibling;
    }

    if (!blockquote) {
      blockquote = script.nextElementSibling;
      while (blockquote && blockquote.tagName !== 'BLOCKQUOTE') {
        blockquote = blockquote.nextElementSibling;
      }
    }

    if (blockquote && blockquote.classList.contains('twitter-tweet')) {
      // Extract tweet ID
      const tweetLink = blockquote.querySelector('a[href*="twitter.com/"], a[href*="x.com/"]');
      let tweetId = null;

      if (tweetLink) {
        const href = tweetLink.getAttribute('href');
        const tweetIdMatch = href.match(/\/(status|statuses)\/(\d+)/);
        if (tweetIdMatch) {
          tweetId = tweetIdMatch[2];
        }
      }

      if (!tweetId) {
        const textContent = blockquote.textContent?.substring(0, 100) || '';
        tweetId = 'hash_' + textContent.replace(/\s+/g, '').substring(0, 50);
      }

      // Only add if we haven't seen this tweet yet
      if (!foundTweetIds.has(tweetId)) {
        foundTweetIds.add(tweetId);
        const html = blockquote.outerHTML + script.outerHTML;
        embeds.push({
          type: 'twitter',
          html: html,
          element: blockquote,
          tweetId: tweetId
        });
      }
    }
  });

  // Extract article content using Readability
  const reader = new Readability(document);
  const article = reader.parse();

  if (!article) {
    throw new Error('Could not extract article content from this URL');
  }

  // Parse the article content to re-insert embeds
  const contentDom = new JSDOM(article.content);
  const contentDoc = contentDom.window.document;
  const contentBody = contentDoc.body;

  // Readability almost always strips embeds, so we'll always re-insert them
  // No need to check for duplicates - just add all embeds we found
  const twitterEmbeds = embeds.filter(e => e.type === 'twitter');
  const youtubeEmbeds = embeds.filter(e => e.type === 'youtube');
  console.log(`Found ${embeds.length} total embeds:`);
  console.log(`  - ${twitterEmbeds.length} Twitter embeds`);
  console.log(`  - ${youtubeEmbeds.length} YouTube embeds`);
  console.log(`  - Will add all ${embeds.length} embeds`);

  // Re-insert all embeds (Readability strips them, so we always need to add them back)
  embeds.forEach(embed => {
    const embedKey = embed.videoId || embed.tweetId || embed.html;
    console.log(`Adding embed: ${embed.type} - ${embedKey}`);

    // Create a wrapper div for the embed
    const wrapper = contentDoc.createElement('div');
    wrapper.className = `embed-wrapper embed-${embed.type}`;

    // Clone the embed HTML
    const tempDiv = contentDoc.createElement('div');
    tempDiv.innerHTML = embed.html;

    // Handle YouTube embeds
    if (embed.type === 'youtube') {
      let iframe = tempDiv.querySelector('iframe');

      // If we generated the embed, create the iframe
      if (!iframe && embed.isGenerated && embed.videoId) {
        iframe = contentDoc.createElement('iframe');
        iframe.src = `https://www.youtube.com/embed/${embed.videoId}`;
        iframe.setAttribute('frameborder', '0');
        iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
        iframe.setAttribute('allowfullscreen', '');
        tempDiv.appendChild(iframe);
      }

      iframe = tempDiv.querySelector('iframe');
      if (iframe) {
        wrapper.style.cssText = 'margin: 2em 0; position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; max-width: 100%; background: #000; border-radius: 8px;';
        iframe.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none;';
        wrapper.appendChild(iframe);
      } else {
        // Handle YouTube links or other formats
        const link = tempDiv.querySelector('a[href*="youtube"], a[href*="youtu.be"]');
        if (link && embed.videoId) {
          // Convert link to iframe embed
          const iframe = contentDoc.createElement('iframe');
          iframe.src = `https://www.youtube.com/embed/${embed.videoId}`;
          iframe.setAttribute('frameborder', '0');
          iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
          iframe.setAttribute('allowfullscreen', '');
          wrapper.style.cssText = 'margin: 2em 0; position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; max-width: 100%; background: #000; border-radius: 8px;';
          iframe.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none;';
          wrapper.appendChild(iframe);
        } else {
          wrapper.style.cssText = 'margin: 2em 0; text-align: center;';
          wrapper.appendChild(tempDiv.cloneNode(true));
        }
      }
    }

    // Handle Twitter/X embeds
    else if (embed.type === 'twitter') {
      wrapper.style.cssText = 'margin: 2em 0; max-width: 100%;';

      // Move all children from tempDiv to wrapper
      // Skip script tags - frontend will handle Twitter widget loading
      while (tempDiv.firstChild) {
        const child = tempDiv.firstChild;

        // Skip script tags - they won't execute via innerHTML anyway
        if (child.tagName === 'SCRIPT') {
          tempDiv.removeChild(child);
          continue;
        }

        // Ensure blockquotes have the twitter-tweet class and proper structure
        if (child.tagName === 'BLOCKQUOTE') {
          if (!child.classList.contains('twitter-tweet')) {
            child.classList.add('twitter-tweet');
          }
          child.style.cssText = 'margin: 0 auto; max-width: 550px;';

          // Ensure blockquote has a link inside (required by Twitter widget)
          if (!child.querySelector('a[href*="twitter"], a[href*="x.com"]')) {
            // Try to extract tweet ID and create a link
            if (embed.tweetId && !embed.tweetId.startsWith('hash_') && !embed.tweetId.startsWith('iframe_')) {
              const link = contentDoc.createElement('a');
              link.href = `https://twitter.com/x/status/${embed.tweetId}`;
              link.textContent = 'View on Twitter';
              child.appendChild(link);
            }
          }
        }

        // Style iframes
        if (child.tagName === 'IFRAME') {
          child.style.cssText = 'max-width: 100%; margin: 0 auto; display: block;';
        }

        // If child is a div containing a blockquote, ensure blockquote is properly structured
        if (child.tagName === 'DIV') {
          const nestedBlockquote = child.querySelector('blockquote');
          if (nestedBlockquote) {
            if (!nestedBlockquote.classList.contains('twitter-tweet')) {
              nestedBlockquote.classList.add('twitter-tweet');
            }
            nestedBlockquote.style.cssText = 'margin: 0 auto; max-width: 550px;';
          }
        }

        wrapper.appendChild(child);
      }
    }

    // Insert embed into content body (append for now, could be improved to preserve position)
    contentBody.appendChild(wrapper);
  });

  // Get the updated content HTML
  const updatedContent = contentBody.innerHTML;

  // Return the parsed article with embeds
  return {
    title: article.title,
    content: updatedContent,
    excerpt: article.excerpt,
    byline: article.byline,
    siteName: article.siteName
  };
}

module.exports = { parseArticle };

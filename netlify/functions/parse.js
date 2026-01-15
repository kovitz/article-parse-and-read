const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const fetch = require('node-fetch');

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

    // Validate URL format
    let articleUrl;
    try {
      articleUrl = new URL(url);
    } catch (e) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ error: 'Invalid URL format' }),
      };
    }

    // Fetch the webpage
    const response = await fetch(articleUrl.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ error: `Failed to fetch URL: ${response.statusText}` }),
      };
    }

    const html = await response.text();

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
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ error: 'Could not extract article content from this URL' }),
      };
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
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        title: article.title,
        content: updatedContent,
        excerpt: article.excerpt,
        byline: article.byline,
        siteName: article.siteName
      }),
    };

  } catch (error) {
    console.error('Error parsing article:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'An error occurred while parsing the article: ' + error.message }),
    };
  }
};

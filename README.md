# Article Reader

A lightweight web application that extracts clean, readable content from web articles by removing ads, navigation, and other clutter.

## Features

- Simple, clean interface
- Extracts article content using Mozilla's Readability algorithm
- Removes ads, navigation, and other non-essential content
- Displays article title, metadata, and clean content

## Setup

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

3. Open your browser and navigate to:
```
http://localhost:3000
```

## Usage

1. Enter a URL of a web article in the text input
2. Click the "Parse" button (or press Enter)
3. The extracted article content will be displayed below

## How It Works

The application uses:
- **Express.js** - Web server framework
- **@mozilla/readability** - Article content extraction algorithm
- **jsdom** - HTML parsing and DOM manipulation
- **node-fetch** - HTTP requests to fetch web pages

The backend fetches the webpage, parses it with JSDOM, and uses Mozilla's Readability algorithm to extract the main article content, removing ads, navigation menus, and other clutter.

## Port

The server runs on port 3000 by default. You can change this by setting the `PORT` environment variable:

```bash
PORT=8080 npm start
```

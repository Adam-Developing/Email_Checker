# Go Email Security Analyser

This project is a Go-based web service designed to perform a deep, multi-faceted analysis of `.eml` files to identify phishing attempts, impersonation, and other security risks.

It exposes a streaming API endpoint that accepts a raw email file and returns a series of JSON events detailing its findings, culminating in a final risk score. The analysis is performed by two parallel methods: one on the raw email content and another on a rendered, OCR-processed screenshot of the email, providing a robust defence against content-hiding techniques.

## Table of Contents

* [Core Features](#core-features)

* [How It Works](#how-it-works)

* [System Dependencies](#system-dependencies)

* [Project Setup](#project-setup)

* [API](#api)

## Core Features

* **Streaming API:** Uses Server-Sent Events (SSE) to stream analysis results in real-time.

* **Dual-Path Analysis:**

    1. **Text Analysis:** Analyses the raw HTML and text content of the email.

    2. **Rendered Analysis:** Renders the email in a headless Chrome instance, takes a full-page screenshot, and uses Tesseract OCR to analyse the text *as a user would see it*. This bypasses common phishing tricks where malicious content is hidden from simple text parsers.

* **AI-Powered Insights:** Uses the Google Gemini API to assess the email's content, identify the sender's purported organisation, summarise the request, and judge its realism.

* **Domain & Sender Verification:**

    * Checks the sender's domain against a local SQLite database of known organisations (built from Wikidata) to spot impersonation.

    * Uses the Google Search API to verify that the sender's domain matches the company they claim to be.

* **URL Scanning:** Extracts all hyperlinks, follows redirects, and (if enabled) submits them to `urlscan.io` for malicious content checks.

* **Attachment Analysis:** Scans for dangerous file attachments (e.g., `.exe`, `.sh`, `.mobileconfig`).

* **Image Processing:** Downloads remote and inline images, converting them to JPG using ImageMagick for consistent processing.

## How It Works

1. A client POSTs a base64-encoded `.eml` file to the `/process-eml-stream` endpoint.

2. The server starts a new analysis "sandbox" for the request.

3. The `.eml` file is parsed, extracting text, HTML, and attachments.

4. The server kicks off several analysis tasks in parallel:

    * **Domain Analysis:** The sender's domain is checked against the `wikidata_websites4.db`.

    * **Executable Analysis:** Attachments are scanned for dangerous extensions.

    * **URL Analysis:** All URLs are extracted and sent for scanning.

    * **Text Analysis:** The raw email content is sent to the Gemini API.

    * **Rendered Analysis:**

        * The email HTML is rendered in headless Chrome.

        * A screenshot is taken.

        * The screenshot is processed by Tesseract OCR.

        * The resulting OCR text is sent to the Gemini API.

5. As each task completes, its findings (and score impact) are sent to the client as a JSON SSE event.

6. Finally, two separate scores (one for the "normal" analysis and one for the "rendered" analysis) are calculated and sent.

## System Dependencies

This application is not fully self-contained and relies on external command-line tools. You **must** have the following installed on the server and available in the system's `PATH`:

* [**Tesseract OCR**](https://tesseract-ocr.github.io/tessdoc/Installation.html)**:** Required for the "Rendered Analysis" (OCR) step.

* [**ImageMagick**](https://imagemagick.org/)**:** Required for converting various image formats to JPG.

* [**Google Chrome**](https://www.google.com/chrome/)**:** Required for the headless browser rendering step.

## Project Setup

### 1. Database Setup

The domain verification feature relies on a local SQLite database. You can generate this file using the provided Python scripts:

1. Install Python dependencies (you may need to create a `requirements.txt` file):

   ```
   pip install tldextract SPARQLWrapper
   
   
   ```

2. Fetch data from Wikidata (this will take a long time):

   ```
   python "Get Companies.py"
   
   
   ```

3. Post-process the database to add domain information:

   ```
   python "Convert Database.py"
   
   
   ```

   This creates the `wikidata_websites4.db` file in your project directory.

### 2. Environment Variables

Create a `.env` file in the root of the project and populate it with your API keys:

```
GEMINI_API_KEY=your_gemini_api_key
GOOGLE_SEARCH_API_KEY=your_google_search_api_key
GOOGLE_SEARCH_CX=your_google_custom_search_engine_id
URLSCAN_API_KEY=your_urlscan.io_api_key
Main_Prompt="Please identify the company they are pretending to be..."


```

### 3. Go Dependencies

Install the Go modules defined in `go.mod`:

```
go mod tidy


```

### 4. Running the Server

Start the application from your terminal:

```
go run .


```

The server will start on port `8080`.

## API

### `POST /process-eml-stream`

Accepts a raw `base64-encoded` string of a `.eml` file as the request body.

Returns a `text/event-stream` response with the following JSON events:

* **`maxScore`**: `{ "maxScore": 122 }` (The total possible score)

* **`domainAnalysis`**: `{ "status": "DomainExactMatch", ... }`

* **`urlAnalysis`**: `{ "status": "Clean", "maliciousCount": 0, ... }`

* **`executableAnalysis`**: `{ "found": false, ... }`

* **`textAnalysis`**: `{ "companyIdentification": { "identified": true, "name": "..." }, ... }`

* **`renderedAnalysis`**: `{ "companyIdentification": { "identified": true, "name": "..." }, ... }`

* **`finalScores`**: `{ "baseScore": 47, "finalScoreNormal": 107, "finalScoreRendered": 107, ... }`
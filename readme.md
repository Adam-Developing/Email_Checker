# Email Security Analyser

| Spam Email | Real Email |
| :---: | :---: |
| <img width="1908" height="903" alt="Spam email" src="https://github.com/user-attachments/assets/fce655a5-16f3-43b9-9b35-408911667a2f" /> | <img width="1907" height="885" alt="Safe email" src="https://github.com/user-attachments/assets/f5854b8e-7a0a-4c43-b790-8ede98a94242" /> |

A comprehensive email security analysis system consisting of a **Go-based backend server** and a **Chrome extension frontend**. The system performs deep, multi-faceted analysis of emails to identify phishing attempts, impersonation, and other security risks.

The backend exposes a streaming API that accepts raw email data and returns real-time analysis results via Server-Sent Events (SSE). The Chrome extension integrates directly with Gmail to provide seamless email analysis within your inbox.

## Table of Contents

- [Core Features](#core-features)
- [How It Works](#how-it-works)
- [Project Structure](#project-structure)
- [Backend Setup](#backend-setup)
  - [System Dependencies](#system-dependencies)
  - [Database Setup](#1-database-setup)
  - [Environment Variables](#2-environment-variables)
  - [Go Dependencies](#3-go-dependencies)
  - [Running the Server](#4-running-the-server)
- [Frontend Setup (Chrome Extension)](#frontend-setup-chrome-extension)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Configuration](#configuration)
  - [Using the Extension](#using-the-extension)
- [API Reference](#api-reference)

## Core Features

* **Streaming API:** Uses Server-Sent Events (SSE) to stream analysis results in real-time.

* **Dual-Path Analysis:**

    1. **Text Analysis:** Analyses the raw HTML and text content of the email.

    2. **Rendered Analysis:** Renders the email in a headless Chrome instance, takes a full-page screenshot, and uses Tesseract OCR to analyse the text *as a user would see it*. This bypasses common phishing tricks where malicious content is hidden from simple text parsers.

* **AI-Powered Insights:** Uses the Google Gemini API to assess the email's content, identify the sender's purported organisation, summarise the request, and judge its realism.

* **Domain & Sender Verification:**

    * Checks the sender's domain against a local SQLite database of known organisations (built from Wikidata) to spot impersonation.

    * Uses the Google Search API to verify that the sender's domain matches the company they claim to be.

* **URL Scanning:** Extracts all hyperlinks, follows redirects, and submits them to VirusTotal for malicious content checks.

* **Attachment Analysis:** Scans for dangerous file attachments (e.g., `.exe`, `.sh`, `.mobileconfig`, `.dmg`, `.bat`, `.vbs`).

* **Image Processing:** Downloads remote and inline images, converting them to JPG using ImageMagick for consistent processing.

* **Gmail Integration:** Chrome extension provides seamless integration with Gmail, displaying analysis scores directly in your inbox.

## How It Works

### Backend Analysis Pipeline

1. A client POSTs a base64-encoded email to the `/process-eml-stream` endpoint.

2. The server creates a unique sandbox directory for the request.

3. The email is parsed, extracting text, HTML, and attachments.

4. The server kicks off several analysis tasks in parallel:

    * **Domain Analysis:** The sender's domain is checked against the `wikidata_websites4.db`.

    * **Executable Analysis:** Attachments are scanned for dangerous extensions.

    * **URL Analysis:** All URLs are extracted, redirects followed, and scanned via VirusTotal.

    * **Text Analysis:** The raw email content is sent to the Gemini API.

    * **Rendered Analysis:**

        * The email HTML is rendered in headless Chrome.

        * A full-page screenshot is taken.

        * The screenshot is processed by Tesseract OCR.

        * The resulting OCR text and screenshot are sent to the Gemini API.

5. As each task completes, its findings (and score impact) are sent to the client as a JSON SSE event.

6. Two separate scores (one for the "normal" analysis and one for the "rendered" analysis) are calculated and sent.

### Chrome Extension Flow

1. User opens an email in Gmail.

2. The extension detects the email and (after authentication) fetches the raw email data via Gmail API.

3. The raw email is sent to the backend server for analysis.

4. Results are displayed in real-time as a score circle next to the sender's name.

5. Clicking the score circle opens a detailed analysis modal with all findings.

## Project Structure

```
Email_Checker/
├── Backend/                    # Go backend server
│   ├── main.go                 # Main server entry point and handlers
│   ├── Central Functions.go    # Core analysis functions
│   ├── Render_Email.go         # Email rendering and OCR
│   ├── scoreSettings.go        # Scoring configuration
│   ├── go.mod                  # Go module dependencies
│   ├── go.sum                  # Go dependency checksums
│   ├── .env.example            # Example environment configuration
│   ├── requirements.txt        # Python dependencies for database setup
│   ├── Get Companies.py        # Script to fetch company data from Wikidata
│   ├── Convert Database.py     # Script to process and create the database
│   └── wikidata_websites4.db   # SQLite database of known company domains
│
├── Frontend/
│   └── chrome-extension/       # Chrome extension for Gmail
│       ├── manifest.example.json  # Extension manifest (copy to manifest.json)
│       ├── background.js       # Service worker for authentication
│       ├── content.js          # Gmail integration script
│       ├── options.html        # Extension settings page
│       ├── options.js          # Settings page logic
│       ├── analysis-ui.html    # Analysis results modal
│       ├── injected-styles.css # Styles injected into Gmail
│       ├── sidepanel.js        # Side panel functionality
│       ├── core/
│       │   ├── analysis-core.js    # Core analysis and SSE handling
│       │   ├── analysis-ui-flow.js # UI flow management
│       │   └── shared-styles.css   # Shared styling
│       └── assets/
│           ├── Icon.png        # Extension icon
│           └── logo-filled.png # Extension logo
│
└── readme.md                   # This file
```

## Backend Setup

### System Dependencies

The backend requires several external command-line tools. You **must** have the following installed and available in your system's `PATH`:

| Tool | Purpose | Installation |
|------|---------|--------------|
| [**Tesseract OCR**](https://tesseract-ocr.github.io/tessdoc/Installation.html) | OCR for rendered email screenshots | See [installation guide](https://tesseract-ocr.github.io/tessdoc/Installation.html) |
| [**ImageMagick**](https://imagemagick.org/) | Image format conversion | See [download page](https://imagemagick.org/script/download.php) |
| [**Google Chrome**](https://www.google.com/chrome/) | Headless browser for email rendering | [Download Chrome](https://www.google.com/chrome/) |
| **Go 1.24+** | Backend server runtime | [Download Go](https://go.dev/dl/) |
| **Python 3.x** (optional) | Database generation scripts | [Download Python](https://www.python.org/downloads/) |

### 1. Database Setup

The domain verification feature relies on a local SQLite database. You can either:

**Option A:** Use the pre-built `wikidata_websites4.db` included in the `Backend/` directory.

**Option B:** Generate a fresh database using the provided Python scripts:

1. Navigate to the Backend directory:
   ```bash
   cd Backend
   ```

2. Install Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Fetch data from Wikidata (this will take a long time):
   ```bash
   python "Get Companies.py"
   ```

4. Post-process the database to add domain information:
   ```bash
   python "Convert Database.py"
   ```

   This creates the `wikidata_websites4.db` file.

### 2. Environment Variables

1. Navigate to the Backend directory:
   ```bash
   cd Backend
   ```

2. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

3. Edit `.env` and populate it with your API keys:

   ```env
   # Required: Google Gemini API key for AI analysis
   GEMINI_API_KEY=your_gemini_api_key

   # Required: Google Custom Search API for company verification
   GOOGLE_SEARCH_API_KEY=your_google_search_api_key
   GOOGLE_SEARCH_CX=your_google_custom_search_engine_id

   # Required (if URL scanning enabled): VirusTotal API key for URL scanning
   VTotal_API_KEY=your_virustotal_api_key

   # Optional: URLScan.io API key (additional URL scanner)
   URLSCAN_API_KEY=your_urlscan_api_key

   # URL Scanning Master Switch: Set to TRUE to enable all URL scanning
   # When FALSE, URL analysis is completely disabled
   URLSCAN_ENABLED=FALSE

   # Required: Main AI prompt (see .env.example for full prompt)
   Main_Prompt="Please identify the company they are pretending to be..."
   ```

**Getting API Keys:**

- **Gemini API Key:** [Google AI Studio](https://aistudio.google.com/app/apikey)
- **Google Custom Search API:** [Google Cloud Console](https://console.cloud.google.com/apis/credentials) - Enable "Custom Search API"
- **Google Custom Search CX:** [Programmable Search Engine](https://programmablesearchengine.google.com/) - Create a search engine
- **VirusTotal API Key:** [VirusTotal](https://www.virustotal.com/gui/join-us) - Free tier available
- **URLScan.io API Key:** [URLScan.io](https://urlscan.io/user/signup) (optional)

### 3. Go Dependencies

Install the Go modules:

```bash
cd Backend
go mod tidy
```

### 4. Running the Server

Start the backend server:

```bash
cd Backend
go run .
```

The server will start on port `8080`. You should see:
```
Starting server on port 8080...
```

**Verify it's running:**
```bash
curl http://localhost:8080/process-eml-stream
```

## Frontend Setup (Chrome Extension)

### Prerequisites

- Google Chrome browser (or Chromium-based browser)
- Backend server running on `http://127.0.0.1:8080`
- A Google Cloud Project with OAuth 2.0 credentials

### Installation

1. **Navigate to the extension directory:**
   ```bash
   cd Frontend/chrome-extension
   ```

2. **Create the manifest file:**
   ```bash
   cp manifest.example.json manifest.json
   ```

3. **Configure OAuth credentials:**

   Edit `manifest.json` and update the `oauth2` section with your own Google Cloud OAuth client ID:

   ```json
   "oauth2": {
     "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
     "scopes": [
       "https://www.googleapis.com/auth/gmail.readonly"
     ]
   }
   ```

   **To get your OAuth Client ID:**

   1. Go to [Google Cloud Console](https://console.cloud.google.com/)
   2. Create a new project (or use an existing one)
   3. Navigate to **APIs & Services** → **Credentials**
   4. Click **Create Credentials** → **OAuth client ID**
   5. Select **Chrome Extension** as the application type
   6. Enter your extension's ID (you'll get this after loading the extension once)
   7. Copy the Client ID and paste it into `manifest.json`

4. **Load the extension in Chrome:**

   1. Open Chrome and go to `chrome://extensions/`
   2. Enable **Developer mode** (toggle in top-right corner)
   3. Click **Load unpacked**
   4. Select the `Frontend/chrome-extension` directory
   5. Note the **Extension ID** displayed on the extension card

5. **Update OAuth credentials with Extension ID:**

   1. Go back to Google Cloud Console → Credentials
   2. Edit your OAuth client and add the Extension ID
   3. Reload the extension in Chrome

### Configuration

Access extension settings by:
- Right-clicking the extension icon → **Options**
- Or clicking the extension icon and selecting **Settings**

**Available Settings:**

| Setting | Description |
|---------|-------------|
| **Analysis Mode** | `Auto` - Automatically analyze emails when opened<br>`Manual` - Click a button to analyze |
| **Enabled Checks** | Toggle individual analysis checks on/off |
| **Account Authorization** | Manage Gmail account permissions |

**Configurable Checks:**
- ✅ Sender Domain Analysis
- ✅ URL Scanning
- ✅ Executable Attachment Analysis
- ✅ Text Content Analysis (AI-powered)
- ✅ Rendered Content Analysis (Screenshot + OCR + AI)

### Using the Extension

1. **Ensure the backend server is running** on `http://127.0.0.1:8080`

2. **Open Gmail** in Chrome

3. **Click on any email** to view it

4. **Authenticate** (first time only):
   - A modal will appear asking for Gmail read access
   - Click **Authenticate** and sign in with your Google account
   - Grant the extension read-only access to your emails

5. **View analysis results:**
   - A score circle appears next to the sender's name
   - **Green (70-100%)**: Looks safe
   - **Orange (40-69%)**: Suspicious
   - **Red (0-39%)**: High risk

6. **Click the score circle** to view detailed analysis including:
   - Domain verification status
   - URL scan results
   - Attachment analysis
   - AI-powered content analysis
   - Phone number validation

## API Reference

### `POST /process-eml-stream`

Analyzes an email and streams results via Server-Sent Events.

**Request:**
- **Content-Type:** `text/plain`
- **Body:** Base64-encoded `.eml` file content

**Query Parameters (optional):**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `checkDomain` | `true` | Enable/disable domain analysis |
| `checkUrls` | `true` | Enable/disable URL scanning |
| `checkAttachments` | `true` | Enable/disable attachment analysis |
| `checkTextAnalysis` | `true` | Enable/disable text content analysis |
| `checkRenderedAnalysis` | `true` | Enable/disable rendered analysis |

**Response:** `text/event-stream`

**SSE Events:**

| Event | Description | Example Payload |
|-------|-------------|-----------------|
| `maxScore` | Maximum possible score | `{ "maxScore": 95, "enabledChecks": {...} }` |
| `domainAnalysis` | Sender domain verification | `{ "status": "DomainExactMatch", "message": "...", "scoreImpact": 30 }` |
| `urlScanStarted` | URL scanning initiated | `{ "total": 5 }` |
| `urlScanResult` | Individual URL result | `{ "url": "...", "finalDecision": false, "report": "..." }` |
| `urlAnalysis` | Final URL analysis | `{ "status": "Clean", "maliciousCount": 0, "scoreImpact": 10 }` |
| `executableAnalysis` | Attachment scan result | `{ "found": false, "message": "...", "scoreImpact": 3 }` |
| `textAnalysis` | AI text analysis | `{ "companyIdentification": {...}, "summary": "...", ... }` |
| `renderedAnalysis` | AI rendered analysis | `{ "companyIdentification": {...}, "summary": "...", ... }` |
| `finalScores` | Final calculated scores | `{ "baseScore": 43, "finalScoreNormal": 95, "finalScoreRendered": 95, ... }` |

**Example Request:**

```bash
curl -X POST http://localhost:8080/process-eml-stream \
  -H "Content-Type: text/plain" \
  -d "$(base64 -w 0 email.eml)"
```

**Example Response (SSE stream):**

```
event: maxScore
data: {"maxScore":95,"enabledChecks":{"checkDomain":true,"checkUrls":true,...}}

event: domainAnalysis
data: {"status":"DomainExactMatch","message":"Domain is in the known database.","scoreImpact":30}

event: executableAnalysis
data: {"found":false,"message":"No dangerous attachments found.","scoreImpact":3}

event: urlAnalysis
data: {"status":"Clean","message":"No malicious URLs were found.","maliciousCount":0,"scoreImpact":10}

event: textAnalysis
data: {"companyIdentification":{"identified":true,"name":"Microsoft"},"summary":"...","realismAnalysis":{"isRealistic":true},...}

event: renderedAnalysis
data: {"companyIdentification":{"identified":true,"name":"Microsoft"},"summary":"...","realismAnalysis":{"isRealistic":true},...}

event: finalScores
data: {"baseScore":43,"finalScoreNormal":95,"finalScoreRendered":95,"maxPossibleScore":95,"normalPercentage":100,"renderedPercentage":100}
```

## Scoring System

The analysis uses a point-based scoring system where each check contributes to the final score:

| Check | Points | Condition |
|-------|--------|-----------|
| Domain Exact Match | +30 | Sender domain matches known company |
| Domain No Similarity | +17 | Unknown domain with no look-alikes |
| Free Mail Provider | +12 | Gmail, Outlook, etc. (neutral) |
| Domain Impersonation | 0 | Domain similar to known company |
| Company Identified | +3 | AI successfully identified company |
| Company Verified | +20 | Domain matches claimed company |
| Realism Check | +25 | Content judged realistic by AI |
| Correct Phone Number | +4 | Phone numbers validate correctly |
| No Malicious URLs | +10 | All URLs clean |
| No Executables | +3 | No dangerous attachments |

**Score Interpretation:**
- **70-100%**: ✅ Looks Safe - Email appears legitimate
- **40-69%**: ⚠️ Suspicious - Exercise caution
- **0-39%**: 🚨 High Risk - Likely phishing/spam

## Troubleshooting

### Backend Issues

**Server won't start:**
- Ensure all environment variables are set in `.env`
- Verify `wikidata_websites4.db` exists in the Backend directory
- Check that Tesseract and ImageMagick are installed and in PATH

**Analysis fails:**
- Check API key validity (Gemini, Google Search, VirusTotal)
- Ensure Chrome is installed for rendered analysis
- Check server logs for specific error messages

### Extension Issues

**Extension not working:**
- Ensure backend server is running on `http://127.0.0.1:8080`
- Check Chrome DevTools console for errors (right-click extension → Inspect)
- Verify OAuth client ID is correct in `manifest.json`

**Authentication failing:**
- Clear account authorisation data in extension settings
- Re-authorise with the correct Gmail account
- Ensure OAuth consent screen is configured in Google Cloud Console

## License

This project is provided under the MIT license.

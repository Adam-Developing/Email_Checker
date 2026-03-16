# Email Security Analyser

| Spam Email | Real Email |
| :---: | :---: |
| <img width="1908" height="903" alt="Spam email" src="https://github.com/user-attachments/assets/fce655a5-16f3-43b9-9b35-408911667a2f" /> | <img width="1907" height="885" alt="Safe email" src="https://github.com/user-attachments/assets/f5854b8e-7a0a-4c43-b790-8ede98a94242" /> |

A Python & Go backend + Chrome extension that analyses emails for phishing, impersonation, and security risks. Results stream in real-time via Server-Sent Events.

## How It Works

1. The Chrome extension grabs the raw email from Gmail and POSTs it (base64-encoded) to the backend.
2. The backend runs several checks in parallel:
   - **Domain analysis** — checks sender domain against a SQLite/Wikidata database of known companies
   - **URL scanning** — follows redirects and submits URLs to VirusTotal
   - **Attachment analysis** — flags dangerous extensions (`.exe`, `.sh`, `.bat`, etc.)
   - **Text analysis** — sends raw content to Gemini AI
   - **Rendered analysis** — renders the email in headless Chrome, OCRs a screenshot, and sends that to Gemini
3. Results stream back as SSE events; the extension shows a colour-coded score circle next to the sender.

## Setup

### System Dependencies

Requires **Tesseract OCR**, **ImageMagick**, **Google Chrome**, and **Go 1.24+** on your PATH.

### Backend

```bash
cd Backend
cp .env.example .env        # fill in API keys (see below)
go mod tidy
go run .                    # starts on port 8080
```

**Required API keys in `.env`:**

| Key | Where to get it |
|-----|----------------|
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/app/apikey) |
| `GOOGLE_SEARCH_API_KEY` + `GOOGLE_SEARCH_CX` | [Google Cloud Console](https://console.cloud.google.com/) |
| `VTotal_API_KEY` | [VirusTotal](https://www.virustotal.com/gui/join-us) |

A pre-built `wikidata_websites4.db` is included. To regenerate it: `pip install -r requirements.txt` then run `Get Companies.py` and `Convert Database.py`.

### Chrome Extension

```bash
cd Frontend/chrome-extension
cp manifest.example.json manifest.json
```

Edit `manifest.json` with your Google Cloud OAuth Client ID (type: Chrome Extension, scope: `gmail.readonly`), then load the unpacked extension at `chrome://extensions/`.

## Scoring

| Check | Points |
|-------|--------|
| Domain exact match | +30 |
| Company verified via search | +20 |
| Realism check passed | +25 |
| No malicious URLs | +10 |
| Domain unknown (no look-alikes) | +17 |
| Free mail provider | +12 |
| No dangerous attachments | +3 |
| Company identified by AI | +3 |
| Phone number validated | +4 |

**Score bands:** ✅ 70–100% Safe · ⚠️ 40–69% Suspicious · 🚨 0–39% High Risk

## API

`POST /process-eml-stream` — body is a base64-encoded `.eml` file. Returns an SSE stream of events: `maxScore`, `domainAnalysis`, `urlScanResult`, `urlAnalysis`, `executableAnalysis`, `textAnalysis`, `renderedAnalysis`, `finalScores`.

Optional query params to toggle checks: `checkDomain`, `checkUrls`, `checkAttachments`, `checkTextAnalysis`, `checkRenderedAnalysis` (all default `true`).

## License

MIT

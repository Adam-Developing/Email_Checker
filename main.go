package main

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jhillyerd/enmime"
	"golang.org/x/net/context"
	"golang.org/x/net/html"

	_ "github.com/glebarez/sqlite"
	"github.com/joho/godotenv"
)

type URLScanUpdate struct {
	URL           string `json:"url"`
	FinalDecision bool   `json:"finalDecision"`
	Report        string `json:"report"`
	Error         string `json:"error,omitempty"`
}

type URLScanStartInfo struct {
	Total int `json:"total"`
}

type DomainAnalysisResult struct {
	Status           string `json:"status"`
	Message          string `json:"message"`
	MatchedDomain    string `json:"matchedDomain"`
	ScoreImpact      int    `json:"scoreImpact"`
	SuspectSubdomain string `json:"suspectSubdomain"` // Added for context
}
type URLAnalysisResult struct {
	Status         string    `json:"status"`
	Message        string    `json:"message"`
	MaliciousCount int       `json:"maliciousCount"`
	ScoreImpact    int       `json:"scoreImpact"`
	UrlVerdicts    []Verdict `json:"urlVerdicts"` // Embed verdicts
}
type ExecutableAnalysisResult struct {
	Found       bool   `json:"found"`
	Message     string `json:"message"`
	ScoreImpact int    `json:"scoreImpact"`
}
type CompanyIdentificationResult struct {
	Identified  bool   `json:"identified"`
	Name        string `json:"name,omitempty"`
	ScoreImpact int    `json:"scoreImpact"`
}
type CompanyVerificationResult struct {
	Verified    bool   `json:"verified"`
	Message     string `json:"message"`
	ScoreImpact int    `json:"scoreImpact"`
}
type ActionAnalysisResult struct {
	ActionRequired bool   `json:"actionRequired"`
	Action         string `json:"action"`
}
type RealismAnalysisResult struct {
	IsRealistic bool   `json:"isRealistic"`
	Reason      string `json:"reason"`
	ScoreImpact int    `json:"scoreImpact"`
}
type PhoneNumbersValidation struct {
	PhoneNumber string `json:"phoneNumber"`
	IsValid     bool   `json:"isValid"`
}
type ContactMethodResult struct {
	PhoneNumbers []PhoneNumbersValidation `json:"phoneNumbers"`
	ScoreImpact  int                      `json:"scoreImpact"`
}
type ContentAnalysisResult struct {
	CompanyIdentification CompanyIdentificationResult `json:"companyIdentification"`
	CompanyVerification   CompanyVerificationResult   `json:"companyVerification"`
	ActionAnalysis        ActionAnalysisResult        `json:"actionAnalysis"`
	Summary               string                      `json:"summary"`
	RealismAnalysis       RealismAnalysisResult       `json:"realismAnalysis"`
	ContactMethodAnalysis ContactMethodResult         `json:"contactMethodAnalysis"`
	Error                 string                      `json:"error,omitempty"`
}

type ScoreResult struct {
	BaseScore          int     `json:"baseScore"`
	FinalScoreNormal   int     `json:"finalScoreNormal"`
	FinalScoreRendered int     `json:"finalScoreRendered"`
	MaxPossibleScore   float64 `json:"maxPossibleScore"`
	NormalPercentage   float64 `json:"normalPercentage"`
	RenderedPercentage float64 `json:"renderedPercentage"`
}

// Struct for streaming individual check results
type CheckResult struct {
	EventName string      `json:"eventName"`
	Payload   interface{} `json:"payload"`
}

// --- Global Variables & Existing Functions ---

type headerRoundTripper struct {
	headers  http.Header
	delegate http.RoundTripper
}

const isURLScanEnabled = false

func (h *headerRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	for k, v := range h.headers {
		if req.Header.Get(k) == "" {
			req.Header[k] = v
		}
	}
	return h.delegate.RoundTrip(req)
}

func init() {
	if err := godotenv.Load(); err != nil {
		log.Printf(".env file not found: %v\n", err)
	}
	geminiKey = os.Getenv("GEMINI_API_KEY")
	googleSearchAPIKey = os.Getenv("GOOGLE_SEARCH_API_KEY")
	googleSearchCX = os.Getenv("GOOGLE_SEARCH_CX")
	mainPrompt = os.Getenv("Main_Prompt")
	URLScanAPIKey = os.Getenv("URLSCAN_API_KEY")
}

var (
	geminiKey          string
	googleSearchAPIKey string
	googleSearchCX     string
	mainPrompt         string
	URLScanAPIKey      string
)
var emailPath = "TestEmails"

// --- Main Application Logic ---
func main() {
	requiredDirs := []string{emailPath, "attachments", "screenshots"}
	for _, dir := range requiredDirs {
		if err := os.MkdirAll(dir, 0755); err != nil {
			log.Fatalf("Failed to create essential directory %s: %v", dir, err)
		}
	}

	http.Handle("/process-eml-stream", enableCORS(http.HandlerFunc(streamEmailHandler)))
	port := "8080"
	log.Printf("Starting server on port %s...\n", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Printf("Error starting server: %s\n", err)
	}
}

func enableCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			return
		}
		next.ServeHTTP(w, r)
	})
}

func streamEmailHandler(w http.ResponseWriter, r *http.Request) {
	// 1. Set headers for SSE
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported!", http.StatusInternalServerError)
		return
	}

	// 2. Initial file processing
	base64Data, err := io.ReadAll(r.Body)
	if err != nil {
		log.Printf("Error reading request body: %v", err)
		return
	}
	// Create a unique sandbox directory for this entire request.
	sandboxDir, err := os.MkdirTemp("", "email-checker-*")
	if err != nil {
		http.Error(w, "Failed to create sandbox directory", http.StatusInternalServerError)
		log.Printf("Error creating sandbox dir: %v", err)
		return
	}
	// Use defer to GUARANTEE the entire sandbox is deleted when the handler finishes.
	defer os.RemoveAll(sandboxDir)

	defer r.Body.Close()
	emlData, err := base64.StdEncoding.DecodeString(string(base64Data))
	if err != nil {
		log.Printf("Error decoding base64 data: %v", err)
		return
	}
	fileName := filepath.Join(sandboxDir, "original.eml")
	if err := os.WriteFile(fileName, emlData, 0644); err != nil {
		log.Printf("Error writing temp eml file: %v", err)
		return
	}

	env, fileName := parseEmail(fileName, sandboxDir)

	// Channel for final results from each main analysis function
	resultsChan := make(chan CheckResult)
	// This channel will safely handle all messages sent to the client.
	eventChan := make(chan CheckResult)

	// Start a single "writer" goroutine. It safely listens on eventChan and writes to the client.
	// 1. Create a WaitGroup specifically for the writer goroutine.
	var writerWg sync.WaitGroup
	writerWg.Add(1) // We have one writer goroutine to wait for.

	go func() {
		// 2. Ensure Done is called when this goroutine exits.
		defer writerWg.Done()

		for event := range eventChan {
			jsonData, err := json.Marshal(event.Payload)
			if err != nil {
				log.Printf("Error marshalling event data for %s: %v", event.EventName, err)
				continue
			}
			fmt.Fprintf(w, "event: %s\n", event.EventName)
			fmt.Fprintf(w, "data: %s\n\n", jsonData)
			flusher.Flush()
		}
	}()

	eventChan <- CheckResult{
		EventName: "maxScore",
		Payload:   map[string]float64{"maxScore": MaxScore()},
	}

	db, err := sql.Open("sqlite", "wikidata_websites4.db")
	if err != nil {
		log.Printf("Database connection failed: %v", err)
		close(eventChan)
		return
	}
	defer db.Close()

	var totalDatabaseReadTimeNanos int64
	const numChecks = 5
	var analysisWg sync.WaitGroup // Renamed for clarity from 'wg'
	analysisWg.Add(numChecks)
	userIP := getIPAddress(r)
	countryCode, err := getCountryCodeFromIP(userIP)
	if err != nil {
		log.Printf("Could not determine country for IP %s: %v. Proceeding without localization.", userIP, err)
		countryCode = "gb" // default to UK
	}

	go performDomainAnalysis(&analysisWg, resultsChan, db, Email.Domain, Email.subDomain, &totalDatabaseReadTimeNanos)
	go performURLAnalysis(&analysisWg, resultsChan, eventChan, r.Context())
	go performExecutableAnalysis(&analysisWg, resultsChan, env)
	go performTextAnalysis(&analysisWg, resultsChan, fileName, db, &totalDatabaseReadTimeNanos, sandboxDir, countryCode)
	go performRenderedAnalysis(&analysisWg, resultsChan, fileName, env, db, &totalDatabaseReadTimeNanos, sandboxDir, countryCode)

	go func() {
		analysisWg.Wait()
		close(resultsChan)
	}()

	allCheckData := make(map[string]interface{})
	for result := range resultsChan {
		allCheckData[result.EventName] = result.Payload
		eventChan <- result
	}

	scores := calculateFinalScores(allCheckData)
	eventChan <- CheckResult{EventName: "finalScores", Payload: scores}

	close(eventChan)

	// 3. Wait for the writer goroutine to finish before the handler returns.
	writerWg.Wait()

	log.Println("Streaming complete for request.")
}

// --- Analysis Functions (Refactored to send results to a channel) ---

func performDomainAnalysis(wg *sync.WaitGroup, ch chan<- CheckResult, db *sql.DB, domain, subdomain string, dbTime *int64) {
	defer wg.Done()
	trustedProviders := map[string]struct{}{
		"gmail.com":      {},
		"googlemail.com": {},
		"outlook.com":    {},
		"hotmail.com":    {},
		"yahoo.com":      {},
		"aol.com":        {},
		"icloud.com":     {},
		"protonmail.com": {},
		"zoho.com":       {},
	}

	if _, isTrusted := trustedProviders[domain]; isTrusted {
		// Find the freemail check to get its impact
		var freeMailCheck Check
		for _, c := range AllChecks {
			if c.Name == "freeMailMatch" {
				freeMailCheck = c
				break
			}
		}

		result := DomainAnalysisResult{
			Status:           "freeMailMatch",
			Message:          "Domain is from a free mail provider.",
			ScoreImpact:      freeMailCheck.Impact,
			MatchedDomain:    domain,
			SuspectSubdomain: subdomain,
		}
		ch <- CheckResult{EventName: "domainAnalysis", Payload: result}
		return // Exit early, skipping the database check
	}

	startDbRead := time.Now()
	domainReal, matchedDomain, err := checkDomainReal(db, domain)
	atomic.AddInt64(dbTime, time.Since(startDbRead).Nanoseconds())
	if err != nil {
		log.Printf("Domain analysis failed: %v", err)
		// Send an error or empty result? For now, we'll just log it.
		return
	}

	result := DomainAnalysisResult{MatchedDomain: matchedDomain, SuspectSubdomain: subdomain}
	switch domainReal {
	case 0:
		result.Status = "DomainImpersonation"
		result.Message = fmt.Sprintf("A similar domain '%s' is in the known database.", matchedDomain)
		for _, c := range AllChecks {
			if c.Name == "DomainImpersonation" {
				result.ScoreImpact = c.Impact
				break
			}
		}
	case 1:
		result.Status = "DomainExactMatch"
		result.Message = "Domain is in the known database."
		for _, c := range AllChecks {
			if c.Name == "DomainExactMatch" {
				result.ScoreImpact = c.Impact
				break
			}
		}
	case 2:
		result.Status = "DomainNoSimilarity"
		result.Message = "Domain not in database, and no similarities found."
		for _, c := range AllChecks {
			if c.Name == "DomainNoSimilarity" {
				result.ScoreImpact = c.Impact
				break
			}
		}
	}
	ch <- CheckResult{EventName: "domainAnalysis", Payload: result}
}

func performURLAnalysis(wg *sync.WaitGroup, ch chan<- CheckResult, eventChan chan<- CheckResult, rCtx context.Context) {
	defer wg.Done()
	var check Check
	for _, c := range AllChecks {
		if c.Name == "MaliciousURLFound" {
			check = c
			break
		}
	}
	if !isURLScanEnabled {
		result := URLAnalysisResult{
			Status:      "Disabled",
			Message:     "Url analysis has been turned of by developer temporarily.",
			ScoreImpact: check.Impact, // No score impact when disabled
		}
		ch <- CheckResult{EventName: "urlAnalysis", Payload: result}
		return // Exit the function early
	}

	defer wg.Done()
	ctx, cancel := context.WithTimeout(rCtx, 3*time.Minute)
	defer cancel()
	// (URL extraction logic)
	initialURLs := append(getURL(Email.HTML), getURL(Email.Text)...)
	ignoredExtensions := map[string]struct{}{".png": {}, ".jpg": {}, ".jpeg": {}, ".gif": {}, ".webp": {}, ".css": {}, ".svg": {}, ".woff": {}, ".woff2": {}, ".ttf": {}, ".js": {}}
	uniqueURLs := make(map[string]struct{})
	for _, u := range initialURLs {
		decodedURL := html.UnescapeString(strings.TrimSpace(u))
		if parsedURL, err := url.Parse(decodedURL); err == nil {
			if _, ignore := ignoredExtensions[strings.ToLower(filepath.Ext(parsedURL.Path))]; !ignore {
				uniqueURLs[decodedURL] = struct{}{}
			}
		}
	}
	var finalURLsEmail []string
	finalUniqueURLs := make(map[string]struct{})
	for u := range uniqueURLs {
		if final, err := getFinalURL(ctx, u); err == nil && final != "" {
			finalUniqueURLs[final] = struct{}{}
		}
	}
	for u := range finalUniqueURLs {
		finalURLsEmail = append(finalURLsEmail, u)
	}

	// Send urlScanStarted event to the central channel
	eventChan <- CheckResult{
		EventName: "urlScanStarted",
		Payload:   URLScanStartInfo{Total: len(finalURLsEmail)},
	}
	var urlWg sync.WaitGroup
	verdictsChan := make(chan Verdict, len(finalURLsEmail))
	for _, u := range finalURLsEmail {
		urlWg.Add(1)
		go func(url string) {
			defer urlWg.Done()
			if v, err := checkURLs(ctx, url); err == nil && v != nil {
				verdictsChan <- *v
				// Stream individual result back to the central event channel
				eventChan <- CheckResult{
					EventName: "urlScanResult",
					Payload:   URLScanUpdate{URL: url, FinalDecision: v.FinalDecision, Report: v.Report},
				}
			} else if err != nil {
				log.Printf("Error scanning URL %s: %v", url, err)
				// Stream error back to the central event channel
				eventChan <- CheckResult{
					EventName: "urlScanResult",
					Payload:   URLScanUpdate{URL: url, Error: err.Error()},
				}
			}
		}(u)
	}
	urlWg.Wait()
	close(verdictsChan)

	var verdicts []Verdict
	for v := range verdictsChan {
		verdicts = append(verdicts, v)
	}

	maliciousURLCount := 0
	for _, v := range verdicts {
		if v.FinalDecision {
			maliciousURLCount++
		}
	}

	result := URLAnalysisResult{UrlVerdicts: verdicts, MaliciousCount: maliciousURLCount}
	if maliciousURLCount > 0 {
		result.Status = "MaliciousURLsDetected"
		result.Message = fmt.Sprintf("%d malicious URL(s) were detected.", maliciousURLCount)
		result.ScoreImpact = 0 // No points if malicious URLs are found
	} else {
		result.Status = "Clean"
		result.Message = "No malicious URLs were found."
		result.ScoreImpact = check.Impact
	}
	ch <- CheckResult{EventName: "urlAnalysis", Payload: result}
}

func performExecutableAnalysis(wg *sync.WaitGroup, ch chan<- CheckResult, env *enmime.Envelope) {
	defer wg.Done() // This line is new!
	var check Check
	for _, c := range AllChecks {
		if c.Name == "ExecutableFileFound" {
			check = c
			break
		}
	}
	found, message := analyseForExecutables(env)
	result := ExecutableAnalysisResult{Found: found, Message: message}
	if !found {
		result.ScoreImpact = check.Impact
	}
	ch <- CheckResult{EventName: "executableAnalysis", Payload: result}
}

func performTextAnalysis(wg *sync.WaitGroup, ch chan<- CheckResult, fileName string, db *sql.DB, dbTime *int64, sandboxDir string, countryCode string) {
	defer wg.Done()
	whoResult, err := whoTheyAre(true, fileName, sandboxDir)
	if err != nil {
		log.Printf("Normal text analysis failed: %v", err)
		// Send an error payload instead of just returning
		ch <- CheckResult{
			EventName: "textAnalysis",
			Payload:   ContentAnalysisResult{Error: "Failed to analyse email content."},
		}
		return
	}
	var result ContentAnalysisResult
	populateContentAnalysis(&result, whoResult, db, dbTime, countryCode)

	// Phone Number Validation (logic is the same as before)
	phoneNumbers := extractPhoneNumbersFromEmail(Email.Text + "\n" + Email.HTML)
	result.ContactMethodAnalysis.PhoneNumbers = []PhoneNumbersValidation{}
	if len(phoneNumbers) == 0 {
		for _, c := range AllChecks {
			if c.Name == "CorrectPhoneNumber" {
				result.ContactMethodAnalysis.ScoreImpact = c.Impact
				break
			}
		}
	} else {
		var scoreImpactApplied bool
		bannedWords := []string{"scam", "fraud", "warning"}
		for _, number := range phoneNumbers {
			isValid := false
			searchQuery := fmt.Sprintf("\"%s\"", number)
			if body, err := searchGoogle(searchQuery, countryCode); err == nil && string(body) != "" {
				var sr, sr2 GoogleSearchResult
				if json.Unmarshal(body, &sr) == nil && len(sr.Items) > 0 {
					if body2, err2 := searchGoogle(sr.Items[0].DisplayLink, countryCode); err2 == nil && string(body2) != "" {
						if json.Unmarshal(body2, &sr2) == nil && len(sr2.Items) > 0 {
							companyTitle := strings.ToLower(sr2.Items[0].Title)
							if whoResult.OrganizationName != "" && strings.Contains(companyTitle, strings.ToLower(whoResult.OrganizationName)) && !containsAny(companyTitle, bannedWords) {
								isValid = true
								if !scoreImpactApplied {
									for _, c := range AllChecks {
										if c.Name == "CorrectPhoneNumber" {
											result.ContactMethodAnalysis.ScoreImpact = c.Impact
											break
										}
									}
									scoreImpactApplied = true
								}
							}
						}
					}
				}
			}
			result.ContactMethodAnalysis.PhoneNumbers = append(result.ContactMethodAnalysis.PhoneNumbers, PhoneNumbersValidation{PhoneNumber: number, IsValid: isValid})
		}
	}

	ch <- CheckResult{EventName: "textAnalysis", Payload: result}
}

func performRenderedAnalysis(wg *sync.WaitGroup, ch chan<- CheckResult, fileName string, env *enmime.Envelope, db *sql.DB, dbTime *int64, sandboxDir string, countryCode string) {
	defer wg.Done()

	// Rendering logic
	fileNameImage := RenderEmailHTML(env, fileName, sandboxDir)
	renderEmailText := OCRImage(fileNameImage)

	var result ContentAnalysisResult
	if renderEmailText == "" {
		log.Println("No text extracted from rendered email.")
	} else {
		whoResult, err := whoTheyAre(false, fileName, sandboxDir)
		if err != nil {
			log.Printf("Rendered text analysis failed: %v", err)
			ch <- CheckResult{
				EventName: "renderedAnalysis",
				Payload:   ContentAnalysisResult{Error: "Failed to analyse rendered email screenshot."},
			}
			return
		} else {
			populateContentAnalysis(&result, whoResult, db, dbTime, countryCode)

			// Phone Number Validation (Rendered)
			phoneNumbers := extractPhoneNumbersFromEmail(renderEmailText)
			result.ContactMethodAnalysis.PhoneNumbers = []PhoneNumbersValidation{}
			if len(phoneNumbers) == 0 {
				for _, c := range AllChecks {
					if c.Name == "CorrectPhoneNumber" {
						result.ContactMethodAnalysis.ScoreImpact = c.Impact
						break
					}
				}
			} else {
				// (Same phone validation logic as text analysis)
				var scoreImpactApplied bool
				bannedWords := []string{"scam", "fraud", "warning"}
				for _, number := range phoneNumbers {
					isValid := false
					searchQuery := fmt.Sprintf("\"%s\"", number)
					if body, err := searchGoogle(searchQuery, countryCode); err == nil && string(body) != "" {
						var sr, sr2 GoogleSearchResult
						if json.Unmarshal(body, &sr) == nil && len(sr.Items) > 0 {
							if body2, err2 := searchGoogle(sr.Items[0].DisplayLink, countryCode); err2 == nil && string(body2) != "" {
								if json.Unmarshal(body2, &sr2) == nil && len(sr2.Items) > 0 {
									companyTitle := strings.ToLower(sr2.Items[0].Title)
									if whoResult.OrganizationName != "" && strings.Contains(companyTitle, strings.ToLower(whoResult.OrganizationName)) && !containsAny(companyTitle, bannedWords) {
										isValid = true
										if !scoreImpactApplied {
											for _, c := range AllChecks {
												if c.Name == "CorrectPhoneNumber" {
													result.ContactMethodAnalysis.ScoreImpact = c.Impact
													break
												}
											}
											scoreImpactApplied = true
										}
									}
								}
							}
						}
					}
					result.ContactMethodAnalysis.PhoneNumbers = append(result.ContactMethodAnalysis.PhoneNumbers, PhoneNumbersValidation{PhoneNumber: number, IsValid: isValid})
				}
			}
		}
	}
	ch <- CheckResult{EventName: "renderedAnalysis", Payload: result}
}

// Helper function remains the same
func populateContentAnalysis(result *ContentAnalysisResult, whoResult EmailAnalysis, db *sql.DB, dbTimeNanos *int64, countryCode string) {
	result.CompanyIdentification.Identified = whoResult.OrganizationFound
	result.CompanyIdentification.Name = whoResult.OrganizationName
	if whoResult.OrganizationFound {
		for _, c := range AllChecks {
			if c.Name == "CompanyIdentified" {
				result.CompanyIdentification.ScoreImpact = c.Impact
				break
			}
		}
		dbReadStart := time.Now()
		verified, err := verifyCompany(db, whoResult, countryCode)
		atomic.AddInt64(dbTimeNanos, time.Since(dbReadStart).Nanoseconds())
		if err != nil {
			log.Printf("Error verifying company: %v", err)
		}
		result.CompanyVerification.Verified = verified
		if verified {
			for _, c := range AllChecks {
				if c.Name == "CompanyVerified" {
					result.CompanyVerification.ScoreImpact = c.Impact
					break
				}
			}
			result.CompanyVerification.Message = "The sender's domain aligns with the company they claim to be."
		} else {
			result.CompanyVerification.Message = "Could not verify the sender's domain against the identified company."
		}
	}

	result.ActionAnalysis.ActionRequired = whoResult.ActionRequired
	result.ActionAnalysis.Action = whoResult.Action
	result.Summary = whoResult.SummaryOfEmail

	result.RealismAnalysis.IsRealistic = whoResult.Realistic
	result.RealismAnalysis.Reason = whoResult.RealisticReason
	if whoResult.Realistic {
		for _, c := range AllChecks {
			if c.Name == "RealismCheck" {
				result.RealismAnalysis.ScoreImpact = c.Impact
				break
			}
		}
	}
}

// New function to calculate scores at the end
// main.go

func calculateFinalScores(data map[string]interface{}) ScoreResult {
	var scores ScoreResult
	var baseScore int

	// Temporarily store the main analysis results to check for context
	var domainData DomainAnalysisResult
	var textData ContentAnalysisResult
	var renderedData ContentAnalysisResult

	// Extract all the results from the data map first
	if d, ok := data["domainAnalysis"].(DomainAnalysisResult); ok {
		domainData = d
	}
	if d, ok := data["textAnalysis"].(ContentAnalysisResult); ok {
		textData = d
	}
	if d, ok := data["renderedAnalysis"].(ContentAnalysisResult); ok {
		renderedData = d
	}

	//isImpersonating := domainData.Status == "DomainNoSimilarity" && textData.CompanyIdentification.Identified && !textData.CompanyVerification.Verified
	//isImpersonatingRendered := domainData.Status == "DomainNoSimilarity" && renderedData.CompanyIdentification.Identified && !renderedData.CompanyVerification.Verified

	//if isImpersonating || isImpersonatingRendered {
	//	// If this pattern is found, the "benefit of the doubt" score for an unknown domain is revoked.
	//	domainData.ScoreImpact = 0
	//}

	// Calculate the base score using the other checks and the (potentially modified) domain score
	if execData, ok := data["executableAnalysis"].(ExecutableAnalysisResult); ok {
		baseScore += execData.ScoreImpact
	}
	baseScore += domainData.ScoreImpact // This now uses the context-aware score
	if urlData, ok := data["urlAnalysis"].(URLAnalysisResult); ok {
		baseScore += urlData.ScoreImpact
	}

	scores.BaseScore = baseScore
	finalScoreNormal := baseScore
	finalScoreRendered := baseScore

	// Add scores from the text analysis
	// If company verification failed, we will also nullify the realism and identification scores
	//if !textData.CompanyVerification.Verified {
	//	textData.RealismAnalysis.ScoreImpact = 0
	//	textData.CompanyIdentification.ScoreImpact = 0
	//}
	finalScoreNormal += textData.CompanyIdentification.ScoreImpact
	finalScoreNormal += textData.CompanyVerification.ScoreImpact
	finalScoreNormal += textData.RealismAnalysis.ScoreImpact
	finalScoreNormal += textData.ContactMethodAnalysis.ScoreImpact

	// Add scores from the rendered analysis, applying the same verification logic
	//if !renderedData.CompanyVerification.Verified {
	//	renderedData.RealismAnalysis.ScoreImpact = 0
	//	renderedData.CompanyIdentification.ScoreImpact = 0
	//}
	finalScoreRendered += renderedData.CompanyIdentification.ScoreImpact
	finalScoreRendered += renderedData.CompanyVerification.ScoreImpact
	finalScoreRendered += renderedData.RealismAnalysis.ScoreImpact
	finalScoreRendered += renderedData.ContactMethodAnalysis.ScoreImpact

	// Finalize and calculate percentages
	scores.FinalScoreNormal = finalScoreNormal
	scores.FinalScoreRendered = finalScoreRendered
	maxScoreVal := MaxScore()
	scores.MaxPossibleScore = maxScoreVal
	if maxScoreVal > 0 {
		scores.NormalPercentage = (float64(finalScoreNormal) / maxScoreVal) * 100
		scores.RenderedPercentage = (float64(finalScoreRendered) / maxScoreVal) * 100
	}

	return scores
}

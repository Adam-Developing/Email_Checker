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
	"time"

	"golang.org/x/net/context"
	"golang.org/x/net/html"

	_ "github.com/glebarez/sqlite" // pure Go, no cgo needed
	"github.com/joho/godotenv"
)

// --- Structs for JSON Output ---
type TimingInfo struct {
	TotalProcessing      string `json:"totalProcessing"`
	EmlParsing           string `json:"emlParsing"`
	ImageConversion      string `json:"imageConversion"`
	DomainAnalysis       string `json:"domainAnalysis"`
	UrlAnalysis          string `json:"urlAnalysis"`
	TextAnalysis         string `json:"textAnalysis"`
	RenderAndOcr         string `json:"renderAndOcr"`
	RenderedTextAnalysis string `json:"renderedTextAnalysis"`
	DatabaseReads        string `json:"databaseReads"`
}
type DomainAnalysisResult struct {
	Status        string `json:"status"`
	Message       string `json:"message"`
	MatchedDomain string `json:"matchedDomain"`
	ScoreImpact   int    `json:"scoreImpact"`
}

type URLAnalysisResult struct {
	Status         string `json:"status"`
	Message        string `json:"message"`
	MaliciousCount int    `json:"maliciousCount"`
	ScoreImpact    int    `json:"scoreImpact"`
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

// PhoneNumberValidation holds a single phone number and its validation status.
type PhoneNumbersValidation struct {
	PhoneNumber string `json:"phoneNumber"`
	IsValid     bool   `json:"isValid"`
}

// ContactMethodResult has been updated to include a list of phone number validation results.
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
}

type ScoreResult struct {
	BaseScore          int     `json:"baseScore"`
	FinalScoreNormal   int     `json:"finalScoreNormal"`
	FinalScoreRendered int     `json:"finalScoreRendered"`
	MaxPossibleScore   float64 `json:"maxPossibleScore"`
	NormalPercentage   float64 `json:"normalPercentage"`
	RenderedPercentage float64 `json:"renderedPercentage"`
}

type FinalResult struct {
	EmailFile          string                   `json:"emailFile"`
	SuspectDomain      string                   `json:"suspectDomain"`
	SuspectSubdomain   string                   `json:"suspectSubdomain"`
	DomainAnalysis     DomainAnalysisResult     `json:"domainAnalysis"`
	URLAnalysis        URLAnalysisResult        `json:"urlAnalysis"`
	UrlVerdicts        []Verdict                `json:"urlVerdicts"`
	ExecutableAnalysis ExecutableAnalysisResult `json:"executableAnalysis"`
	TextAnalysis       ContentAnalysisResult    `json:"textAnalysis"`
	RenderedAnalysis   ContentAnalysisResult    `json:"renderedAnalysis"`
	Scores             ScoreResult              `json:"scores"`
	Timings            TimingInfo               `json:"timings"`
}

// --- Global Variables & Existing Functions ---

type headerRoundTripper struct {
	headers  http.Header
	delegate http.RoundTripper
}

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

	// Wrap your existing handler with the CORS middleware
	http.Handle("/process-eml", enableCORS(http.HandlerFunc(runEmailHandler)))

	// Define the port to listen on
	port := "8080"
	log.Printf("Starting server on port %s...\n", port)

	// Start the web server
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Printf("Error starting server: %s\n", err)
	}
}

// New CORS middleware function
func enableCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Set headers to allow cross-origin requests
		w.Header().Set("Access-Control-Allow-Origin", "*") // Allow any origin
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization")

		// If it's a preflight (OPTIONS) request, we can just send the headers and exit.
		if r.Method == "OPTIONS" {
			return
		}

		// Otherwise, serve the next handler
		next.ServeHTTP(w, r)
	})
}
func runEmailHandler(w http.ResponseWriter, r *http.Request) {
	startEmlParsing := time.Now()

	log.Println("Handling request...")

	var baseScore = 0
	var finalScoreNormal = 0
	var finalScoreRendered = 0
	var totalDatabaseReadTime time.Duration

	// 1. Only allow POST requests
	if r.Method != http.MethodPost {
		http.Error(w, "Invalid request method", http.StatusMethodNotAllowed)
		return
	}

	// Read the Base64 encoded data from the request body
	base64Data, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Error reading request body", http.StatusInternalServerError)
		return
	}
	defer func(Body io.ReadCloser) {
		err := Body.Close()
		if err != nil {
			log.Printf("Error closing request body: %v", err)
			http.Error(w, "Error closing request body", http.StatusInternalServerError)
		}
	}(r.Body)

	// **FIX**: Decode the Base64 data to get the raw EML content
	emlData, err := base64.StdEncoding.DecodeString(string(base64Data))
	if err != nil {
		log.Printf("Error decoding base64 data: %v", err)
		http.Error(w, "Error decoding base64 data from client", http.StatusBadRequest)
		return
	}
	// Write the *decoded* EML data to a temporary file
	fileName := emailPath + "/" + fmt.Sprintf("%d_%s", time.Now().UnixNano(), "REAL WORLD TEST.eml")
	if err := os.WriteFile(fileName, emlData, 0644); err != nil {
		log.Printf("Error writing temp eml file: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// Clean up the temporary file when done
	//defer os.Remove(tempFileName) //TODO Uncomment this line in production

	// Initialize the final result structure
	finalResult := FinalResult{
		EmailFile: fileName,
	}

	// File system setup
	if err := os.RemoveAll("attachments"); err != nil {
		log.Println(err)
	}
	_ = os.Mkdir("attachments", 0o755)

	// Parse the email file
	startTaskTimer := time.Now()

	env := parseEmail(fileName) // Capture the result here
	var executableFileCheck Check
	for _, check := range AllChecks {
		if check.Name == "ExecutableFileFound" {
			executableFileCheck = check
			break
		}
	}

	foundExecutable, execMessage := analyseForExecutables(env)
	finalResult.ExecutableAnalysis.Found = foundExecutable
	finalResult.ExecutableAnalysis.Message = execMessage

	if foundExecutable {
		finalResult.ExecutableAnalysis.ScoreImpact = 0
		log.Println(execMessage)
	} else {
		baseScore += executableFileCheck.Impact
		finalResult.ExecutableAnalysis.ScoreImpact = executableFileCheck.Impact
	}

	finalResult.SuspectDomain = Email.Domain
	finalResult.SuspectSubdomain = Email.subDomain
	// The folder containing the images to convert.
	inputDir := "attachments"

	// Check if the input directory exists.
	if _, err := os.Stat(inputDir); os.IsNotExist(err) {
		fmt.Printf("Error: The directory '%s' does not exist. Please create it and add your images.\n", inputDir)
		return
	}

	// Walk through all the files in the directory.
	err = filepath.Walk(inputDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		// Skip directories.
		if info.IsDir() {
			return nil
		}
		// Get the file extension and convert it to lowercase.
		ext := strings.ToLower(filepath.Ext(path))

		// Check if the file is one of the types we want to ignore.
		if ext == ".jpg" || ext == ".jpeg" || ext == ".png" || ext == ".webp" {
			fmt.Printf("Skipping file '%s' (already a supported format).\n", path)
			return nil
		}
		// Attempt to convert the file.
		if err := convertImageToJPG(path); err != nil {
			if !strings.Contains(err.Error(), "executable file not found") {
				fmt.Printf("An error occurred processing %s: %v\n", path, err)
			}
		} else {
			err := os.Remove(path)
			if err != nil {
				// If deletion fails, report the error but don't fail the whole process,
				// as the conversion itself was successful.
				return fmt.Errorf("could not remove original file '%s': %w", path, err)
			}

		}

		return nil
	})

	if err != nil {
		fmt.Printf("An error occurred while walking the directory: %v\n", err)
	} else {
		fmt.Println("\nImage conversion process finished.")
	}
	finalResult.Timings.EmlParsing = time.Since(startTaskTimer).String()

	// Database setup
	db, err := sql.Open("sqlite", "wikidata_websites4.db")
	if err != nil {
		log.Println(err)
	}
	defer func(db *sql.DB) {
		err := db.Close()
		if err != nil {
			log.Println(err)
		}
	}(db)
	startTaskTimer = time.Now()

	// --- Domain Analysis ---
	startDbRead := time.Now()
	DomainReal, domain, err := checkDomainReal(db, Email.Domain)
	totalDatabaseReadTime += time.Since(startDbRead)
	if err != nil {
		log.Println(err)
		// TODO handle error gracefully
	}

	finalResult.DomainAnalysis.MatchedDomain = domain
	switch DomainReal {
	case 0: // Impersonation
		baseScore += AllChecks[2].Impact
		finalResult.DomainAnalysis.Status = "DomainImpersonation"
		finalResult.DomainAnalysis.Message = fmt.Sprintf("A similar domain '%s' is in the known database. This is likely an attempt to impersonate a legitimate entity.", domain)
		finalResult.DomainAnalysis.ScoreImpact = AllChecks[2].Impact
	case 1: // Exact Match
		baseScore += AllChecks[0].Impact
		finalResult.DomainAnalysis.Status = "DomainExactMatch"
		finalResult.DomainAnalysis.Message = "Domain is in the known database."
		finalResult.DomainAnalysis.ScoreImpact = AllChecks[0].Impact
	case 2: // No Similarity
		baseScore += AllChecks[1].Impact
		finalResult.DomainAnalysis.Status = "DomainNoSimilarity"
		finalResult.DomainAnalysis.Message = "Domain is not in the known database, and no similarities were found."
		finalResult.DomainAnalysis.ScoreImpact = AllChecks[1].Impact
	}

	log.Println("Extracting, filtering, and deduplicating URLs...")
	urlsHTML := getURL(Email.HTML)
	urlsPlainText := getURL(Email.Text)
	initialURLs := append(urlsHTML, urlsPlainText...)

	// Define file extensions to ignore as they are not typically malicious webpages
	ignoredExtensions := map[string]struct{}{
		".png": {}, ".jpg": {}, ".jpeg": {}, ".gif": {}, ".webp": {},
		".css": {}, ".svg": {}, ".woff": {}, ".woff2": {}, ".ttf": {}, ".js": {},
	}

	// Use a map to handle deduplication automatically
	uniqueURLs := make(map[string]struct{})

	for _, u := range initialURLs {
		// 1. Basic cleaning and Normalisation
		// Decode HTML entities like &amp; -> &
		decodedURL := html.UnescapeString(u)
		trimmedURL := strings.TrimSpace(decodedURL)
		if trimmedURL == "" {
			continue
		}

		// 2. Filter by file extension
		parsedURL, err := url.Parse(trimmedURL)
		if err != nil {
			log.Printf("Ignoring invalid URL: %s", trimmedURL)
			continue // Ignore invalid URLs
		}
		ext := strings.ToLower(filepath.Ext(parsedURL.Path))
		if _, shouldIgnore := ignoredExtensions[ext]; shouldIgnore {
			log.Printf("Ignoring low-value URL due to extension: %s", trimmedURL)
			continue
		}

		// 3. Add to the map to ensure uniqueness
		uniqueURLs[trimmedURL] = struct{}{}
	}

	// Convert the map of unique URLs back to a slice and get their final destination
	var finalURLsEmail []string
	// We create a new map for final URLs to handle cases where different initial URLs redirect to the same final destination.
	finalUniqueURLs := make(map[string]struct{})
	for u := range uniqueURLs {
		final, err := getFinalURL(r.Context(), u)
		if err != nil || final == "" {
			continue
		}
		finalUniqueURLs[final] = struct{}{}
	}
	for u := range finalUniqueURLs {
		finalURLsEmail = append(finalURLsEmail, u)
	}

	log.Printf("Found %d unique, high-value URLs to scan.", len(finalURLsEmail))

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	var wg sync.WaitGroup
	// Create a buffered channel to hold the results. The buffer size is the number of URLs.
	resultsChan := make(chan Verdict, len(finalURLsEmail))

	// Launch a separate goroutine for each URL to be scanned in parallel.
	for _, u := range finalURLsEmail {
		wg.Add(1) // Increment the WaitGroup counter.

		go func(url string) {
			defer wg.Done() // Decrement the counter when the goroutine completes.

			v, err := checkURLs(ctx, url)
			if err != nil {
				// Don't stop everything, just log the error for this one URL.
				log.Printf("Error scanning URL %s: %v", url, err)
				return
			}
			if v != nil {
				// Send the successful verdict to the channel.
				resultsChan <- *v
			}
		}(u) // Pass 'u' as an argument to the goroutine to ensure the correct URL is used.
	}

	// Start a new goroutine that will wait for all scanning goroutines to finish, then close the channel.
	go func() {
		wg.Wait()
		close(resultsChan)
	}()

	// Collect all the results from the channel as they come in.
	// This loop will automatically finish when the channel is closed.
	for verdict := range resultsChan {
		finalResult.UrlVerdicts = append(finalResult.UrlVerdicts, verdict)
	}

	// --- URL Analysis Scoring ---
	var maliciousURLFound = false
	var maliciousURLCount = 0
	for _, verdict := range finalResult.UrlVerdicts {
		if verdict.FinalDecision {
			maliciousURLFound = true
			maliciousURLCount++
		}
	}

	// Find the MaliciousURLFound check from AllChecks
	var maliciousURLCheck Check
	for _, check := range AllChecks {
		if check.Name == "MaliciousURLFound" {
			maliciousURLCheck = check
			break
		}
	}

	if maliciousURLFound {
		// If malicious, the score impact is 0.
		finalResult.URLAnalysis.Status = "MaliciousURLsDetected"
		finalResult.URLAnalysis.Message = fmt.Sprintf("%d URL(s) identified as malicious or suspicious.", maliciousURLCount)
		finalResult.URLAnalysis.MaliciousCount = maliciousURLCount
		finalResult.URLAnalysis.ScoreImpact = 0
	} else {
		// If safe, apply the positive score impact.
		baseScore += maliciousURLCheck.Impact

		finalResult.URLAnalysis.Status = "Clean"
		finalResult.URLAnalysis.Message = "No malicious or suspicious URLs were found."
		finalResult.URLAnalysis.MaliciousCount = 0
		finalResult.URLAnalysis.ScoreImpact = maliciousURLCheck.Impact
	}

	finalResult.Timings.DomainAnalysis = time.Since(startTaskTimer).String()
	startTaskTimer = time.Now()

	// --- Normal (Text) Analysis ---
	whoTheyAreResultNormal, err := whoTheyAre(true, fileName)
	if err != nil {
		log.Println(err)
		// TODO handle error gracefully
	}
	bannedWords := []string{"scam", "fraud", "warning"}

	// Initialise the slice in the final result.
	finalResult.TextAnalysis.ContactMethodAnalysis.PhoneNumbers = []PhoneNumbersValidation{}
	var scoreImpactApplied bool // This flag tracks if we've already applied the score.

	phoneNumbersText := extractPhoneNumbersFromEmail(Email.Text + "\n" + Email.HTML)

	// Handle the case where no phone numbers are found in the email.
	if len(phoneNumbersText) == 0 {
		log.Println("No phone numbers found in the email.")
		// Apply the score impact as per the original logic for no-numbers case.
		finalResult.TextAnalysis.ContactMethodAnalysis.ScoreImpact = AllChecks[6].Impact
		finalScoreNormal += AllChecks[6].Impact
	} else {
		// If phone numbers are found, iterate through each one.
		for _, phoneNumber := range phoneNumbersText {
			isValid := false // Assume the number is not valid by default.

			// The validation logic from your original code is preserved here.
			body, err := searchGoogle(phoneNumber)
			if err != nil {
				log.Printf("Error searching Google for phone number %s: %v", phoneNumber, err)
				// Add the number as invalid and continue to the next.
				finalResult.TextAnalysis.ContactMethodAnalysis.PhoneNumbers = append(
					finalResult.TextAnalysis.ContactMethodAnalysis.PhoneNumbers,
					PhoneNumbersValidation{PhoneNumber: phoneNumber, IsValid: false},
				)
				continue
			}

			if string(body) != "" {
				var sr GoogleSearchResult
				if err := json.Unmarshal(body, &sr); err == nil && len(sr.Items) > 0 {
					DisplayLink := strings.ToLower(sr.Items[0].DisplayLink)
					body, err := searchGoogle(DisplayLink)
					if err == nil && string(body) != "" {
						var sr2 GoogleSearchResult
						if err := json.Unmarshal(body, &sr2); err == nil && len(sr2.Items) > 0 {
							companyTitle := strings.ToLower(sr2.Items[0].Title)

							// Check if the company name matches and is not a banned word.
							if whoTheyAreResultNormal.OrganizationName != "" && strings.Contains(companyTitle, strings.ToLower(whoTheyAreResultNormal.OrganizationName)) && !containsAny(companyTitle, bannedWords) {
								log.Printf("Found a valid match for '%s' in search results for phone number %s.", whoTheyAreResultNormal.OrganizationName, phoneNumber)
								isValid = true // Mark this number as valid.

								// CRITICAL: Only apply score impact if it hasn't been applied yet.
								if !scoreImpactApplied {
									finalResult.TextAnalysis.ContactMethodAnalysis.ScoreImpact = AllChecks[6].Impact
									finalScoreNormal += AllChecks[6].Impact
									scoreImpactApplied = true // Set the flag to prevent future score changes.
								}
							}
						}
					}
				}
			}

			if !isValid {
				log.Printf("No valid match found for phone number %s.", phoneNumber)
			}

			// Add the result for the current phone number to the final list.
			finalResult.TextAnalysis.ContactMethodAnalysis.PhoneNumbers = append(
				finalResult.TextAnalysis.ContactMethodAnalysis.PhoneNumbers,
				PhoneNumbersValidation{PhoneNumber: phoneNumber, IsValid: isValid},
			)
		}
	}
	// Populate text analysis results
	populateContentAnalysis(&finalResult.TextAnalysis, &finalScoreNormal, whoTheyAreResultNormal, db, w, &totalDatabaseReadTime)
	finalResult.Timings.TextAnalysis = time.Since(startTaskTimer).String()
	startTaskTimer = time.Now()

	// --- Rendered (HTML) Analysis ---
	fileNameImage := RenderEmailHTML(env, fileName)
	renderEmailText := OCRImage(fileNameImage)

	if renderEmailText == "" {
		log.Println("No text extracted from the rendered email.")
	} else {
		phoneNumbersRendered := extractPhoneNumbersFromEmail(renderEmailText)
		// Initialise the slice in the final result.
		finalResult.RenderedAnalysis.ContactMethodAnalysis.PhoneNumbers = []PhoneNumbersValidation{}
		var scoreImpactApplied bool // This flag tracks if we've already applied the score.

		// Handle the case where no phone numbers are found in the email.
		if len(phoneNumbersRendered) == 0 {
			log.Println("No phone numbers found in the email.")
			// **FIXED**: Apply score impact to the correct rendered analysis variables.
			finalResult.RenderedAnalysis.ContactMethodAnalysis.ScoreImpact = AllChecks[6].Impact
			finalScoreRendered += AllChecks[6].Impact
		} else {
			// If phone numbers are found, iterate through each one.
			for _, phoneNumber := range phoneNumbersRendered {
				isValid := false // Assume the number is not valid by default.

				// The validation logic from your original code is preserved here.
				body, err := searchGoogle(phoneNumber)
				if err != nil {
					log.Printf("Error searching Google for phone number %s: %v", phoneNumber, err)
					// **FIXED**: Appending to the rendered analysis results.
					finalResult.RenderedAnalysis.ContactMethodAnalysis.PhoneNumbers = append(
						finalResult.RenderedAnalysis.ContactMethodAnalysis.PhoneNumbers,
						PhoneNumbersValidation{PhoneNumber: phoneNumber, IsValid: false},
					)
					continue
				}

				if string(body) != "" {
					var sr GoogleSearchResult
					if err := json.Unmarshal(body, &sr); err == nil && len(sr.Items) > 0 {
						DisplayLink := strings.ToLower(sr.Items[0].DisplayLink)
						body, err := searchGoogle(DisplayLink)
						if err == nil && string(body) != "" {
							var sr2 GoogleSearchResult
							if err := json.Unmarshal(body, &sr2); err == nil && len(sr2.Items) > 0 {
								companyTitle := strings.ToLower(sr2.Items[0].Title)

								// Check if the company name matches and is not a banned word.
								if whoTheyAreResultNormal.OrganizationName != "" && strings.Contains(companyTitle, strings.ToLower(whoTheyAreResultNormal.OrganizationName)) && !containsAny(companyTitle, bannedWords) {
									log.Printf("Found a valid match for '%s' in search results for phone number %s.", whoTheyAreResultNormal.OrganizationName, phoneNumber)
									isValid = true // Mark this number as valid.

									// CRITICAL: Only apply score impact if it hasn't been applied yet.
									if !scoreImpactApplied {
										finalResult.TextAnalysis.ContactMethodAnalysis.ScoreImpact = AllChecks[6].Impact
										finalScoreNormal += AllChecks[6].Impact
										scoreImpactApplied = true // Set the flag to prevent future score changes.
									}
								}
							}
						}
					}
				}

				if !isValid {
					log.Printf("No valid match found for phone number %s.", phoneNumber)
				}

				// Add the result for the current phone number to the final list.
				// **FIXED**: Appending to the rendered analysis results.
				finalResult.RenderedAnalysis.ContactMethodAnalysis.PhoneNumbers = append(
					finalResult.RenderedAnalysis.ContactMethodAnalysis.PhoneNumbers,
					PhoneNumbersValidation{PhoneNumber: phoneNumber, IsValid: isValid},
				)
			}
		}
	}
	whoTheyAreResultRendered, err := whoTheyAre(false, fileName)
	if err != nil {
		log.Println(err)
		// TODO handle error gracefully
	}
	// Populate rendered analysis results
	populateContentAnalysis(&finalResult.RenderedAnalysis, &finalScoreRendered, whoTheyAreResultRendered, db, w, &totalDatabaseReadTime)
	finalResult.Timings.RenderedTextAnalysis = time.Since(startTaskTimer).String()

	// --- Final Scoring ---
	finalResult.Scores.BaseScore = baseScore
	finalResult.Scores.FinalScoreNormal = finalScoreNormal + baseScore
	finalResult.Scores.FinalScoreRendered = finalScoreRendered + baseScore
	maxScoreVal := MaxScore()
	finalResult.Scores.MaxPossibleScore = maxScoreVal
	finalResult.Scores.NormalPercentage = (float64(finalResult.Scores.FinalScoreNormal) / float64(maxScoreVal)) * 100
	finalResult.Scores.RenderedPercentage = (float64(finalResult.Scores.FinalScoreRendered) / float64(maxScoreVal)) * 100
	finalResult.Timings.EmlParsing = time.Since(startEmlParsing).String()
	finalResult.Timings.DatabaseReads = totalDatabaseReadTime.String()

	// --- Output JSON ---
	// Marshal the final result into a pretty-printed JSON string for console output
	jsonOutput, err := json.MarshalIndent(finalResult, "", "  ")
	if err != nil {
		log.Printf("Error marshalling JSON for console output: %v", err)
	} else {
		// Print the final JSON string to the console
		fmt.Println(string(jsonOutput))
	}

	// 4. Send the structured output back as a JSON response
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(finalResult); err != nil {
		log.Printf("Error encoding JSON response: %v", err)
		return
	}
}

// Helper function to populate content analysis sections to reduce code duplication
func populateContentAnalysis(result *ContentAnalysisResult, score *int, whoResult EmailAnalysis, db *sql.DB, w http.ResponseWriter, dbTime *time.Duration) {
	result.CompanyIdentification.Identified = whoResult.OrganizationFound
	result.CompanyIdentification.Name = whoResult.OrganizationName
	if whoResult.OrganizationFound {
		*score += AllChecks[3].Impact
		result.CompanyIdentification.ScoreImpact = AllChecks[3].Impact
	} else {
		//*score -= AllChecks[3].Impact
		//result.CompanyIdentification.ScoreImpact = -AllChecks[3].Impact
		result.CompanyIdentification.ScoreImpact = 0
	}

	if whoResult.OrganizationFound {
		startDbRead := time.Now()
		verified, err := verifyCompany(db, whoResult)
		*dbTime += time.Since(startDbRead)
		if err != nil {
			log.Printf("Error checking domain: %v", err)
			http.Error(w, "Internal server error during domain analysis", http.StatusInternalServerError)

			// TODO handle error gracefully
		}
		result.CompanyVerification.Verified = verified
		if verified {
			*score += AllChecks[4].Impact
			result.CompanyVerification.ScoreImpact = AllChecks[4].Impact
			result.CompanyVerification.Message = "The sender's domain aligns with the company they claim to be."
		} else {
			//*score -= AllChecks[4].Impact
			//result.CompanyVerification.ScoreImpact = -AllChecks[4].Impact
			//result.CompanyVerification.ScoreImpact = 0
			result.CompanyVerification.Message = "Could not verify the sender's domain against the identified company."
		}
	}

	result.ActionAnalysis.ActionRequired = whoResult.ActionRequired
	result.ActionAnalysis.Action = whoResult.Action
	result.Summary = whoResult.SummaryOfEmail

	result.RealismAnalysis.IsRealistic = whoResult.Realistic
	result.RealismAnalysis.Reason = whoResult.RealisticReason
	if whoResult.Realistic {
		*score += AllChecks[5].Impact
		result.RealismAnalysis.ScoreImpact = AllChecks[5].Impact
	} else {
		//*score -= AllChecks[5].Impact
		//result.RealismAnalysis.ScoreImpact = -AllChecks[5].Impact
		result.RealismAnalysis.ScoreImpact = 0
	}

}

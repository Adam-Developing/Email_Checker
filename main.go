package main

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "github.com/glebarez/sqlite" // pure Go, no cgo needed
	"github.com/joho/godotenv"
)

// --- Structs for JSON Output ---

type DomainAnalysisResult struct {
	Status        string `json:"status"`
	Message       string `json:"message"`
	MatchedDomain string `json:"matchedDomain"`
	ScoreImpact   int    `json:"scoreImpact"`
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
	EmailFile        string                `json:"emailFile"`
	SuspectDomain    string                `json:"suspectDomain"`
	SuspectSubdomain string                `json:"suspectSubdomain"`
	DomainAnalysis   DomainAnalysisResult  `json:"domainAnalysis"`
	TextAnalysis     ContentAnalysisResult `json:"textAnalysis"`
	RenderedAnalysis ContentAnalysisResult `json:"renderedAnalysis"`
	Scores           ScoreResult           `json:"scores"`
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
}

var (
	geminiKey          string
	googleSearchAPIKey string
	googleSearchCX     string
	mainPrompt         string
)
var emailPath = "TestEmails"

// --- Main Application Logic ---
func main() {
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

	log.Println("Handling request...")

	var baseScore = 0
	var finalScoreNormal = 0
	var finalScoreRendered = 0

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
	env := parseEmail(fileName) // Capture the result here
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

	// --- Domain Analysis ---
	DomainReal, domain, err := checkDomainReal(db, Email.Domain)
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
							if strings.Contains(companyTitle, strings.ToLower(whoTheyAreResultNormal.CompanyName)) && !containsAny(companyTitle, bannedWords) {
								log.Printf("Found a valid match for '%s' in search results for phone number %s.", whoTheyAreResultNormal.CompanyName, phoneNumber)
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
	populateContentAnalysis(&finalResult.TextAnalysis, &finalScoreNormal, whoTheyAreResultNormal, db, w)

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
			// Apply the score impact as per the original logic for no-numbers case.
			finalResult.TextAnalysis.ContactMethodAnalysis.ScoreImpact = AllChecks[6].Impact
			finalScoreNormal += AllChecks[6].Impact
		} else {
			// If phone numbers are found, iterate through each one.
			for _, phoneNumber := range phoneNumbersRendered {
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
								if strings.Contains(companyTitle, strings.ToLower(whoTheyAreResultNormal.CompanyName)) && !containsAny(companyTitle, bannedWords) {
									log.Printf("Found a valid match for '%s' in search results for phone number %s.", whoTheyAreResultNormal.CompanyName, phoneNumber)
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
	}
	whoTheyAreResultRendered, err := whoTheyAre(false, fileName)
	if err != nil {
		log.Println(err)
		// TODO handle error gracefully
	}
	// Populate rendered analysis results
	populateContentAnalysis(&finalResult.RenderedAnalysis, &finalScoreRendered, whoTheyAreResultRendered, db, w)

	// --- Final Scoring ---
	finalResult.Scores.BaseScore = baseScore
	finalResult.Scores.FinalScoreNormal = finalScoreNormal + baseScore
	finalResult.Scores.FinalScoreRendered = finalScoreRendered + baseScore
	maxScoreVal := MaxScore()
	finalResult.Scores.MaxPossibleScore = maxScoreVal
	finalResult.Scores.NormalPercentage = (float64(finalResult.Scores.FinalScoreNormal) / float64(maxScoreVal)) * 100
	finalResult.Scores.RenderedPercentage = (float64(finalResult.Scores.FinalScoreRendered) / float64(maxScoreVal)) * 100

	// --- Output JSON ---
	_, err = json.MarshalIndent(finalResult, "", "  ")
	if err != nil {
		log.Printf("Error marshalling JSON: %v", err)
		// TODO handle error gracefully
	}
	//fmt.Println(string(jsonOutput))
	// 4. Send the structured output back as a JSON response
	w.Header().Set("Content-Type", "application/json")

	err = json.NewEncoder(w).Encode(finalResult)
	if err != nil {
		return
	}

}

// Helper function to populate content analysis sections to reduce code duplication
func populateContentAnalysis(result *ContentAnalysisResult, score *int, whoResult EmailAnalysis, db *sql.DB, w http.ResponseWriter) {
	result.CompanyIdentification.Identified = whoResult.CompanyFound
	result.CompanyIdentification.Name = whoResult.CompanyName
	if whoResult.CompanyFound {
		*score += AllChecks[3].Impact
		result.CompanyIdentification.ScoreImpact = AllChecks[3].Impact
	} else {
		//*score -= AllChecks[3].Impact
		//result.CompanyIdentification.ScoreImpact = -AllChecks[3].Impact
		result.CompanyIdentification.ScoreImpact = 0
	}

	if whoResult.CompanyFound {
		verified, err := verifyCompany(db, whoResult)
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

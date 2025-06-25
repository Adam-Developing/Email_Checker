package main

import (
	"database/sql"
	"fmt"
	_ "github.com/glebarez/sqlite" // pure Go, no cgo needed
	"github.com/joho/godotenv"
	"log"
	"net/http"
	"os"
)

var baseScore = 0
var finalScoreNormal = 0
var finalScoreRendered = 0

type headerRoundTripper struct {
	headers  http.Header
	delegate http.RoundTripper
}

var fileName = "spam7.eml"

func (h *headerRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	for k, v := range h.headers {
		// Set only if not already explicitly set
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
	//openRouterKey = os.Getenv("OPENROUTER_API_KEY")
	geminiKey = os.Getenv("GEMINI_API_KEY")
	googleSearchAPIKey = os.Getenv("GOOGLE_SEARCH_API_KEY")
	googleSearchCX = os.Getenv("GOOGLE_SEARCH_CX")
	mainPrompt = os.Getenv("Main_Prompt")
}

var (
	//openRouterKey      string
	geminiKey          string
	googleSearchAPIKey string
	googleSearchCX     string
	mainPrompt         string
)

func main() {
	if err := os.RemoveAll("attachments"); err != nil {
		log.Fatal(err)
	}
	// recreate the now-missing folder for later writes
	_ = os.Mkdir("attachments", 0o755)

	parseEmail()

	db, err := sql.Open("sqlite", "wikidata_websites4.db")
	if err != nil {
		log.Fatal(err)
	}
	defer func(db *sql.DB) {
		err := db.Close()
		if err != nil {
			log.Fatal(err)
		}
	}(db)

	DomainReal, domain, err := checkDomainReal(db, Email.Domain)
	if err != nil {
		log.Fatal(err.Error())
	}
	log.Println("Suspect is " + Email.Domain + " and subdomain is " + Email.subDomain)
	if DomainReal == 0 {
		baseScore += AllChecks[2].Impact // DomainImpersonation
		log.Println("A similar domain is in the known database, We believe they are trying to impersonate", domain, fmt.Sprintf("(Score: %+d)", AllChecks[2].Impact))
	} else if DomainReal == 1 {
		baseScore += AllChecks[0].Impact // DomainExactMatch
		log.Println("Domain is in the known database exactly domain:", domain, fmt.Sprintf("(Score: %+d)", AllChecks[0].Impact))
	} else if DomainReal == 2 {
		baseScore += AllChecks[1].Impact // DomainNoSimilarity
		log.Println("Domain is not in the known database, and there are no similarities, domain:", domain, fmt.Sprintf("(Score: %+d)", AllChecks[1].Impact))
	}

	whoTheyAreResult, err := whoTheyAre(true)
	if err != nil {
		log.Fatal(err.Error())
	}
	if whoTheyAreResult.CompanyFound {
		finalScoreNormal += AllChecks[3].Impact // CompanyIdentified
		log.Println("Gemini identified them as", whoTheyAreResult.CompanyName, fmt.Sprintf("(Score: %+d)", AllChecks[3].Impact))
	} else {
		finalScoreNormal -= AllChecks[3].Impact // CompanyIdentified
		log.Println("Gemini could not identify them, but they are likely a scammer", fmt.Sprintf("(Score: %+d)", -AllChecks[3].Impact))
	}

	if whoTheyAreResult.CompanyFound {
		Verified, err2 := verifyCompany(db, whoTheyAreResult)
		if err2 != nil {
			log.Fatal(err2.Error())
			return
		}
		if Verified {
			finalScoreNormal += AllChecks[4].Impact // CompanyVerified
			log.Println("We could verify their domain with who they are trying to be", fmt.Sprintf("(Score: %+d)", AllChecks[4].Impact))
		} else {
			finalScoreNormal -= AllChecks[4].Impact
			log.Println("We could not verify their domain with who they are trying to be.", fmt.Sprintf("(Score: %+d)", -AllChecks[4].Impact))
		}
	}
	if whoTheyAreResult.ActionRequired {
		log.Println("They have an action they want you to do:", whoTheyAreResult.Action)
	} else {
		log.Println("They do not want you to do anything.")
	}
	log.Println("This is a short summary of the email:", whoTheyAreResult.SummaryOfEmail)

	if whoTheyAreResult.Realistic {
		finalScoreNormal += AllChecks[5].Impact // RealismCheck
		log.Println("Gemini believes the email is realistic", fmt.Sprintf("(Score: %+d)", AllChecks[5].Impact))
	} else {
		finalScoreNormal -= AllChecks[5].Impact // RealismCheck
		log.Println("Gemini believes the email is not realistic", fmt.Sprintf("(Score: %+d)", -AllChecks[5].Impact))
	}

	log.Println("The reason for this is:", whoTheyAreResult.RealisticReason)

	log.Println("------------ NOW IT IS CHECKING A RENDERED VERSION OF THE EMAIL -----------")
	// Render the email HTML in a headless browser and take a screenshot
	RenderEmailHTML()

	whoTheyAreResult, err = whoTheyAre(false)
	if err != nil {
		log.Fatal(err.Error())
	}
	if whoTheyAreResult.CompanyFound {
		finalScoreRendered += AllChecks[3].Impact // CompanyIdentified
		log.Println("Gemini identified them as", whoTheyAreResult.CompanyName, fmt.Sprintf("(Score: %+d)", AllChecks[3].Impact))

	} else {
		finalScoreRendered -= AllChecks[3].Impact // CompanyIdentified
		log.Println("Gemini could not identify them, but they are likely a scammer", fmt.Sprintf("(Score: %+d)", -AllChecks[3].Impact))
	}
	if whoTheyAreResult.CompanyFound {
		Verified, err2 := verifyCompany(db, whoTheyAreResult)
		if err2 != nil {
			log.Fatal(err2.Error())
			return
		}
		if Verified {
			finalScoreRendered += AllChecks[4].Impact // CompanyVerified
			log.Println("We could verify their domain with who they are trying to be", fmt.Sprintf("(Score: %+d)", AllChecks[4].Impact))
		} else {
			finalScoreRendered -= AllChecks[4].Impact
			log.Println("We could not verify their domain with who they are trying to be.", fmt.Sprintf("(Score: %+d)", -AllChecks[4].Impact))
		}
	}
	if whoTheyAreResult.ActionRequired {
		log.Println("They have an action they want you to do:", whoTheyAreResult.Action)
	} else {
		log.Println("They do not want you to do anything.")
	}
	log.Println("This is a short summary of the email:", whoTheyAreResult.SummaryOfEmail)

	if whoTheyAreResult.Realistic {
		finalScoreRendered += AllChecks[5].Impact // RealismCheck
		log.Println("Gemini believes the email is realistic", fmt.Sprintf("(Score: %+d)", AllChecks[5].Impact))
	} else {
		finalScoreRendered -= AllChecks[5].Impact // RealismCheck
		log.Println("Gemini believes the email is not realistic", fmt.Sprintf("(Score: %+d)", -AllChecks[5].Impact))
	}

	log.Println("The reason for this is:", whoTheyAreResult.RealisticReason)

	log.Println("Final score normal:", finalScoreNormal+baseScore)
	log.Println("Final score rendered:", finalScoreRendered+baseScore)

	maxScoreVal := MaxScore()
	normalPercentage := (float64(finalScoreNormal+baseScore) / maxScoreVal) * 100
	renderedPercentage := (float64(finalScoreRendered+baseScore) / maxScoreVal) * 100

	log.Printf("normal Percentage of how real: %.2f%%", normalPercentage)
	log.Printf("rendered Percentage of how real: %.2f%%", renderedPercentage)
}

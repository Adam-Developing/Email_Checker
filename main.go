package main

import (
	"database/sql"
	_ "github.com/glebarez/sqlite" // pure Go, no cgo needed
	"github.com/joho/godotenv"
	"log"
	"net/http"
	"os"
)

type headerRoundTripper struct {
	headers  http.Header
	delegate http.RoundTripper
}

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
}

var (
	//openRouterKey      string
	geminiKey          string
	googleSearchAPIKey string
	googleSearchCX     string
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
	if DomainReal {
		log.Println("Domain is in the known database or there are no similarities, domain:", domain)
	} else {
		log.Println("A similar domain is in the known database, We believe they are trying to impersonate ", domain)
	}
	whoTheyAreResult, err := whoTheyAre(true)
	if err != nil {
		log.Fatal(err.Error())
	}
	if whoTheyAreResult.CompanyFound {
		log.Println("Gemini identified them as", whoTheyAreResult.CompanyName)

	} else {
		log.Println("Gemini could not identify them, but they are likely a scammer")
	}
	if whoTheyAreResult.CompanyFound {
		Verified, err2 := verifyCompany(db, whoTheyAreResult)
		if err2 != nil {
			log.Fatal(err2.Error())
			return
		}
		if Verified {
			log.Println("We could verify their domain with who they are trying to be")
		} else {
			log.Println("We could not verify their domain with who they are trying to be.")
		}
	}
	if whoTheyAreResult.ActionRequired {
		log.Println("They have an action they want you to do:", whoTheyAreResult.Action)
	} else {
		log.Println("They do not want you to do anything.")
	}
	log.Println("This is a short summary of the email:", whoTheyAreResult.SummaryOfEmail)

	if whoTheyAreResult.Realistic {
		log.Println("Gemini believes the email is realistic")
	} else {
		log.Println("Gemini believes the email is not realistic")
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
		log.Println("Gemini identified them as", whoTheyAreResult.CompanyName)

	} else {
		log.Println("Gemini could not identify them, but they are likely a scammer")
	}
	if whoTheyAreResult.CompanyFound {
		Verified, err2 := verifyCompany(db, whoTheyAreResult)
		if err2 != nil {
			log.Fatal(err2.Error())
			return
		}
		if Verified {
			log.Println("We could verify their domain with who they are trying to be")
		} else {
			log.Println("We could not verify their domain with who they are trying to be.")
		}
	}
	if whoTheyAreResult.ActionRequired {
		log.Println("They have an action they want you to do:", whoTheyAreResult.Action)
	} else {
		log.Println("They do not want you to do anything.")
	}
	log.Println("This is a short summary of the email:", whoTheyAreResult.SummaryOfEmail)

	if whoTheyAreResult.Realistic {
		log.Println("Gemini believes the email is realistic")
	} else {
		log.Println("Gemini believes the email is not realistic")
	}

	log.Println("The reason for this is:", whoTheyAreResult.RealisticReason)

}

package main

import (
	"database/sql"
	_ "github.com/glebarez/sqlite" // pure Go, no cgo needed
	"github.com/joho/godotenv"
	"log"
	"os"
)

func init() {
	if err := godotenv.Load(); err != nil {
		log.Printf(".env file not found: %v\n", err)
	}
	openRouterKey = os.Getenv("OPENROUTER_API_KEY")
	geminiKey = os.Getenv("GEMINI_API_KEY")
	googleSearchAPIKey = os.Getenv("GOOGLE_SEARCH_API_KEY")
	googleSearchCX = os.Getenv("GOOGLE_SEARCH_CX")
}

var (
	openRouterKey      string
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
	are, b, err := whoTheyAre(db)
	if err != nil {
		return
	}
	if b {
		log.Println("The company matches their domain, and Gemini identified them as", are)
	} else {
		log.Println("Their domain doesn't match their claimed identity. Gemini suggests they are", are)
	}

}

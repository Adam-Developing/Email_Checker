package main

import (
	"database/sql"
	_ "github.com/glebarez/sqlite" // pure Go, no cgo needed
	"log"
)

func main() {
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
	if DomainReal {
		log.Println("Domain is real, domain:", domain)
	} else {
		log.Println("Domain is not real, We believe they are trying to impersonate ", domain)
	}
	whoTheyAre()

}

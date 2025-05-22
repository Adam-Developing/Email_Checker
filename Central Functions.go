package main

import (
	"database/sql"
	"github.com/jhillyerd/enmime"
	"github.com/lithammer/fuzzysearch/fuzzy"
	"golang.org/x/net/idna"
	"log"
	"math"
	"net/mail"
	"os"
	"strings"
)

var Email struct {
	Subject string
	From    string
	Domain  string
	Text    string
	HTML    string
}

func parseEmail() {
	f, err := os.Open("test.eml")
	if err != nil {
		log.Fatal(err)
	}
	defer func(f *os.File) {
		err := f.Close()
		if err != nil {
			log.Fatal(err)
		}
	}(f)
	env, err := enmime.ReadEnvelope(f)
	if err != nil {
		log.Fatal(err)
	}
	Email.Subject = env.GetHeader("Subject")
	Email.From = env.GetHeader("From")
	Email.Text = env.Text
	Email.HTML = env.HTML

	address, err := mail.ParseAddress(Email.From)
	if err != nil {
		return
	}
	_, Email.Domain, _ = strings.Cut(strings.ToLower(address.Address), "@")
}

func checkDomainReal(db *sql.DB, domainReal string) (bool, string, error) {
	// TODO This does not factor in subdomains or domain endings like .com, .net, etc.
	// 1) Normalise (IDN → ASCII, lower-case)
	ascii, err := idna.Lookup.ToASCII(strings.ToLower(domainReal))
	if err != nil {
		ascii = strings.ToLower(domainReal) // fallback
	}

	// 2) Exact-match check
	var cnt int
	err = db.QueryRow(
		`SELECT COUNT(domain) FROM websites WHERE domain = ?`,
		ascii,
	).Scan(&cnt)
	if err != nil {
		return true, "", err
	}
	if cnt > 0 {
		return true, ascii, nil
	}

	// 3) Compute a sensible Levenshtein threshold
	//    ≤1 for names <8 chars, ≤2 for 8–12, ~15% for >12
	var thresh int
	l := len(ascii)
	switch {
	case l <= 11:
		thresh = 1
	case l <= 15:
		thresh = 2
	default:
		thresh = int(math.Ceil(float64(l) * 0.15))
	}

	// 4) Fetch all domains from the database
	rows, err := db.Query("SELECT domain FROM websites")
	if err != nil {
		return true, "", err
	}
	defer func(rows *sql.Rows) {
		err := rows.Close()
		if err != nil {
			log.Fatal(err)
		}
	}(rows)

	// 5) Single pass: compute edit distance only on this tiny subset
	for rows.Next() {
		var dbDomain string
		if err := rows.Scan(&dbDomain); err != nil {
			return true, "", err
		}
		lower := strings.ToLower(dbDomain)
		if fuzzy.LevenshteinDistance(ascii, lower) <= thresh {
			// found a look-alike
			return false, dbDomain, nil
		}
	}
	if err := rows.Err(); err != nil {
		return true, "", err
	}

	// 6) No close matches → treat as real (or benign typo)
	return true, ascii, nil
}

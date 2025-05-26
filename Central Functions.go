package main

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/jhillyerd/enmime"
	"github.com/lithammer/fuzzysearch/fuzzy"
	"golang.org/x/net/context"
	"golang.org/x/net/html"
	"golang.org/x/net/idna"
	"golang.org/x/net/publicsuffix"
	"google.golang.org/genai"
	"io"
	"log"
	"math"
	"mime"
	"mime/quotedprintable"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var Email struct {
	Subject   string
	From      string
	subDomain string
	Domain    string
	Text      string
	HTML      string
}

var fileName = "google.eml"

type GoogleSearchResult struct {
	Items []struct {
		Link string `json:"link"`
	} `json:"items"`
}

// cutHTML trims everything starting at the first giant spacer (<div height:… >)
// or at the first run of 40 empty <p/> tags.
func cutHTML(src string) string {
	lc := strings.ToLower(src)

	// 1) huge fixed-height div
	if m := regexp.MustCompile(`(?i)<div[^>]*\bheight\s*:\s*(\d+)px`).FindStringSubmatchIndex(lc); len(m) == 4 {
		if h, _ := strconv.Atoi(lc[m[2]:m[3]]); h > 3000 { // px threshold
			return src[:m[0]]
		}
	}

	// 2) ≥40 consecutive blank paragraphs ( , &nbsp;, nothing)
	if m := regexp.MustCompile(`(?i)(?:<p[^>]*>\s*(?:&nbsp;)?\s*</p>[\s\r\n]*){40,}`).FindStringIndex(lc); len(m) == 2 {
		return src[:m[0]]
	}

	return src
}
func htmlToText(src string) string {
	z := html.NewTokenizer(strings.NewReader(src))
	var b strings.Builder
	writeNL := func() {
		if b.Len() > 0 && b.String()[b.Len()-1] != '\n' {
			b.WriteByte('\n')
		}
	}

	for {
		switch tt := z.Next(); tt {
		case html.ErrorToken:
			return strings.TrimSpace(html.UnescapeString(b.String()))
		case html.TextToken:
			txt := strings.TrimSpace(html.UnescapeString(string(z.Text())))
			if txt != "" {
				b.WriteString(txt)
				b.WriteByte(' ')
			}
		case html.StartTagToken, html.EndTagToken:
			name, _ := z.TagName()
			switch strings.ToLower(string(name)) {
			case "p", "br", "div", "li", "tr", "hr":
				writeNL()
			}
		default:
			panic("unhandled default case")
		}
	}
}
func updateEML(in, out, newPlain, newHTML string) error {
	// ----- read original headers -----
	r, err := os.Open(in)
	if err != nil {
		return err
	}
	msg, err := mail.ReadMessage(r)
	err = r.Close()
	if err != nil {
		return err
	}
	// ----- craft a fresh multipart/alternative -----
	boundary := "=_clean_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	var buf bytes.Buffer

	// original (non-body) headers
	for k, vv := range msg.Header {
		if strings.EqualFold(k, "Content-Type") {
			continue // we replace it
		}
		for _, v := range vv {
			_, _ = fmt.Fprintf(&buf, "%s: %s\r\n", k, v)

		}
	}
	_, _ = fmt.Fprintf(&buf,
		"Content-Type: multipart/alternative; boundary=\"%s\"\r\n\r\n", boundary)

	// plain text part (quoted-printable)
	_, _ = fmt.Fprintf(&buf, "--%s\r\n", boundary)
	_, _ = fmt.Fprint(&buf, "Content-Type: text/plain; charset=utf-8\r\n")
	_, _ = fmt.Fprint(&buf, "Content-Transfer-Encoding: quoted-printable\r\n\r\n")
	qp := quotedprintable.NewWriter(&buf)
	_, _ = qp.Write([]byte(newPlain))
	_ = qp.Close()
	buf.WriteString("\r\n")

	// HTML part (quoted-printable)
	_, _ = fmt.Fprintf(&buf, "--%s\r\n", boundary)
	_, _ = fmt.Fprint(&buf, "Content-Type: text/html; charset=utf-8\r\n")
	_, _ = fmt.Fprint(&buf, "Content-Transfer-Encoding: quoted-printable\r\n\r\n")
	qp = quotedprintable.NewWriter(&buf)
	_, _ = qp.Write([]byte(newHTML))
	_ = qp.Close()
	buf.WriteString("\r\n")

	// close multipart
	_, _ = fmt.Fprintf(&buf, "--%s--\r\n", boundary)

	// ----- write back out -----
	return os.WriteFile(out, buf.Bytes(), 0o644)
}
func imgSrcs(htmlStr string) []string {
	var list []string
	z := html.NewTokenizer(strings.NewReader(htmlStr))
	for {
		switch z.Next() {
		case html.ErrorToken:
			return list
		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			if string(name) != "img" || !hasAttr {
				continue
			}
			for {
				key, val, moreAttr := z.TagAttr()
				if string(key) == "src" {
					list = append(list, string(val))
					break
				}
				if !moreAttr {
					break
				}
			}
		default:
			panic("unhandled default case")
		}
	}
}

func parseEmail() {
	f, err := os.Open(fileName)
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

	/* ---------- truncate & clean ---------- */
	Email.HTML = cutHTML(Email.HTML)
	Email.Text = htmlToText(Email.HTML)

	if err := updateEML(
		fileName,
		strings.Replace(fileName, ".eml", "-clean.eml", 1),
		Email.Text, Email.HTML); err != nil {
		log.Fatal(err)
	}
	fileName = strings.Replace(fileName, ".eml", "-clean.eml", 1)

	if addr, err := mail.ParseAddress(Email.From); err == nil {
		_, Email.subDomain, _ = strings.Cut(strings.ToLower(addr.Address), "@")
		if md, err := publicsuffix.EffectiveTLDPlusOne(Email.subDomain); err == nil {
			Email.Domain = md
		}
	}

	_ = os.RemoveAll("attachments") // start fresh
	_ = os.MkdirAll("attachments", 0o755)

	/* ---------- save inline & attached images ---------- */
	savePart := func(p *enmime.Part, prefix string, n int) {
		if !strings.HasPrefix(p.ContentType, "image/") {
			return
		}
		name := p.FileName
		if name == "" {
			if exts, _ := mime.ExtensionsByType(p.ContentType); len(exts) > 0 {
				name = fmt.Sprintf("%s-%d%s", prefix, n, exts[0])
			} else {
				name = fmt.Sprintf("%s-%d.bin", prefix, n)
			}
		}
		_ = os.WriteFile(filepath.Join("attachments", name), p.Content, 0o644)
	}
	for i, p := range env.Inlines {
		savePart(p, "inline", i)
	}
	for i, p := range env.Attachments {
		savePart(p, "attach", i)
	}

	/* ---------- save every image referenced in <img src="…"> ---------- */
	seen := make(map[string]struct{})
	for i, src := range imgSrcs(Email.HTML) {
		if _, dup := seen[src]; dup {
			continue
		}
		seen[src] = struct{}{}

		switch {
		// "cid:xxxx"  → already saved above, nothing to do
		case strings.HasPrefix(src, "cid:"):
			continue

		// data-URI  → decode & save
		case strings.HasPrefix(src, "data:image/"):
			if idx := strings.Index(src, "base64,"); idx != -1 {
				data, err := base64.StdEncoding.DecodeString(src[idx+7:])
				if err == nil {
					ext := ".img"
					if m := regexp.MustCompile(`data:image/([^;]+);`).FindStringSubmatch(src); len(m) == 2 {
						ext = "." + m[1]
					}
					fn := fmt.Sprintf("data-%d%s", i, ext)
					_ = os.WriteFile(filepath.Join("attachments", fn), data, 0o644)
				}
			}

		// //example.com/…  → add scheme
		case strings.HasPrefix(src, "//"):
			src = "https:" + src
			fallthrough

		// http(s) remote  → download
		case strings.HasPrefix(src, "http://"), strings.HasPrefix(src, "https://"):
			resp, err := http.Get(src)
			if err != nil || resp.StatusCode != http.StatusOK {
				if resp != nil && resp.Body != nil {
					err := resp.Body.Close()
					if err != nil {
						log.Fatal(err)
						return
					}
				}
				continue
			}
			ct := resp.Header.Get("Content-Type")
			if !strings.HasPrefix(ct, "image/") {
				err := resp.Body.Close()
				if err != nil {
					log.Fatal(err)
					return
				}
				continue
			}
			data, _ := io.ReadAll(resp.Body)
			err = resp.Body.Close()
			if err != nil {
				log.Fatal(err)
				return
			}

			u, _ := url.Parse(src)
			name := path.Base(u.Path)
			if name == "" || name == "/" {
				if exts, _ := mime.ExtensionsByType(ct); len(exts) > 0 {
					name = fmt.Sprintf("remote-%d%s", i, exts[0])
				} else {
					name = fmt.Sprintf("remote-%d", i)
				}
			}
			_ = os.WriteFile(filepath.Join("attachments", name), data, 0o644)
		}
	}
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

//func whoTheyAre() {
//	prompt := "This is the plain text email: " + Email.Text + " This is the HTML email: " + Email.HTML + "\n Please tell me the company they are trying to be."
//	client := openrouter.NewClient(
//		openRouterKey,
//		openrouter.WithXTitle("Email Checker"),
//		openrouter.WithHTTPReferer("https://adamkhattab.co.uk"),
//	)
//	resp, err := client.CreateChatCompletion(
//		context.Background(),
//		openrouter.ChatCompletionRequest{
//			Model: "deepseek/deepseek-r1:free",
//			Messages: []openrouter.ChatCompletionMessage{
//				{
//					Role:    openrouter.ChatMessageRoleUser,
//					Content: openrouter.Content{Text: prompt},
//				},
//				{
//					Role:    openrouter.ChatMessageRoleSystem,
//					Content: openrouter.Content{Text: "You are a bot that identifies companies from emails. You only respond with the company name in plain text with no additional characters or information."},
//				},
//			},
//		},
//	)
//
//	if err != nil {
//		fmt.Printf("ChatCompletion error: %v\n", err)
//		return
//	}
//
//	fmt.Println(resp.Choices[0].Message.Content)
//
//}

// hard cap for the request we send to Gemini (bytes on-the-wire)
// adjust to match the model-backend limit – 8 MiB keeps us well inside 10 MB
const maxReqBytes = 8 << 20 // 8 MiB

func whoTheyAre(db *sql.DB) (string, bool, error) {
	f, err := os.Open(fileName)
	if err != nil {
		return "", false, err
	}
	raw, err := io.ReadAll(f)
	err = f.Close()
	if err != nil {
		return "", false, err
	}

	prompt := "This is the full EML file:\n" + string(raw) +
		"\nPlease tell me the company they are trying to be."
	used := len(prompt) // running total request size

	var contents []*genai.Content

	/* ---- attach images while we have room ---- */
	if items, err := os.ReadDir("attachments"); err == nil {
		for _, it := range items {
			if it.IsDir() {
				continue
			}
			b, err := os.ReadFile(filepath.Join("attachments", it.Name()))
			if err != nil {
				continue
			}
			if mimeEmail := http.DetectContentType(b); strings.HasPrefix(mimeEmail, "image/") {
				if used+len(b) > maxReqBytes {
					break // adding this one would push us over the cap
				}
				contents = append(contents, genai.NewContentFromBytes(b, mimeEmail, ""))
				used += len(b)
			}
		}
	}

	/* ---- finally add the textual prompt ---- */
	contents = append(contents, genai.NewContentFromText(prompt, ""))

	ctx := context.Background()
	client, err := genai.NewClient(ctx, &genai.ClientConfig{
		APIKey:  geminiKey,
		Backend: genai.BackendGeminiAPI,
	})
	if err != nil {
		return "", false, err
	}

	cfg := &genai.GenerateContentConfig{
		SystemInstruction: genai.NewContentFromText(
			"You are a bot that identifies companies from emails. You only respond with the company name in plain text with no additional characters or information. If you cannot identify the company, respond with the word UNKNOWN. You must not assume anything and only use the information provided in the email STRICTLY.",
			"",
		),
	}

	res, err := client.Models.GenerateContent(ctx, "gemini-2.0-flash-lite", contents, cfg)
	if err != nil {
		return "", false, err
	}
	companyName := strings.TrimSpace(res.Text())
	log.Println("Gemini believes the Company Name is:", companyName)

	/* ---- check DB ---- */
	q, err := db.Query(`SELECT domain FROM websites WHERE item_label = ?`, companyName)
	if err != nil {
		return companyName, false, err
	}
	defer func(q *sql.Rows) {
		err := q.Close()
		if err != nil {
			log.Fatal(err)
		}
	}(q)
	for q.Next() {
		var d string
		_ = q.Scan(&d)
		if d == Email.Domain {
			return companyName, true, nil
		}
	}

	/* ---- Google fallback ---- */
	escaped := url.QueryEscape(companyName)
	req, err := http.NewRequest("GET",
		"https://www.googleapis.com/customsearch/v1?key="+googleSearchAPIKey+
			"&cx="+googleSearchCX+
			"&q="+escaped, nil)
	if err != nil {
		return companyName, false, err
	}
	req.Header.Set("User-Agent", "Adam Khattab's Spam Email Checker/1.0 (https://adamkhattab.co.uk)")
	req.Header.Set("Accept", "*/*")

	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		return companyName, false, err
	}
	body, _ := io.ReadAll(resp.Body)
	err = resp.Body.Close()
	if err != nil {
		return "", false, err
	}

	var sr GoogleSearchResult
	if err := json.Unmarshal(body, &sr); err != nil {
		return companyName, false, err
	}
	if len(sr.Items) == 0 {
		return companyName, false, nil
	}
	linkDomain, err := extractDomain(sr.Items[0].Link)
	if err != nil {
		return companyName, false, err
	}
	return companyName, linkDomain == Email.Domain, nil
}

// Function to extract domain from a URL
func extractDomain(rawURL string) (string, error) {
	parsedURL, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	host := parsedURL.Host
	if strings.HasPrefix(host, "www.") {
		host = strings.TrimPrefix(host, "www.")
	}
	return host, nil
}

package main

import (
	"bytes"
	"context"
	"fmt"
	_ "io"
	"log"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/chromedp/chromedp"
	"github.com/jhillyerd/enmime"
	"golang.org/x/net/html"
)

var screenshotFileName string

// RenderEmailHTML renders the email's HTML content in a headless browser and saves a screenshot.
// It correctly handles embedded images (cid:) by saving them as temporary files and rewriting the HTML.
func RenderEmailHTML(env *enmime.Envelope) {
	// --- Step 1: Create a temporary directory for all rendering assets ---
	tempDir, err := os.MkdirTemp("", "email-render-*")
	if err != nil {
		log.Printf("Failed to create temp directory: %v", err)
		return
	}
	defer func(path string) {
		err := os.RemoveAll(path)
		if err != nil {
			log.Fatal(err)
		}
	}(tempDir)

	// --- Step 2: Rewrite the HTML to use local file paths for embedded images ---
	modifiedHTML, err := rewriteHTMLForRendering(env, tempDir)
	if err != nil {
		log.Printf("Failed to rewrite HTML for rendering: %v", err)
		return
	}

	// Save the modified HTML to the temporary directory.
	tempFile := filepath.Join(tempDir, "email.html")
	if err := os.WriteFile(tempFile, []byte(modifiedHTML), 0644); err != nil {
		log.Printf("Failed to write temp HTML file: %v", err)
		return
	}

	// --- Step 3: Set up and run the headless browser (Chrome) ---
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.DisableGPU,
		chromedp.NoSandbox,
		chromedp.Flag("disable-extensions", true),
		chromedp.Flag("incognito", true),
	)
	allocCtx, cancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer cancel()

	ctx, cancel := chromedp.NewContext(allocCtx)
	defer cancel()
	ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// --- Step 4: Capture the screenshot ---
	var buf []byte
	fileURL := "file:///" + filepath.ToSlash(tempFile)

	if err := chromedp.Run(ctx,
		chromedp.Navigate(fileURL),
		chromedp.WaitVisible("body", chromedp.ByQuery),
		chromedp.FullScreenshot(&buf, 100),
	); err != nil {
		log.Printf("Failed to capture screenshot: %v", err)
		return
	}

	// --- Step 5: Save the screenshot to the "screenshots" directory ---
	if err := os.MkdirAll("screenshots", 0755); err != nil {
		log.Printf("Failed to create screenshots directory: %v", err)
		return
	}

	screenshotFileName = strings.TrimSuffix(filepath.Base(fileName), filepath.Ext(fileName)) + ".png"
	screenshotFile := filepath.Join("screenshots", screenshotFileName)

	if err := os.WriteFile(screenshotFile, buf, 0644); err != nil {
		log.Printf("Failed to save screenshot: %v", err)
	}
}

// rewriteHTMLForRendering finds all cid: images in the HTML, saves them to a directory,
// and returns a new HTML string with the src attributes rewritten to local file paths.
func rewriteHTMLForRendering(env *enmime.Envelope, tempDir string) (string, error) {
	// Create a map of Content-IDs to their corresponding email parts.
	cidMap := make(map[string]*enmime.Part)
	allParts := append(env.Inlines, env.Attachments...)
	allParts = append(allParts, env.OtherParts...)
	for _, p := range allParts {
		if cid := p.Header.Get("Content-ID"); cid != "" {
			cidMap[strings.Trim(cid, "<>")] = p
		}
	}

	doc, err := html.Parse(strings.NewReader(env.HTML))
	if err != nil {
		return "", err
	}

	// This recursive function walks through the HTML nodes.
	var f func(*html.Node)
	f = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "img" {
			var newAttrs []html.Attribute
			for _, attr := range n.Attr {
				// If we find the 'src' attribute and it's a 'cid:' link...
				if attr.Key == "src" && strings.HasPrefix(attr.Val, "cid:") {
					cid := strings.TrimPrefix(attr.Val, "cid:")
					if part, ok := cidMap[cid]; ok {
						// Determine file extension from content type.
						exts, _ := mime.ExtensionsByType(part.ContentType)
						ext := ".bin"
						if len(exts) > 0 {
							ext = exts[0]
						}
						// Create a unique local filename and save the image.
						imgFileName := fmt.Sprintf("%s%s", part.FileName, ext)
						if part.FileName == "" {
							imgFileName = fmt.Sprintf("%s%s", cid, ext)
						}
						imgPath := filepath.Join(tempDir, imgFileName)
						if err := os.WriteFile(imgPath, part.Content, 0644); err == nil {
							// Replace the src attribute with the new local path.
							attr.Val = imgFileName
						}
					}
				}
				newAttrs = append(newAttrs, attr)
			}
			n.Attr = newAttrs
		}
		// Recurse for all children of the node.
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			f(c)
		}
	}
	f(doc)

	// Render the modified HTML tree back into a string.
	var buf bytes.Buffer
	if err := html.Render(&buf, doc); err != nil {
		return "", err
	}
	return buf.String(), nil
}

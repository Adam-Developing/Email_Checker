package main

import (
	"bytes"
	"context"
	"fmt"
	_ "io"
	"log"
	"mime"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/chromedp/cdproto/emulation"

	"github.com/chromedp/chromedp"
	"github.com/jhillyerd/enmime"
	"golang.org/x/net/html"
)

var screenshotFileName string

// RenderEmailHTML renders the email's HTML content in a headless browser and saves a screenshot.
// It correctly handles embedded images (cid:) by saving them as temporary files and rewriting the HTML.
func RenderEmailHTML(env *enmime.Envelope, fileName string, sandboxDir string) string {

	// --- Step 2: Rewrite the HTML to use local file paths for embedded images ---
	modifiedHTML, err := rewriteHTMLForRendering(env, sandboxDir)
	if err != nil {
		log.Printf("Failed to rewrite HTML for rendering: %v", err)
		return ""
	}

	// Save the modified HTML to the temporary directory.
	tempFile := filepath.Join(sandboxDir, "email.html")
	if err := os.WriteFile(tempFile, []byte(modifiedHTML), 0644); err != nil {
		log.Printf("Failed to write temp HTML file: %v", err)
		return ""
	}

	// --- Step 3: Set up and run the headless browser (Chrome) ---
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
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
		emulation.SetDeviceMetricsOverride(1280, 1024, 3, false).
			WithScreenOrientation(&emulation.ScreenOrientation{
				Type:  emulation.OrientationTypePortraitPrimary,
				Angle: 0,
			}),

		chromedp.Navigate(fileURL),
		chromedp.WaitReady("body", chromedp.ByQuery),
		chromedp.Sleep(1*time.Second),
		chromedp.FullScreenshot(&buf, 100),
	); err != nil {
		log.Printf("Failed to capture screenshot: %v", err)
		return ""
	}

	// --- Step 5: Save the screenshot to the "screenshots" directory ---

	screenshotsDir := filepath.Join(sandboxDir, "screenshots")
	if err := os.MkdirAll(screenshotsDir, 0755); err != nil {
		log.Printf("Failed to create screenshots directory: %v", err)
		return ""
	}

	screenshotFileName = strings.TrimSuffix(filepath.Base(fileName), filepath.Ext(fileName)) + ".png"
	screenshotFile := filepath.Join(screenshotsDir, screenshotFileName)

	if err := os.WriteFile(screenshotFile, buf, 0644); err != nil {
		log.Printf("Failed to save screenshot: %v", err)
	}
	return screenshotFile
}

// rewriteHTMLForRendering finds cid: images, saves them, rewrites src attributes,
// and ensures the HTML has a UTF-8 meta tag.
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

	// --- START: MODIFICATION ---
	// Ensure the document has a <head> and a <meta charset="UTF-8"> tag.
	var head *html.Node
	var htmlNode *html.Node

	// Find <html> and <head>
	var findNodes func(*html.Node)
	findNodes = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if n.Data == "html" {
				htmlNode = n
			}
			if n.Data == "head" {
				head = n
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			findNodes(c)
		}
	}
	findNodes(doc)

	// If <head> doesn't exist, create it inside <html>
	if head == nil && htmlNode != nil {
		head = &html.Node{
			Type: html.ElementNode,
			Data: "head",
		}
		// Prepend head to html's children
		if htmlNode.FirstChild != nil {
			head.NextSibling = htmlNode.FirstChild
		}
		htmlNode.FirstChild = head
	}

	// If we have a <head>, add the meta tag
	if head != nil {
		metaNode := &html.Node{
			Type: html.ElementNode,
			Data: "meta",
			Attr: []html.Attribute{
				{Key: "charset", Val: "UTF-8"},
			},
		}
		// Prepend meta tag to head's children
		if head.FirstChild != nil {
			metaNode.NextSibling = head.FirstChild
		}
		head.FirstChild = metaNode
		// Create the <style> tag to force a clear font for OCR
		styleContent := `* { font-family: Verdana, sans-serif !important; }`
		styleNode := &html.Node{
			Type: html.ElementNode,
			Data: "style",
			FirstChild: &html.Node{
				Type: html.TextNode,
				Data: styleContent,
			},
		}
		// Prepend the style tag right after the meta tag
		styleNode.NextSibling = head.FirstChild
		head.FirstChild = styleNode

	}

	// This recursive function walks through the HTML nodes to replace image sources.
	var f func(*html.Node)
	f = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "img" {
			var newAttrs []html.Attribute
			for _, attr := range n.Attr {
				if attr.Key == "src" && strings.HasPrefix(attr.Val, "cid:") {
					cid := strings.TrimPrefix(attr.Val, "cid:")
					if part, ok := cidMap[cid]; ok {
						if len(part.Content) > 0 {

							exts, _ := mime.ExtensionsByType(part.ContentType)
							ext := ".bin"
							if len(exts) > 0 {
								ext = exts[0]
							}
							imgFileName := fmt.Sprintf("%s%s", part.FileName, ext)
							if part.FileName == "" {
								imgFileName = fmt.Sprintf("%s%s", cid, ext)
							}
							imgPath := filepath.Join(tempDir, imgFileName)
							if err := os.WriteFile(imgPath, part.Content, 0644); err == nil {
								attr.Val = imgFileName
							}
						}

					}
				}
				newAttrs = append(newAttrs, attr)
			}
			n.Attr = newAttrs
		}
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

// OCRImage executes the Tesseract command-line tool on the given image file
// and returns the extracted text.
func OCRImage(fileNameImage string) string {
	// Prepare the command to run Tesseract. The "stdout" argument tells
	// Tesseract to print its output to the console instead of a file.
	cmd := exec.Command("tesseract", fileNameImage, "stdout")

	// Run the command and capture the combined standard output and standard error.
	output, err := cmd.CombinedOutput()
	if err != nil {
		// If the command fails, log the error and the output for debugging.
		log.Printf("Error running Tesseract: %v\nOutput: %s", err, string(output))
		return "" // Return an empty string to indicate failure.
	}

	// Remove lines containing 'Estimating resolution as' from the output
	lines := strings.Split(string(output), "\n")
	var filtered []string
	for _, line := range lines {
		if !strings.Contains(line, "Estimating resolution as") {
			filtered = append(filtered, line)
		}
	}
	return strings.Join(filtered, "\n")
}

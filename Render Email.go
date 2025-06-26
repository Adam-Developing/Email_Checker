package main

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"github.com/chromedp/chromedp"
)

// RenderEmailHTML takes the HTML content from the Email struct,
// renders it in a headless browser, and takes a full screenshot of the page.
// The screenshot is saved to a file in the current directory.

var screenshotFileName string

func RenderEmailHTML() {
	// Create a custom allocator with specific options to avoid cookie parsing issues
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.DisableGPU,
		chromedp.NoSandbox,
		chromedp.Flag("disable-extensions", true),
		chromedp.Flag("incognito", true),
	)
	allocCtx, cancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer cancel()

	// Create a context with the custom allocator
	ctx, cancel := chromedp.NewContext(allocCtx)
	defer cancel()

	// Add a timeout to the context
	ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// Create a temporary HTML file to render
	tempDir, err := os.MkdirTemp("", "email-render")
	if err != nil {
		//log.Fatalf("Failed to create temp directory: %v", err)
		// TODO handle error gracefully
	}
	defer func(path string) {
		err := os.RemoveAll(path)
		if err != nil {
			//log.Printf("Failed to remove temp directory: %v", err)
			// TODO handle error gracefully
		}
	}(tempDir)

	tempFile := filepath.Join(tempDir, "email.html")
	if err := os.WriteFile(tempFile, []byte(Email.HTML), 0644); err != nil {
		//log.Fatalf("Failed to write temp file: %v", err)
		// TODO handle error gracefully
	}

	// Convert to file URL - ensure proper format for Windows
	fileURL := "file:///" + filepath.ToSlash(tempFile)

	// Create a buffer to store the screenshot
	var buf []byte

	// Use chromedp to navigate to the file and take a screenshot
	if err := chromedp.Run(ctx,
		chromedp.Navigate(fileURL),
		chromedp.WaitVisible("body", chromedp.ByQuery),
		chromedp.FullScreenshot(&buf, 100),
	); err != nil {
		//log.Fatalf("Failed to capture screenshot: %v", err)
		// TODO handle error gracefully
	}

	// Create screenshots directory if it doesn't exist
	if err := os.MkdirAll("screenshots", 0755); err != nil {
		//log.Fatalf("Failed to create screenshots directory: %v", err)
		// TODO handle error gracefully
	}

	// Generate a filename based on the original email filename
	screenshotFileName = filepath.Base(fileName) + ".png"
	screenshotFile := filepath.Join("screenshots", screenshotFileName)

	// Save the screenshot
	if err := os.WriteFile(screenshotFile, buf, 0644); err != nil {
		//log.Fatalf("Failed to save screenshot: %v", err)
		// TODO handle error gracefully
	}

	//log.Printf("Screenshot saved to %s", screenshotFile)
	// TODO handle success gracefully
}

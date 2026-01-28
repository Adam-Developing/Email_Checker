//go:build windows

package main

import (
	"log"
	"os"
	"os/exec"
)

func setupDependencies() {
	// Check for ImageMagick
	if !commandExists("magick", "magick.exe") {
		if askForConfirmation("ImageMagick is missing. Install via Winget/Chocolatey?") {
			if commandExists("winget") {
				runWinget("ImageMagick.ImageMagick")
			} else if commandExists("choco", "choco.exe") {
				runChoco("imagemagick")
			} else {
				log.Println("No supported Windows package manager (winget or choco) found. Please install ImageMagick manually from https://imagemagick.org/")
			}
		} else {
			log.Println("Skipping ImageMagick. Rendered analysis may fail.")
		}
	}

	// Check for Tesseract
	if !commandExists("tesseract", "tesseract.exe") {
		if askForConfirmation("Tesseract OCR is missing. Install via Winget/Chocolatey?") {
			if commandExists("winget") {
				runWinget("UB-Mannheim.TesseractOCR")
			} else if commandExists("choco", "choco.exe") {
				runChoco("tesseract")
			} else {
				log.Println("No supported Windows package manager (winget or choco) found. Please install Tesseract manually from https://github.com/tesseract-ocr/tesseract")
			}
		} else {
			log.Println("Skipping Tesseract. OCR features will be disabled.")
		}
	}
}

func runWinget(id string) {
	if _, err := exec.LookPath("winget"); err != nil {
		log.Printf("winget not found: %v", err)
		return
	}
	cmd := exec.Command("winget", "install", "--id", id, "-e", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	if err := cmd.Run(); err != nil {
		log.Printf("Failed to install %s via winget: %v", id, err)
	} else {
		log.Println("Install complete. You may need to restart the app to detect the new PATH.")
	}
}

func runChoco(pkg string) {
	if _, err := exec.LookPath("choco"); err != nil {
		log.Printf("choco not found: %v", err)
		return
	}
	cmd := exec.Command("choco", "install", pkg, "-y")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	if err := cmd.Run(); err != nil {
		log.Printf("Failed to install %s via choco: %v", pkg, err)
	} else {
		log.Println("Install complete. You may need to restart the app to detect the new PATH.")
	}
}

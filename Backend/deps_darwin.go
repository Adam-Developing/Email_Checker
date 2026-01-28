//go:build darwin

package main

import (
	"log"
	"os"
	"os/exec"
)

func setupDependencies() {
	if !commandExists("brew") {
		log.Println("Homebrew not found. Cannot auto-install dependencies.")
		return
	}

	depsToInstall := []string{}

	if !commandExists("tesseract") {
		if askForConfirmation("Tesseract OCR is missing. Install via Homebrew?") {
			depsToInstall = append(depsToInstall, "tesseract")
		}
	}

	if !commandExists("magick") {
		if askForConfirmation("ImageMagick is missing. Install via Homebrew?") {
			depsToInstall = append(depsToInstall, "imagemagick")
		}
	}

	if len(depsToInstall) > 0 {
		log.Printf("Installing via Homebrew: %v...", depsToInstall)
		args := append([]string{"install"}, depsToInstall...)
		cmd := exec.Command("brew", args...)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.Stdin = os.Stdin
		if err := cmd.Run(); err != nil {
			log.Printf("Homebrew install failed: %v", err)
		}
	}
}

//go:build linux

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
)

func setupDependencies() {
	dependencies := map[string]string{
		"tesseract": "tesseract-ocr",
		"magick":    "imagemagick",
	}

	for cmd, pkg := range dependencies {
		if !commandExists(cmd) {
			msg := fmt.Sprintf("Missing dependency '%s' (%s). Would you like to install it?", cmd, pkg)
			if askForConfirmation(msg) {
				installLinuxPackage(pkg)
			} else {
				log.Printf("Skipping installation of %s. Some features may not work.", pkg)
			}
		}
	}
}

func installLinuxPackage(pkg string) {
	managers := []struct {
		check      string
		installCmd []string
	}{
		{"apt-get", []string{"sudo", "apt-get", "install", "-y", pkg}},
		{"dnf", []string{"sudo", "dnf", "install", "-y", pkg}},
		{"pacman", []string{"sudo", "pacman", "-S", "--noconfirm", pkg}},
	}

	for _, mgr := range managers {
		if _, err := exec.LookPath(mgr.check); err == nil {
			log.Printf("Installing %s using %s...", pkg, mgr.check)
			cmd := exec.Command(mgr.installCmd[0], mgr.installCmd[1:]...)
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			cmd.Stdin = os.Stdin
			if err := cmd.Run(); err != nil {
				log.Printf("Failed to install %s: %v", pkg, err)
			}
			return
		}
	}
	log.Printf("No supported package manager found. Please install %s manually.", pkg)
}

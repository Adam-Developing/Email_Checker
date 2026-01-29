package main

import (
	"strings"
	"testing"
)

func TestSanitizeEmailCSS(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		contains []string
		notContains []string
	}{
		{
			name:  "Remove obfuscated classes",
			input: `<div class="obf-TForm obf-EmailCheckbox">Test</div>`,
			notContains: []string{"obf-TForm", "obf-EmailCheckbox"},
		},
		{
			name:  "Disable Outlook conditional comments",
			input: `<!--[if mso]><style>body{font-family:Arial;}</style><![endif]-->`,
			notContains: []string{"<!--[if mso]"},
			contains: []string{"<!--[disabled if"},
		},
		{
			name:  "Remove dangerous CSS properties - position fixed",
			input: `<style>div{position:fixed;top:0;}</style>`,
			notContains: []string{"position:fixed", "position: fixed"},
			contains: []string{"/* removed */"},
		},
		{
			name:  "Remove dangerous CSS properties - high z-index",
			input: `<style>.modal{z-index:9999;}</style>`,
			notContains: []string{"z-index:9999", "z-index: 9999"},
			contains: []string{"/* removed */"},
		},
		{
			name:  "Preserve safe content",
			input: `<div class="normal-class">Content</div>`,
			contains: []string{"normal-class", "Content"},
		},
		{
			name:  "Handle mixed content",
			input: `<div class="safe obf-Dangerous">Text</div><style>p{position:absolute;}</style>`,
			notContains: []string{"obf-Dangerous", "position:absolute"},
			contains: []string{"Text", "/* removed */"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := sanitizeEmailCSS(tt.input)
			
			for _, expected := range tt.contains {
				if !strings.Contains(result, expected) {
					t.Errorf("Expected output to contain %q, but it didn't.\nInput: %s\nOutput: %s", 
						expected, tt.input, result)
				}
			}
			
			for _, notExpected := range tt.notContains {
				if strings.Contains(result, notExpected) {
					t.Errorf("Expected output NOT to contain %q, but it did.\nInput: %s\nOutput: %s", 
						notExpected, tt.input, result)
				}
			}
		})
	}
}

func TestSanitizeEmailCSS_ComplexOutlookEmail(t *testing.T) {
	// Test with a complex Outlook-style email similar to the problem statement
	input := `
	<style>
	.obf-TFormEmailTextBox{width:100%}
	.obf-TFormEmailCheckbox{display:inline-block;vertical-align:middle}
	#obf-EmailCheckBoxLabel{margin-bottom:8px}
	.obf-TFormEmailLabel{display:inline-block;vertical-align:top;width:80%;margin-left:3px}
	</style>
	<div class="obf-TFormEmailTextBox">
		<input class="obf-TFormEmailCheckbox" type="checkbox">
	</div>
	`
	
	result := sanitizeEmailCSS(input)
	
	// Verify obfuscated classes are removed
	obfClasses := []string{"obf-TFormEmailTextBox", "obf-TFormEmailCheckbox", "obf-EmailCheckBoxLabel"}
	for _, class := range obfClasses {
		if strings.Contains(result, class) {
			t.Errorf("Obfuscated class %q should have been removed from result", class)
		}
	}
	
	// Verify basic structure remains
	if !strings.Contains(result, "<style>") {
		t.Error("Style tag should still be present")
	}
	if !strings.Contains(result, "<div") {
		t.Error("Div tag should still be present")
	}
}

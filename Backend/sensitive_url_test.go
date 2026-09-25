package main

import "testing"

func TestCheckSensitiveURL(t *testing.T) {
	tests := []struct {
		name             string
		url              string
		text             string
		expectedSens     bool
		expectedCategory string
	}{
		{
			name:             "Account activation via URL",
			url:              "https://example.com/activate/ab12cd34",
			text:             "Click here",
			expectedSens:     true,
			expectedCategory: "account activation",
		},
		{
			name:             "Account activation via anchor text",
			url:              "https://clicks.example.com/track/12345",
			text:             "Activate your account",
			expectedSens:     true,
			expectedCategory: "account activation",
		},
		{
			name:             "Account confirmation via anchor text",
			url:              "https://subdomain.example.com/user/confirm-email",
			text:             "Confirm email address",
			expectedSens:     true,
			expectedCategory: "account confirmation",
		},
		{
			name:             "Verification link",
			url:              "https://example.com/verify?token=xyz",
			text:             "Verify Now",
			expectedSens:     true,
			expectedCategory: "account confirmation",
		},
		{
			name:             "Password reset link",
			url:              "https://example.com/auth/reset-password",
			text:             "Reset your password",
			expectedSens:     true,
			expectedCategory: "password reset",
		},
		{
			name:             "Unsubscribe link",
			url:              "https://mail.example.com/unsubscribe?id=99",
			text:             "Unsubscribe",
			expectedSens:     true,
			expectedCategory: "unsubscribe",
		},
		{
			name:             "One-time login link",
			url:              "https://app.example.com/login?magic=true",
			text:             "Magic link sign-in",
			expectedSens:     true,
			expectedCategory: "one-time login",
		},
		{
			name:             "Standard safe product link",
			url:              "https://store.example.com/products/headphones",
			text:             "View Headphones",
			expectedSens:     false,
			expectedCategory: "",
		},
		{
			name:             "Homepage link",
			url:              "https://company.org/",
			text:             "Our Website",
			expectedSens:     false,
			expectedCategory: "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			sens, cat := checkSensitiveURL(tc.url, tc.text)
			if sens != tc.expectedSens {
				t.Errorf("%s: expected isSens=%v, got %v", tc.name, tc.expectedSens, sens)
			}
			if cat != tc.expectedCategory {
				t.Errorf("%s: expected category=%q, got %q", tc.name, tc.expectedCategory, cat)
			}
			if isSensitiveURL(tc.url, tc.text) != tc.expectedSens {
				t.Errorf("%s: isSensitiveURL mismatch with checkSensitiveURL", tc.name)
			}
		})
	}
}

package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func isRerunRequest(r *http.Request) bool {
	return r.URL.Query().Get("rerun") == "true" ||
		r.URL.Query().Get("forceRerun") == "true" ||
		r.Header.Get("X-Force-Rerun") == "true" ||
		strings.Contains(r.Header.Get("Cache-Control"), "no-cache")
}

func TestIsRerunRequest(t *testing.T) {
	tests := []struct {
		name     string
		url      string
		headers  map[string]string
		expected bool
	}{
		{
			name:     "Normal request without rerun flag",
			url:      "/process-eml-stream?checkDomain=true&checkUrls=true",
			headers:  map[string]string{},
			expected: false,
		},
		{
			name:     "Query param rerun=true",
			url:      "/process-eml-stream?checkDomain=true&rerun=true",
			headers:  map[string]string{},
			expected: true,
		},
		{
			name:     "Query param forceRerun=true",
			url:      "/process-eml-stream?checkDomain=true&forceRerun=true",
			headers:  map[string]string{},
			expected: true,
		},
		{
			name:     "Header X-Force-Rerun: true",
			url:      "/process-eml-stream",
			headers:  map[string]string{"X-Force-Rerun": "true"},
			expected: true,
		},
		{
			name:     "Header Cache-Control: no-cache",
			url:      "/process-eml-stream",
			headers:  map[string]string{"Cache-Control": "no-cache"},
			expected: true,
		},
		{
			name:     "Query param rerun=false",
			url:      "/process-eml-stream?rerun=false",
			headers:  map[string]string{},
			expected: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", tc.url, nil)
			for k, v := range tc.headers {
				req.Header.Set(k, v)
			}
			actual := isRerunRequest(req)
			if actual != tc.expected {
				t.Errorf("%s: expected %v, got %v", tc.name, tc.expected, actual)
			}
		})
	}
}

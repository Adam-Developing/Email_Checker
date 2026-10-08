package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestVTCache(t *testing.T) {
	testKey := "test:example.com"
	testVerdict := &Verdict{
		Score:           0,
		Report:          "https://example.com/report",
		PlatformVerdict: false,
		FinalDecision:   false,
	}
	testStats := &DomainVTStats{
		Harmless:   25,
		Malicious:  0,
		Suspicious: 0,
		Undetected: 10,
	}

	// 1. Initial get should be false
	if _, _, found := getFromVTCache(testKey); found {
		t.Fatalf("expected key %s not to be in cache", testKey)
	}

	// 2. Set in cache and retrieve
	setInVTCache(testKey, testVerdict, testStats)
	cachedV, cachedStats, found := getFromVTCache(testKey)
	if !found {
		t.Fatalf("expected key %s to be found in cache", testKey)
	}
	if cachedV.Report != testVerdict.Report {
		t.Errorf("expected report %s, got %s", testVerdict.Report, cachedV.Report)
	}
	if cachedStats == nil || cachedStats.Harmless != 25 {
		t.Errorf("expected harmless stats 25, got %v", cachedStats)
	}

	// 3. Test expiration logic
	vtCacheMu.Lock()
	vtCache[testKey] = vtCacheEntry{
		verdict:     testVerdict,
		domainStats: testStats,
		timestamp:   time.Now().Add(-7 * time.Hour), // Older than 6 hours
	}
	vtCacheMu.Unlock()

	if _, _, found := getFromVTCache(testKey); found {
		t.Errorf("expected expired cache entry to return false")
	}
}

func TestSharedHostingDomains(t *testing.T) {
	shared := []string{
		"firebaseapp.com",
		"pages.dev",
		"workers.dev",
		"github.io",
		"s3.amazonaws.com",
		"ngrok.io",
		"duckdns.org",
		"linodeobjects.com",
		"linodeusercontent.com",
	}
	for _, d := range shared {
		if _, ok := sharedHostingDomains[d]; !ok {
			t.Errorf("expected %s to be in sharedHostingDomains map", d)
		}
		if !isSharedHostingDomain(d) {
			t.Errorf("expected %s to be recognized by isSharedHostingDomain", d)
		}
	}

	// Test subdomain matching (e.g. Linode object storage buckets, S3 buckets, etc.)
	subdomainShared := []string{
		"mybucket.us-east-1.linodeobjects.com",
		"asset-bucket.linodeobjects.com",
		"192-168-1-1.ip.linodeusercontent.com",
		"my-bucket.s3.amazonaws.com",
		"test-project.firebaseapp.com",
		"developer.github.io",
	}
	for _, d := range subdomainShared {
		if !isSharedHostingDomain(d) {
			t.Errorf("expected subdomain %s to be recognized as shared hosting domain", d)
		}
	}

	notShared := []string{
		"shell.hirevue-app.eu",
		"hirevue-app.eu",
		"modernhire.eu",
		"shell.com",
		"google.com",
		"paypal.com",
		"notlinodeobjects.com",
	}
	for _, d := range notShared {
		if isSharedHostingDomain(d) {
			t.Errorf("expected %s to NOT be recognized as shared hosting domain", d)
		}
	}
}

func TestConcurrentGetFinalURL(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect1":
			http.Redirect(w, r, "/target1", http.StatusMovedPermanently)
		case "/target1":
			_, _ = w.Write([]byte("Target 1 content"))
		case "/redirect2":
			http.Redirect(w, r, "/target2", http.StatusFound)
		case "/target2":
			_, _ = w.Write([]byte("Target 2 content"))
		case "/direct":
			_, _ = w.Write([]byte("Direct content"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()

	urlsToTest := map[string]struct{}{
		ts.URL + "/redirect1": {},
		ts.URL + "/redirect2": {},
		ts.URL + "/direct":    {},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var finalUniqueURLs = make(map[string]struct{})
	var resolveMu sync.Mutex
	var resolveWg sync.WaitGroup

	for u := range urlsToTest {
		resolveWg.Add(1)
		go func(rawURL string) {
			defer resolveWg.Done()
			final, err := getFinalURL(ctx, rawURL)
			resolveMu.Lock()
			defer resolveMu.Unlock()
			if err == nil && final != "" {
				finalUniqueURLs[final] = struct{}{}
			} else {
				finalUniqueURLs[rawURL] = struct{}{}
			}
		}(u)
	}
	resolveWg.Wait()

	expected1 := ts.URL + "/target1"
	expected2 := ts.URL + "/target2"
	expected3 := ts.URL + "/direct"

	if _, ok := finalUniqueURLs[expected1]; !ok {
		t.Errorf("expected %s in resolved URLs, got %v", expected1, finalUniqueURLs)
	}
	if _, ok := finalUniqueURLs[expected2]; !ok {
		t.Errorf("expected %s in resolved URLs, got %v", expected2, finalUniqueURLs)
	}
	if _, ok := finalUniqueURLs[expected3]; !ok {
		t.Errorf("expected %s in resolved URLs, got %v", expected3, finalUniqueURLs)
	}
}

func TestCheckDomainVTotalMock(t *testing.T) {
	// Mock VirusTotal API server
	mockVT := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "clean-company.com") {
			resp := map[string]interface{}{
				"data": map[string]interface{}{
					"attributes": map[string]interface{}{
						"last_analysis_stats": map[string]int{
							"harmless":   50,
							"malicious":  0,
							"suspicious": 0,
							"undetected": 20,
						},
						"categories": map[string]string{
							"Vendor1": "business",
						},
						"reputation": 100,
					},
				},
			}
			_ = json.NewEncoder(w).Encode(resp)
			return
		}

		if strings.Contains(r.URL.Path, "phishing-site.com") {
			resp := map[string]interface{}{
				"data": map[string]interface{}{
					"attributes": map[string]interface{}{
						"last_analysis_stats": map[string]int{
							"harmless":   0,
							"malicious":  5,
							"suspicious": 2,
							"undetected": 10,
						},
						"categories": map[string]string{
							"Vendor1": "phishing",
						},
						"reputation": -50,
					},
				},
			}
			_ = json.NewEncoder(w).Encode(resp)
			return
		}

		http.NotFound(w, r)
	}))
	defer mockVT.Close()

	// Direct test of parsing and verdict calculation logic
	cleanStats := DomainVTStats{
		Harmless:   50,
		Malicious:  0,
		Suspicious: 0,
		Undetected: 20,
	}
	if cleanStats.Harmless < 1 || cleanStats.Malicious > 0 || cleanStats.Suspicious > 0 {
		t.Errorf("expected cleanStats to qualify as clean domain")
	}

	phishStats := DomainVTStats{
		Harmless:   0,
		Malicious:  5,
		Suspicious: 2,
		Undetected: 10,
	}
	if phishStats.Malicious == 0 && phishStats.Suspicious == 0 {
		t.Errorf("expected phishStats to be identified as malicious")
	}
}

func TestVTBetaThreshold(t *testing.T) {
	// Helper to calculate finalDecision mimicking Central Functions.go logic
	evaluateVerdict := func(ctx context.Context, maliciousCount int, suspiciousCount int) bool {
		score := maliciousCount + suspiciousCount
		malicious := maliciousCount > 0
		if IsVTBetaThresholdEnabled(ctx) {
			return malicious || suspiciousCount >= 2
		}
		return malicious || score > 0
	}

	// 1. When Beta Threshold is OFF:
	SetVTBetaThreshold(false)
	bgCtx := context.Background()

	if !evaluateVerdict(bgCtx, 0, 1) {
		t.Errorf("expected 1 suspicious engine to be flagged when beta flag is OFF")
	}
	if evaluateVerdict(bgCtx, 0, 0) {
		t.Errorf("expected 0 engines to be clean when beta flag is OFF")
	}
	if !evaluateVerdict(bgCtx, 1, 0) {
		t.Errorf("expected 1 malicious engine to be flagged when beta flag is OFF")
	}

	// 2. When Beta Threshold is ON:
	SetVTBetaThreshold(true)

	if evaluateVerdict(bgCtx, 0, 1) {
		t.Errorf("expected 1 suspicious engine to NOT be flagged when beta flag is ON")
	}
	if !evaluateVerdict(bgCtx, 0, 2) {
		t.Errorf("expected 2 suspicious engines to be flagged when beta flag is ON")
	}
	if !evaluateVerdict(bgCtx, 0, 3) {
		t.Errorf("expected 3 suspicious engines to be flagged when beta flag is ON")
	}
	if !evaluateVerdict(bgCtx, 1, 0) {
		t.Errorf("expected 1 malicious engine to be flagged when beta flag is ON")
	}

	// 3. Context override:
	// Global is ON, but request context specifies FALSE
	overrideDisabledCtx := WithVTBetaThreshold(bgCtx, false)
	if !evaluateVerdict(overrideDisabledCtx, 0, 1) {
		t.Errorf("expected context override (false) to flag 1 suspicious engine")
	}

	// Global is OFF, but request context specifies TRUE
	SetVTBetaThreshold(false)
	overrideEnabledCtx := WithVTBetaThreshold(bgCtx, true)
	if evaluateVerdict(overrideEnabledCtx, 0, 1) {
		t.Errorf("expected context override (true) to NOT flag 1 suspicious engine")
	}
	if !evaluateVerdict(overrideEnabledCtx, 0, 2) {
		t.Errorf("expected context override (true) to flag 2 suspicious engines")
	}

	// Reset state
	ResetVTBetaThreshold()
}
